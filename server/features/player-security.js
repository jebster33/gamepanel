'use strict';

/**
 * Who is joining: VPN and proxy blocking, alt account detection and what the
 * player history says about where and when people play.
 *
 * Join protection (settings.joinProtection) looks each new address up on
 * proxycheck.io. In "log" mode a VPN or proxy join is only recorded; in "kick"
 * mode the player is kicked (and optionally put on the shared ban list). An
 * address, or a player, can be allowed. A failed lookup never blocks anyone.
 * Addresses are sent to proxycheck.io, so the feature is off by default.
 *
 * Alts: accounts that joined from the same address. Many names on one address
 * is usually a shared network (a school, a mobile carrier), so addresses with
 * more than a handful of names are listed apart as "busy".
 */

const secrets = require('../core/secrets');
const { fail, logger } = require('../core/util');
const geoip = require('./geoip');
const records = require('./player-records');
const cidr = require('../core/cidr');

const DEFAULTS = { mode: 'off', ban: false, apiKey: '', allowIps: [], allowNames: [], flagAlts: true, altKick: false };
const CACHE_MS = 24 * 3600_000;
const BUSY = 6;
const cache = new Map();
const recentlyChecked = new Map();

const settings = (store) => ({ ...DEFAULTS, ...(store.state.settings.joinProtection || {}) });
const isPrivate = (ip) => Boolean(geoip.classifyPrivate(ip));

function view(store) {
  const s = settings(store);
  return { mode: s.mode, ban: s.ban, flagAlts: s.flagAlts, altKick: s.altKick, allowIps: s.allowIps, allowNames: s.allowNames, apiKeySet: Boolean(s.apiKey) };
}

function update(store, body = {}) {
  const s = settings(store);
  if (body.mode !== undefined) {
    if (!['off', 'log', 'kick'].includes(body.mode)) fail(400, 'Mode: off, log or kick');
    s.mode = body.mode;
  }
  for (const k of ['ban', 'flagAlts', 'altKick']) if (body[k] !== undefined) s[k] = Boolean(body[k]);
  if (body.allowIps !== undefined) {
    const items = (Array.isArray(body.allowIps) ? body.allowIps : String(body.allowIps).split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
    for (const item of items) if (!cidr.parseCidr(item)) fail(400, `"${item}" is not an address or range like 203.0.113.0/24`);
    s.allowIps = items;
  }
  if (body.allowNames !== undefined) {
    s.allowNames = (Array.isArray(body.allowNames) ? body.allowNames : String(body.allowNames).split(/[\s,]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 200);
  }
  if (body.clearApiKey) s.apiKey = '';
  else if (String(body.apiKey || '').trim()) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(body.apiKey).trim())) fail(400, 'That does not look like a proxycheck.io key');
    s.apiKey = secrets.seal(String(body.apiKey).trim());
  }
  store.state.settings.joinProtection = s;
  store.save();
  return view(store);
}

