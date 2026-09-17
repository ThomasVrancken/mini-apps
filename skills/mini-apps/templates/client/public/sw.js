// Minimal service worker: offline app shell + last-seen data.
// No precache manifest (Vite's hashed filenames aren't known ahead of time):
// everything is cached opportunistically as it's fetched.
// Bump CACHE_NAME if a bad shell ever got cached.

const CACHE_NAME = 'SERVICE_NAME-v1';
const API_CACHE = 'SERVICE_NAME-api-v1'; // must match API_CACHE_NAME in src/services/api.js

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME && key !== API_CACHE).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never cache mutating calls

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave third-party requests alone

  // API reads: network-first, keep the last good response for offline use.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(API_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Navigations (index.html) MUST be network-first: index.html references the
  // current build's hashed JS/CSS filenames, which change on every deploy.
  // Cache-first here strands returning users on a shell pointing at assets
  // that no longer exist. Falls back to the cache only when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Hashed static assets (JS/CSS/icons): cache-first is safe, a changed file
  // always gets a new filename.
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
