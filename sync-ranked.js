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

function saveWithMovement(players) {
  // Charger l'ancien classement pour calculer les mouvements
  let previousById = new Map();
  try {
    const oldRaw = fs.readFileSync("ranked.json", "utf8");
    const oldData = JSON.parse(oldRaw);
    const oldPlayers = oldData["1v1"] || [];
    oldPlayers.forEach(p => {
      if (p.public_id) previousById.set(p.public_id, p.rank);
    });
    console.log(`[ranked-sync] 📊 Ancien classement chargé: ${oldPlayers.length} joueurs`);
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

  const payload = {
    "1v1": enriched,
    updatedAt: new Date().toISOString(),
    totalPlayers: enriched.length,
  };
  const json = JSON.stringify(payload);
  fs.writeFileSync("ranked.json", json);
  fs.writeFileSync("ranked.json.gz", zlib.gzipSync(json));
  
  const movements = enriched.filter(p => p.movement != null && p.movement !== 0).length;
  console.log(
    `[ranked-sync] 💾 ${enriched.length} joueurs sauvegardés — ` +
      `${(json.length / 1024).toFixed(0)} KB raw / ` +
      `${(zlib.gzipSync(json).length / 1024).toFixed(0)} KB gz ` +
      `(${movements} mouvements détectés)`
  );
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
  saveWithMovement(players);
  console.log("[ranked-sync] ✅ Terminé.");
}

main().catch((e) => {
  console.error("[ranked-sync] Fatal:", e);
  process.exit(1);
});
