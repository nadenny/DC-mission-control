/* DC Mission Control — service worker
   HTML is NEVER cached: a stale page shell was the single worst failure mode
   on the phone. Only static assets get cached. */
const CACHE_VERSION = 'dc-mc-v38';
const ASSETS = ['./manifest.json','./icon-192.png','./icon-512.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => c.addAll(ASSETS).catch(()=>{}))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Escape hatch: ?nosw bypasses the worker entirely
  if (url.search.includes('nosw')) return;

  const isHTML = e.request.mode === 'navigate'
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('/');

  if (isHTML) {
    // Network first, always. Cache is only a last resort when offline.
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request).then(r => r || new Response(
        '<h1>Offline</h1><p>Reconnect and reload.</p>',
        { headers: { 'Content-Type': 'text/html' } }
      )))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(e.request, copy)).catch(()=>{});
        return res;
      });
    })
  );
});
