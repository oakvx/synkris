// Enhanced Service Worker (stale-while-revalidate + update messaging)
const CACHE = 'velto-cache-v2';
const CORE = ['/', 'dashboard.html', 'worker.js', 'sw.js'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try { await cache.addAll(CORE); } catch(e) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if(event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    // Network-first for navigation
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        return cached || caches.match('/dashboard.html') || Response.error();
      }
    })());
    return;
  }
  if (url.origin === self.location.origin && /\.(?:js|css|html)$/.test(url.pathname)) {
    // Stale-while-revalidate for static assets
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const fetchPromise = fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy));
        return res;
      }).catch(_ => cached);
      return cached || fetchPromise;
    })());
    return;
  }
  // Default: passthrough
  // (Add CacheFirst for images or libs if needed)
});