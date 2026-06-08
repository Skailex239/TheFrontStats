// sw.js — Service Worker for TheFrontStats offline support
const CACHE_NAME = 'thefrontstats-v2';
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Static assets to cache on install
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/runs.html',
  '/profile.html',
  '/styles.css',
  '/auth.css',
  '/profile.css',
  '/animations.css',
  '/app.js',
  '/auth.js',
  '/runs.js',
  '/profile.js',
  '/i18n.js',
  '/animations.js',
  '/openfront-client.js',
  '/openfront-parse.js',
  '/toast.js',
  '/toast.css',
  '/shared/maps.js',
  '/shared/firebase-config.js',
  '/favicon.ico',
  // Optimized public data files (small, cacheable)
  '/runs_public.json.gz',
  '/runs_compact_public.json.gz',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Failed to cache some assets:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first for API/data, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip Firebase and CORS proxy requests
  if (url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('corsproxy.io') ||
      url.hostname.includes('allorigins.win') ||
      url.hostname.includes('openfront.io')) {
    return;
  }

  // For data files (runs_public.json.gz, etc.): network-first with cache fallback
  if (url.pathname.endsWith('.json.gz') || url.pathname.endsWith('.json')) {
    // For public payload files, use shorter cache duration
    const isPublicPayload = url.pathname.includes('_public.');
    event.respondWith(
      fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => {
        return caches.match(event.request).then((cached) => {
          if (cached && isPublicPayload) {
            // Check if cache is stale for public payloads
            const cachedTime = new Date(cached.headers.get('date')).getTime();
            if (Date.now() - cachedTime > CACHE_DURATION) {
              // Return stale but log warning
              console.warn('[SW] Serving stale public payload from cache');
            }
          }
          return cached;
        });
      })
    );
    return;
  }

  // For static assets: cache-first, network fallback
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
