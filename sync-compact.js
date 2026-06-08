// ⚠️ DEPRECATED: This file is kept for backward compatibility only.
// Use `node sync.js --mode=compact` instead.
// This file will be removed in a future version.

// sync-compact.js — Sync pour les speedruns sur maps compactes
// Critères : gameMapSize=Compact, 100 bots, min 3 joueurs humains, seul modificateur: isCompact

// Charger .env manuellement AVANT les imports
import fs from "fs";
try {
  const envContent = fs.readFileSync(".env", "utf8");
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=").trim();
    if (key && value) {
      process.env[key.trim()] = value;
    }
  });
} catch (e) {
  // .env optionnel
}

import fetch from "node-fetch";
import zlib from "zlib";
import {
  API_BASE,
  openFrontFetch,
  warnIfNoExemption,
  hasExemption,
  resetApiStats,
  logApiStats,
} from "./openfront-api.js";

// ── Configuration ─────────────────────────────────────────────────────────────
const FETCH_TIMEOUT    = 8_000;
const TIME_OFFSET_SECS = 32;

const HAS_EXEMPTION = hasExemption();

if (!HAS_EXEMPTION) {
  console.warn("[compact-api] OPENFRONT_SKAILEX_ACCESS absent — requêtes sans exemption (rate limit strict)");
} else {
  console.log("[compact] 🔑 Exemption Skailex active");
}

const WINDOW_MS  = 30 * 1_000;
const HISTORY_MS = 400 * 24 * 60 * 60 * 1_000;
const TARGET_DATE = new Date("2025-11-01").getTime();

const BATCH_DELAY_NORMAL  = HAS_EXEMPTION ? 0 : 200;
const WINDOW_DELAY        = HAS_EXEMPTION ? 0 : 50;
const DETAIL_CONCURRENCY  = HAS_EXEMPTION ? 12 : 2;
const DELAY_429           = HAS_EXEMPTION ? 2_000 : 8_000;
const CHECKPOINT_EVERY    = 20;
const DEFAULT_HISTORY_WINDOWS = HAS_EXEMPTION ? 500 : 40;

function resolveHistoryWindowLimit(argv) {
  const env = parseInt(process.env.COMPACT_HISTORY_WINDOWS || "", 10);
  if (!Number.isNaN(env) && env > 0) return env;
  const arg = parseInt(argv[1] || "", 10);
  if (!Number.isNaN(arg) && arg > 0) return arg;
  return DEFAULT_HISTORY_WINDOWS;
}

const RECENT_MAX_MS = 3 * 60 * 60 * 1_000;
const RECENT_OVERLAP_MS = 10 * 60 * 1_000;
const GAMES_LIST_FILTER = "type=Public&mode=Free%20For%20All";

const WINDOW_SATURATION_THRESHOLD = 45;

// ── Fichiers séparés pour la sync compact ──
const RUNS_FILE        = "runs_compact.json";
const RUNS_BACKUP_FILE = "runs_compact_backup.json";
const RUNS_FULL_FILE   = "runs_compact_full.json";
const CHECKPOINT_FILE = "checkpoint_compact.json";
const SEEN_FILE       = "seen_compact.json";

let currentLatestCommit = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Persistence ───────────────────────────────────────────────────────────────
function loadRuns() {
  try {
    if (fs.existsSync(RUNS_FULL_FILE)) {
      const raw = JSON.parse(fs.readFileSync(RUNS_FULL_FILE, "utf8"));
      return Array.isArray(raw) ? raw : (raw.runs || []);
    }
    const raw = JSON.parse(fs.readFileSync(RUNS_FILE, "utf8"));
    return Array.isArray(raw) ? raw : (raw.runs || []);
  } catch { return []; }
}

