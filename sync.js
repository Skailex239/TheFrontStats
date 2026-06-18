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
import { MAP_ALIASES, normalizeMap } from "./shared/maps.js";
import { extractSpeedrun, TIME_OFFSET_SECS } from "./shared/extract-speedrun.js";

// ── Configuration ─────────────────────────────────────────────────────────────
const FETCH_TIMEOUT    = 8_000;

const HAS_EXEMPTION = hasExemption();

// Avertir si pas d'exemption (après chargement du .env)
if (!HAS_EXEMPTION) {
  console.warn("[openfront-api] OPENFRONT_SKAILEX_ACCESS absent — requêtes sans exemption (rate limit strict)");
} else {
  console.log("[sync] 🔑 Exemption Skailex active");
}
// Fenêtres de 30s : évite de rater des parties si l'API tronque une grosse plage
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
  // Check mode-specific env var first
  const envVar = syncMode === "compact" ? "COMPACT_HISTORY_WINDOWS" : "SYNC_HISTORY_WINDOWS";
  const env = parseInt(process.env[envVar] || "", 10);
  if (!Number.isNaN(env) && env > 0) return env;
  const actionArgs = argv.filter(a => !a.startsWith('--mode'));
  const arg = parseInt(actionArgs[1] || "", 10);
  if (!Number.isNaN(arg) && arg > 0) return arg;
  return DEFAULT_HISTORY_WINDOWS;
}

const RECENT_MAX_MS = 3 * 60 * 60 * 1_000;
const RECENT_OVERLAP_MS = 10 * 60 * 1_000;
const GAMES_LIST_FILTER = "type=Public&mode=Free%20For%20All";

const WINDOW_SATURATION_THRESHOLD = 45;

// ── File paths — set dynamically based on mode ──────────────────────────
let RUNS_FILE        = "runs.json";
let RUNS_BACKUP_FILE = "runs_backup.json";
let RUNS_FULL_FILE   = "runs_full.json";
let CHECKPOINT_FILE = "checkpoint.json";
let SEEN_FILE       = "seen.json";

/** Update file paths based on mode (normal/compact) */
function setModePaths(mode) {
  if (mode === "compact") {
    RUNS_FILE        = "runs_compact.json";
    RUNS_BACKUP_FILE = "runs_compact_backup.json";
    RUNS_FULL_FILE   = "runs_compact_full.json";
    CHECKPOINT_FILE = "checkpoint_compact.json";
    SEEN_FILE       = "seen_compact.json";
  } else {
    RUNS_FILE        = "runs.json";
    RUNS_BACKUP_FILE = "runs_backup.json";
    RUNS_FULL_FILE   = "runs_full.json";
    CHECKPOINT_FILE = "checkpoint.json";
    SEEN_FILE       = "seen.json";
  }
}

let currentLatestCommit = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Persistence ───────────────────────────────────────────────────────────────
function loadRuns() {
  try {
    // 1. Try full file first (fastest, raw array — local only, never committed)
    if (fs.existsSync(RUNS_FULL_FILE)) {
      const raw = JSON.parse(fs.readFileSync(RUNS_FULL_FILE, "utf8"));
      return Array.isArray(raw) ? raw : (raw.runs || []);
    }
    // 2. Try uncompressed JSON (gitignored, may exist locally)
    if (fs.existsSync(RUNS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(RUNS_FILE, "utf8"));
      return Array.isArray(raw) ? raw : (raw.runs || []);
    }
    // 3. Try gzipped file (THIS is the one that's actually committed to the repo!)
    const gzPath = RUNS_FILE + ".gz";
    if (fs.existsSync(gzPath)) {
      const gzipped = fs.readFileSync(gzPath);
      const decompressed = zlib.gunzipSync(gzipped);
      const raw = JSON.parse(decompressed.toString("utf8"));
      return Array.isArray(raw) ? raw : (raw.runs || []);
    }
  } catch (e) {
    console.warn(`[sync] ⚠️ loadRuns error: ${e.message}`);
  }
  return [];
}

