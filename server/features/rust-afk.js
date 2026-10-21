'use strict';

/**
 * Opt-in AFK and high-ping kicker for Rust. A watcher asks each running Rust
 * server that turned it on for `playerlist` (ping) and the live map plugin's
 * positions every 20 seconds:
 *
 *   - AFK: a player who has not moved more than a few metres for N minutes is
 *     warned in chat, then kicked after the grace time if still not moving.
 *   - High ping: a player over the limit on several checks in a row is warned,
 *     then kicked after the grace time if the ping is still over.
 *
 * Owners and moderators (users.cfg) and the steam ids on the ignore list are
 * never touched. Everything the game sees is a number or fixed text.
 */

const fs = require('fs');
const { fail, logger } = require('../core/util');
const { containedPath } = require('./files');
const livemap = require('./rust-livemap');
const players = require('../games/players');

const TICK_MS = 20_000;
const MOVE_METRES = 3;
const STEAM_ID = /^\d{17}$/;
const DEFAULTS = {
  enabled: false,
  afk: true,
  afkMinutes: 15,
  highPing: false,
  maxPing: 250,
  pingChecks: 6, // checks in a row (20 s apart) over the limit
  graceSeconds: 60,
  minPlayers: 0, // only kick while at least this many are online (0 = always)
  ignoreAdmins: true,
  ignoreIds: [],
};

const state = new Map(); // server id -> { tracks: Map(id -> track) }

/** Validate and fill the settings a person sent. */
function clean(body = {}, base = DEFAULTS) {
  const b = { ...base, ...body };
  const int = (v, min, max, label) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < min || n > max) fail(400, `${label} must be from ${min} to ${max}`);
    return n;
  };
  const ids = Array.isArray(b.ignoreIds) ? b.ignoreIds : String(b.ignoreIds || '').split(/[\s,;]+/);
  const ignoreIds = [...new Set(ids.map((s) => String(s).trim()).filter(Boolean))];
  if (ignoreIds.some((id) => !STEAM_ID.test(id))) fail(400, 'Steam IDs are 17 digits');
  if (ignoreIds.length > 100) fail(400, 'At most 100 ignored players');
  return {
    enabled: Boolean(b.enabled),
    afk: Boolean(b.afk),
    afkMinutes: int(b.afkMinutes, 3, 240, 'AFK minutes'),
    highPing: Boolean(b.highPing),
    maxPing: int(b.maxPing, 80, 2000, 'The ping limit'),
    pingChecks: int(b.pingChecks, 2, 30, 'Ping checks'),
    graceSeconds: int(b.graceSeconds, 20, 600, 'The warning time'),
    minPlayers: int(b.minPlayers, 0, 500, 'Minimum players'),
    ignoreAdmins: Boolean(b.ignoreAdmins),
    ignoreIds,
  };
}

const settings = (server) => ({ ...DEFAULTS, ...(server.rustTools?.afk || {}) });

function update(manager, server, body) {
  const next = clean(body, settings(server));
  server.rustTools = { ...(server.rustTools || {}), afk: next };
  manager.store.save();
  state.delete(server.id);
  return next;
}

/** Steam ids of owners and moderators from the server's users.cfg. */
function adminIds(server) {
  try {
    const text = fs.readFileSync(containedPath(server.dir, 'server/gamepanel/cfg/users.cfg'), 'utf8');
    return new Set([...text.matchAll(/^\s*(?:ownerid|moderatorid)\s+(\d{17})\b/gim)].map((m) => m[1]));
  } catch {
    return new Set();
  }
}

/**
 * One check. `list` is [{ id, name, ping, x, z }] (x and z null when positions
 * are not available). `tracks` is the memory between checks. Returns what to
 * do: [{ id, name, kind: 'warn'|'kick', why: 'afk'|'ping' }].
 */
