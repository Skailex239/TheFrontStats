/**
 * Appels API OpenFront côté navigateur.
 *
 * En dev local  : proxy via /api/openfront/ (server.js)
 * En production : proxy CORS (corsproxy.io) pour contourner les restrictions
 *                 CORS de l'API OpenFront (qui n'autorise que openfront.io).
 *
 * Alternative propre : déployer server.js sur Render/Railway et pointer
 * OPENFRONT_API_PROXY vers cette URL.
 */

import { parseSessionsPayload, normalizeSession } from "./openfront-parse.js";

export { parseSessionsPayload, normalizeSession };

export const API_BASE = "https://api.openfront.io";

/**
 * URL d'un proxy CORS pour la production.
 * Peut être surchargé via window.OPENFRONT_API_PROXY ou un <meta> tag.
 *
 * Options :
 *   - "corsproxy"  → utilise https://corsproxy.io/ (gratuit, fiable)
 *   - URL complète → proxy custom (ex: https://my-api.render.com/api/openfront)
 *   - null/false   → désactivé (fetch direct, ne marche que si CORS le permet)
 */
const CORS_PROXY_META = typeof document !== "undefined"
  ? document.querySelector('meta[name="openfront-api-proxy"]')?.content
  : null;

const CORS_PROXY_GLOBAL = typeof window !== "undefined"
  ? window.OPENFRONT_API_PROXY
  : null;

const CORS_PROXY_CONFIG = CORS_PROXY_META || CORS_PROXY_GLOBAL || "corsproxy";

/**
 * Résout l'URL complète pour un appel API OpenFront.
 * En dev : proxy local via server.js (/api/openfront/...)
 * En prod : proxy CORS ou URL custom
 */
export function resolveOpenFrontFetchUrl(apiPath) {
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;

  if (typeof location !== "undefined") {
    const host = location.hostname;
    // Dev local → proxy server.js
    if (host === "localhost" || host === "127.0.0.1") {
      return `/api/openfront${path}`;
    }
  }

  // Production → CORS proxy
  if (CORS_PROXY_CONFIG === "corsproxy") {
    return `https://corsproxy.io/?url=${encodeURIComponent(API_BASE + path)}`;
  }

  // URL de proxy custom (ex: backend déployé sur Render/Railway)
  if (CORS_PROXY_CONFIG && CORS_PROXY_CONFIG !== "false" && CORS_PROXY_CONFIG.startsWith("http")) {
    return `${CORS_PROXY_CONFIG}${path}`;
  }

  // Aucun proxy configuré → fetch direct (sera bloqué par CORS sauf si on est sur openfront.io)
  return API_BASE + path;
}

/**
 * Fetch générique vers l'API OpenFront, avec gestion CORS proxy.
 * Retries with fallback CORS proxy if the primary one fails.
 */
export async function fetchOpenFront(apiPath, retries = 2) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const url = resolveOpenFrontFetchUrl(apiPath);
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 120)}` : ""}`);
      }
      return r.json();
    } catch (e) {
      lastError = e;
      // If on first attempt and using corsproxy, try allorigins as fallback
      if (attempt === 0 && CORS_PROXY_CONFIG === "corsproxy") {
        const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
        const fallbackUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(API_BASE + path)}`;
        try {
          const r = await fetch(fallbackUrl, { cache: "no-store" });
          if (r.ok) return r.json();
        } catch (fallbackErr) {
          // Fallback also failed, continue to next retry
        }
      }
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}
