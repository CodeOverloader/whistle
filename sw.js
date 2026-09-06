// ============================================================
// Whistle Service Worker
// ============================================================
// A service worker is a background script the browser runs even
// when the app isn't open. It intercepts network requests and can
// serve cached responses when you're offline. This one caches the
// app "shell" (HTML, icon, manifest) so the app loads instantly on
// return visits — even without network. Actual sheet data is cached
// separately in localStorage by the main app.
// ============================================================

const CACHE_NAME = 'whistle-shell-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
];

// Install: pre-cache the app shell so first offline load works.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches from previous versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//  - Google Sheets requests: always try network (never serve stale sheet data).
//    The main app handles offline fallback via its own localStorage cache.
//  - App shell files: network-first, cache fallback. This means updates ship
//    immediately when online, but old versions still work offline.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Skip caching for external data sources — let the app handle those.
  if (url.includes('docs.google.com') || url.includes('googleapis.com')) {
    return; // browser handles this request normally
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Successful fetch: update the cache with the fresh copy for next offline visit.
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
