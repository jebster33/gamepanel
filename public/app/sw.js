/*
 * Keeps the app shell available when the connection drops for a moment.
 * Network first, so a panel update shows up on the next launch; the API and
 * the WebSocket are never cached.
 */
const CACHE = 'gp-app-v6';
const SHELL = ['/app/', '/app/app.css', '/app/app.js', '/img/logo-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/app/')))
  );
});

/* Push notifications from the panel (crashes, failed backups…). */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'GamePanel', {
      body: data.body || '',
      icon: '/img/logo-192.png',
      badge: '/img/favicon-64.png',
      tag: data.tag,
      // Buttons (Restart, Start…) where the phone shows them; iOS only shows them on a long press.
      actions: (Array.isArray(data.actions) ? data.actions : []).slice(0, 2).map((a) => ({ action: String(a.action), title: String(a.title) })),
      data: { url: data.url || '/app/', consoleUrl: data.consoleUrl, tokens: data.tokens || {} },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { tokens, consoleUrl } = event.notification.data || {};
  const action = event.action;
  if (action && tokens && tokens[action]) {
    event.waitUntil(
      fetch('/api/notify-actions/run', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tokens[action] }) })
        .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
        .then(({ ok, body }) => self.registration.showNotification(ok ? 'Done' : 'That did not work', { body: ok ? body.message : body.error || 'Open the app to do it.', icon: '/img/logo-192.png', tag: 'gp-action-result' }))
        .catch(() => self.registration.showNotification('That did not work', { body: 'The panel could not be reached.', icon: '/img/logo-192.png', tag: 'gp-action-result' }))
    );
    return;
  }
  const url = (action === 'console' && consoleUrl) || event.notification.data?.url || '/app/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.includes('/app'));
      if (open) {
        open.postMessage({ type: 'open', url });
        return open.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
