// Cache the shell so the app opens on a bad connection. API calls always go to the network.
const CACHE = 'fieldops-operator-v1';
const SHELL = [
  './', './index.html', './app.html', './css/app.css', './js/api.js', './manifest.json',
  './icon-192.png', './icon-512.png',
  './fonts/archivo-latin-600-normal.woff2', './fonts/archivo-latin-700-normal.woff2',
  './fonts/ibm-plex-sans-latin-400-normal.woff2', './fonts/ibm-plex-sans-latin-500-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match('./index.html'))),
  );
});
