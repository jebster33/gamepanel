'use strict';

/**
 * The Players page: warnings and notes shared by all staff, alt accounts,
 * join protection (VPN and proxy blocking), the peak-time heatmap and where
 * players connect from.
 */

const { fail } = require('../../core/util');
const records = require('../../features/player-records');
const security = require('../../features/player-security');

module.exports = (router, { store, auth, manager }, { requireAdmin, requireCap, visibleServers }) => {
  const consoleIds = (user) => visibleServers(user).filter((s) => !s.node && auth.can(user, 'console', s.id)).map((s) => s.id);

  /* ------------------------------------------------- warnings and notes -- */

  router.get('/api/player-records', ({ user, url }) => {
    requireCap(user, 'command');
    return { players: records.overview(store, url.searchParams.get('q') || ''), settings: records.settings(store) };
  });

  router.get('/api/player-records/:name', ({ user, params }) => {
    requireCap(user, 'command');
    return records.file(store, params.name);
  });

  router.post('/api/player-records', async ({ user, body }) => {
    requireCap(user, 'command');
    if (body?.serverId) {
      const server = manager.require(String(body.serverId));
      if (!auth.canAccessServer(user, server.id)) fail(403, 'You do not have access to this server');
    }
    if (body?.kind === 'warning') return records.warn(manager, store, body, user.username);
    return { record: records.add(store, body || {}, user.username) };
  });

  router.delete('/api/player-records/:id', ({ user, params }) => {
    requireAdmin(user);
    return records.revoke(store, params.id, user.username);
  });

  router.put('/api/player-records-settings', ({ user, body }) => {
    requireAdmin(user);
    return records.updateSettings(store, body || {});
  });

  /* ------------------------------------------------------------- alts etc -- */

  // Addresses are personal data: administrators only, like the player profile.
  router.get('/api/player-insights/alts', ({ user }) => {
    requireAdmin(user);
    return security.alts(manager, store, manager.servers.filter((s) => !s.node).map((s) => s.id));
  });

  router.get('/api/player-insights/heatmap', ({ user, url }) => {
    const ids = consoleIds(user);
    const only = url.searchParams.get('server');
    return security.heatmap(manager, only ? ids.filter((id) => id === only) : ids);
  });

  router.get('/api/player-insights/countries', ({ user, url }) => {
    requireAdmin(user);
    const ids = manager.servers.filter((s) => !s.node).map((s) => s.id);
    const only = url.searchParams.get('server');
    return security.countries(manager, store, only ? ids.filter((id) => id === only) : ids);
  });

  router.get('/api/join-protection', ({ user }) => {
    requireAdmin(user);
    return security.view(store);
  });

  router.put('/api/join-protection', ({ user, body }) => {
    requireAdmin(user);
    return security.update(store, body || {});
  });
};
