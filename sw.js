/* Offline app shell. Caches only the app's own code – never archive data (that lives in IndexedDB). */
const VERSION = 'lca-v6'; // v6: robust import (helper start check, slow-file copy, visible errors)
const SHELL = ['./', 'index.html', 'styles.css?v=6', 'app.js?v=6', 'shared.js?v=6', 'parsers.js?v=6', 'worker.js?v=6', 'vendor/zip.min.js?v=6', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/icon-maskable-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // network-first so updates arrive, cache fallback for offline
  // revalidate with the server (not the HTTP cache) so a new version is picked up right away
  const net = e.request.mode === 'navigate'
    ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(r => r.redirected ? fetch(e.request) : r)
    : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(net.then(r => { if (r.ok) { const cl = r.clone(); caches.open(VERSION).then(c => c.put(e.request, cl)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
