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

  /** Minecraft's server-icon.png (64×64), shown next to the name in the server list. */
  router.get('/api/servers/:id/icon', ({ user, params, res }) => {
    const server = serverFor(user, params.id);
    const fs = require('fs');
    let png;
    try {
      png = fs.readFileSync(require('../../features/files').containedPath(server.dir, 'server-icon.png'));
    } catch {
      fail(404, 'No icon yet');
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-cache' });
    res.end(png);
    return undefined;
  });

  router.put('/api/servers/:id/icon', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    const png = Buffer.from(String(body?.png || '').replace(/^data:image\/png;base64,/, ''), 'base64');
    // A real PNG, exactly 64×64 (the IHDR width and height), and small.
    const isPng = png.length > 24 && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng || png.readUInt32BE(16) !== 64 || png.readUInt32BE(20) !== 64 || png.length > 256 * 1024) fail(400, 'The icon must be a 64×64 PNG');
    require('fs').writeFileSync(require('../../features/files').containedPath(server.dir, 'server-icon.png'), png);
    store.addEvent('server.settings', `${user.username} changed the server icon of ${server.name}`, { serverId: server.id });
    return { ok: true };
  });

  /** Duplicate a server onto fresh ports, optionally with its files. */
  router.post('/api/servers/:id/clone', async ({ user, params, body }) => {
    requireAdmin(user);
    return manager.cloneServer(params.id, { name: body?.name, copyFiles: body?.copyFiles !== false }, user);
  });

  /** This server's own Discord channel: chat, joins and leaves, and status. */
  router.put('/api/servers/:id/discord-feed', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    // An empty URL with keep:true changes only the switches on the webhook already saved.
    const webhook = String(body?.webhook || '').trim() || (body?.keep ? server.discordFeed?.webhook || '' : '');
    if (webhook && !/^https:\/\/(?:[a-z]+\.)?(?:discord|discordapp)\.com\/api\/webhooks\//.test(webhook)) fail(400, 'Paste a Discord webhook URL (Channel settings, Integrations, Webhooks)');
    const before = server.discordFeed;
    let channelId = webhook && webhook === before?.webhook ? before.channelId : undefined;
    if (webhook && body.fromDiscord && !channelId) {
      // The webhook knows its own channel, so Discord → game needs nothing else pasted.
      const info = await fetch(webhook, { signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!/^\d+$/.test(String(info?.channel_id || ''))) fail(400, 'Discord did not recognise that webhook');
      channelId = String(info.channel_id);
    }
    server.discordFeed = webhook ? { webhook, chat: body.chat !== false, joins: body.joins !== false, status: body.status !== false, fromDiscord: Boolean(body.fromDiscord), channelId } : undefined;
    store.save();
    // The bot only asks Discord for message content while some server wants it.
    if (Boolean(before?.fromDiscord) !== Boolean(server.discordFeed?.fromDiscord)) require('../../features/discord-bot').init({ store, manager }).reload();
    if (webhook && body.test) {
      try {
        await require('../../features/discord-feed').post(webhook, { content: `✅ ${server.name} is connected to this channel.`, username: server.name.slice(0, 80) });
      } catch (err) {
        fail(400, `Discord did not accept the message: ${err.message}`);
      }
    }
    return { discordFeed: server.discordFeed ? { ...server.discordFeed, webhook: undefined, channelId: undefined, connected: true } : null };
  });

  /** The whole server as one archive another panel can import. */
  router.get('/api/servers/:id/export', async ({ user, params, res }) => {
    requireAdmin(user);
    await manager.exportServer(serverFor(user, params.id, 'files'), res);
    return undefined;
  });

  /** A friendly address (play.example.com) through Cloudflare DNS. */
  router.put('/api/servers/:id/subdomain', async ({ user, params, body }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    const result = await require('../../features/dns').assign(store, server, body?.name, { ip: body?.ip });
    store.addEvent('server.settings', `${user.username} pointed ${result.host} at ${server.name}`, { serverId: server.id });
    return { subdomain: result, address: require('../../features/dns').playerAddress(server) };
  });

  router.delete('/api/servers/:id/subdomain', async ({ user, params }) => {
    requireAdmin(user);
    return require('../../features/dns').release(store, manager.require(params.id));
  });

  /** Bedrock crossplay (Geyser + Floodgate) on Paper and Purpur. */
  router.get('/api/servers/:id/crossplay', ({ user, params }) => manager.crossplayInfo(serverFor(user, params.id, 'settings')));

  router.post('/api/servers/:id/crossplay', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    return body?.enabled === false ? manager.disableCrossplay(server.id, user) : manager.enableCrossplay(server.id, user);
  });

  /** Minecraft Java game rules over RCON (keep inventory, daylight cycle…). */
  router.get('/api/servers/:id/gamerules', ({ user, params }) => manager.gamerules(serverFor(user, params.id, 'command')));

  router.put('/api/servers/:id/gamerules', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'command');
    const result = await manager.setGamerule(server, String(body?.name || ''), body?.value);
    store.addEvent('server.settings', `${user.username} set ${result.name} to ${result.value} on ${server.name}`, { serverId: server.id });
    return result;
  });

  /** A live web map (BlueMap) on Paper and Purpur. */
  router.get('/api/servers/:id/map', ({ user, params }) => manager.mapInfo(serverFor(user, params.id, 'settings')));

  router.post('/api/servers/:id/map', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    return body?.enabled === false ? manager.disableMap(server.id, user) : manager.enableMap(server.id, user);
  });

  /** World pre-generation with Chunky. */
  router.get('/api/servers/:id/pregen', ({ user, params }) => manager.pregenInfo(serverFor(user, params.id, 'console')));

  router.post('/api/servers/:id/pregen', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'command');
    if (body?.action === 'install') requireCap(user, 'mods');
    return manager.pregen(server.id, { action: String(body?.action || ''), radius: body?.radius }, user);
  });

  /** Minecraft worlds. */
  router.get('/api/servers/:id/worlds', async ({ user, params }) => manager.listWorlds(serverFor(user, params.id, 'files')));

  router.post('/api/servers/:id/worlds/use', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    return manager.useWorld(server.id, body?.name, user);
  });

  router.post('/api/servers/:id/worlds/reset', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'files.write');
    return manager.resetWorld(server.id, { name: body?.name, seed: body?.seed, backup: body?.backup !== false }, user);
  });

  router.post('/api/servers/:id/worlds/delete', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'files.write');
    return manager.deleteWorld(server.id, body?.name, user);
  });

  router.post('/api/servers/:id/worlds/import', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'files.write');
    return manager.importWorld(server.id, { path: body?.path, name: body?.name, use: Boolean(body?.use) }, user);
  });

  router.get('/api/servers/:id/worlds/download', ({ user, params, url, res }) => {
    manager.downloadWorld(serverFor(user, params.id, 'files'), url.searchParams.get('name'), res);
    return undefined;
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

  /** Search logs/latest.log and the archived days (?q=, or ?file= to read one). */
  router.get('/api/servers/:id/logs', ({ user, params, url }) => {
    const server = serverFor(user, params.id, 'console');
    return manager.searchLogs(server, url.searchParams.get('q'), { file: url.searchParams.get('file') || undefined });
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

  /** Ban (or unban) one player on every Minecraft server this account can moderate. */
  router.post('/api/players/ban-everywhere', async ({ user, body }) => {
    requireCap(user, 'command');
    const lists = require('../../games/player-lists');
    const unban = Boolean(body?.unban);
    const results = [];
    for (const server of manager.servers) {
      if (user.role !== 'admin' && !(user.servers || []).includes(server.id)) continue;
      if (!lists.listsFor(manager.template(server))?.bans) continue;
      try {
        await lists.changeList(manager, server, { list: 'bans', action: unban ? 'remove' : 'add', name: body?.name, reason: body?.reason }, user.username);
        results.push({ server: server.name, ok: true });
      } catch (err) {
        results.push({ server: server.name, ok: false, error: err.message });
      }
    }
    if (!results.length) fail(400, 'No Minecraft Java servers you can moderate');
    store.addEvent(unban ? 'player.unban' : 'player.ban', `${user.username} ${unban ? 'unbanned' : 'banned'} ${String(body?.name || '')} on ${results.filter((r) => r.ok).length} server(s)`);
    return { results };
  });

  /** Say something in the chat of every running server this account can command. */
  router.post('/api/servers/broadcast', async ({ user, body }) => {
    requireCap(user, 'command');
    const message = String(body?.message || '').replace(/["\r\n]/g, '').trim().slice(0, 240);
    if (!message) fail(400, 'Type a message');
    const command = require('../../games/players').broadcastCommand;
    const results = [];
    for (const server of visibleServers(user)) {
      const line = command(manager.template(server));
      if (!line || !manager.isActive(server.id)) continue;
      try {
        await manager.sendCommand(server.id, require('../../games/players').fillBroadcast(line, message));
        results.push({ server: server.name, ok: true });
      } catch (err) {
        results.push({ server: server.name, ok: false, error: err.message });
      }
    }
    if (!results.length) fail(400, 'None of your servers are running a game with chat');
    store.addEvent('server.broadcast', `${user.username} told ${results.filter((r) => r.ok).length} server(s): ${message}`);
    return { results };
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

  router.put('/api/servers/:id/maintenance', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'command');
    const on = Boolean(body?.enabled);
    const result = await require('../../games/player-lists').setMaintenance(manager, server, on, body?.message, user.username);
    store.addEvent('server.maintenance', `${user.username} turned maintenance mode ${on ? 'on' : 'off'} for ${server.name}`, { serverId: server.id });
    return result;
  });

  /** Everyone who has played, the players-online graph and the activity log. */
  router.get('/api/servers/:id/player-history', ({ user, params }) => {
    const server = serverFor(user, params.id, 'console');
    return manager.playerHistory(server.id);
  });

  router.get('/api/servers/:id/player-history/:name', ({ user, params }) => {
    const server = serverFor(user, params.id, 'console');
    // Addresses are personal data: administrators only.
    const profile = manager.playerProfile(server.id, params.name, { withAddresses: user.role === 'admin' });
    if (!profile) fail(404, 'This player has never been seen on this server');
    return { ...profile, stats: manager.playerStats(server, profile.name) };
  });

  /** Find a player on any server this account can see. */
  router.get('/api/players/search', ({ user, url }) => {
    requireCap(user, 'console');
    const ids = visibleServers(user).map((s) => s.id);
    return { players: manager.searchPlayers(ids, url.searchParams.get('q'), { byAddress: user.role === 'admin' }) };
  });

  /** A staff note on a player, and whether to alert when they join any server. */
  router.put('/api/players/:name/note', ({ user, params, body }) => {
    requireCap(user, 'command');
    const note = manager.setPlayerNote(params.name, { note: body?.note, watch: body?.watch }, user);
    store.addEvent('player.note', `${user.username} ${note?.watch ? 'put' : 'updated'} ${params.name}${note?.watch ? ' on the watchlist' : "'s note"}`);
    return { note };
  });

  router.get('/api/servers/:id/activity', ({ user, params, url, res }) => {
    const qs = Object.fromEntries(url.searchParams);
    const server = serverFor(user, params.id, 'console');
    if (qs.format === 'csv') {
      // The whole log (or the filtered part) for a spreadsheet or an appeal.
      const { entries } = manager.activityLog(server.id, { types: qs.types ? String(qs.types).split(',') : undefined, q: qs.q, limit: 200_000 });
      // A leading = + - @ would run as a formula when the file is opened.
      const cell = (v) => `"${String(v ?? '').replace(/^([=+\-@\t\r])/, "'$1").replace(/"/g, '""')}"`;
      const rows = entries.reverse().map((e) => [new Date(e.t).toISOString(), e.type, e.name, e.text, e.by, e.dur ? Math.round(e.dur / 1000) : ''].map(cell).join(','));
      const safe = server.name.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'server';
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${safe}-activity.csv"` });
      res.end(['time,type,player,text,by,seconds', ...rows].join('\r\n'));
      return;
    }
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

  /** Rotating chat announcements. */
  router.put('/api/servers/:id/announcements', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'schedules');
    requireCap(user, 'command');
    if (!require('../../games/players').broadcastCommand(manager.template(server))) fail(400, 'This game has no chat broadcast command');
    const messages = (Array.isArray(body?.messages) ? body.messages : [])
      .map((m) => String(m).replace(/[\r\n]+/g, ' ').trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 20);
    const every = Math.max(1, Math.min(240, Math.round(Number(body?.every) || 15)));
    server.announcements = { enabled: Boolean(body?.enabled) && messages.length > 0, every, messages, next: 0 };
    if (body?.welcome !== undefined) {
      server.welcome = { enabled: Boolean(body.welcome.enabled), message: String(body.welcome.message || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) };
    }
    store.save();
    return { announcements: server.announcements, welcome: server.welcome || null };
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
