import fs from "fs";

// Charger .env manuellement AVANT tout autre import
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

export const API_BASE = "https://api.openfront.io";

export const apiStats = { total: 0, ok: 0, rate429: 0, other: 0 };

export function resetApiStats() {
  apiStats.total = 0;
  apiStats.ok = 0;
  apiStats.rate429 = 0;
  apiStats.other = 0;
}

export function logApiStats(label = "API") {
  console.log(
    `[${label}] ${apiStats.total} requêtes — ${apiStats.ok} OK, ${apiStats.rate429}×429, ${apiStats.other} erreurs`
  );
}

/** Headers Skailex (auto-sync) — voir docs/API.md sur OpenFrontIO */
export function openFrontHeaders() {
  const headers = { "User-Agent": "skailex" };
  const token = process.env.OPENFRONT_SKAILEX_ACCESS;
  if (token) {
    headers["x-skailex-access"] = token;
  }
  return headers;
}

export function hasExemption() {
  return Boolean(process.env.OPENFRONT_SKAILEX_ACCESS);
}

export function warnIfNoExemption() {
  // Ne plus avertir lors de l'initialisation du module
  // L'avertissement sera fait dans sync.js après le chargement du .env
}

export async function openFrontFetch(url, options = {}) {
  apiStats.total++;
  const res = await fetch(url, {
    ...options,
    headers: { ...openFrontHeaders(), ...(options.headers || {}) },
  });
  if (res.status === 429) apiStats.rate429++;
  else if (res.ok) apiStats.ok++;
  else apiStats.other++;
  return res;
}
