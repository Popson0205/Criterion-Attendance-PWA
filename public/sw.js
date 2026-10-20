// Bump this string on every release you want phones to pick up immediately.
const CACHE = 'cac-attendance-v7';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './common.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the browser's HTTP cache so we never store stale files.
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.all(ASSETS.map(a => cache.add(new Request(a, { cache: 'reload' }))))
    )
  );
  self.skipWaiting(); // don't wait for old tabs to close
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const hadOldVersion = keys.some(k => k !== CACHE && k.startsWith('cac-attendance-'));
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))); // erase old cache
    await self.clients.claim();
    // An older version was installed on this phone: reload any open copy of the
    // app so the teacher sees the new screen right away, with no manual clearing.
    if (hadOldVersion) {
      const open = await self.clients.matchAll({ type: 'window' });
      open.forEach(c => { try { c.navigate(c.url); } catch (_) {} });
    }
  })());
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // API calls and the admin page are never cached.
  const isAdminAsset = ['/admin', '/admin/', '/admin.html', '/admin.js'].includes(url.pathname);
  if (url.pathname.startsWith('/api/') || isAdminAsset) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Network-first: always try for the newest file; fall back to the saved copy
  // only when the phone is offline or the server is unreachable.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const clone = res.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request).then(cached => cached || caches.match('./index.html')))
  );
});
