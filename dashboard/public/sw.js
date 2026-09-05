// v6: purge runtime-cached bundles from older builds. Combined with the
// heuristically-cached app shell (index.html had no Cache-Control header),
// stale runtime entries could pin an old bundle — and old dashboard numbers
// (e.g. the YouTube subscriber count) — on an installed PWA for days.
// v8: brief.html gained link + dismiss action buttons (storm course-change nudge).
const CACHE_NAME = 'still-afloat-editorial-v8';

// App shell to cache on install. MUST only contain basic-auth-EXEMPT paths:
// caching '/' + '/index.html' (behind the dashboard basic-auth) made every SW
// install fire 401s and pop the iOS sign-in dialog over the brief (recurring —
// the SW reinstalls on every update). brief.html is the only shell we need.
const APP_SHELL = [
  '/brief.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Remove old caches
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls — always go to network
  if (url.pathname.startsWith('/api/')) return;

  // v7: only intercept navigations to the basic-auth-EXEMPT brief page (for its
  // offline fallback + freshness). Auth-gated pages must navigate NATIVELY: a
  // 401 on a SW-mediated fetch never triggers the browser's sign-in dialog, so
  // an expired basic-auth session left the whole dashboard stuck on nginx's raw
  // 401 page with no way to log in. index.html freshness is now handled
  // server-side (nginx sends Cache-Control: no-cache on the app shell).
  if (event.request.mode === 'navigate') {
    if (url.pathname === '/brief.html') {
      event.respondWith(
        fetch(event.request.url, { cache: 'no-store', credentials: 'include' }).catch(() =>
          caches.match('/brief.html')
        )
      );
    }
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      });
    })
  );
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