function saveRuns(runs) {
  const meta = {
    totalCount: runs.length,
    lastUpdate: new Date().toISOString(),
    latestCommit: currentLatestCommit,
  };

  // Fichier public (sans URL, plus léger)
  const cleanedRuns = runs.map(({ url, ...rest }) => rest);
  const publicOutput = { ...meta, runs: cleanedRuns };
  const jsonString = JSON.stringify(publicOutput);

  fs.writeFileSync(RUNS_FILE, jsonString);
  const gzipped = zlib.gzipSync(jsonString);
  fs.writeFileSync(RUNS_FILE + ".gz", gzipped);

  // Backup complet (toutes les runs + URLs), mis à jour à chaque sync
  const backupOutput = { ...meta, runs };
  const backupString = JSON.stringify(backupOutput);
  fs.writeFileSync(RUNS_BACKUP_FILE, backupString);
  try {
    fs.writeFileSync(RUNS_BACKUP_FILE + ".gz", zlib.gzipSync(backupString));
  } catch (e) {
    console.warn("[sync] ⚠️ Impossible d'écrire runs_backup.json.gz:", e.message);
  }

  // Archive interne (tableau brut, utilisé par loadRuns)
  try {
    fs.writeFileSync(RUNS_FULL_FILE, JSON.stringify(runs));
  } catch (e) {
    console.warn("[sync] ⚠️ Impossible d'écrire runs_full.json:", e.message);
  }

  // ── Optimized public payload (tiny instead of 15+ MB) ──
  // Only includes: top 25 per map + 50 most recent runs
  // Uses compact array format to minimize size
  try {
    const byMap = {};
    const mapTotals = {}; // NEW: Store true count of runs per map
    runs.forEach(r => { 
      if (!byMap[r.map]) byMap[r.map] = []; 
      byMap[r.map].push(r); 
      mapTotals[r.map] = (mapTotals[r.map] || 0) + 1;
    });
    const topPerMap = [];
    Object.entries(byMap).forEach(([map, mapRuns]) => {
      mapRuns.sort((a, b) => a.duration_s - b.duration_s);
      topPerMap.push(...mapRuns.slice(0, 25));
    });

    const allSorted = [...runs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const recent50 = allSorted.slice(0, 50);

    const seen = new Set();
    const merged = [];
    [...recent50, ...topPerMap].forEach(r => {
      if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
    });

    // Compact format: array of arrays instead of array of objects
    // Key map: [id, player, playerId, map, duration_s, difficulty, bots, players, timestamp]
    const publicPayload = {
      t: meta.totalCount,
      u: meta.lastUpdate,
      c: meta.latestCommit,
      m: mapTotals, // NEW: Include map totals in the payload
      k: ['id', 'player', 'playerId', 'map', 'duration_s', 'difficulty', 'bots', 'players', 'timestamp'],
      r: merged.map(r => [r.id, r.player, r.playerId || '', r.map, r.duration_s, r.difficulty || '', r.bots || 0, r.players || 0, r.timestamp])
    };

    const publicJson = JSON.stringify(publicPayload);
    const publicFile = RUNS_FILE.replace('.json', '_public.json');
    fs.writeFileSync(publicFile, publicJson);
    fs.writeFileSync(publicFile + '.gz', zlib.gzipSync(publicJson));
    console.log(`[sync] 🚀 Public payload: ${(publicJson.length / 1024).toFixed(0)} KB raw, ${(zlib.gzipSync(publicJson).length / 1024).toFixed(0)} KB gzipped (${merged.length} runs, top 25/map + 50 recent)`);
  } catch (e) {
    console.warn("[sync] ⚠️ Impossible de générer le payload public:", e.message);
  }

  console.log(
    `[sync] 💾 ${runs.length} runs — public ${(jsonString.length / 1024 / 1024).toFixed(2)} Mo, ` +
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
  try {
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
    // ── Reset check: if do-reset.ps1 set {"reset":true}, clear all sync state ──
    if (cp.reset === true) {
      console.log("[checkpoint] ⚠️ Reset detected — clearing sync state for full re-sync.");
      const cleared = { history_oldest_reached: String(Date.now()), history_saturated_windows: 0, last_sync_time: "0" };
      saveCheckpoints(cleared);
      return cleared;
    }
    return cp;
  } catch { return {}; }
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
        console.log(`[rate-limit] 429 — attente ${wait}ms (tentative ${attempt + 1}/${retries})`);
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

// MAP_ALIASES, normalizeMap, extractSpeedrun, TIME_OFFSET_SECS are now imported from shared/

// ── Global mode (set by --mode flag) ──────────────────────────────────────
let syncMode = "normal";
const MIN_HUMANS = () => syncMode === "compact" ? 3 : 10;

function filterSpeedrunCandidates(games) {
  return games.filter(g =>
    g.type === "Public" &&
    (g.mode === "Free For All" || g.mode === "FFA") &&
    (g.numPlayers == null || g.numPlayers >= MIN_HUMANS())
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
    return filterSpeedrunCandidates(games);
  } catch (e) {
    if (e.message !== "Timeout") console.warn(`[fetch] ⚠️ ${url}: ${e.message}`);
    return [];
  }
}

async function processOneGame(game, seen, runs, runIds) {
  const gameId = game.game;
  try {
    const raw = await fetchGameDetail(gameId);
    seen.add(gameId);
    const run = extractSpeedrun(raw, syncMode);
    if (run && !runIds.has(run.id)) {
      runs.push(run);
      runIds.add(run.id);
      const mins = Math.floor(run.duration_s / 60);
      const secs = String(run.duration_s % 60).padStart(2, "0");
      const modeLabel = syncMode === "compact" ? "compact" : "sync";
      console.log(`[${modeLabel}] ✅ ${run.player} — ${run.map} — ${mins}m${secs}s (${run.difficulty}, ${run.players}p)`);
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
    `[sync] ${unseen.length} parties à détailler (×${DETAIL_CONCURRENCY} parallèle${HAS_EXEMPTION ? ", mode rapide" : ""})`
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
        if (errors <= 5) console.warn(`[sync] ⚠️ ${r.gameId}: ${r.error.message}`);
      }
    }
    if (BATCH_DELAY_NORMAL > 0) await sleep(BATCH_DELAY_NORMAL);
  }

  if (errors > 5) console.log(`[sync] ... et ${errors - 5} autres erreurs`);
  return newRuns;
}

async function fetchGameDetail(gameId) {
  return fetchWithRetry(`${API_BASE}/public/game/${gameId}?turns=false`);
}

// ── Sync normale (dernières 3h) ───────────────────────────────────────────────
async function syncRecent() {
  console.log(`[sync] 🔄 Sync récente — ${new Date().toISOString()}`);
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
    `[sync] ${windows.length} fenêtres de 30s (~${windowMin} min, max 3h, filtre Public FFA ≥10p)`
  );

  for (const { start, end } of windows) {
    const games = await fetchGamesInWindow(start, end);
    if (games.length > 0) {
      if (games.length >= WINDOW_SATURATION_THRESHOLD) {
        console.log(
          `[sync] ⚠️ Fenêtre saturée (${games.length}) ${start.toISOString().slice(11, 19)} — possible troncature`
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

  logApiStats("sync-recent");
  console.log(`[sync] ✅ Sync récente terminée — ${totalNew} nouveaux runs`);
  return totalNew;
}

function countHistoryWindows(rangeStartMs, rangeEndMs) {
  return Math.max(0, Math.ceil((rangeEndMs - rangeStartMs) / WINDOW_MS));
}

/** État de la sync (checkpoint, fenêtres, playerId, etc.) */
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

  console.log("\n📍 ÉTAT DE LA SYNC");
  console.log("═══════════════════════════════════════");
  console.log(`Runs en base:        ${runs.length.toLocaleString()}`);
  console.log(`Avec clientID:     ${withPlayerId.toLocaleString()} (${Math.round((withPlayerId / runs.length) * 100) || 0}%)`);
  console.log(`Parties vues (seen): ${seenCount.toLocaleString()}`);
  console.log(`Dernière sync récente: ${lastSync}`);
  console.log(`Exemption Skailex: ${HAS_EXEMPTION ? "oui" : "non"}`);
  console.log(`Fenêtre historique:  ${DEFAULT_HISTORY_WINDOWS} max / run (${HAS_EXEMPTION ? "exemption" : "sans exemption"})`);
  console.log("");
  console.log(`Cible historique:    ${new Date(oldest).toISOString().slice(0, 10)} → maintenant`);
  console.log(`Checkpoint (plus vieux traité): ${new Date(saved).toISOString()}`);
  console.log(`Fenêtres 30s totales:  ~${totalWindows.toLocaleString()}`);
  console.log(`Fenêtres restantes:    ~${remainingWindows.toLocaleString()} (recul depuis maintenant)`);
  console.log(`Avancement historique: ~${historyPct}%`);
  console.log(`Fenêtres saturées (cumul): ${cp.history_saturated_windows || 0}`);
  if (historyDone) {
    console.log("\n⚠️  Historique marqué COMPLET — des parties peuvent manquer (429 / fenêtres saturées).");
    console.log("   Pour rescanner: node sync.js reset-history  puis  node sync.js history 500");
  }
  // Show public payload size
  try {
    const publicFile = RUNS_FILE.replace('.json', '_public.json');
    const stat = fs.statSync(publicFile);
    const statGz = fs.statSync(publicFile + '.gz');
    console.log(`Payload public:       ${(stat.size / 1024).toFixed(0)} KB raw, ${(statGz.size / 1024).toFixed(0)} KB gzipped`);
  } catch { /* public payload may not exist yet */ }

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
    console.log(`[history] ✅ Historique complet jusqu'au ${new Date(oldest).toISOString().slice(0, 10)}`);
    console.log("[history] Utilise reset-history puis history 500 pour rescanner les trous.");
    return 0;
  }

  console.log(`[history] 🕐 Reprise depuis ${new Date(resumeFrom).toISOString()}`);

  const rangeEnd = new Date(resumeFrom);
  const rangeStart = new Date(oldest);
  const windows = buildWindows30s(rangeStart, rangeEnd);

  const toProcess = Math.min(windows.length, maxWindows);
  console.log(`[history] ${windows.length.toLocaleString()} fenêtres restantes — traitement de ${toProcess} (max ${maxWindows})`);

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
          if (saturatedWindows <= 3) {
            console.log(
              `[history] ⚠️ Fenêtre saturée (${games.length}): ${start.toISOString().slice(0, 16)}`
            );
          }
        }
        const added = await processGames(games, seen, runs, runIds);
        totalRuns += added;
        if (added > 0) {
          console.log(`[history] +${added} runs (${start.toISOString().slice(0, 10)} ${start.toISOString().slice(11, 16)})`);
        }
      }
      oldestReached = end.getTime();
    } catch (e) {
      console.warn(`[history] ⚠️ Erreur fenêtre ${start.toISOString()}: ${e.message}`);
    }

    if (WINDOW_DELAY > 0) await sleep(WINDOW_DELAY);

    // Checkpoint périodique
    if ((i + 1) % CHECKPOINT_EVERY === 0 || i === toProcess - 1) {
      cp.history_oldest_reached = String(oldestReached);
      cp.history_saturated_windows = (cp.history_saturated_windows || 0) + saturatedWindows;
      saveCheckpoints(cp);
      saveSeen(seen);
      if (totalRuns > 0) saveRuns(runs);

      const pct = Math.round(((now - oldestReached) / (now - oldest)) * 100);
      console.log(`[history] 💾 ${i + 1}/${toProcess} fenêtres — ${totalRuns} runs — ${pct}% de l'historique`);
    }
  }

  // Sauvegarde finale
  if (totalRuns > 0) saveRuns(runs);
  saveSeen(seen);

  if (saturatedWindows > 0) {
    console.log(`[history] ⚠️ ${saturatedWindows} fenêtres saturées détectées — certains runs ont peut-être été manqués`);
  }

  if (windows.length > maxWindows) {
    console.log(`[history] ⏹️ Limite atteinte — reprendra au prochain run (reste: ${(windows.length - toProcess).toLocaleString()} fenêtres)`);
  } else {
    console.log(`[history] ✅ Historique terminé — ${totalRuns} runs insérés`);
  }

  return totalRuns;
}

