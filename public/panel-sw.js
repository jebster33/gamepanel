/*
 * The panel's service worker: lets desktop browsers show notifications (with
 * Restart / Start / Open console buttons) even when no panel tab is open.
 * It caches nothing and never touches page requests.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  const actions = (Array.isArray(data.actions) ? data.actions : []).slice(0, 2).map((a) => ({ action: String(a.action), title: String(a.title) }));
  event.waitUntil(
    self.registration.showNotification(data.title || 'GamePanel', {
      body: data.body || '',
      icon: '/img/logo-192.png',
      badge: '/img/favicon-64.png',
      tag: data.tag,
      actions,
      data: { url: data.url || '/', consoleUrl: data.consoleUrl, tokens: data.tokens || {} },
    })
  );
});

async function openUrl(url) {
  const target = new URL(url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return undefined;
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = list.find((c) => new URL(c.url).origin === target.origin);
  if (open) {
    await open.navigate(target.href).catch(() => {});
    return open.focus();
  }
  return self.clients.openWindow(target.href);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, consoleUrl, tokens } = event.notification.data || {};
  const action = event.action;
  if (action && tokens && tokens[action]) {
    event.waitUntil(
      fetch('/api/notify-actions/run', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tokens[action] }) })
        .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
        .then(({ ok, body }) => self.registration.showNotification(ok ? 'Done' : 'That did not work', { body: ok ? body.message : body.error || 'Open the panel to do it.', icon: '/img/logo-192.png', tag: 'gp-action-result' }))
        .catch(() => self.registration.showNotification('That did not work', { body: 'The panel could not be reached.', icon: '/img/logo-192.png', tag: 'gp-action-result' }))
    );
    return;
  }
  event.waitUntil(openUrl(action === 'console' ? consoleUrl || url : url));
});
