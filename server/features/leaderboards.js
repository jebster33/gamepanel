'use strict';

/**
 * Leaderboards across every game and server.
 *
 * Every game has play time and visits (from the player history). Where the
 * game reports more, that is added: Minecraft's own statistics, and for games
 * with wipes the number of days a player showed up this wipe. A player is
 * matched by name, so the same name on several servers adds up.
 */

const DAY = 86_400_000;

const GENERIC = [
  { id: 'playtime', label: 'Play time', unit: 'h' },
  { id: 'sessions', label: 'Visits', unit: '' },
];
const MINECRAFT = [
  { id: 'mobKills', label: 'Mob kills', unit: '' },
  { id: 'playerKills', label: 'Player kills', unit: '' },
  { id: 'mined', label: 'Blocks mined', unit: '' },
  { id: 'km', label: 'Distance travelled', unit: ' km' },
  { id: 'deaths', label: 'Deaths', unit: '' },
  { id: 'advancements', label: 'Advancements', unit: '' },
];
const WIPE = [{ id: 'activeDays', label: 'Days active this wipe', unit: '' }];

const STATS_TTL = 10 * 60_000;
const statsCache = new Map(); // serverId -> { at, rows: Map(lowerName -> stats) }

const isMinecraft = (server) => String(server.templateId || '').startsWith('minecraft') && server.templateId !== 'minecraft-bedrock';

/** Minecraft statistics for everyone the server has seen, cached because it reads many files. */
function minecraftStats(manager, server, names) {
  const hit = statsCache.get(server.id);
  if (hit && Date.now() - hit.at < STATS_TTL) return hit.rows;
  const rows = new Map();
  for (const name of names.slice(0, 300)) {
    try {
      const st = manager.playerStats?.(server, name);
      if (st) rows.set(name.toLowerCase(), st);
    } catch {
      /* no stats for this one */
    }
  }
  statsCache.set(server.id, { at: Date.now(), rows });
  return rows;
}

function popcount(n) {
  let c = 0;
  for (let v = n >>> 0; v; v &= v - 1) c++;
  return c;
}

function metricsFor(manager, servers) {
  const out = [...GENERIC];
  if (servers.some(isMinecraft)) out.push(...MINECRAFT);
  if (servers.some((s) => manager.template(s)?.wipe)) out.push(...WIPE);
  return out;
}

/**
 * The top `limit` players for one metric over `servers`.
 * Returns { games, metrics, game, metric, rows: [{ rank, name, value, display, servers }] }.
 */
function compute(manager, servers, { game, metric, limit = 10 } = {}) {
  const games = [];
  for (const s of servers) {
    if (!games.some((g) => g.id === s.templateId)) games.push({ id: s.templateId, name: manager.template(s)?.name || s.templateId });
  }
  const chosen = game && games.some((g) => g.id === game) ? game : null;
  const pool = chosen ? servers.filter((s) => s.templateId === chosen) : servers;
  const metrics = metricsFor(manager, pool);
  const def = metrics.find((m) => m.id === metric) || metrics[0];
  const totals = new Map();
  const add = (name, value, serverId) => {
    if (!(value > 0)) return;
    const key = name.toLowerCase();
    const row = totals.get(key) || { name, value: 0, servers: new Set() };
    row.value += value;
    row.servers.add(serverId);
    totals.set(key, row);
  };

  for (const server of pool) {
    const h = manager.playerHistory?.(server.id);
    if (!h) continue;
    if (def.id === 'playtime') for (const p of h.players) add(p.name, p.seconds / 3600, server.id);
    else if (def.id === 'sessions') for (const p of h.players) add(p.name, p.sessions, server.id);
    else if (def.id === 'activeDays') {
      const wipe = manager.history(server.id).wipes?.slice(-1)[0];
      if (wipe) for (const [name, entry] of Object.entries(wipe.players)) add(name, popcount(entry[1]), server.id);
    } else if (isMinecraft(server)) {
      const rows = minecraftStats(manager, server, h.players.map((p) => p.name));
      for (const p of h.players) add(p.name, Number(rows.get(p.name.toLowerCase())?.[def.id]) || 0, server.id);
    }
  }

  const fmt = (v) => (def.id === 'playtime' ? Math.round(v * 10) / 10 : def.id === 'km' ? Math.round(v * 100) / 100 : Math.round(v));
  const rows = [...totals.values()]
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map((r, i) => ({ rank: i + 1, name: r.name, value: fmt(r.value), display: `${fmt(r.value).toLocaleString('en-US')}${def.unit}`, servers: r.servers.size }));
  return { games, metrics: metrics.map(({ id, label }) => ({ id, label })), game: chosen, metric: def.id, rows };
}

module.exports = { compute, DAY };
