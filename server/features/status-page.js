'use strict';

/**
 * A public, read-only page anyone with the link can open: which servers are
 * up, who is on and the address to join. Off until an admin turns it on, and
 * it only ever shows the servers picked for it.
 */

const crypto = require('crypto');
const fs = require('fs');
const { fail } = require('../core/util');

const DEFAULTS = { enabled: false, slug: '', title: '', description: '', servers: [], showPlayers: true, showAddress: true, showMotd: true, host: '', links: { discord: '', vote: '', website: '' }, blurbs: {} };

// Games the Steam client can join straight from a link (steam://connect/host:port).
const STEAM_CONNECT = new Set(['cs2', 'tf2', 'left4dead', 'left4dead2', 'garrysmod', 'rust', 'counter-strike-source', 'day-of-defeat-source', 'half-life-2-deathmatch', 'no-more-room-in-hell', 'insurgency-2014', 'day-of-infamy']);

/** A link the page offers: http(s) only, so nothing else can be smuggled into an href. */
function cleanUrl(value, label) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(url) || url.length > 300) fail(400, `The ${label} link must start with https://`);
  return url;
}

/** Minecraft's message of the day from server.properties, without colour codes. */
function readMotd(server) {
  try {
    const file = require('./files').containedPath(server.dir, 'server.properties');
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => /^motd\s*=/.test(l));
    if (!line) return null;
    const raw = line.replace(/^motd\s*=\s*/, '').replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\n/g, ' ').replace(/\\(.)/g, '$1');
    return raw.replace(/§[0-9a-fk-or]/gi, '').trim().slice(0, 200) || null;
  } catch {
    return null;
  }
}

/** A one-click join link where the game has one. */
function joinUrl(server, address) {
  if (!address) return null;
  if (STEAM_CONNECT.has(server.templateId)) return `steam://connect/${address}`;
  if (server.templateId === 'fivem') return `fivem://connect/${address}`;
  return null;
}

function settings(store) {
  return { ...DEFAULTS, ...(store.state.settings.statusPage || {}) };
}

function newSlug() {
  return crypto.randomBytes(9).toString('base64url');
}

function update(store, body) {
  const s = settings(store);
  if (body.enabled !== undefined) s.enabled = Boolean(body.enabled);
  if (body.title !== undefined) s.title = String(body.title).trim().slice(0, 60);
  if (body.description !== undefined) s.description = String(body.description).trim().slice(0, 200);
  if (Array.isArray(body.servers)) s.servers = body.servers.map(String).slice(0, 100);
  if (body.showPlayers !== undefined) s.showPlayers = Boolean(body.showPlayers);
  if (body.showAddress !== undefined) s.showAddress = Boolean(body.showAddress);
  if (body.showMotd !== undefined) s.showMotd = Boolean(body.showMotd);
  if (body.links) s.links = { discord: cleanUrl(body.links.discord, 'Discord'), vote: cleanUrl(body.links.vote, 'vote'), website: cleanUrl(body.links.website, 'website') };
  if (body.blurbs && typeof body.blurbs === 'object') {
    s.blurbs = {};
    for (const [id, text] of Object.entries(body.blurbs)) {
      const clean = String(text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
      if (clean) s.blurbs[String(id)] = clean;
    }
  }
  if (body.host !== undefined) s.host = String(body.host).trim().replace(/^https?:\/\//, '').replace(/[/:].*$/, '').slice(0, 253);
  if (body.newLink || !s.slug) s.slug = newSlug();
  store.state.settings.statusPage = s;
  store.save();
  return s;
}

/** What the public page gets. Nothing here may identify more than the admin chose to show. */
function publicView(store, manager, slug) {
  const s = settings(store);
  if (!s.enabled || !s.slug || slug !== s.slug) return null;
  const servers = s.servers
    .map((id) => manager.servers.find((x) => x.id === id))
    .filter(Boolean)
    .map((server) => {
      const p = manager.publicServer(server);
      const running = p.status === 'running';
      return {
        id: server.id,
        name: server.name,
        game: p.templateName,
        icon: p.templateIcon,
        status: running ? 'online' : p.status === 'starting' ? 'starting' : 'offline',
        maintenance: server.maintenance ? server.maintenance.message : undefined,
        players: running ? p.players ?? p.playerList.length : 0,
        maxPlayers: p.maxPlayers,
        playerNames: s.showPlayers && running ? p.playerList.slice(0, 100) : undefined,
        port: s.showAddress ? p.ports?.game ?? Object.values(p.ports || {})[0] : undefined,
        motd: s.showMotd && p.templateCategory === 'Minecraft' ? readMotd(server) : null,
        blurb: s.blurbs?.[server.id] || null,
        join: s.showAddress ? joinUrl(server, `${require('./dns').playerAddress(server) || `${s.host || '{host}'}:${p.ports?.game ?? Object.values(p.ports || {})[0]}`}`) : null,
        address: s.showAddress ? require('./dns').playerAddress(server) || undefined : undefined,
        version: p.gameVersion || null,
        uptime: running ? p.uptime : 0,
        joinNote: s.showAddress ? p.joinNote : null,
        mapPort: s.showAddress && server.ports?.map ? server.ports.map : undefined,
        mapUrl: require('../games/world-maps').publicMapUrl(server) || undefined,
        uptime30: manager.uptime ? manager.uptime(server.id) : null,
        topPlayers: s.showPlayers && manager.playerHistory
          ? manager.playerHistory(server.id).players.filter((x) => x.seconds >= 60).sort((a, b) => b.seconds - a.seconds).slice(0, 5).map((x) => ({ name: x.name, hours: Math.round(x.seconds / 360) / 10 }))
          : undefined,
        leaderboards: s.showPlayers && manager.leaderboards ? manager.leaderboards(server) : undefined,
      };
    });
  return {
    title: s.title || store.state.settings.panelName || 'GamePanel',
    description: s.description,
    host: s.showAddress ? s.host || null : null,
    showAddress: s.showAddress,
    links: s.links || DEFAULTS.links,
    servers,
    updatedAt: Date.now(),
  };
}

module.exports = { settings, update, publicView, readMotd, joinUrl };