function saveRuns(runs) {
  const meta = {
    totalCount: runs.length,
    lastUpdate: new Date().toISOString(),
    latestCommit: currentLatestCommit,
  };

  const cleanedRuns = runs.map(({ url, ...rest }) => rest);
  const publicOutput = { ...meta, runs: cleanedRuns };
  const jsonString = JSON.stringify(publicOutput);

  fs.writeFileSync(RUNS_FILE, jsonString);
  const gzipped = zlib.gzipSync(jsonString);
  fs.writeFileSync(RUNS_FILE + ".gz", gzipped);

  const backupOutput = { ...meta, runs };
  const backupString = JSON.stringify(backupOutput);
  fs.writeFileSync(RUNS_BACKUP_FILE, backupString);
  try {
    fs.writeFileSync(RUNS_BACKUP_FILE + ".gz", zlib.gzipSync(backupString));
  } catch (e) {
    console.warn("[compact] ⚠️ Impossible d'écrire runs_compact_backup.json.gz:", e.message);
  }

  try {
    fs.writeFileSync(RUNS_FULL_FILE, JSON.stringify(runs));
  } catch (e) {
    console.warn("[compact] ⚠️ Impossible d'écrire runs_compact_full.json:", e.message);
  }

  console.log(
    `[compact] 💾 ${runs.length} runs compact — public ${(jsonString.length / 1024 / 1024).toFixed(2)} Mo, ` +
    `backup ${(backupString.length / 1024 / 1024).toFixed(2)} Mo`
  );
}

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"))); }
  catch { return new Set(); }
}
function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]));
}
function loadCheckpoints() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8")); }
  catch { return {}; }
}
function saveCheckpoints(cp) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