function evaluate(tracks, list, cfg, now, exempt = new Set()) {
  const out = [];
  const seen = new Set();
  for (const p of list) {
    seen.add(p.id);
    let t = tracks.get(p.id);
    if (!t) tracks.set(p.id, (t = { x: p.x, z: p.z, movedAt: now, over: 0, warned: null }));
    if (p.x != null && (t.x == null || Math.hypot(p.x - t.x, p.z - t.z) > MOVE_METRES)) {
      t.x = p.x;
      t.z = p.z;
      t.movedAt = now;
    }
    t.over = cfg.highPing && p.ping > cfg.maxPing ? t.over + 1 : 0;
    if (exempt.has(p.id)) {
      t.warned = null;
      continue;
    }
    const afk = cfg.afk && p.x != null && now - t.movedAt >= cfg.afkMinutes * 60_000;
    const slow = cfg.highPing && t.over >= cfg.pingChecks;
    if (!afk && !slow) {
      t.warned = null;
      continue;
    }
    const why = afk ? 'afk' : 'ping';
    if (!t.warned) {
      t.warned = { at: now, why };
      out.push({ id: p.id, name: p.name, kind: 'warn', why });
    } else if (now - t.warned.at >= cfg.graceSeconds * 1000) {
      out.push({ id: p.id, name: p.name, kind: 'kick', why });
      tracks.delete(p.id);
    }
  }
  for (const id of [...tracks.keys()]) if (!seen.has(id)) tracks.delete(id);
  return out;
}

/** The JSON array in a `playerlist` answer. */
function parsePlayerList(text) {
  const s = String(text || '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b < a) return [];
  try {
    const rows = JSON.parse(s.slice(a, b + 1));
    return rows
      .map((r) => ({ id: String(r.SteamID || ''), name: String(r.DisplayName || ''), ping: Number(r.Ping) || 0 }))
      .filter((r) => STEAM_ID.test(r.id));
  } catch {
    return [];
  }
}

const MESSAGES = {
  afk: (name, s) => `${name}, you look AFK. Move within ${s} seconds or you will be kicked.`,
  ping: (name, s) => `${name}, your connection is too slow for this server. You will be kicked in ${s} seconds if it stays that way.`,
};
const KICK_REASON = { afk: 'Kicked for being AFK', ping: 'Kicked for a high ping' };

async function check(manager, server) {
  const cfg = settings(server);
  if (!cfg.enabled || server.templateId !== 'rust' || !manager.isActive(server.id) || !livemap.hasRcon(manager, server)) return [];
  const rows = parsePlayerList(await livemap.ask(manager, server, 'playerlist'));
  const pos = new Map();
  if (cfg.afk) {
    const reply = await livemap.pages(manager, server, 'players', 'players').catch(() => null);
    for (const [id, , x, z] of reply?.players || []) pos.set(String(id), [x, z]);
  }
  const list = rows.map((r) => ({ ...r, x: pos.get(r.id)?.[0] ?? null, z: pos.get(r.id)?.[1] ?? null }));
  const entry = state.get(server.id) || { tracks: new Map() };
  state.set(server.id, entry);
  const exempt = new Set(cfg.ignoreIds);
  if (cfg.ignoreAdmins) for (const id of adminIds(server)) exempt.add(id);
  const todo = evaluate(entry.tracks, list, cfg, Date.now(), exempt);
  const say = players.broadcastCommand(manager.template(server));
  const crowded = list.length >= cfg.minPlayers;
  for (const a of todo) {
    if (a.kind === 'warn' && say) await manager.sendCommand(server.id, players.fillBroadcast(say, MESSAGES[a.why](a.name, cfg.graceSeconds))).catch(() => {});
    if (a.kind === 'kick' && crowded) {
      // The id is checked to be 17 digits and the reason is fixed text.
      await manager.sendCommand(server.id, `kick ${a.id} "${KICK_REASON[a.why]}"`).catch(() => {});
      manager.store.addEvent('server.autokick', `${a.name} was kicked from ${server.name}: ${KICK_REASON[a.why].toLowerCase()}`, { serverId: server.id });
    }
  }
  return todo;
}

function start({ manager }) {
  const timer = setInterval(() => {
    for (const server of manager.servers) {
      if (server.templateId === 'rust' && server.rustTools?.afk?.enabled) check(manager, server).catch((err) => logger.debug(`AFK check on ${server.name}: ${err.message}`));
    }
  }, TICK_MS);
  timer.unref?.();
}

module.exports = { DEFAULTS, clean, settings, update, evaluate, parsePlayerList, adminIds, check, start };
