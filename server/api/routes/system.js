'use strict';

const { json, fail, clamp } = require('../../core/util');
const { config } = require('../../core/config');
const { describeHost, HOST_PLATFORM } = require('../../core/platform');
const updater = require('../../features/updater');
const { EVENT_CHOICES } = require('../../features/notify');
const VERSION = require('../../../package.json').version;

module.exports = (router, { store, auth, manager, hostMetrics, notifier }, { requireAdmin, requireCap }) => {
  router.get('/api/system', ({ user }) => ({
    host: hostMetrics.last,
    overview: manager.overview(),
    version: VERSION,
    platform: HOST_PLATFORM,
    os: describeHost(),
    docker: { available: manager.dockerAvailable },
    isAdmin: user.role === 'admin',
    dataDir: user.role === 'admin' ? config.dataDir : undefined,
  }));

  router.get('/api/events', ({ user, url }) => {
    requireCap(user, 'activity');
    const limit = clamp(url.searchParams.get('limit') || 100, 1, 500);
    const all = store.state.events;
    const visible = user.role === 'admin' ? all : all.filter((e) => !e.serverId || auth.canAccessServer(user, e.serverId));
    return { events: visible.slice(0, limit) };
  });

  /** What a fresh panel still needs, shown as a checklist on the dashboard. */
  router.get('/api/system/checklist', ({ user }) => {
    requireAdmin(user);
    const s = store.state.settings;
    const servers = manager.servers;
    return {
      items: [
        { id: 'server', label: 'Create your first server', done: servers.length > 0, link: '#/deploy' },
        { id: 'online', label: 'Start a server and see it come online', done: servers.some((x) => manager.isActive(x.id) || x.lastExit), link: '#/' },
        { id: 'ports', label: 'Open its ports so friends can join', done: store.state.events.some((e) => e.type === 'network.opened'), link: servers[0] ? `#/servers/${servers[0].id}/network` : '#/' },
        { id: 'backup', label: 'Schedule a backup', done: servers.some((x) => (x.schedules || []).some((sc) => sc.action === 'backup')), link: servers[0] ? `#/servers/${servers[0].id}/schedules` : '#/' },
        { id: 'alerts', label: 'Get crash alerts on Discord', done: Boolean(s.notifications?.discordWebhook), link: '#/settings/notifications' },
      ],
      dismissed: Boolean(s.checklistDismissed),
    };
  });

  /* ------------------------------------------------------------ updates -- */

  router.get('/api/system/update', async ({ user }) => {
    requireAdmin(user);
    return updater.checkForUpdate();
  });

  router.post(
    '/api/system/update',
    async ({ user, res }) => {
      requireAdmin(user);
      const lines = [];
      const result = await updater.applyUpdate({ onLog: (line) => lines.push(line) });
      store.addEvent('panel.updated', `Panel updated ${result.from} → ${result.to} by ${user.username}`);
      // Reply first, then restart. Containerised servers keep running.
      json(res, 200, { ok: true, ...result, log: lines, restarting: true });
      updater.scheduleRestart();
      return undefined;
    },
    { raw: true }
  );

  router.get('/api/system/runtime', async ({ user }) => {
    requireAdmin(user);
    return {
      platform: HOST_PLATFORM,
      docker: { available: manager.dockerAvailable, info: manager.dockerInfo, socket: config.dockerSocket },
      containerize: store.state.settings.containerize !== false,
      servers: manager.servers.map((s) => ({ id: s.id, name: s.name, platform: s.platform, runtime: manager.runtimeFor(s) })),
    };
  });

  /* ----------------------------------------------------------- settings -- */

  router.get('/api/settings', ({ user }) => {
    requireAdmin(user);
    return { settings: store.state.settings, notificationEvents: EVENT_CHOICES };
  });

  router.patch('/api/settings', ({ user, body }) => {
    requireAdmin(user);
    const s = store.state.settings;
    if (body.panelName) s.panelName = String(body.panelName).slice(0, 40);
    if (body.portRangeStart) s.portRangeStart = clamp(body.portRangeStart, 1024, 65535);
    if (body.portRangeEnd) s.portRangeEnd = clamp(body.portRangeEnd, 1024, 65535);
    if (s.portRangeEnd < s.portRangeStart) fail(400, 'The port range ends before it starts');
    if (body.autoRestart !== undefined) s.autoRestart = Boolean(body.autoRestart);
    if (body.maxCrashRestarts !== undefined) s.maxCrashRestarts = clamp(body.maxCrashRestarts, 0, 100);
    if (body.containerize !== undefined) s.containerize = Boolean(body.containerize);
    if (body.geoLookup !== undefined) s.geoLookup = Boolean(body.geoLookup);
    if (body.checklistDismissed !== undefined) s.checklistDismissed = Boolean(body.checklistDismissed);
    if (body.notifications) {
      const n = { ...(s.notifications || {}) };
      if (body.notifications.discordWebhook !== undefined) {
        const url = String(body.notifications.discordWebhook).trim();
        if (url && !/^https:\/\//.test(url)) fail(400, 'The webhook must start with https://');
        n.discordWebhook = url;
      }
      if (Array.isArray(body.notifications.events)) n.events = body.notifications.events.filter((e) => EVENT_CHOICES.includes(e));
      s.notifications = n;
    }
    if (body.integrations) {
      s.integrations = { ...(s.integrations || {}) };
      const { curseforgeKey, steamApiKey, factorio } = body.integrations;
      if (curseforgeKey !== undefined) s.integrations.curseforgeKey = String(curseforgeKey).trim();
      if (steamApiKey !== undefined) s.integrations.steamApiKey = String(steamApiKey).trim();
      if (factorio !== undefined) {
        s.integrations.factorio = { username: String(factorio.username || '').trim(), token: String(factorio.token || '').trim() };
      }
    }
    store.save();
    return { settings: s };
  });

  router.post('/api/settings/notifications/test', async ({ user, body }) => {
    requireAdmin(user);
    try {
      return await notifier.test(body.discordWebhook);
    } catch (err) {
      return fail(400, `Discord did not accept the message: ${err.message}`);
    }
  });
};
