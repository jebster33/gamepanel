'use strict';

/**
 * ARK tools: mod load order, level cap and engram overrides, supply crate loot,
 * the give-item tool and the cluster transfer log.
 */

const { fail } = require('../../core/util');
const G = require('../../features/ark-gameini');
const mods = require('../../features/ark-mods');
const levels = require('../../features/ark-levels');
const crates = require('../../features/ark-crates');
const items = require('../../features/ark-items');
const transfers = require('../../features/ark-transfers');
const { getJson } = require('../../features/mods/http');

module.exports = (router, { store, manager }, { requireAdmin, serverFor }) => {
  /** The server, which must be an ARK one. */
  const arkServer = (user, id, capability) => {
    const server = serverFor(user, id, capability);
    if (!G.isArk(server)) fail(400, 'This is not an ARK server');
    return server;
  };
  const gameIni = (server) => G.iniPath(manager, server);
  const saved = (server, extra = {}) => ({ ok: true, restartNeeded: manager.isActive(server.id), ...extra });

  /* ------------------------------------------------------------ mod order -- */

  router.get('/api/servers/:id/ark/mods', ({ user, params }) => mods.read(manager, arkServer(user, params.id, 'mods')));

  router.put('/api/servers/:id/ark/mods', ({ user, params, body }) => {
    const server = arkServer(user, params.id, 'mods');
    const result = mods.write(manager, server, body?.mods, user.username);
    store.addEvent('ark.mods', `${user.username} changed the mod load order on ${server.name}`, { serverId: server.id });
    return { ...result, restartNeeded: manager.isActive(server.id) };
  });

  router.get('/api/servers/:id/ark/ini-diff', ({ user, params, url }) => require('../../features/ark-ini-diff').view(manager, arkServer(user, params.id, 'files'), url.searchParams.get('file') || 'GameUserSettings.ini'));

  // ASA mods come from CurseForge (game 83374). Search them by name so nobody has to hunt for IDs.
  router.get('/api/servers/:id/ark/mods/search', async ({ user, params, url }) => {
    const server = arkServer(user, params.id, 'mods');
    if (server.templateId !== 'ark-survival-ascended') fail(400, 'Mod search is for ARK: Survival Ascended (Evolved uses the Steam Workshop)');
    const apiKey = (store.state.settings.integrations || {}).curseforgeKey;
    if (!apiKey) fail(400, 'Add a CurseForge API key in Settings, Integrations to search for mods. It is free at console.curseforge.com.');
    const q = new URLSearchParams({ gameId: '83374', searchFilter: String(url.searchParams.get('q') || '').slice(0, 80), pageSize: '20', sortField: url.searchParams.get('q') ? '2' : '6', sortOrder: 'desc' });
    const data = await getJson(`https://api.curseforge.com/v1/mods/search?${q}`, { 'x-api-key': apiKey });
    return {
      items: (data.data || []).map((m) => ({ id: String(m.id), name: m.name, author: m.authors?.[0]?.name || '', summary: m.summary, downloads: m.downloadCount, icon: m.logo?.thumbnailUrl || null, url: m.links?.websiteUrl || null })),
    };
  });

  /* ------------------------------------------------- level cap and engrams -- */

  router.get('/api/servers/:id/ark/levels', ({ user, params }) => {
    const server = arkServer(user, params.id, 'settings');
    const file = gameIni(server);
    const text = G.readText(file);
    return { exists: Boolean(text), running: manager.isActive(server.id), values: levels.parse(text), suggestions: levels.ENGRAM_SUGGESTIONS, maxLevel: levels.MAX_LEVEL };
  });

  /** The level cap calculator: a ramp or an engram point list for the numbers asked for. */
  router.post('/api/servers/:id/ark/levels/preview', ({ user, params, body }) => {
    arkServer(user, params.id, 'settings');
    const b = body || {};
    if (b.kind === 'points') return { points: levels.generatePoints(b) };
    const finalXp = b.finalXp ?? levels.suggestFinalXp(b.cap);
    return { ramp: levels.generateRamp({ ...b, finalXp }), finalXp };
  });

  router.put('/api/servers/:id/ark/levels', ({ user, params, body }) => {
    const server = arkServer(user, params.id, 'settings');
    const file = gameIni(server);
    G.writeText(file, levels.apply(G.readText(file), body || {}));
    store.addEvent('ark.levels', `${user.username} changed the level cap and engram settings on ${server.name}`, { serverId: server.id });
    return saved(server, { values: levels.parse(G.readText(file)) });
  });

  /* --------------------------------------------------------- supply crates -- */

  router.get('/api/servers/:id/ark/crates', ({ user, params }) => {
    const server = arkServer(user, params.id, 'settings');
    const text = G.readText(gameIni(server));
    return { exists: Boolean(text), running: manager.isActive(server.id), crates: crates.parse(text), known: crates.CRATES };
  });

  router.put('/api/servers/:id/ark/crates', ({ user, params, body }) => {
    const server = arkServer(user, params.id, 'settings');
    const file = gameIni(server);
    G.writeText(file, crates.apply(G.readText(file), body?.crates));
    store.addEvent('ark.crates', `${user.username} changed the supply crate loot on ${server.name}`, { serverId: server.id });
    return saved(server, { crates: crates.parse(G.readText(file)) });
  });

  /* ------------------------------------------------------------- give item -- */

  router.get('/api/servers/:id/ark/items', ({ user, params, url }) => {
    arkServer(user, params.id, 'command');
    return { ...items.search({ query: url.searchParams.get('q') || '', category: url.searchParams.get('category') || '', limit: url.searchParams.get('limit') || 50 }), tiers: items.QUALITY_TIERS };
  });

  router.post('/api/servers/:id/ark/give', async ({ user, params, body }) => {
    const server = arkServer(user, params.id, 'command');
    const b = body || {};
    const built = items.build(b);
    if (!built.send) return { ok: true, sent: false, command: built.command, note: 'This form of the command only works typed into the game console by an admin, so it was not sent.' };
    if (!manager.isActive(server.id)) fail(409, 'Start the server first');
    const name = String(b.player || '');
    // Only someone actually online, and nothing that could smuggle in a second command.
    if (!manager.rt(server.id).playerList?.includes(name) || /["\r\n\x00-\x1f]/.test(name)) fail(400, 'That player is not online');
    const result = await manager.sendCommand(server.id, built.command);
    store.addEvent('ark.give', `${user.username} gave ${built.quantity} item(s) to ${name} (${server.name})`, { serverId: server.id });
    manager.logActivity?.(server.id, { type: 'give', name, by: user.username });
    return { ok: true, sent: true, command: built.command, response: result.response || '' };
  });

  /* ----------------------------------------------------- cluster transfers -- */

  router.get('/api/clusters/:id/transfers', ({ user, params }) => {
    requireAdmin(user);
    return transfers.view(manager, store, params.id);
  });
};