// ── Fetch avec retry et gestion 429 ──────────────────────────────────────────
async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await openFrontFetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        const wait = DELAY_429 * (attempt + 1);
        console.log(`[compact-rate-limit] 429 — attente ${wait}ms (tentative ${attempt + 1}/${retries})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") {
        if (attempt < retries) { await sleep(500); continue; }
        throw new Error("Timeout");
      }
      if (attempt === retries) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
}

// ── Normalisation des noms de maps ───────────────────────────────────────────
const MAP_ALIASES = {
  "Afrique":           "Africa",
  "Alpes":             "Alps",
  "Arctique":          "Arctic",
  "Asie":              "Asia",
  "Australie":         "Australia",
  "Amérique du Nord":  "North America",
  "Amérique du Sud":  "South America",
  "Europe":            "Europe",
  "Islande":           "Iceland",
  "Japon":             "Japan",
  "Italie":            "Italy",
  "Italia":            "Italy",
  "Delta du Nil":      "Nile Delta",
  "Fleuve Amazone":    "Amazon River",
  "Mer Noire":         "Black Sea",
  "Détroit du Bosphore":"Bosphorus Straits",
  "Détroit de Béring": "Bering Strait",
  "Mer de Béring":     "Bering Sea",
  "Détroit de Gibraltar":"Strait of Gibraltar",
  "Détroit d'Hormuz":  "Strait of Hormuz",
  "Entre Deux Mers":   "Between Two Seas",
  "Monde":             "World",
  "Pangée":            "Pangaea",
  "Achiran":           "Achiran",
  "Aegean":            "Aegean",
  "Amazon River":      "Amazon River",
  "Antarctica":        "Antarctica",
  "Archipelago Sea":   "Archipelago Sea",
  "ArchipelagoSea":    "Archipelago Sea",
  "Arctic":            "Arctic",
  "Asia":              "Asia",
  "Australia":         "Australia",
  "Baikal":            "Baikal",
  "Baikal (Nuke Wars)": "Baikal (Nuke Wars)",
  "Baja California":   "Baja California",
  "Bering Sea":        "Bering Sea",
  "BeringStrait":      "Bering Strait",
  "BetweenTwoSeas":    "Between Two Seas",
  "BlackSea":          "Black Sea",
  "Bosphorus Straits": "Bosphorus Straits",
  "Britannia":         "Britannia",
  "Britannia Classic": "Britannia Classic",
  "Caucasus":          "Caucasus",
  "Conakry":           "Conakry",
  "Danish Straits":    "Danish Straits",
  "Deglaciated Antarctica": "Deglaciated Antarctica",
  "Didier":            "Didier",
  "Didier (France)":   "Didier (France)",
  "Dyslexdria":        "Dyslexdria",
  "East Asia":         "East Asia",
  "Europe":            "Europe",
  "Falkland Islands":  "Falkland Islands",
  "Faroe Islands":     "Faroe Islands",
  "Four Islands":      "Four Islands",
  "GatewayToTheAtlantic": "Gateway to the Atlantic",
  "Giant_World_Map":   "Giant World Map",
  "Great Lakes":       "Great Lakes",
  "Gulf of St. Lawrence": "Gulf of St. Lawrence",
  "Halkidiki":         "Halkidiki",
  "Hawaii":            "Hawaii",
  "Iceland":           "Iceland",
  "Italia":            "Italia",
  "Japan":             "Japan",
  "Lemnos":            "Lemnos",
  "Lisbon":            "Lisbon",
  "Los Angeles":       "Los Angeles",
  "Luna":              "Luna",
  "Manicouagan":       "Manicouagan",
  "Mare Nostrum":      "Mare Nostrum",
  "Mars":              "Mars",
  "MENA":              "MENA",
  "Middle East":       "Middle East",
  "Milkyway":          "Milkyway",
  "Montreal":          "Montreal",
  "New York City":     "New York City",
  "Nile Delta":        "Nile Delta",
  "NorthAmerica":      "North America",
  "Northwest Passage": "Northwest Passage",
  "Oceania":           "Oceania",
  "Pangaea":           "Pangaea",
  "Passage":           "Passage",
  "Pluto":             "Pluto",
  "SanFrancisco":      "San Francisco",
  "Sierpinski":        "Sierpinski",
  "Americas":          "Americas",
  "Strait of Gibraltar": "Strait of Gibraltar",
  "Strait of Hormuz":  "Strait of Hormuz",
  "Strait Of Malacca": "Strait of Malacca",
  "Surrounded":        "Surrounded",
  "Svalmel":           "Svalmel",
  "Taiwan Strait":     "Taiwan Strait",
  "TheBox":            "The Box",
  "Tourney1":          "Tourney 1",
  "Tourney2":          "Tourney 2",
  "Tourney3":          "Tourney 3",
  "Tourney4":          "Tourney 4",
  "Traders Dream":     "Traders Dream",
  "Two Lakes":         "Two Lakes",
  "Venice":            "Venice",
  "World":             "World",
  "Yenisei":           "Yenisei"
};
function normalizeMap(n) { return MAP_ALIASES[n] || n; }

// ── Extraction d'un speedrun COMPACT valide ────────────────────────────────
function extractCompactSpeedrun(raw) {
  const detail = raw.info;
  if (!detail) return null;
  const config = detail.config || {};

  // ── Critères de validité COMPACT ──────────────────────────────────────────
  if (config.gameType    !== "Public")       return null;
  if (config.gameMode    !== "Free For All") return null;
  if (config.gameMapSize !== "Compact")      return null;  // <-- COMPACT uniquement
  if (config.bots        !== 100)            return null;  // <-- 100 bots (pas 400)

  const mods = config.publicGameModifiers || {};
  // Seul isCompact est accepté — rejeter tout autre modificateur
  const allowedMods = ["isCompact"];
  const modKeys = Object.keys(mods).filter(k => mods[k]);
  for (const key of modKeys) {
    if (!allowedMods.includes(key)) return null;
  }

  // Vérifier qu'aucun flag de triche/modification n'est actif
  if (config.randomSpawn  !== false) return null;
  if (config.donateGold   !== false) return null;
  if (config.donateTroops !== false) return null;
  if (config.infiniteGold)           return null;
  if (config.infiniteTroops)         return null;
  if (config.instantBuild)           return null;
  if (config.startingGold  != null && config.startingGold  !== 0) return null;
  if (config.goldMultiplier != null && config.goldMultiplier !== 1) return null;

  const players = detail.players || [];
  const humanPlayers = players.filter(p => !p.isBot);
  if (humanPlayers.length < 3) return null;  // <-- Min 3 joueurs humains

  const winner = detail.winner;
  if (!winner || !Array.isArray(winner) || winner.length < 2) return null;

  const winnerPlayer = players.find(p => p.clientID === winner[1]);
  if (!winnerPlayer?.username || winnerPlayer.isBot) return null;

  // Calcul de la durée
  let durationSecs = null;
  if (detail.duration) {
    const d = detail.duration;
    durationSecs = d > 100_000 ? Math.round(d / 1000) : d;
  } else if (detail.start && detail.end) {
    const diff = detail.end - detail.start;
    durationSecs = diff > 100_000 ? Math.round(diff / 1000) : diff;
  }
  if (!durationSecs || durationSecs < 60) return null;
  durationSecs = Math.max(0, durationSecs - TIME_OFFSET_SECS);

  const gameId = detail.gameID || detail.gameId || detail.id;
  const mapName = normalizeMap(config.gameMap || "Unknown");

  return {
    id:         gameId,
    player:     winnerPlayer.username,
    playerId:   winnerPlayer.clientID,
    map:        mapName,
    duration_s: durationSecs,
    difficulty: config.difficulty || "Medium",
    bots:       100,
    players:    humanPlayers.length,
    timestamp:  detail.start
      ? new Date(detail.start > 1e10 ? detail.start : detail.start * 1000).toISOString()
      : new Date().toISOString(),
    url:        `https://openfront.io/game/${gameId}`,
  };
}

