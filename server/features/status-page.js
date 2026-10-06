'use strict';

/**
 * A public, read-only page anyone with the link can open: which servers are
 * up, who is on and the address to join. Off until an admin turns it on, and
 * it only ever shows the servers picked for it.
 */

const crypto = require('crypto');

const DEFAULTS = { enabled: false, slug: '', title: '', description: '', servers: [], showPlayers: true, showAddress: true, host: '' };

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
        address: s.showAddress ? require('./dns').playerAddress(server) || undefined : undefined,
        version: p.gameVersion || null,
        uptime: running ? p.uptime : 0,
        joinNote: s.showAddress ? p.joinNote : null,
        uptime30: manager.uptime ? manager.uptime(server.id) : null,
      };
    });
  return {
    title: s.title || store.state.settings.panelName || 'GamePanel',
    description: s.description,
    host: s.showAddress ? s.host || null : null,
    showAddress: s.showAddress,
    servers,
    updatedAt: Date.now(),
  };
}

module.exports = { settings, update, publicView };
