/* DC Mission Control — service worker
   HTML is ALWAYS fetched fresh from the network. Only static assets are cached.
   This makes a stale or blank page impossible, while still working offline. */
const CACHE_VERSION = 'dc-mc-v19';

// Only truly static things get pre-cached. No HTML here, on purpose.
const ASSETS = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
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

  // Never intercept API / auth traffic
  if (url.hostname.includes('anthropic.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('google.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('firebaseio.com')) {
    return;
  }

  const isHTML = e.request.mode === 'navigate' ||
                 url.pathname.endsWith('.html') ||
                 (e.request.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // ALWAYS network for pages. Cache is a last resort for genuine offline,
    // and only a verified-good copy is ever stored.
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => {
          if (res && res.ok && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(e.request, copy)).catch(()=>{});
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(hit =>
          hit || new Response(
            '<!doctype html><meta charset="utf-8">' +
            '<body style="font-family:system-ui;background:#080C14;color:#E8EDF5;padding:2rem;line-height:1.6">' +
            '<h2 style="color:#F5C842">Offline</h2>' +
            '<p>No connection, and no saved copy of this page yet.</p>' +
            '<p><a href="./dc_mission_control.html" style="color:#2DD4BF">Try again</a></p></body>',
            { headers: { 'Content-Type': 'text/html' } }
          )
        ))
    );
    return;
  }

  // Static assets: serve from cache, refresh in the background
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res && res.ok && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(e.request, copy)).catch(()=>{});
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

self.addEventListener('message', e => {
  if (e.data === 'KILL') {
    self.registration.unregister()
      .then(() => caches.keys())
      .then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});