// ── Filtre candidats compact ──
// On ne peut pas filtrer par gameMapSize dans la liste (pas de paramètre API),
// donc on prend tout Public FFA et on filtre dans extractCompactSpeedrun
function filterCompactCandidates(games) {
  return games.filter(g =>
    g.type === "Public" &&
    (g.mode === "Free For All" || g.mode === "FFA") &&
    (g.numPlayers == null || g.numPlayers >= 3)
  );
}

/** Découpe [rangeStart, rangeEnd] en intervalles de 30 secondes */
function buildWindows30s(rangeStart, rangeEnd) {
  const windows = [];
  for (let end = rangeEnd.getTime(); end > rangeStart.getTime(); end -= WINDOW_MS) {
    const start = Math.max(end - WINDOW_MS, rangeStart.getTime());
    windows.push({ start: new Date(start), end: new Date(end) });
  }
  return windows;
}

// ── Récupération des parties dans une fenêtre de 30s ──────────────────────────
async function fetchGamesInWindow(start, end) {
  const url =
    `${API_BASE}/public/games?start=${start.toISOString()}&end=${end.toISOString()}` +
    `&${GAMES_LIST_FILTER}`;
  try {
    const data = await fetchWithRetry(url);
    if (!data) return [];
    const games = Array.isArray(data) ? data : (data.games || []);
    return filterCompactCandidates(games);
  } catch (e) {
    if (e.message !== "Timeout") console.warn(`[compact-fetch] ⚠️ ${url}: ${e.message}`);
    return [];
  }
}

async function processOneGame(game, seen, runs, runIds) {
  const gameId = game.game;
  try {
    const raw = await fetchGameDetail(gameId);
    seen.add(gameId);
    const run = extractCompactSpeedrun(raw);
    if (run && !runIds.has(run.id)) {
      runs.push(run);
      runIds.add(run.id);
      const mins = Math.floor(run.duration_s / 60);
      const secs = String(run.duration_s % 60).padStart(2, "0");
      console.log(`[compact] ✅ ${run.player} — ${run.map} — ${mins}m${secs}s (${run.difficulty}, ${run.players}p)`);
      return 1;
    }
  } catch (e) {
    return { error: e, gameId };
  }
  return 0;
}

// ── Traitement d'un lot de parties (parallèle si exemption) ───────────────────
async function processGames(games, seen, runs, runIds) {
  const unseen = games.filter(g => g.game && !seen.has(g.game));
  if (unseen.length === 0) return 0;

  let newRuns = 0;
  let errors = 0;

  console.log(
    `[compact] ${unseen.length} parties à détailler (×${DETAIL_CONCURRENCY} parallèle${HAS_EXEMPTION ? ", mode rapide" : ""})`
  );

  for (let i = 0; i < unseen.length; i += DETAIL_CONCURRENCY) {
    const chunk = unseen.slice(i, i + DETAIL_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(game => processOneGame(game, seen, runs, runIds))
    );
    for (const r of results) {
      if (typeof r === "number") newRuns += r;
      else if (r?.error) {
        errors++;
        if (errors <= 5) console.warn(`[compact] ⚠️ ${r.gameId}: ${r.error.message}`);
      }
    }
    if (BATCH_DELAY_NORMAL > 0) await sleep(BATCH_DELAY_NORMAL);
  }

  if (errors > 5) console.log(`[compact] ... et ${errors - 5} autres erreurs`);
  return newRuns;
}

async function fetchGameDetail(gameId) {
  return fetchWithRetry(`${API_BASE}/public/game/${gameId}?turns=false`);
}

