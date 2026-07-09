/* ════════════════════════════════════════════════════════════
   Focus — Service Worker (offline support)
   Strategy:
   • App shell (index.html, app.js, style.css): NETWORK-FIRST.
     Online loads always fetch fresh code from GitHub Pages, then
     update the cache. Offline loads fall back to the cached copy.
     → Deploys are never stuck behind the SW cache.
   • Google Fonts (CSS + font files): CACHE-FIRST (they never change).
   • Everything else (Google Calendar API, OAuth, etc.): passed
     straight through to the network — never cached.
   ════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'focus-v1';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const FONT_CACHE    = `${CACHE_VERSION}-fonts`;

/* Files that make up the app shell. './' covers the GitHub Pages
   directory URL (https://homiejhan.github.io/worky/). */
const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icon-180.png',
  './icon-512.png',
];

/* ── Install: pre-cache the shell so offline works after first load ── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate: clean up caches from older versions ── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch routing ── */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET requests; POST/DELETE etc. (Google Calendar
  // writes) always go straight to the network.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Google Fonts → cache-first
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // Same-origin app shell (including navigations) → network-first
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  // Anything else (Google Calendar API, accounts.google.com, …)
  // → default browser behavior, no caching.
});

/* Network-first: try the network, update cache on success,
   fall back to cache when offline. */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // Navigation fallback: serve the cached shell for any page request
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

/* Cache-first: serve from cache, fetch & store on first miss. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    // Offline and not cached — let the request fail gracefully.
    // The app still works; fonts just fall back to system fonts.
    throw err;
  }
}