/** { proxy: boolean, type, provider } or null when unknown. */
async function check(ip, key) {
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  let result = null;
  try {
    const res = await fetch(`https://proxycheck.io/v2/${encodeURIComponent(ip)}?vpn=1&asn=1${key ? `&key=${encodeURIComponent(key)}` : ''}`, { headers: { 'User-Agent': 'GamePanel/1.0' }, signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const entry = data?.[ip];
    if (entry && data.status !== 'error' && data.status !== 'denied') result = { proxy: entry.proxy === 'yes', type: entry.type || null, provider: entry.provider || entry.organisation || null };
  } catch (err) {
    logger.debug(`proxycheck for ${ip}: ${err.message}`);
  }
  cache.set(ip, { at: Date.now(), result });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return result;
}

const allowed = (s, name, ip) => s.allowNames.includes(String(name).toLowerCase()) || cidr.matchesAny(s.allowIps, ip);

/** Called when a player's address is first seen (see history.noteAddress). */
function onJoin(manager, server, name, ip) {
  const store = manager.store;
  const s = settings(store);
  if (!ip || isPrivate(ip) || allowed(s, name, ip)) return;
  const stamp = `${server.id}:${name}:${ip}`;
  if (Date.now() - (recentlyChecked.get(stamp) || 0) < 60_000) return;
  recentlyChecked.set(stamp, Date.now());
  if (recentlyChecked.size > 2000) recentlyChecked.delete(recentlyChecked.keys().next().value);

  if (s.flagAlts) flagAlts(manager, server, name, ip, s);
  if (s.mode === 'off') return;
  check(ip, s.apiKey ? secrets.open(s.apiKey) : '')
    .then(async (r) => {
      if (!r?.proxy) return;
      const what = `${r.type || 'VPN or proxy'}${r.provider ? ` (${r.provider})` : ''}`;
      records.add(store, { name, kind: 'action', text: `Joined ${server.name} through a ${what}${s.mode === 'kick' ? ': kicked' : ''}`, serverId: server.id }, 'panel');
      if (s.mode !== 'kick') {
        store.addEvent('player.vpn_blocked', `${name} joined ${server.name} through a ${what} (not blocked: log only)`, { serverId: server.id });
        return;
      }
      const tpl = manager.template(server);
      const cmds = require('../games/players').playerCommands(tpl);
      if (cmds.kick) {
        const reason = ' VPNs and proxies are not allowed on this server';
        await manager.sendCommand(server.id, cmds.kick.replace(/\{name\}/g, String(name).replace(/["\r\n;]/g, '')) + (/^minecraft/.test(tpl?.id || '') ? reason : ''));
      }
      if (s.ban) await require('./bans').ban(manager, store, { name, reason: 'Joined through a VPN or proxy', hours: 0 }, 'join protection').catch(() => {});
      store.addEvent('player.vpn_blocked', `${name} was kicked from ${server.name}: joined through a ${what}${cmds.kick ? '' : ' (this game has no kick command, so only recorded)'}`, { serverId: server.id });
    })
    .catch((err) => logger.debug(`Join protection: ${err.message}`));
}

/** Someone who joins from the address of a banned player. */
function flagAlts(manager, server, name, ip, s) {
  const store = manager.store;
  const banned = new Set((store.state.bans?.list || []).filter((b) => !b.until || b.until > Date.now()).map((b) => String(b.name).toLowerCase()));
  if (!banned.size) return;
  const lower = String(name).toLowerCase();
  if (banned.has(lower)) return;
  const names = new Set();
  for (const sv of manager.servers) {
    for (const [other, list] of Object.entries(manager.history(sv.id).ips || {})) {
      if (other.toLowerCase() !== lower && list.some((e) => e.ip === ip)) names.add(other);
    }
  }
  const hit = [...names].find((n) => banned.has(n.toLowerCase()));
  if (!hit) return;
  records.add(store, { name, kind: 'action', text: `Joined ${server.name} from the same address as banned player ${hit}`, serverId: server.id }, 'panel');
  store.addEvent('player.watched', `${name} joined ${server.name} from the same address as banned player ${hit}`, { serverId: server.id });
  if (s.altKick) {
    const cmds = require('../games/players').playerCommands(manager.template(server));
    if (cmds.kick) manager.sendCommand(server.id, cmds.kick.replace(/\{name\}/g, String(name).replace(/["\r\n;]/g, ''))).catch(() => {});
  }
}

/* ------------------------------------------------------------- insights -- */

/**
 * Accounts that share addresses, across every server: clusters of names joined by a shared
 * address. `busy` addresses (many names) are listed on their own, not used to link accounts.
 */
function alts(manager, store, serverIds) {
  const byIp = new Map();
  const seen = new Map(); // lower name -> { name, servers:Set, last }
  for (const id of serverIds) {
    const h = manager.history(id);
    for (const [name, list] of Object.entries(h.ips || {})) {
      const k = name.toLowerCase();
      const acc = seen.get(k) || { name, servers: new Set(), last: 0 };
      acc.servers.add(id);
      for (const e of list) {
        if (isPrivate(e.ip) || /^(127\.|::1$)/.test(e.ip)) continue;
        acc.last = Math.max(acc.last, e.last || 0);
        (byIp.get(e.ip) || byIp.set(e.ip, new Set()).get(e.ip)).add(k);
      }
      seen.set(k, acc);
    }
  }
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const busy = [];
  const linking = new Map();
  for (const [ip, names] of byIp) {
    if (names.size < 2) continue;
    if (names.size > BUSY) {
      busy.push({ ip, names: names.size });
      continue;
    }
    const arr = [...names];
    for (const n of arr) if (!parent.has(n)) parent.set(n, n);
    for (const n of arr.slice(1)) parent.set(find(n), find(arr[0]));
    linking.set(ip, arr);
  }
  const groups = new Map();
  for (const n of parent.keys()) (groups.get(find(n)) || groups.set(find(n), []).get(find(n))).push(n);
  const banned = new Set((store.state.bans?.list || []).filter((b) => !b.until || b.until > Date.now()).map((b) => String(b.name).toLowerCase()));
  const clusters = [...groups.values()]
    .map((names) => {
      const ips = [...linking].filter(([, arr]) => names.includes(arr[0])).map(([ip]) => ip);
      return {
        accounts: names.map((n) => ({ name: seen.get(n).name, banned: banned.has(n), last: seen.get(n).last, points: records.pointsOf(store, n) })).sort((a, b) => b.last - a.last),
        ips,
        strong: ips.length >= 2,
      };
    })
    .sort((a, b) => b.accounts.filter((x) => x.banned).length - a.accounts.filter((x) => x.banned).length || b.accounts.length - a.accounts.length)
    .slice(0, 200);
  return { clusters, busy: busy.sort((a, b) => b.names - a.names).slice(0, 30) };
}

/** Average players online by weekday and hour (local time) from the last 4 weeks of samples. */
function heatmap(manager, serverIds) {
  const sum = Array.from({ length: 7 }, () => Array(24).fill(0));
  const count = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const id of serverIds) {
    for (const [t, n] of manager.history(id).samples) {
      if (n == null) continue;
      const d = new Date(t);
      sum[d.getDay()][d.getHours()] += n;
      count[d.getDay()][d.getHours()]++;
    }
  }
  const grid = sum.map((row, d) => row.map((v, h) => (count[d][h] ? Math.round((v / count[d][h]) * 10) / 10 : null)));
  const flat = grid.flat().filter((v) => v != null);
  const max = flat.length ? Math.max(...flat) : 0;
  let best = null;
  grid.forEach((row, d) => row.forEach((v, h) => v != null && (!best || v > best.avg) && (best = { day: d, hour: h, avg: v })));
  return { grid, max, best, days: 28 };
}

let backfilling = false;

/** Players per country from the addresses seen. Older addresses are looked up in the background. */
function countries(manager, store, serverIds) {
  const byCc = new Map();
  const missing = [];
  for (const id of serverIds) {
    for (const [name, list] of Object.entries(manager.history(id).ips || {})) {
      const latest = [...list].sort((a, b) => b.last - a.last).find((e) => !isPrivate(e.ip));
      if (!latest) continue;
      if (!latest.cc) {
        missing.push({ id, name, entry: latest });
        continue;
      }
      const e = byCc.get(latest.cc) || { cc: latest.cc, players: new Set(), lat: 0, lon: 0, n: 0 };
      e.players.add(`${id}:${name.toLowerCase()}`);
      if (latest.lat != null) {
        e.lat += latest.lat;
        e.lon += latest.lon;
        e.n++;
      }
      byCc.set(latest.cc, e);
    }
  }
  if (missing.length && !backfilling && store.state.settings.geoLookup !== false) backfill(manager, missing.slice(0, 30));
  const list = [...byCc.values()].map((e) => ({ cc: e.cc, players: e.players.size, lat: e.n ? e.lat / e.n : null, lon: e.n ? e.lon / e.n : null })).sort((a, b) => b.players - a.players);
  return { countries: list, total: list.reduce((a, c) => a + c.players, 0), pending: missing.length };
}

async function backfill(manager, items) {
  backfilling = true;
  try {
    for (const { id, entry } of items) {
      const info = await geoip.lookup(entry.ip, { enabled: true });
      if (info?.cc) {
        Object.assign(entry, { where: info.label, cc: info.cc, lat: info.lat, lon: info.lon });
        manager.history(id).dirty = true;
      }
    }
  } finally {
    backfilling = false;
  }
}

module.exports = { view, update, onJoin, check, alts, heatmap, countries, settings };
