'use strict';

/**
 * "Is my server really on the Steam server list?" Steam games (Rust, ARK,
 * Valheim, CS2 and friends) only get players from the in-game browser if the
 * master server has them. A server can be running, answer queries and still
 * be missing: wrong query port, blocked UDP, a bad IP, a Steam outage.
 *
 * Asks Steam's Web API (IGameServersService/GetServerList, needs the Steam
 * Web API key from Settings, Integrations) for the servers at this network's
 * public IP and looks for this one by its game or query port. Opt-in per
 * server: server.serverList = { enabled, ip }. An enabled server that is not
 * found on two checks in a row (after a grace period following its start)
 * raises server.unlisted; it raises server.relisted when it comes back.
 */

const { logger } = require('../core/util');
const { publicIp } = require('./reachability');

const CHECK_MS = 5 * 60_000;
const GRACE_MS = 10 * 60_000; // Steam takes a few minutes to list a fresh server
const MISSES_BEFORE_ALERT = 2;
const API = 'https://api.steampowered.com/IGameServersService/GetServerList/v1/';

/** Servers this check makes sense for: Steam games that answer the Steam query. */
const supports = (manager, server) => ['a2s', 'source'].includes(manager.template(server)?.query?.type);

const state = new Map(); // server id -> { listed, checkedAt, misses, error, entry, alerted }
let app = null;
let ipCache = { ip: null, at: 0 };

async function myIp() {
  if (ipCache.ip && Date.now() - ipCache.at < 10 * 60_000) return ipCache.ip;
  ipCache = { ip: await publicIp(), at: Date.now() };
  return ipCache.ip;
}

/** Match a Steam list entry to a server by its game or query port. */
function matches(entry, server) {
  const ports = [server.ports?.game, server.ports?.query].filter((p) => p != null).map(Number);
  const addrPort = Number(String(entry.addr || '').split(':')[1]);
  return ports.includes(Number(entry.gameport)) || ports.includes(addrPort);
}

async function lookup(ip, apiKey) {
  const url = `${API}?key=${encodeURIComponent(apiKey)}&limit=200&filter=${encodeURIComponent(`\\addr\\${ip}`)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'GamePanel server list check' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 403 || res.status === 401) throw new Error('Steam refused the Web API key. Check it in Settings, Integrations.');
  if (!res.ok) throw new Error(`Steam answered ${res.status}`);
  return (await res.json())?.response?.servers || [];
}

/** Check one server now and remember the answer. Never throws. */
async function check(manager, server, apiKey) {
  const prev = state.get(server.id) || { misses: 0, listed: null };
  const next = { ...prev, checkedAt: Date.now(), error: null };
  try {
    if (!apiKey) throw new Error('Add a Steam Web API key in Settings, Integrations first.');
    const ip = server.serverList?.ip || (await myIp());
    const hit = (await lookup(ip, apiKey)).find((e) => matches(e, server));
    next.ip = ip;
    next.listed = Boolean(hit);
    next.entry = hit ? { name: hit.name, players: hit.players, maxPlayers: hit.max_players, map: hit.map, region: hit.region } : null;
    next.misses = hit ? 0 : prev.misses + 1;
  } catch (err) {
    // Steam or the key failing says nothing about the server itself.
    next.error = err.message;
  }
  state.set(server.id, next);
  return next;
}

/** Alert on a drop (or a return) once a check has settled. */
function raise(manager, server, now) {
  const rt = manager.rt(server.id);
  const settled = rt.startedAt && Date.now() - rt.startedAt >= GRACE_MS;
  if (now.listed === false && now.misses >= MISSES_BEFORE_ALERT && settled && !now.alerted) {
    now.alerted = true;
    manager.store.addEvent('server.unlisted', `${server.name} is running but is not on the Steam server list, so players cannot find it in the in-game browser`, { serverId: server.id });
  } else if (now.listed && now.alerted) {
    now.alerted = false;
    manager.store.addEvent('server.relisted', `${server.name} is back on the Steam server list`, { serverId: server.id });
  }
}

async function sweep() {
  const { manager, store } = app;
  const apiKey = store.state.settings.integrations?.steamApiKey;
  if (!apiKey) return;
  for (const server of manager.servers) {
    if (!server.serverList?.enabled || !supports(manager, server) || manager.rt(server.id).status !== 'running') continue;
    const now = await check(manager, server, apiKey);
    if (!now.error) raise(manager, server, now);
  }
}

/** What the server page shows. */
function view(manager, server, apiKey) {
  const s = state.get(server.id) || {};
  return {
    supported: supports(manager, server),
    enabled: Boolean(server.serverList?.enabled),
    ip: server.serverList?.ip || '',
    hasKey: Boolean(apiKey),
    running: manager.rt(server.id).status === 'running',
    listed: s.listed ?? null,
    entry: s.entry || null,
    misses: s.misses || 0,
    checkedAt: s.checkedAt || null,
    error: s.error || null,
  };
}

function start(ctx) {
  app = ctx;
  const timer = setInterval(() => sweep().catch((err) => logger.debug(`Server list check failed: ${err.message}`)), CHECK_MS);
  timer.unref?.();
}

module.exports = { start, check, view, supports, matches, raise, GRACE_MS };
