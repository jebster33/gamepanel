'use strict';

const { fail, logger } = require('../../core/util');
const { rconCommand } = require('../../games/rcon');
const { query } = require('../../games/query');

module.exports = (router, { store, manager, scheduler }, { requireAdmin, requireCap, serverFor, visibleServers }) => {
  router.get('/api/servers', ({ user }) => ({ servers: visibleServers(user) }));

  router.post('/api/servers', async ({ user, body }) => {
    requireAdmin(user);
    const server = manager.create(body, user);
    // Installs can take many minutes: start it and let the console stream.
    manager.install(server.id).catch((err) => logger.error('Install error:', err.message));
    return { server: manager.publicServer(server) };
  });

  /** Bring an existing server folder under the panel instead of installing a new one. */
  router.post('/api/servers/import', async ({ user, body }) => {
    requireAdmin(user);
    const server = await manager.importExisting(body, user);
    return { server: manager.publicServer(server) };
  });

  router.get('/api/servers/:id', ({ user, params }) => {
    const server = serverFor(user, params.id);
    const template = manager.template(server);
    return { server: manager.publicServer(server), template: template ? { ...template, install: undefined, windows: undefined, linux: undefined } : null };
  });

  router.patch('/api/servers/:id', ({ user, params, body }) => {
    if (user.role !== 'admin') {
      serverFor(user, params.id, 'settings');
      // The start command runs in a shell on the host: administrators only.
      if (body.startCommand !== undefined) fail(403, 'Only administrators can change the start command');
    }
    return { server: manager.publicServer(manager.update(params.id, body)) };
  });

  router.delete('/api/servers/:id', async ({ user, params, url }) => {
    requireAdmin(user);
    await manager.remove(params.id, url.searchParams.get('keepFiles') !== '1');
    return { ok: true };
  });

  router.post('/api/servers/:id/power', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'power');
    switch (String(body.action || '').toLowerCase()) {
      case 'start':
        return { ok: true, server: await manager.start(server.id) };
      case 'stop':
        return manager.stop(server.id);
      case 'restart':
        return manager.restart(server.id);
      case 'kill':
        manager.killTree(server.id);
        return { ok: true };
      default:
        return fail(400, 'action must be one of: start, stop, restart, kill');
    }
  });

  router.post('/api/servers/:id/install', async ({ user, params, body }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    manager.install(server.id, { reinstall: Boolean(body.reinstall) }).catch((err) => logger.error('Install error:', err.message));
    return { ok: true, started: true };
  });

  /** Pull the latest game files (SteamCMD games) without touching configs or saves. */
  router.post('/api/servers/:id/update', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'power');
    manager.updateGame(server.id).catch((err) => manager.pushConsole(server, `Update failed: ${err.message}`, 'system'));
    return { ok: true, started: true };
  });

  router.get('/api/servers/:id/console', ({ user, params }) => {
    const server = serverFor(user, params.id, 'console');
    return { lines: manager.getConsole(server.id) };
  });

  /** The game's own config file as a form (Minecraft's server.properties and friends). */
  router.get('/api/servers/:id/game-settings', ({ user, params }) => {
    const server = serverFor(user, params.id, 'settings');
    return require('../../games/settings').readGameSettings(manager, server);
  });

  router.put('/api/servers/:id/game-settings', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    const result = require('../../games/settings').writeGameSettings(manager, server, body.values);
    if (result.changed) store.addEvent('server.settings', `${user.username} changed ${result.changed} game setting${result.changed === 1 ? '' : 's'} on ${server.name}`, { serverId: server.id });
    return { ...result, restartNeeded: manager.isActive(server.id) };
  });

  /** Kick or ban someone on the Players tab, through the game's own console command. */
  router.post('/api/servers/:id/players/action', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'command');
    const commands = require('../../games/players').playerCommands(manager.template(server));
    const template = commands[body.action];
    if (!template) fail(400, `This game has no ${String(body.action || 'such')} command the panel knows`);
    const name = String(body.name || '');
    // Only someone actually online, and nothing that could smuggle in a second command.
    if (!manager.rt(server.id).playerList.includes(name) || /["\r\n\x00-\x1f]/.test(name)) fail(400, 'That player is not online');
    const result = await manager.sendCommand(server.id, template.replace('{name}', name));
    store.addEvent(`player.${body.action}`, `${user.username} used ${body.action} on ${name} (${server.name})`, { serverId: server.id });
    manager.logActivity(server.id, { type: body.action, name, by: user.username });
    return result;
  });

  /** Crash doctor: what went wrong, and a fix where there is a safe one. */
  router.get('/api/servers/:id/diagnose', ({ user, params }) => {
    const server = serverFor(user, params.id, 'console');
    return manager.runDiagnosis(server) || { findings: [] };
  });

  router.post('/api/servers/:id/diagnose/fix', async ({ user, params, body }) => {
    const action = String(body?.action || '');
    const cap = ['disable-mod', 'disable-plugin', 'eula'].includes(action) ? 'files.write' : 'settings';
    const server = serverFor(user, params.id, cap);
    if (action === 'memory') requireAdmin(user);
    return manager.applyFix(server.id, body || {}, user);
  });

  /** Upload the console to mclo.gs so it can be shown to someone helping. */
  router.post('/api/servers/:id/share-log', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'console');
    return manager.shareLog(server.id);
  });

  /** Game version and (Minecraft Java) server type switching. */
  router.get('/api/servers/:id/version', ({ user, params }) => {
    const server = serverFor(user, params.id, 'settings');
    return manager.versionInfo(server);
  });

  router.post('/api/servers/:id/version', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    return manager.switchVersion(server.id, { templateId: body?.templateId, vars: body?.vars, backup: body?.backup !== false, stopFirst: Boolean(body?.stopFirst) }, user);
  });

  /** Whitelist, operators and bans (Minecraft). */
  router.get('/api/servers/:id/player-lists', ({ user, params }) => {
    const server = serverFor(user, params.id, 'command');
    return require('../../games/player-lists').readLists(manager, server);
  });

  router.post('/api/servers/:id/player-lists', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'command');
    const result = await require('../../games/player-lists').changeList(manager, server, body || {}, user.username);
    store.addEvent('player.list', `${user.username} ${body.action === 'add' ? 'added' : 'removed'} ${body.name} (${body.list}, ${server.name})`, { serverId: server.id });
    return result;
  });

  router.put('/api/servers/:id/player-lists/whitelist', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'command');
    const result = await require('../../games/player-lists').setWhitelist(manager, server, Boolean(body?.enabled), user.username);
    store.addEvent('player.whitelist', `${user.username} turned the whitelist ${body?.enabled ? 'on' : 'off'} (${server.name})`, { serverId: server.id });
    return result;
  });

  /** Everyone who has played, the players-online graph and the activity log. */
  router.get('/api/servers/:id/player-history', ({ user, params }) => {
    const server = serverFor(user, params.id, 'console');
    return manager.playerHistory(server.id);
  });

  router.get('/api/servers/:id/player-history/:name', ({ user, params }) => {
    const server = serverFor(user, params.id, 'console');
    const profile = manager.playerProfile(server.id, params.name);
    if (!profile) fail(404, 'This player has never been seen on this server');
    return profile;
  });

  router.get('/api/servers/:id/activity', ({ user, params, url }) => {
    const qs = Object.fromEntries(url.searchParams);
    const server = serverFor(user, params.id, 'console');
    return manager.activityLog(server.id, {
      before: Number(qs.before) || undefined,
      types: qs.types ? String(qs.types).split(',') : undefined,
      q: qs.q,
      limit: Math.min(500, Number(qs.limit) || 100),
    });
  });

  router.post('/api/servers/:id/command', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'command');
    if (!body.command || !String(body.command).trim()) fail(400, 'Type a command first');
    return manager.sendCommand(server.id, String(body.command).trim());
  });

  router.get('/api/servers/:id/history', ({ user, params }) => {
    const server = serverFor(user, params.id);
    return { history: manager.getHistory(server.id) };
  });

  router.get('/api/servers/:id/query', async ({ user, params }) => {
    const server = serverFor(user, params.id);
    const q = manager.template(server)?.query;
    const type = server.vars?.QUERY_TYPE || q?.type;
    if (!type || type === 'none') return { supported: false };
    const port = q?.portOffset ? Number(server.ports.game) + Number(q.portOffset) : server.ports[q?.port || 'query'] ?? server.ports.game;
    return { supported: true, result: await query({ type, host: '127.0.0.1', port }) };
  });

  router.post('/api/servers/:id/rcon', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'command');
    const template = manager.template(server);
    if (!template?.rcon) fail(400, 'This game does not support RCON');
    const response = await rconCommand({
      host: '127.0.0.1',
      port: server.ports[template.rcon.port || 'rcon'],
      password: server.vars?.RCON_PASSWORD,
      command: String(body.command || ''),
    });
    return { response };
  });

  /* ---------------------------------------------------------- schedules -- */

  router.get('/api/servers/:id/schedules', ({ user, params }) => {
    const server = serverFor(user, params.id);
    return { schedules: scheduler.list(server) };
  });

  router.post('/api/servers/:id/schedules', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'schedules');
    if (body.action === 'command' && user.role !== 'admin') requireCap(user, 'command');
    const schedule = scheduler.add(server, body);
    store.addEvent('schedule.created', `${schedule.name} scheduled on ${server.name} (${schedule.cron})`, { serverId: server.id });
    return { schedule };
  });

  router.patch('/api/servers/:id/schedules/:sid', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'schedules');
    return { schedule: scheduler.update(server, params.sid, body) };
  });

  router.post('/api/servers/:id/schedules/:sid/run', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'schedules');
    const schedule = (server.schedules || []).find((s) => s.id === params.sid);
    if (!schedule) fail(404, 'Schedule not found');
    return { result: await scheduler.run(server, schedule) };
  });

  router.delete('/api/servers/:id/schedules/:sid', ({ user, params }) => {
    const server = serverFor(user, params.id, 'schedules');
    scheduler.remove(server, params.sid);
    return { ok: true };
  });

  /* ------------------------------------------------- public status page -- */

  const statusPage = require('../../features/status-page');

  router.get('/api/status-page', ({ user }) => {
    requireAdmin(user);
    return { settings: statusPage.settings(store) };
  });

  router.patch('/api/status-page', ({ user, body }) => {
    requireAdmin(user);
    const settings = statusPage.update(store, body);
    store.addEvent('settings.status_page', `Public status page ${settings.enabled ? 'on' : 'off'}${body.newLink ? ' (new link)' : ''} (${user.username})`);
    return { settings };
  });

  router.get(
    '/api/public/status/:slug',
    ({ params, res }) => {
      const view = statusPage.publicView(store, manager, params.slug);
      if (!view) fail(404, 'This status page does not exist or is turned off');
      res.setHeader('Cache-Control', 'no-store');
      return view;
    },
    { public: true }
  );
};
