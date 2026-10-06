'use strict';

/**
 * Discord role → whitelist. Members of a Discord server who have one of the
 * chosen roles are put on a game server's whitelist; losing the role (or
 * leaving) takes them off again. The panel only ever removes names it added
 * itself, so people whitelisted by hand stay.
 *
 * Players tell the bot their game name with /link <name>; servers that use
 * nicknames as game names can use those instead.
 *
 * server.discordWhitelist = { enabled, guildId, roles: [ids], source: 'link'|'nickname' }
 * server.discordWhitelisted = [names the panel added]
 * store.state.discordLinks = { [discordUserId]: { name, at } }
 */

const { fail, logger } = require('../core/util');
const lists = require('../games/player-lists');

const SYNC_EVERY_MS = 5 * 60_000;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

const bot = () => require('./discord-bot').instance();
const linksOf = (store) => (store.state.discordLinks ||= {});

function link(store, userId, name) {
  const n = String(name || '').trim();
  if (!NAME_RE.test(n)) fail(400, 'That is not a Minecraft name (3 to 16 letters, numbers or _)');
  const taken = Object.entries(linksOf(store)).find(([id, l]) => id !== userId && l.name.toLowerCase() === n.toLowerCase());
  if (taken) fail(409, `${n} is already linked to someone else. Ask an admin if it is yours.`);
  linksOf(store)[userId] = { name: n, at: Date.now() };
  store.save();
  return n;
}

function unlink(store, userId) {
  const had = linksOf(store)[userId];
  delete linksOf(store)[userId];
  store.save();
  return had?.name || null;
}

/** Every member of a guild (needs the Server Members Intent switched on for the bot). */
async function members(guildId) {
  const b = bot();
  if (!b?.settings.token) fail(400, 'Set up the Discord bot first (Settings → Discord bot)');
  const out = [];
  let after = '0';
  for (let page = 0; page < 50; page++) {
    let batch;
    try {
      batch = await b.rest('GET', `/guilds/${guildId}/members?limit=1000&after=${after}`);
    } catch (err) {
      if (/403/.test(err.message)) fail(403, 'Discord refused to list members: turn on "Server Members Intent" on the Bot page of the Discord developer portal');
      throw err;
    }
    out.push(...(batch || []));
    if (!batch || batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }
  return out;
}

/** The game names that should be on a server's whitelist right now. */
function wanted(store, cfg, memberList) {
  const roles = new Set(cfg.roles);
  const names = new Map();
  for (const m of memberList) {
    if (m.user?.bot || !(m.roles || []).some((r) => roles.has(r))) continue;
    let name = linksOf(store)[m.user.id]?.name;
    if (!name && cfg.source === 'nickname') {
      const nick = String(m.nick || m.user.global_name || m.user.username || '').trim();
      if (NAME_RE.test(nick)) name = nick;
    }
    if (name) names.set(name.toLowerCase(), name);
  }
  return names;
}

/** Bring one server's whitelist in line with the roles. */
async function syncServer(manager, store, server, memberList = null) {
  const cfg = server.discordWhitelist;
  if (!cfg?.enabled || !cfg.guildId || !cfg.roles?.length) return { added: [], removed: [] };
  if (!lists.listsFor(manager.template(server))?.whitelist) return { added: [], removed: [] };
  const want = wanted(store, cfg, memberList || (await members(cfg.guildId)));
  const have = new Map((server.discordWhitelisted || []).map((n) => [n.toLowerCase(), n]));
  const added = [];
  const removed = [];
  for (const [key, name] of want) {
    if (have.has(key)) continue;
    try {
      await lists.changeList(manager, server, { list: 'whitelist', action: 'add', name }, 'Discord roles');
      have.set(key, name);
      added.push(name);
    } catch (err) {
      logger.warn(`Discord whitelist: could not add ${name} on ${server.name}: ${err.message}`);
    }
  }
  for (const [key, name] of [...have]) {
    if (want.has(key)) continue;
    try {
      await lists.changeList(manager, server, { list: 'whitelist', action: 'remove', name }, 'Discord roles');
    } catch (err) {
      if (err.code !== 404 && err.status !== 404) {
        logger.warn(`Discord whitelist: could not remove ${name} on ${server.name}: ${err.message}`);
        continue;
      }
    }
    have.delete(key);
    removed.push(name);
  }
  server.discordWhitelisted = [...have.values()];
  server.discordWhitelistSync = { at: Date.now(), count: have.size, error: null };
  store.save();
  if (added.length || removed.length) {
    store.addEvent('player.whitelist', `Discord roles: ${added.length ? `added ${added.join(', ')}` : ''}${added.length && removed.length ? '; ' : ''}${removed.length ? `removed ${removed.join(', ')}` : ''} on ${server.name}`, { serverId: server.id });
  }
  return { added, removed };
}

/** All servers, fetching each guild's members once. */
async function syncAll(manager, store) {
  const byGuild = new Map();
  for (const server of manager.servers) {
    const cfg = server.discordWhitelist;
    if (!cfg?.enabled || !cfg.guildId) continue;
    try {
      if (!byGuild.has(cfg.guildId)) byGuild.set(cfg.guildId, await members(cfg.guildId));
      await syncServer(manager, store, server, byGuild.get(cfg.guildId));
    } catch (err) {
      server.discordWhitelistSync = { ...(server.discordWhitelistSync || {}), at: Date.now(), error: err.message };
      logger.warn(`Discord whitelist on ${server.name}: ${err.message}`);
    }
  }
}

let last = 0;
function tick(manager, store, now = Date.now()) {
  if (now - last < SYNC_EVERY_MS) return Promise.resolve();
  if (!manager.servers.some((s) => s.discordWhitelist?.enabled)) return Promise.resolve();
  last = now;
  return syncAll(manager, store);
}

/** The bot's Discord servers and their roles, for the picker. */
async function guilds() {
  const b = bot();
  if (!b?.settings.token || b.state.status !== 'online') fail(400, 'The Discord bot is not online. Set it up under Settings → Discord bot.');
  const list = (await b.rest('GET', '/users/@me/guilds')) || [];
  const out = [];
  for (const g of list.slice(0, 20)) {
    const roles = ((await b.rest('GET', `/guilds/${g.id}/roles`).catch(() => [])) || [])
      .filter((r) => r.name !== '@everyone' && !r.managed)
      .sort((a, b2) => b2.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null }));
    out.push({ id: g.id, name: g.name, roles });
  }
  return out;
}

function configure(manager, store, server, input = {}) {
  if (!lists.listsFor(manager.template(server))?.whitelist) fail(400, 'This game has no whitelist the panel can manage');
  const cfg = {
    enabled: Boolean(input.enabled),
    guildId: /^\d{15,22}$/.test(String(input.guildId || '')) ? String(input.guildId) : '',
    roles: (Array.isArray(input.roles) ? input.roles : []).map(String).filter((r) => /^\d{15,22}$/.test(r)).slice(0, 25),
    source: input.source === 'nickname' ? 'nickname' : 'link',
  };
  if (cfg.enabled && (!cfg.guildId || !cfg.roles.length)) fail(400, 'Pick the Discord server and at least one role');
  server.discordWhitelist = cfg;
  store.save();
  return view(server);
}

function view(server) {
  return { settings: server.discordWhitelist || { enabled: false, guildId: '', roles: [], source: 'link' }, managed: server.discordWhitelisted || [], sync: server.discordWhitelistSync || null };
}

module.exports = { link, unlink, members, wanted, syncServer, syncAll, tick, guilds, configure, view, NAME_RE };