// ── Sync récente (dernières 3h) ─────────────────────────────────────────────
async function syncRecent() {
  console.log(`[compact] 🔄 Sync récente — ${new Date().toISOString()}`);
  const seen = loadSeen();
  const runs = loadRuns();
  const runIds = new Set(runs.map(r => r.id));
  let totalNew = 0;

  const now = new Date();
  const cp = loadCheckpoints();
  const lastSync = cp.last_sync_time ? parseInt(cp.last_sync_time, 10) : 0;
  const agoMs = Math.max(now.getTime() - RECENT_MAX_MS, lastSync - RECENT_OVERLAP_MS);
  const ago = new Date(agoMs);
  const windowMin = Math.round((now - ago) / 60_000);

  const windows = buildWindows30s(ago, now);
  console.log(
    `[compact] ${windows.length} fenêtres de 30s (~${windowMin} min, max 3h, filtre Compact FFA ≥3p)`
  );

  for (const { start, end } of windows) {
    const games = await fetchGamesInWindow(start, end);
    if (games.length > 0) {
      if (games.length >= WINDOW_SATURATION_THRESHOLD) {
        console.log(
          `[compact] ⚠️ Fenêtre saturée (${games.length}) ${start.toISOString().slice(11, 19)} — possible troncature`
        );
      }
      totalNew += await processGames(games, seen, runs, runIds);
    }
    if (WINDOW_DELAY > 0) await sleep(WINDOW_DELAY);
  }

  if (totalNew > 0) saveRuns(runs);
  saveSeen(seen);

  cp.last_sync_time = String(Date.now());
  saveCheckpoints(cp);

  logApiStats("compact-recent");
  console.log(`[compact] ✅ Sync récente terminée — ${totalNew} nouveaux runs compact`);
  return totalNew;
}

function countHistoryWindows(rangeStartMs, rangeEndMs) {
  return Math.max(0, Math.ceil((rangeEndMs - rangeStartMs) / WINDOW_MS));
}

function printSyncStatus(cp = loadCheckpoints()) {
  const runs = loadRuns();
  const now = Date.now();
  const oldest = TARGET_DATE;
  const saved = cp.history_oldest_reached ? parseInt(cp.history_oldest_reached, 10) : now;
  const totalWindows = countHistoryWindows(oldest, now);
  const remainingWindows = countHistoryWindows(oldest, saved);
  const historyPct = totalWindows
    ? Math.round(((now - saved) / (now - oldest)) * 100)
    : 100;
  const withPlayerId = runs.filter((r) => r.playerId).length;
  const lastSync = cp.last_sync_time
    ? new Date(parseInt(cp.last_sync_time, 10)).toISOString()
    : "—";

  let seenCount = 0;
  try {
    seenCount = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")).length;
  } catch { /* */ }

  const historyDone = saved <= oldest + WINDOW_MS * 2;

  console.log("\n📍 ÉTAT DE LA SYNC COMPACT");
  console.log("═══════════════════════════════════════");
  console.log(`Runs compact en base:        ${runs.length.toLocaleString()}`);
  console.log(`Avec clientID:     ${withPlayerId.toLocaleString()} (${Math.round((withPlayerId / runs.length) * 100) || 0}%)`);
  console.log(`Parties vues (seen): ${seenCount.toLocaleString()}`);
  console.log(`Dernière sync récente: ${lastSync}`);
  console.log(`Exemption Skailex: ${HAS_EXEMPTION ? "oui" : "non"}`);
  console.log(`Filtres: Compact · 100 bots · ≥3 joueurs · isCompact uniquement`);
  console.log("");
  console.log(`Cible historique:    ${new Date(oldest).toISOString().slice(0, 10)} → maintenant`);
  console.log(`Checkpoint: ${new Date(saved).toISOString()}`);
  console.log(`Avancement historique: ~${historyPct}%`);
  if (historyDone) {
    console.log("\n⚠️  Historique compact marqué COMPLET.");
  }
  console.log("═══════════════════════════════════════\n");
}

