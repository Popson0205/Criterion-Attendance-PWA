const CACHE = 'cac-attendance-v5';
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
  e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Never cache API calls or the admin page/script — admin needs to
  // always be current, and doesn't need offline support anyway. This
  // matters even though admin.html never registers the service worker
  // itself: once it's registered from the staff page, it controls every
  // path on this origin, /admin included.
  const isAdminAsset = ['/admin', '/admin/', '/admin.html', '/admin.js'].includes(url.pathname);
  if (url.pathname.startsWith('/api/') || isAdminAsset) {
    e.respondWith(fetch(e.request));
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
