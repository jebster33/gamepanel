'use strict';

/**
 * Notification preferences and action buttons, monthly uptime reports and
 * extensions (themes, pages, widgets, hooks). See features/notify-prefs.js,
 * features/reports.js and features/extensions.js.
 */

const fs = require('fs');
const { fail, readBody } = require('../../core/util');
const { RateLimiter } = require('../../core/ratelimit');
const { clientIp } = require('../helpers');
const audit = require('../../features/audit');
const prefs = require('../../features/notify-prefs');
const quotas = require('../../features/quotas');

module.exports = (router, app, h) => {
  const { store, auth, manager } = app;
  const { requireAdmin, visibleServers } = h;
  const push = () => require('../../features/push').init(app);
  const extensions = () => require('../../features/extensions').init(app);
  const reports = () => require('../../features/reports').init(app);

  /* ------------------------------------------- notification preferences -- */

  const knownServers = (user) => visibleServers(user).map((s) => s.id);

  router.get('/api/notify-prefs', ({ user, url }) => {
    const endpoint = url.searchParams.get('endpoint') || '';
    const account = prefs.userPrefs(store, user.id) || { mutedCategories: [], mutedServers: [] };
    const device = endpoint ? push().devicePrefs(user, endpoint) : null;
    return {
      categories: prefs.CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
      servers: visibleServers(user).map((s) => ({ id: s.id, name: s.name })),
      // "device" when this phone or browser has its own list, else the account's.
      scope: device ? 'device' : 'account',
      prefs: device || account,
      account,
    };
  });

  router.put('/api/notify-prefs', ({ user, body }) => {
    const clean = prefs.sanitize(body, knownServers(user));
    const endpoint = String(body?.endpoint || '');
    if (endpoint) push().setDevicePrefs(user, endpoint, body?.reset ? undefined : clean);
    else prefs.saveUserPrefs(store, user.id, clean);
    return { ok: true, prefs: clean };
  });

  /* -------------------------------------------- notification action buttons -- */

  // Public on purpose: the browser's service worker calls it when a button on a
  // notification is tapped, possibly with no panel tab open. The one-time signed
  // token is the credential; a signed-in session, if present, must be the same account.
  const byIp = new RateLimiter({ limit: 30, windowMs: 60_000 });
  const byUser = new RateLimiter({ limit: 10, windowMs: 60_000 });
  router.post(
    '/api/notify-actions/run',
    async ({ req, body }) => {
      const ip = clientIp(req);
      if (!byIp.take(ip)) fail(429, 'Too many requests. Try again in a minute.');
      const claim = prefs.tokens.consume(body?.token);
      if (!claim) fail(403, 'That button has expired or was already used. Open the panel instead.');
      if (!byUser.take(claim.userId)) fail(429, 'Too many actions from this account. Try again in a minute.');
      const user = auth.users.find((u) => u.id === claim.userId);
      const session = auth.userFromRequest(req);
      if (!user || (session && session.id !== user.id)) fail(403, 'That button belongs to another account');
      const server = manager.servers.find((s) => s.id === claim.serverId);
      const record = (status, error) => audit.record({ user: user.username, ip, action: `notification action (${claim.action})`, path: '/api/notify-actions/run', serverId: claim.serverId, server: server?.name, status, error, via: 'notification' });
      try {
        // Permissions are checked now, not when the notification was made.
        if (!server || !auth.canAccessServer(user, server.id)) fail(403, 'You no longer have access to this server');
        if (!auth.can(user, 'power', server.id)) fail(403, 'Your account is not allowed to start or stop this server');
        if (claim.action === 'restart') await manager.restart(server.id);
        else if (claim.action === 'start') {
          quotas.checkDisk(manager, server, store.state.users);
          await manager.start(server.id);
        } else fail(400, 'Unknown action');
      } catch (err) {
        record(typeof err.code === 'number' ? err.code : 500, err.message);
        throw err;
      }
      record(200);
      return { ok: true, message: `${claim.action === 'restart' ? 'Restarting' : 'Starting'} ${server.name}` };
    },
    { public: true }
  );

  /* ------------------------------------------------------------- reports -- */

  router.get('/api/reports', ({ user }) => {
    requireAdmin(user);
    const r = reports();
    return { reports: r.list(), auto: Boolean(r.settings.auto), servers: manager.servers.map((s) => ({ id: s.id, name: s.name })) };
  });

  router.put('/api/reports/settings', ({ user, body }) => {
    requireAdmin(user);
    reports().settings.auto = Boolean(body?.auto);
    store.save();
    return { ok: true, auto: reports().settings.auto };
  });

  router.post('/api/reports/generate', ({ user, body }) => {
    requireAdmin(user);
    const data = reports().save(body?.month);
    return { ok: true, month: data.period.key, reports: reports().list() };
  });

  // The PDF itself, made on request (a month, optionally one server).
  router.get(
    '/api/reports/uptime.pdf',
    ({ user, url, res }) => {
      requireAdmin(user);
      const { buffer, data } = reports().pdf(url.searchParams.get('month'), url.searchParams.get('server') || undefined);
      const name = `uptime-${data.period.key}${url.searchParams.get('server') ? `-${String(url.searchParams.get('server')).replace(/[^A-Za-z0-9_-]/g, '')}` : ''}.pdf`;
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buffer.length, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
      res.end(buffer);
      return undefined;
    },
    { raw: true }
  );

  router.get(
    '/api/reports/file/:name',
    ({ user, params, res }) => {
      requireAdmin(user);
      const file = reports().file(params.name);
      if (!file) fail(404, 'No such report');
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': data.length, 'Content-Disposition': `attachment; filename="${params.name}"`, 'Cache-Control': 'no-store' });
      res.end(data);
      return undefined;
    },
    { raw: true }
  );

  /* ---------------------------------------------------------- extensions -- */

  // Everything an account can use: themes to pick, pages for the sidebar, widgets, and its own theme.
  router.get('/api/extensions/active', ({ user }) => {
    const ext = extensions();
    const view = ext.publicView(user);
    const chosen = store.state.userPrefs?.[user.id]?.theme || '';
    return { ...view, selected: view.themes.some((t) => t.id === chosen) ? chosen : '', current: chosen ? ext.theme(chosen) : null };
  });

  router.put('/api/account/theme', ({ user, body }) => {
    const id = String(body?.theme || '');
    if (id && !extensions().theme(id)) fail(400, 'That theme is not installed or is turned off');
    const all = (store.state.userPrefs ||= {});
    all[user.id] = { ...(all[user.id] || {}), theme: id };
    store.save();
    return { ok: true, theme: id, current: id ? extensions().theme(id) : null };
  });

  router.get('/api/extensions', ({ user }) => {
    requireAdmin(user);
    const ext = extensions();
    return { extensions: ext.list(), allowCode: Boolean(ext.settings.allowCode) };
  });

  router.put('/api/extensions/settings', ({ user, body }) => {
    requireAdmin(user);
    extensions().setAllowCode(body?.allowCode);
    return { ok: true, allowCode: Boolean(extensions().settings.allowCode) };
  });

  router.put('/api/extensions/:name', ({ user, params, body }) => {
    requireAdmin(user);
    extensions().setEnabled(params.name, Boolean(body?.enabled));
    return { extensions: extensions().list() };
  });

  router.delete('/api/extensions/:name', ({ user, params }) => {
    requireAdmin(user);
    extensions().remove(params.name);
    return { extensions: extensions().list() };
  });

  router.post('/api/extensions/install-url', async ({ user, body }) => {
    requireAdmin(user);
    const manifest = await extensions().installUrl(body?.url);
    return { ok: true, installed: manifest.name, extensions: extensions().list() };
  });

  router.post(
    '/api/extensions/install-zip',
    async ({ user, req }) => {
      requireAdmin(user);
      const manifest = extensions().installZip(await readBody(req, 21 * 1024 * 1024));
      audit.record({ user: user.username, ip: clientIp(req), action: `install extension ${manifest.name}`, path: '/api/extensions/install-zip', status: 200 });
      return { ok: true, installed: manifest.name, extensions: extensions().list() };
    },
    { rawBody: true }
  );
};
