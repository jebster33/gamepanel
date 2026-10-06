'use strict';

const { fail, logger, readBody } = require('../../core/util');
const { rconCommand } = require('../../games/rcon');
const { query } = require('../../games/query');
const quotas = require('../../features/quotas');

module.exports = (router, { store, manager, scheduler, bridge }, { requireAdmin, requireCap, serverFor, visibleServers, serverView }) => {
  router.get('/api/servers', ({ user }) => ({ servers: visibleServers(user) }));

  /**
   * Create a server for this account: anything for administrators, and within
   * the quota (with nothing that reaches the shell) for self-service accounts.
   */
  const createFor = (user, body) => {
    let server;
    if (user.role === 'admin') {
      server = manager.create(body, user);
    } else {
      // Self-service: within the account's quota, and nothing that reaches the host's shell.
      requireCap(user, 'deploy');
      const template = manager.templates.require(body.templateId);
      // Templates whose variables are commands or scripts run anything on the host.
      if (template.adminOnly) fail(403, `Only administrators can create ${template.name} servers`);
      // The same rules as a sub-user's edits (servers/untrusted.js), measured against the template's defaults.
      const defaults = Object.fromEntries((template.variables || []).map((v) => [v.name, v.default ?? '']));
      require('../../servers/untrusted').checkPatch(template, { name: body.name, vars: body.vars || {} }, { name: '', vars: defaults });
      quotas.checkCreate(manager, user, Number(body.memory) || Number(template.defaultMemory) || 2048);
      server = manager.create({ templateId: body.templateId, name: body.name, memory: body.memory, maxPlayers: body.maxPlayers, autoStart: body.autoStart, autoRestart: body.autoRestart, vars: body.vars, ports: body.ports }, user);
      server.ownerId = user.id;
      const record = store.state.users.find((u) => u.id === user.id);
      record.servers = [...new Set([...(record.servers || []), server.id])];
      record.serverPerms = { ...(record.serverPerms || {}), [server.id]: quotas.OWNER_PERMISSIONS };
      store.save();
    }
    return server;
  };

  router.post('/api/servers', async ({ user, body }) => {
    const server = createFor(user, body);
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

  /** The receiving end of a move from another node: an export streamed in as the body. */
  router.post(
    '/api/servers/receive',
    async ({ user, req, url }) => {
      requireAdmin(user);
      const server = await manager.receiveServer(req, user, { name: url.searchParams.get('name') || undefined });
      return { server: manager.publicServer(server) };
    },
    { rawBody: true }
  );

  /** Move a server to another node, or from a node to this machine. */
  router.post('/api/move', ({ user, body }) => {
    requireAdmin(user);
    return require('../../features/move').start({ manager, store }, { serverId: String(body?.serverId || ''), to: String(body?.to || ''), keepSource: Boolean(body?.keepSource) }, user);
  });

  /** Minecraft networks: a Velocity proxy in front of Paper/Purpur servers. */
  const networks = require('../../features/networks');
  router.get('/api/networks', ({ user }) => {
    requireAdmin(user);
    return networks.list(manager, store);
  });
  router.post('/api/networks', ({ user, body }) => {
    requireAdmin(user);
    return networks.create(manager, store, body || {}, user);
  });
  router.put('/api/networks/:id', ({ user, params, body }) => {
    requireAdmin(user);
    return networks.update(manager, store, params.id, body || {});
  });
  router.delete('/api/networks/:id', ({ user, params }) => {
    requireAdmin(user);
    return networks.remove(manager, store, params.id);
  });

  /** Servers other panels (Pterodactyl, AMP, LinuxGSM) left on this machine, ready to import. */
  router.get('/api/import/scan', ({ user }) => {
    requireAdmin(user);
    return { found: require('../../features/import-scan').scanAll(manager) };
  });

  router.post('/api/import/pterodactyl', async ({ user, body }) => {
    requireAdmin(user);
    return { found: await require('../../features/import-scan').scanPterodactylWithApi(manager.templates, body || {}) };
  });

  router.post('/api/import/inspect', ({ user, body }) => {
    requireAdmin(user);
    return require('../../features/import-scan').inspect(manager, body?.path);
  });

  router.get('/api/servers/:id', ({ user, params }) => {
    const server = serverFor(user, params.id);
    const template = manager.template(server);
    return { server: serverView(user, server), template: template ? { ...template, install: undefined, windows: undefined, linux: undefined } : null };
  });

  router.patch('/api/servers/:id', ({ user, params, body }) => {
    const admin = user.role === 'admin';
    // Names and variables reach a shell on the host: non-admins get checked values only (servers/untrusted.js).
    if (!admin) {
      serverFor(user, params.id, 'settings');
      // Raising a server's memory counts against its owner's quota.
      if (body.memory !== undefined) quotas.checkMemory(manager, user, manager.require(params.id), Math.max(256, Number(body.memory) || 0));
    }
    return { server: manager.publicServer(manager.update(params.id, body, { trusted: admin })) };
  });

  router.delete('/api/servers/:id', async ({ user, params, url }) => {
    // People who deployed a server themselves may delete it.
    if (user.role !== 'admin' && serverFor(user, params.id).ownerId !== user.id) requireAdmin(user);
    await manager.remove(params.id, url.searchParams.get('keepFiles') !== '1');
    bridge?.forgetServer(params.id);
    return { ok: true };
  });

  router.post('/api/servers/:id/power', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'power');
    switch (String(body.action || '').toLowerCase()) {
      case 'start':
        quotas.checkDisk(manager, server, store.state.users);
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

  /** Wipes (games whose template has a "wipe" spec, like Rust). */
  router.get('/api/servers/:id/wipe', ({ user, params, url }) => {
    const server = serverFor(user, params.id, 'files.write');
    const { files } = require('../../features/wipe').plan(manager, server, { blueprints: url.searchParams.get('blueprints') === '1' });
    return { files, lastWipe: server.lastWipe || null };
  });

  router.post('/api/servers/:id/wipe', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'files.write');
    requireCap(user, 'power', server.id);
    const opts = { blueprints: Boolean(body?.blueprints), newSeed: Boolean(body?.newSeed), updateFirst: Boolean(body?.updateFirst) };
    const log = (line) => manager.pushConsole(server, line, 'system');
    const result = await require('../../features/wipe').wipe(manager, server, opts, log);
    store.addEvent('server.wiped', `${server.name} was wiped by ${user.username}${opts.blueprints ? ' (blueprints too)' : ''}`, { serverId: server.id });
    return { ok: true, ...result };
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
    const result = require('../../games/settings').writeGameSettings(manager, server, body.values, { trusted: user.role === 'admin', actor: user.username });
    if (result.changed) store.addEvent('server.settings', `${user.username} changed ${result.changed} game setting${result.changed === 1 ? '' : 's'} on ${server.name}`, { serverId: server.id });
    return { ...result, restartNeeded: manager.isActive(server.id) };
  });

  /** Kick or ban someone on the Players tab, through the game's own console command. */
  /** Chat moderation: word list, links, caps, spam, and what happens to players who break them. */
  router.get('/api/servers/:id/moderation', ({ user, params }) => require('../../features/chat-moderation').view(manager, serverFor(user, params.id, 'command')));

  router.put('/api/servers/:id/moderation', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'command');
    const result = require('../../features/chat-moderation').update(manager, server, body || {});
    store.addEvent('server.settings', `${user.username} changed chat moderation on ${server.name} (${result.settings.enabled ? 'on' : 'off'})`, { serverId: server.id });
    return result;
  });

  router.delete('/api/servers/:id/moderation/bans/:name', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'command');
    const ban = (server.tempBans || []).find((b) => b.name.toLowerCase() === String(params.name).toLowerCase());
    if (!ban) fail(404, 'No temporary ban for that player');
    // Lifted early: tick() pardons it on the next minute.
    ban.until = 0;
    store.save();
    await require('../../features/chat-moderation').tick(manager);
    return require('../../features/chat-moderation').view(manager, server);
  });

  /** A Minecraft player's inventory, now or in a backup, and putting it back. */
  router.get('/api/servers/:id/players/:name/inventory', ({ user, params, url }) =>
    require('../../features/player-data').inventory(manager, serverFor(user, params.id, 'files'), params.name, { backup: url.searchParams.get('backup') || null })
  );
  router.post('/api/servers/:id/players/:name/inventory/restore', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'backups.restore');
    if (!body?.backup) fail(400, 'Pick the backup to restore from');
    return require('../../features/player-data').restore(manager, store, server, params.name, String(body.backup), user.username);
  });

  /** Whitelist from Discord roles. */
  router.get('/api/discord/guilds', async ({ user }) => {
    requireCap(user, 'command');
    return { guilds: await require('../../features/discord-roles').guilds() };
  });

  router.get('/api/servers/:id/discord-whitelist', ({ user, params }) => require('../../features/discord-roles').view(serverFor(user, params.id, 'command')));

  router.put('/api/servers/:id/discord-whitelist', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'command');
    const roles = require('../../features/discord-roles');
    roles.configure(manager, store, server, body || {});
    let result = { added: [], removed: [] };
    if (server.discordWhitelist.enabled) result = await roles.syncServer(manager, store, server);
    return { ...roles.view(server), ...result };
  });

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

  /** Staging copies: make one, see what differs from live, push changes to live. */
  const staging = require('../../features/staging');
  router.post('/api/servers/:id/staging', ({ user, params, body }) => {
    requireAdmin(user);
    return staging.create(manager, store, manager.require(params.id).id, { name: body?.name, withWorld: body?.withWorld !== false }, user);
  });
  router.get('/api/servers/:id/staging/diff', ({ user, params }) => {
    requireAdmin(user);
    return staging.diff(manager, params.id);
  });
  router.post('/api/servers/:id/staging/push', ({ user, params, body }) => {
    requireAdmin(user);
    return staging.push(manager, store, params.id, { entries: body?.entries, properties: body?.properties !== false, version: Boolean(body?.version) }, user);
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
  router.get('/api/servers/:id/export', async ({ user, params, res, url }) => {
    requireAdmin(user);
    // ?move=1 (a move to another node) carries secret variables in the clear; administrators only, as above.
    await manager.exportServer(serverFor(user, params.id, 'files'), res, { forMove: url.searchParams.get('move') === '1' });
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

  /** A web map for Rust, Valheim and Terraria worlds. */
  router.get('/api/servers/:id/world-map', ({ user, params }) => ({ map: require('../../games/world-maps').worldMap(serverFor(user, params.id, 'console')) }));

  /** World pre-generation with Chunky. */
  router.get('/api/servers/:id/pregen', ({ user, params }) => manager.pregenInfo(serverFor(user, params.id, 'console')));

  router.post('/api/servers/:id/pregen', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'command');
    if (body?.action === 'install') requireCap(user, 'mods', server.id);
    return manager.pregen(server.id, { action: String(body?.action || ''), radius: body?.radius }, user);
  });

  /** Memory and settings advice, and applying one piece of it. */
  router.get('/api/servers/:id/advice', ({ user, params }) => require('../../features/advice').advise(manager, serverFor(user, params.id)));
  router.post('/api/servers/:id/advice/:adviceId/apply', ({ user, params }) => {
    requireAdmin(user);
    return require('../../features/advice').apply(manager, store, serverFor(user, params.id), params.adviceId, user.username);
  });

  /** Datapacks in the loaded world (Minecraft Java). */
  const datapacks = require('../../features/datapacks');
  router.get('/api/servers/:id/datapacks', ({ user, params }) => datapacks.list(manager, serverFor(user, params.id, 'mods')));
  router.get('/api/servers/:id/datapacks/search', ({ user, params, url }) =>
    datapacks.search(manager, serverFor(user, params.id, 'mods'), { query: String(url.searchParams.get('query') || '').slice(0, 100), page: Math.min(50, Math.max(0, Number(url.searchParams.get('page')) || 0)) })
  );
  router.get('/api/servers/:id/datapacks/updates', ({ user, params }) => datapacks.updates(manager, serverFor(user, params.id, 'mods')));
  router.post('/api/servers/:id/datapacks/install', ({ user, params, body }) => datapacks.install(manager, store, serverFor(user, params.id, 'mods'), { projectId: body?.projectId, versionId: body?.versionId }, user.username));
  router.post(
    '/api/servers/:id/datapacks/upload',
    async ({ user, params, url, req }) => {
      const server = serverFor(user, params.id, 'mods');
      return datapacks.upload(manager, store, server, url.searchParams.get('name'), await readBody(req, 256 * 1024 * 1024), user.username);
    },
    { rawBody: true }
  );
  router.post('/api/servers/:id/datapacks/:name/toggle', ({ user, params, body }) => datapacks.toggle(manager, serverFor(user, params.id, 'mods'), params.name, Boolean(body?.on), user.username));
  router.delete('/api/servers/:id/datapacks/:name', ({ user, params }) => datapacks.remove(manager, store, serverFor(user, params.id, 'mods'), params.name, user.username));

  /** Minecraft worlds. */
  router.get('/api/servers/:id/worlds',async ({ user, params }) => manager.listWorlds(serverFor(user, params.id, 'files')));

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
      if (user.role !== 'admin' && !canCommand(user, server.id)) continue;
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

  const canCommand = (user, id) => {
    try {
      serverFor(user, id, 'command');
      return true;
    } catch {
      return false;
    }
  };

  /** Say something in the chat of every running server this account can command. */
  router.post('/api/servers/broadcast', async ({ user, body }) => {
    requireCap(user, 'command');
    const message = String(body?.message || '').replace(/["\r\n]/g, '').trim().slice(0, 240);
    if (!message) fail(400, 'Type a message');
    const command = require('../../games/players').broadcastCommand;
    const results = [];
    for (const server of visibleServers(user)) {
      const line = command(manager.template(server));
      if (!line || !manager.isActive(server.id) || !canCommand(user, server.id)) continue;
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

  router.get('/api/servers/:id/history', ({ user, params, url }) => {
    const server = serverFor(user, params.id);
    return { history: manager.getHistory(server.id, url.searchParams.get('range')) };
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
    requireCap(user, 'command', server.id);
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

  // A schedule does its action later on the user's behalf, so it needs the same permission.
  const SCHEDULE_CAPS = { command: 'command', backup: 'backups', mods: 'mods', start: 'power', stop: 'power', restart: 'power', update: 'power' };
  const requireScheduleCap = (user, server, action) => {
    if (SCHEDULE_CAPS[action]) requireCap(user, SCHEDULE_CAPS[action], server.id);
  };

  router.post('/api/servers/:id/schedules', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'schedules');
    requireScheduleCap(user, server, body.action);
    const schedule = scheduler.add(server, body);
    store.addEvent('schedule.created', `${schedule.name} scheduled on ${server.name} (${schedule.cron})`, { serverId: server.id });
    return { schedule };
  });

  router.patch('/api/servers/:id/schedules/:sid', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'schedules');
    const existing = (server.schedules || []).find((s) => s.id === params.sid);
    requireScheduleCap(user, server, body.action ?? existing?.action);
    return { schedule: scheduler.update(server, params.sid, body) };
  });

  router.post('/api/servers/:id/schedules/:sid/run', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'schedules');
    const schedule = (server.schedules || []).find((s) => s.id === params.sid);
    if (!schedule) fail(404, 'Schedule not found');
    requireScheduleCap(user, server, schedule.action);
    return { result: await scheduler.run(server, schedule) };
  });

  router.delete('/api/servers/:id/schedules/:sid', ({ user, params }) => {
    const server = serverFor(user, params.id, 'schedules');
    scheduler.remove(server, params.sid);
    return { ok: true };
  });

  /* -------------------------------------------------- ready-made setups -- */

  const setups = require('../../features/setups');

  router.get('/api/setups', ({ user }) => {
    if (user.role !== 'admin') requireCap(user, 'deploy');
    return { setups: setups.list(manager.templates) };
  });

  /** Save a server as a setup of your own (administrators). */
  router.post('/api/servers/:id/save-as-setup', ({ user, params, body }) => {
    requireAdmin(user);
    const setup = setups.saveCustom(setups.fromServer(manager, manager.require(params.id), { name: body?.name, description: body?.description }));
    store.addEvent('server.setup_saved', `${user.username} saved ${setup.name} as a setup`, { serverId: params.id });
    return { setup };
  });

  router.delete('/api/setups/:sid', ({ user, params }) => {
    requireAdmin(user);
    setups.removeCustom(params.sid);
    return { ok: true };
  });

  router.post('/api/setups/:sid/deploy', async ({ user, params, body }) => {
    const setup = setups.get(params.sid);
    const server = createFor(user, setups.serverInput(setup, { name: body?.name, memory: body?.memory }));
    setups.attach(store, server, setup);
    store.addEvent('server.setup_deployed', `${user.username} deployed ${server.name} from the ${setup.name} setup`, { serverId: server.id });
    manager.install(server.id).catch((err) => logger.error('Install error:', err.message));
    return { server: manager.publicServer(server) };
  });

  /* ---------------------------------------------------- scheduled events -- */

  const events = require('../../features/events');
  const eventServer = (user, id) => {
    const server = serverFor(user, id, 'schedules');
    requireCap(user, 'settings', server.id);
    return server;
  };

  router.get('/api/servers/:id/events', ({ user, params }) => {
    const server = serverFor(user, params.id, 'schedules');
    return { enabled: events.enabled(store), events: events.list(server) };
  });

  router.post('/api/servers/:id/events', ({ user, params, body }) => {
    const server = eventServer(user, params.id);
    if (!events.enabled(store)) fail(400, 'Scheduled events are off. An administrator can turn them on in Settings.');
    const event = events.add(manager, store, server, body || {}, { trusted: user.role === 'admin' });
    store.addEvent('schedule.created', `${user.username} scheduled the event ${event.name} on ${server.name}`, { serverId: server.id });
    return { event };
  });

  router.patch('/api/servers/:id/events/:eid', ({ user, params, body }) => ({ event: events.update(manager, store, eventServer(user, params.id), params.eid, body || {}, { trusted: user.role === 'admin' }) }));

  router.delete('/api/servers/:id/events/:eid', async ({ user, params }) => {
    await events.remove(manager, store, eventServer(user, params.id), params.eid);
    return { ok: true };
  });

  /** Start or end one now, outside its schedule. */
  router.post('/api/servers/:id/events/:eid/:action', async ({ user, params }) => {
    const server = eventServer(user, params.id);
    const event = (server.events || []).find((e) => e.id === params.eid);
    if (!event) fail(404, 'Event not found');
    if (params.action === 'start') return { event: await events.begin(manager, store, server, event) };
    if (params.action === 'end') return { event: await events.finish(manager, store, server, event) };
    return fail(400, 'Use start or end');
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

  router.put('/api/status-page/logo', ({ user, body }) => {
    requireAdmin(user);
    return { settings: statusPage.setLogo(store, body?.image) };
  });

  router.delete('/api/status-page/logo', ({ user }) => {
    requireAdmin(user);
    return { settings: statusPage.removeLogo(store) };
  });

  router.get(
    '/api/public/status/:slug/logo',
    ({ params, res }) => {
      const logo = statusPage.readLogo(store, params.slug);
      if (!logo) fail(404, 'No logo');
      res.writeHead(200, { 'Content-Type': logo.type, 'Content-Length': logo.data.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      res.end(logo.data);
      return undefined;
    },
    { public: true }
  );

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
