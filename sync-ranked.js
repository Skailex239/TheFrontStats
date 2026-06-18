import fs from "fs";
import zlib from "zlib";
import {
  API_BASE,
  openFrontFetch,
  hasExemption,
} from "./openfront-api.js";

// Charger .env manuellement (même pattern que sync.js)
try {
  const envContent = fs.readFileSync(".env", "utf8");
  envContent.split(/\r?\n/).forEach((line) => {
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

const MAX_PAGES = 4; // 4 × 50 = top 200 joueurs
const MAX_HISTORY_POINTS = 200; // 200 points max par joueur (~50h de sync)

async function fetchLeaderboard() {
  const allPlayers = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const url = `${API_BASE}/leaderboard/ranked?page=${page}`;
    try {
      const res = await openFrontFetch(url);
      if (!res.ok) {
        if (res.status === 404) {
          console.log(`[ranked-sync] Page ${page}: 404, arrêt.`);
          break;
        }
        // C4: Graceful fallback on 401/403 (exemption token missing/invalid)
        if (res.status === 401 || res.status === 403) {
          console.warn(`[ranked-sync] ⚠️ HTTP ${res.status} — token d'exemption manquant ou invalide.`);
          console.warn(`[ranked-sync] Conservation du cache précédent (ranked.json non écrasé).`);
          // Try to load previous cached data
          try {
            const cached = JSON.parse(fs.readFileSync("ranked.json", "utf8"));
            if (cached && cached["1v1"] && cached["1v1"].length > 0) {
              console.log(`[ranked-sync] Cache précédent conservé: ${cached["1v1"].length} joueurs.`);
              return cached["1v1"];
            }
          } catch (e2) { /* no cache available */ }
          return allPlayers; // return whatever we have so far
        }
        console.warn(`[ranked-sync] HTTP ${res.status} à la page ${page}`);
        break;
      }
      const data = await res.json();
      const players = data["1v1"];
      if (!players || !Array.isArray(players) || players.length === 0) {
        console.log(`[ranked-sync] Plus de joueurs à la page ${page}`);
        break;
      }
      allPlayers.push(...players);
      console.log(
        `[ranked-sync] Page ${page}: ${players.length} joueurs (total: ${allPlayers.length})`
      );
      page++;
    } catch (e) {
      console.warn(`[ranked-sync] Erreur page ${page}:`, e.message);
      break;
    }
  }

  return allPlayers;
}

async function enrichStreaks(players) {
  // Calcule la série de victoires/défaites consécutives pour le top 20
  const topN = 20;
  const enriched = [...players];
  for (let i = 0; i < Math.min(topN, enriched.length); i++) {
    const p = enriched[i];
    if (!p.public_id) continue;
    try {
      const res = await openFrontFetch(`${API_BASE}/public/player/${encodeURIComponent(p.public_id)}`);
      if (!res.ok) {
        console.warn(`[ranked-sync] Streak fetch ${p.username}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const games = (data.games || [])
        .filter(g => g.rankedType === '1v1' || g.mode === '1v1' || g.type === 'Ranked')
        .sort((a, b) => new Date(b.start || b.end || 0) - new Date(a.start || a.end || 0));

      let streak = 0;
      for (const g of games) {
        if (g.hasWon === true) {
          if (streak >= 0) streak++;
          else break;
        } else if (g.hasWon === false) {
          if (streak <= 0) streak--;
          else break;
        } else {
          break; // unknown result
        }
      }
      enriched[i] = { ...p, streak };
      console.log(`[ranked-sync] Streak #${i + 1} ${p.username}: ${streak > 0 ? '🔥+' + streak : streak < 0 ? '❄️' + streak : '0'}`);
    } catch (e) {
      console.warn(`[ranked-sync] Streak erreur ${p.username}:`, e.message);
    }
  }
  return enriched;
}

function loadHistory() {
  try {
    const raw = fs.readFileSync("ranked_history.json", "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveHistory(history, players) {
  const now = Date.now();
  players.forEach(p => {
    if (!p.public_id) return;
    if (!history[p.public_id]) history[p.public_id] = [];
    history[p.public_id].push({ t: now, elo: p.elo, rank: p.rank });
    // Garder les derniers MAX_HISTORY_POINTS
    if (history[p.public_id].length > MAX_HISTORY_POINTS) {
      history[p.public_id] = history[p.public_id].slice(-MAX_HISTORY_POINTS);
    }
  });

  // Nettoyer les joueurs non vus depuis 7 jours
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  Object.keys(history).forEach(pid => {
    const arr = history[pid];
    if (!arr || arr.length === 0) { delete history[pid]; return; }
    const last = arr[arr.length - 1];
    if (last.t < weekAgo) delete history[pid];
  });

  const json = JSON.stringify(history);
  fs.writeFileSync("ranked_history.json", json);
  fs.writeFileSync("ranked_history.json.gz", zlib.gzipSync(json));
  console.log(`[ranked-sync] 📈 Historique sauvegardé: ${Object.keys(history).length} joueurs, ${(json.length / 1024).toFixed(0)} KB`);
}

function computeNewcomersAndDropouts(currentPlayers, previousPlayers) {
  const currentIds = new Set(currentPlayers.map(p => p.public_id));
  const previousIds = new Set(previousPlayers.map(p => p.public_id));
  const previousById = new Map(previousPlayers.map(p => [p.public_id, p]));

  const newcomers = currentPlayers
    .filter(p => !previousIds.has(p.public_id))
    .map(p => ({ rank: p.rank, username: p.username, public_id: p.public_id, elo: p.elo }));

  const dropouts = previousPlayers
    .filter(p => !currentIds.has(p.public_id))
    .map(p => ({ rank: p.rank, username: p.username, public_id: p.public_id, elo: p.elo }));

  return { newcomers, dropouts };
}

function saveWithMovement(players) {
  // Charger l'ancien classement pour calculer les mouvements
  let previousById = new Map();
  let previousPlayers = [];
  try {
    const oldRaw = fs.readFileSync("ranked.json", "utf8");
    const oldData = JSON.parse(oldRaw);
    previousPlayers = oldData["1v1"] || [];
    previousPlayers.forEach(p => {
      if (p.public_id) previousById.set(p.public_id, p.rank);
    });
    console.log(`[ranked-sync] 📊 Ancien classement chargé: ${previousPlayers.length} joueurs`);
  } catch (e) {
    console.log("[ranked-sync] ℹ️ Pas d'ancien classement, mouvements non calculés");
  }

  // Ajouter movement (ancien rang - nouveau rang)
  // > 0 = monté, < 0 = descendu, 0 = inchangé
  const enriched = players.map(p => {
    const prevRank = previousById.get(p.public_id);
    const movement = prevRank != null ? prevRank - p.rank : null;
    return { ...p, movement };
  });

  // Nouveaux arrivants / sortants (top 100 uniquement)
  const top100 = enriched.slice(0, 100);
  const prevTop100 = previousPlayers.slice(0, 100);
  const { newcomers, dropouts } = computeNewcomersAndDropouts(top100, prevTop100);
  if (newcomers.length) console.log(`[ranked-sync] 🆕 Nouveaux: ${newcomers.map(n => n.username).join(', ')}`);
  if (dropouts.length) console.log(`[ranked-sync] 📉 Sortants: ${dropouts.map(d => d.username).join(', ')}`);

  const payload = {
    "1v1": enriched,
    newcomers,
    dropouts,
    updatedAt: new Date().toISOString(),
    totalPlayers: enriched.length,
  };
  const json = JSON.stringify(payload);
  fs.writeFileSync("ranked.json", json);
  fs.writeFileSync("ranked.json.gz", zlib.gzipSync(json));
  
  const movements = enriched.filter(p => p.movement != null && p.movement !== 0).length;
  const streaks = enriched.filter(p => p.streak != null && p.streak !== 0).length;
  console.log(
    `[ranked-sync] 💾 ${enriched.length} joueurs sauvegardés — ` +
      `${(json.length / 1024).toFixed(0)} KB raw / ` +
      `${(zlib.gzipSync(json).length / 1024).toFixed(0)} KB gz ` +
      `(${movements} mouvements, ${streaks} streaks, ${newcomers.length}↑, ${dropouts.length}↓)`
  );

  return { newcomers, dropouts };
}

async function main() {
  console.log("[ranked-sync] 🚀 Démarrage du sync ranked...");
  if (hasExemption()) {
    console.log("[ranked-sync] 🔑 Exemption Skailex active");
  } else {
    console.warn(
      "[ranked-sync] ⚠️ Pas d'exemption — les rate limits peuvent s'appliquer"
    );
  }
  const players = await fetchLeaderboard();
  const playersWithStreaks = await enrichStreaks(players);
  const history = loadHistory();
  saveHistory(history, playersWithStreaks);
  saveWithMovement(playersWithStreaks);
  console.log("[ranked-sync] ✅ Terminé.");
}

main().catch((e) => {
  console.error("[ranked-sync] Fatal:", e);
  process.exit(1);
});
