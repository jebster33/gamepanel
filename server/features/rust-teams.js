'use strict';

/**
 * Rust read-outs built on the live map plugin (GamePanelMap.cs):
 *
 *   teams()     Rust teams with their members, online state and bases
 *               (tool cupboards), plus the Clans plugin's clans when it is there
 *   entities()  how many things each player has built, biggest first, to spot
 *               the bases that cost the server the most
 *   infoCard()  the public-safe facts about the server and a join link
 *
 * Teams and entities need the console permission: positions and names of
 * players are sensitive. The info card has no secrets in it.
 */

const fs = require('fs');
const { containedPath } = require('./files');
const livemap = require('./rust-livemap');
const dns = require('./dns');

const STEAM_ID = /^\d{17}$/;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* ----------------------------------------------------------------- clans -- */

/** Ids from a members value: an array of ids or objects, or an object keyed by id. */
function memberIds(value) {
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.entries(value).map(([k, v]) => (STEAM_ID.test(k) ? k : v)) : [];
  return rows.map((m) => String(m && typeof m === 'object' ? m.id ?? m.steamId ?? m.userID ?? m.userId ?? m.playerId ?? '' : m)).filter((id) => STEAM_ID.test(id));
}

/** Clans from the Clans plugin's data file. Layouts differ between versions, so this is forgiving. */
function parseClans(json) {
  const root = json && typeof json === 'object' ? json.clans ?? json : {};
  const list = Array.isArray(root) ? root : Object.entries(root).map(([key, v]) => ({ ...(v && typeof v === 'object' ? v : {}), _key: key }));
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const members = memberIds(c.members ?? c.memberIds ?? c.players);
    const tag = String(c.tag ?? c.clanTag ?? c.name ?? c._key ?? '').slice(0, 24);
    if (!tag || !members.length) continue;
    const owner = String(c.ownerID ?? c.ownerId ?? c.owner ?? c.leader ?? c.leaderId ?? '');
    out.push({ tag, owner: STEAM_ID.test(owner) ? owner : null, members });
  }
  return out;
}

function readClans(server) {
  for (const file of ['oxide/data/clans.json', 'oxide/data/Clans.json', 'oxide/data/clan_data.json']) {
    try {
      return parseClans(JSON.parse(fs.readFileSync(containedPath(server.dir, file), 'utf8')));
    } catch {
      /* not there, or not readable */
    }
  }
  return null;
}

/* ----------------------------------------------------------------- teams -- */

/** Join the plugin's teams, the online players and the bases into what the page shows. */
function buildTeams({ teams, players = [], bases = [], clans = null }) {
  const online = new Map(players.map((p) => [String(p.id), p]));
  const names = new Map();
  for (const p of players) names.set(String(p.id), p.name);
  for (const b of bases) if (b.owner && b.name && !names.has(String(b.owner))) names.set(String(b.owner), b.name);
  const clanOf = new Map();
  for (const c of clans || []) for (const id of c.members) clanOf.set(id, c.tag);
  const basesOf = (ids) =>
    bases
      .filter((b) => ids.includes(String(b.owner)))
      .map((b) => ({ owner: String(b.owner), x: b.x, z: b.z, authorized: b.members, name: b.name || null }));
  const rows = teams.map(([id, leader, ids]) => {
    const members = ids.map((m) => ({ id: m, name: names.get(m) || null, online: online.has(m), leader: m === leader, clan: clanOf.get(m) || null, x: online.get(m)?.x ?? null, z: online.get(m)?.z ?? null }));
    return { id, members, online: members.filter((m) => m.online).length, bases: basesOf(ids) };
  });
  rows.sort((a, b) => b.online - a.online || b.members.length - a.members.length);
  return {
    teams: rows,
    clans: (clans || []).map((c) => ({ tag: c.tag, owner: c.owner, members: c.members.map((id) => ({ id, name: names.get(id) || null, online: online.has(id) })), bases: basesOf(c.members) })),
  };
}

async function teams(manager, store, server) {
  const map = await livemap.snapshot(manager, store, server);
  if (!map.running) return { available: false, reason: 'The server is not running.' };
  if (!map.live) return { available: false, reason: map.error || 'The live map plugin did not answer. Install it on the Live map tab.', plugin: map.plugin };
  const reply = await livemap.pages(manager, server, 'teams', 'teams').catch(() => null);
  if (!reply) return { available: false, reason: 'The live map plugin is out of date. Update it on the Live map tab to see teams.', plugin: map.plugin };
  return { available: true, ...buildTeams({ teams: reply.teams, players: map.players, bases: map.bases, clans: readClans(server) }) };
}

/* -------------------------------------------------------------- entities -- */

const CAUTION = 1500; // entities one player owns before it is flagged as heavy

function shapeOwners(rows, players = []) {
  const online = new Set(players.map((p) => String(p.id)));
  const owners = rows.map(([id, name, total, blocks, deployables, x, y, z]) => ({
    id: String(id),
    name: name || null,
    total: num(total),
    blocks: num(blocks),
    deployables: num(deployables),
    x: num(x),
    y: num(y),
    z: num(z),
    online: online.has(String(id)),
    heavy: num(total) >= CAUTION,
    // Rust's own admin command; paste it into the console to stand at the base.
    teleport: `teleportpos (${Math.round(num(x))},${Math.round(num(y)) + 2},${Math.round(num(z))})`,
  }));
  return owners.sort((a, b) => b.total - a.total);
}

async function entities(manager, store, server) {
  if (server.status !== 'running' || !livemap.hasRcon(manager, server)) return { available: false, reason: 'The server is not running.' };
  const reply = await livemap.pages(manager, server, 'entities', 'owners').catch(() => null);
  if (!reply) return { available: false, reason: 'The live map plugin did not answer or is out of date. Install or update it on the Live map tab.' };
  const map = await livemap.snapshot(manager, store, server).catch(() => ({ players: [] }));
  return { available: true, all: num(reply.all), caution: CAUTION, owners: shapeOwners(reply.owners, map.players) };
}

/* ------------------------------------------------------------- info card -- */

function httpsUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Public-safe fields only: no RCON password, no paths, no tokens. */
function infoCard(manager, server, host) {
  const vars = manager.vars(server);
  const rt = manager.rt ? manager.rt(server.id) : {};
  const port = server.ports?.game;
  const address = dns.playerAddress(server) || (host && port ? `${host}:${port}` : null);
  return {
    name: String(vars.HOSTNAME_FULL || vars.SERVER_HOSTNAME || server.name),
    description: String(vars.SERVER_DESCRIPTION || ''),
    headerImage: httpsUrl(vars.HEADER_IMAGE),
    url: httpsUrl(vars.SERVER_URL),
    tags: String(vars.SERVER_TAGS || ''),
    address,
    connect: address ? `steam://connect/${address}` : null,
    rustPlusPort: server.ports?.app || null,
    seed: num(vars.WORLD_SEED),
    size: num(vars.WORLD_SIZE),
    maxPlayers: num(vars.MAX_PLAYERS) || server.maxPlayers || 0,
    players: rt.players ?? rt.playerList?.length ?? 0,
    status: server.status,
    lastWipe: server.lastWipe?.at || null,
    gatherRate: num(vars.GATHER_RATE) || 1,
    teamLimit: num(vars.TEAM_LIMIT) || null,
  };
}

module.exports = { parseClans, readClans, buildTeams, shapeOwners, teams, entities, infoCard, CAUTION };
