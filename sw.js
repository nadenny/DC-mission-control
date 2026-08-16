/* DC Mission Control — service worker
   Bump CACHE_VERSION whenever you update any tool file. */
const CACHE_VERSION = 'dc-mc-v2';

const ASSETS = [
  './dc_mission_control.html',
  './semester_startup_checklist.html',
  './email_template_library.html',
  './meeting_tool.html',
  './concern_log.html',
  './sheet_builder.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

// Install — pre-cache the app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

// Activate — drop old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch — network first for our own pages (so updates land),
// cache fallback when offline. Never intercept API calls.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Let API + auth traffic pass straight through
  if (url.hostname.includes('anthropic.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('google.com')) {
    return;
  }

  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Stash a fresh copy for offline use
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(e.request, copy)).catch(()=>{});
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(hit =>
          hit || caches.match('./dc_mission_control.html')
        )
      )
  );
});