// ── Diagnostic : vérifie les trous dans la couverture temporelle ──────────────
async function diagnose() {
  const cp = loadCheckpoints();
  const runs = loadRuns();

  printSyncStatus(cp);

  console.log("📊 DIAGNOSTIC DU DATASET");
  console.log("═══════════════════════════════════════");
  console.log(`Total runs: ${runs.length.toLocaleString()}`);

  // Répartition par mois
  const byMonth = {};
  runs.forEach(r => {
    const k = r.timestamp ? r.timestamp.slice(0, 7) : "unknown";
    byMonth[k] = (byMonth[k] || 0) + 1;
  });
  console.log("\nRuns par mois:");
  Object.keys(byMonth).sort().forEach(k => {
    const bar = "█".repeat(Math.round(byMonth[k] / 200));
    console.log(`  ${k}: ${byMonth[k].toLocaleString().padStart(6)} ${bar}`);
  });

  // Top 10 maps
  const byMap = {};
  runs.forEach(r => { byMap[r.map] = (byMap[r.map] || 0) + 1; });
  const topMaps = Object.entries(byMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log("\nTop 10 maps:");
  topMaps.forEach(([map, count]) => console.log(`  ${map.padEnd(30)} ${count.toLocaleString()}`));

  console.log("═══════════════════════════════════════\n");
}

/** Remet le curseur historique à maintenant pour rescanner (garde runs + seen). */
function resetHistoryCheckpoint() {
  const cp = loadCheckpoints();
  cp.history_oldest_reached = String(Date.now());
  cp.history_saturated_windows = 0;
  cp.history_rescan_at = new Date().toISOString();
  saveCheckpoints(cp);
  console.log("[reset-history] ✅ Curseur remis à maintenant — les parties déjà dans seen/ seront ignorées, les manquantes seront ajoutées.");
  printSyncStatus(cp);
}

// ── Enrich : backfill playerIds manquants ─────
async function enrichPlayerIds() {
  const runs = loadRuns();
  const missing = runs.filter(r => !r.playerId);
  console.log(`[enrich] ${missing.length} runs sans playerId sur ${runs.length} total`);

  if (missing.length === 0) {
    console.log("[enrich] ✅ Tous les runs ont déjà un playerId");
    return;
  }

  let fixed = 0, errors = 0;
  const ENRICH_BATCH = 250; // Nombre de runs traités par exécution
  
  const toProcess = missing.slice(0, ENRICH_BATCH);
  console.log(`[enrich] Traitement de ${toProcess.length} runs (max ${ENRICH_BATCH} par exécution)...`);

  for (const run of toProcess) {
    try {
      const raw = await fetchWithRetry(`${API_BASE}/public/game/${run.id}?turns=false`);
      const info = raw.info || raw;
      const players = info.players || [];
      const winner = info.winner;
      if (winner && Array.isArray(winner) && winner.length >= 2) {
        const wp = players.find(p => p.clientID === winner[1]);
        if (wp && wp.clientID) {
          run.playerId = wp.clientID;
          fixed++;
        }
      }
    } catch (e) {
      errors++;
    }
    await sleep(150);
  }

  console.log(`[enrich] ✅ ${fixed} runs enrichis, ${errors} erreurs`);
  if (missing.length > ENRICH_BATCH) {
    console.log(`[enrich] ⏳ Reste ${missing.length - ENRICH_BATCH} runs — relancer 'node sync.js enrich'`);
  }

  saveRuns(runs);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function fetchLatestCommit() {
  try {
    const res = await fetch("https://api.github.com/repos/openfrontio/OpenFrontIO/commits/main", {
      headers: { "Accept": "application/vnd.github.v3+json" }
    });
    if (res.ok) {
      const data = await res.json();
      return {
        sha: data.sha,
        date: data.commit.author.date,
        message: data.commit.message
      };
    }
  } catch (e) {
    console.warn("[sync] ⚠️ Impossible de récupérer le dernier commit d'OpenFrontIO:", e.message);
  }
  return null;
}

/** Mesure le débit avant 429 — node sync.js benchmark */
async function benchmarkExemption() {
  if (!HAS_EXEMPTION) {
    console.log("[benchmark] OPENFRONT_SKAILEX_ACCESS requis");
    return;
  }
  resetApiStats();
  console.log("[benchmark] Enchaînement /public/games jusqu'aux 429…");
  const now = new Date();
  const ago = new Date(now.getTime() - 3_600_000);
  const t0 = Date.now();
  let i = 0;
  let first429 = null;

  for (i = 0; i < 500; i++) {
    const url =
      `${API_BASE}/public/games?start=${ago.toISOString()}&end=${now.toISOString()}` +
      `&${GAMES_LIST_FILTER}&limit=50`;
    const res = await openFrontFetch(url);
    if (res.status === 429) {
      first429 = i + 1;
      const retryAfter = res.headers.get("retry-after");
      console.log(`[benchmark] Premier 429 après ${first429} requêtes (Retry-After: ${retryAfter ?? "n/a"})`);
      break;
    }
    if (!res.ok) {
      console.log(`[benchmark] HTTP ${res.status} à la requête ${i + 1}`);
      break;
    }
    await res.json();
  }

  const sec = (Date.now() - t0) / 1000;
  logApiStats("benchmark");
  if (!first429) {
    console.log(`[benchmark] Aucun 429 sur ${i} requêtes en ${sec.toFixed(1)}s (~${(i / sec).toFixed(1)} req/s)`);
    console.log("[benchmark] Limite non atteinte — exemption probablement illimitée ou >500 req/burst");
  } else {
    console.log(`[benchmark] Débit avant limite: ~${(first429 / sec).toFixed(1)} req/s`);
  }
  console.log("[benchmark] Plafonds API fixes (exemption ou non): fenêtre 2j, 1000 jeux/requête");
}

async function main() {
  const args = process.argv.slice(2);

  // ── Determine sync mode from --mode flag ──────────────────────────────
  syncMode = args.includes('--mode=compact') ? 'compact' : 'normal';
  setModePaths(syncMode);

  // Strip --mode flags from args to find the action command
  const actionArgs = args.filter(a => !a.startsWith('--mode'));
  const mode = actionArgs[0] || "full";

  const modeLabel = syncMode === "compact" ? "COMPACT" : "Normal";
  console.log(`[sync] 🚀 Démarrage — ${modeLabel} (action: ${mode})`);
  if (process.env.OPENFRONT_SKAILEX_ACCESS) {
    console.log("[sync] 🔑 Exemption Skailex active");
  }
  currentLatestCommit = await fetchLatestCommit();

  resetApiStats();

  if (mode === "benchmark") {
    await benchmarkExemption();
    return;
  }

  if (mode === "diagnose" || mode === "status") {
    if (mode === "status") printSyncStatus();
    else await diagnose();
    return;
  }

  if (mode === "reset-history") {
    resetHistoryCheckpoint();
    return;
  }

  if (mode === "enrich") {
    await enrichPlayerIds();
    return;
  }

  const runs = loadRuns();
  console.log(`[sync] ${runs.length.toLocaleString()} runs existants (${syncMode})`);

  if (mode === "full" || mode === "recent") {
    await syncRecent();
  }

  if (mode === "history") {
    const maxW = resolveHistoryWindowLimit(actionArgs);
    await syncHistory(maxW);
    return;
  }

  if (mode === "full") {
    await syncHistory(resolveHistoryWindowLimit(actionArgs));
  }

  const finalRuns = loadRuns();
  const finalCount = Array.isArray(finalRuns) ? finalRuns.length : (finalRuns.totalCount || 0);
  const statsLabel = syncMode === "compact" ? "compact-total" : "sync-total";
  logApiStats(statsLabel);
  console.log(`[sync] 🏁 Terminé: ${finalCount.toLocaleString()} runs total (${syncMode})`);
}

main().catch(e => {
  console.error("[sync] Fatal:", e);
  process.exit(1);
});