// ── Sync historique avec checkpoint ──────────────────────────────────────────
async function syncHistory(maxWindows = DEFAULT_HISTORY_WINDOWS) {
  const cp = loadCheckpoints();
  const oldest = TARGET_DATE;
  const now = Date.now();

  const saved = cp.history_oldest_reached;
  const resumeFrom = saved ? Math.max(parseInt(saved) - WINDOW_MS, oldest) : now;

  printSyncStatus(cp);

  if (parseInt(saved) <= oldest + WINDOW_MS * 2) {
    console.log(`[compact-history] ✅ Historique compact complet jusqu'au ${new Date(oldest).toISOString().slice(0, 10)}`);
    return 0;
  }

  console.log(`[compact-history] 🕐 Reprise depuis ${new Date(resumeFrom).toISOString()}`);

  const rangeEnd = new Date(resumeFrom);
  const rangeStart = new Date(oldest);
  const windows = buildWindows30s(rangeStart, rangeEnd);

  const toProcess = Math.min(windows.length, maxWindows);
  console.log(`[compact-history] ${windows.length.toLocaleString()} fenêtres restantes — traitement de ${toProcess}`);

  const seen = loadSeen();
  const runs = loadRuns();
  const runIds = new Set(runs.map(r => r.id));
  let totalRuns = 0;
  let oldestReached = resumeFrom;
  let saturatedWindows = 0;

  for (let i = 0; i < toProcess; i++) {
    const { start, end } = windows[i];
    try {
      const games = await fetchGamesInWindow(start, end);
      if (games.length > 0) {
        if (games.length >= WINDOW_SATURATION_THRESHOLD) {
          saturatedWindows++;
        }
        const added = await processGames(games, seen, runs, runIds);
        totalRuns += added;
      }
      oldestReached = end.getTime();
    } catch (e) {
      console.warn(`[compact-history] ⚠️ Erreur fenêtre ${start.toISOString()}: ${e.message}`);
    }

    if (WINDOW_DELAY > 0) await sleep(WINDOW_DELAY);

    if ((i + 1) % CHECKPOINT_EVERY === 0 || i === toProcess - 1) {
      cp.history_oldest_reached = String(oldestReached);
      cp.history_saturated_windows = (cp.history_saturated_windows || 0) + saturatedWindows;
      saveCheckpoints(cp);
      saveSeen(seen);
      if (totalRuns > 0) saveRuns(runs);

      const pct = Math.round(((now - oldestReached) / (now - oldest)) * 100);
      console.log(`[compact-history] 💾 ${i + 1}/${toProcess} fenêtres — ${totalRuns} runs — ${pct}%`);
    }
  }

  if (totalRuns > 0) saveRuns(runs);
  saveSeen(seen);

  if (windows.length > maxWindows) {
    console.log(`[compact-history] ⏹️ Limite atteinte — reprendra au prochain run`);
  } else {
    console.log(`[compact-history] ✅ Historique compact terminé — ${totalRuns} runs insérés`);
  }

  return totalRuns;
}

function resetHistoryCheckpoint() {
  const cp = loadCheckpoints();
  cp.history_oldest_reached = String(Date.now());
  cp.history_saturated_windows = 0;
  saveCheckpoints(cp);
  console.log("[compact-reset] ✅ Curseur historique compact remis à maintenant");
  printSyncStatus(cp);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function fetchLatestCommit() {
  try {
    const res = await fetch("https://api.github.com/repos/openfrontio/OpenFrontIO/commits/main", {
      headers: { "Accept": "application/vnd.github.v3+json" }
    });
    if (res.ok) {
      const data = await res.json();
      return { sha: data.sha, date: data.commit.author.date, message: data.commit.message };
    }
  } catch (e) {
    console.warn("[compact] ⚠️ Impossible de récupérer le dernier commit d'OpenFrontIO:", e.message);
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || "full";

  console.log(`[compact] 🚀 Démarrage sync COMPACT (mode: ${mode})`);
  if (process.env.OPENFRONT_SKAILEX_ACCESS) {
    console.log("[compact] 🔑 Exemption Skailex active");
  }
  currentLatestCommit = await fetchLatestCommit();

  resetApiStats();

  if (mode === "diagnose" || mode === "status") {
    printSyncStatus();
    return;
  }

  if (mode === "reset-history") {
    resetHistoryCheckpoint();
    return;
  }

  const runs = loadRuns();
  console.log(`[compact] ${runs.length.toLocaleString()} runs compact existants`);

  if (mode === "full" || mode === "recent") {
    await syncRecent();
  }

  if (mode === "history") {
    const maxW = resolveHistoryWindowLimit(args);
    await syncHistory(maxW);
    return;
  }

  if (mode === "full") {
    await syncHistory(resolveHistoryWindowLimit(args));
  }

  const finalRuns = loadRuns();
  const finalCount = Array.isArray(finalRuns) ? finalRuns.length : (finalRuns.totalCount || 0);
  logApiStats("compact-total");
  console.log(`[compact] 🏁 Terminé: ${finalCount.toLocaleString()} runs compact total`);
}

main().catch(e => {
  console.error("[compact] Fatal:", e);
  process.exit(1);
});
