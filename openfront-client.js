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

  // fetchWithTimeout: AbortController-based timeout to prevent hanging on unresponsive proxies
  const fetchWithTimeout = async (url, ms = 6000) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      return r;
    } finally {
      clearTimeout(timer);
    }
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const url = resolveOpenFrontFetchUrl(apiPath);
      const r = await fetchWithTimeout(url);
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 120)}` : ""}`);
      }
      return r.json();
    } catch (e) {
      lastError = e;
      // Try fallback CORS proxies (helps with large responses >1MB)
      // Only try fallbacks on first attempt to avoid compounding timeouts
      if (attempt === 0 && CORS_PROXY_CONFIG === "corsproxy") {
        const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
        const encodedUrl = encodeURIComponent(API_BASE + path);
        const fallbacks = [
          `https://api.codetabs.com/v1/proxy/?quest=${encodedUrl}`,
          `https://api.allorigins.win/raw?url=${encodedUrl}`,
        ];
        for (const fallbackUrl of fallbacks) {
          try {
            const r = await fetchWithTimeout(fallbackUrl, 8000);
            if (r.ok) {
              const text = await r.text();
              try { return JSON.parse(text); } catch { /* not JSON */ }
            }
          } catch (fallbackErr) {
            // continue to next fallback (timeout or network error)
          }
        }
      }
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}
