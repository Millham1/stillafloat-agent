// This worker does two jobs: Web Push (below) and an offline copy of the
// auth-exempt brief page. It deliberately caches NOTHING else.
//
// v11 (2026-10-19): the dashboard opened blank after a deploy. The old worker
// answered every non-navigation request cache-first and cache-put every 200
// answer, so a hashed bundle name that one deploy served (or that a stale shell
// asked for before it existed, answered with the SPA fallback page) stayed in
// the cache and was handed back to later pages. Hashed build files are
// content-addressed and nginx already sends them "immutable", so the browser's
// own HTTP cache is the right place for them. The worker now leaves every
// request except the brief page alone, and deletes every cache but its own on
// activate, so each installed copy sheds what v10 and older left behind.
//
// History kept from earlier versions:
// v6: purge runtime-cached bundles from older builds (stale bundle pinned old
//     dashboard numbers on an installed PWA for days).
// v7: auth-gated pages navigate NATIVELY. A 401 on a SW-mediated fetch never
//     triggers the browser's sign-in dialog, so an expired basic-auth session
//     left the dashboard stuck on nginx's raw 401 page. That is also why this
//     worker never answers a dashboard navigation: it cannot serve a cached
//     index.html when the network answered, because it never touches it.
// v9: brief.html link buttons resolve the dashboard root per host.
// v10: brief.html validates a token before saving it, keeps it on a 401, and
//      accepts #token= links.
const CACHE_NAME = 'still-afloat-brief-v11';

// MUST only contain basic-auth-EXEMPT paths: caching '/' + '/index.html' (behind
// the dashboard basic-auth) made every SW install fire 401s and pop the iOS
// sign-in dialog over the brief (recurring — the SW reinstalls on every update).
const BRIEF_URL = '/brief.html';

self.addEventListener('install', (event) => {
  // A missing brief page (the dev box serves it elsewhere) must not fail the
  // install: push still has to work.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.add(new Request(BRIEF_URL, { cache: 'reload' })))
      .catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Remove every cache that is not this build's, then take over open tabs so a
  // deploy never leaves a page under an older worker.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Only the brief page is answered here: network first (never the HTTP cache),
  // the stored copy only when the network fails. Everything else — API calls,
  // dashboard navigations, hashed bundles, images, fonts — goes straight to the
  // network / the browser's HTTP cache, untouched.
  if (req.mode === 'navigate' && url.pathname === BRIEF_URL) {
    event.respondWith(
      fetch(req.url, { cache: 'no-store', credentials: 'include' })
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(BRIEF_URL, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => caches.match(BRIEF_URL).then((cached) => cached || Response.error()))
    );
  }
});

// ── Web Push ───────────────────────────────────────────────────────────────
// In-house notifications: the server signs an encrypted payload with its VAPID
// key and the push transport relays it here. No Telegram, no third-party service.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_e) { data = {}; }
  const title = data.title || 'Still Afloat';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || '/brief.html' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping a notification focuses an open dashboard tab (or opens one) at the URL.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/brief.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client) { try { client.navigate(target); } catch (_e) {} }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});
