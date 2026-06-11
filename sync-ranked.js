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

function save(data) {
  const payload = {
    "1v1": data,
    updatedAt: new Date().toISOString(),
    totalPlayers: data.length,
  };
  const json = JSON.stringify(payload);
  fs.writeFileSync("ranked.json", json);
  fs.writeFileSync("ranked.json.gz", zlib.gzipSync(json));
  console.log(
    `[ranked-sync] 💾 ${data.length} joueurs sauvegardés — ` +
      `${(json.length / 1024).toFixed(0)} KB raw / ` +
      `${(zlib.gzipSync(json).length / 1024).toFixed(0)} KB gz`
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
  save(players);
  console.log("[ranked-sync] ✅ Terminé.");
}

main().catch((e) => {
  console.error("[ranked-sync] Fatal:", e);
  process.exit(1);
});
