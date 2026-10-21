'use strict';

/** Welcome messages, MOTD rotation, the public join feed switch and leaderboards. */

const { fail } = require('../../core/util');
const { RateLimiter } = require('../../core/ratelimit');
const { clientIp } = require('../helpers');
const welcome = require('../../features/welcome');
const leaderboards = require('../../features/leaderboards');
const statusPage = require('../../features/status-page');

module.exports = (router, { store, manager }, { requireAdmin, requireCap, serverFor, visibleServers }) => {
  router.put('/api/servers/:id/community-messages', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'schedules');
    requireCap(user, 'command', server.id);
    if (body?.welcome && !require('../../games/players').broadcastCommand(manager.template(server))) fail(400, 'This game has no chat broadcast command');
    return welcome.save(manager, server, body || {});
  });

  /** Top players across the servers this account can see. ?game= ?metric= */
  router.get('/api/leaderboards', ({ user, url }) => {
    const ids = new Set(visibleServers(user).map((s) => s.id));
    const servers = manager.servers.filter((s) => ids.has(s.id));
    return leaderboards.compute(manager, servers, { game: url.searchParams.get('game'), metric: url.searchParams.get('metric') });
  });

  // Anyone with the page's link can read this, so it is limited per address on top of the global limit.
  const boardLimit = new RateLimiter({ limit: 30, windowMs: 60_000 });
  router.get(
    '/api/public/status/:slug/leaderboards',
    ({ req, params, url }) => {
      if (!boardLimit.take(clientIp(req))) fail(429, 'Too many requests. Try again in a minute.');
      const servers = statusPage.publicServers(store, manager, params.slug);
      if (!servers) fail(404, 'This status page does not exist, is turned off or does not show players');
      return leaderboards.compute(manager, servers, { game: url.searchParams.get('game'), metric: url.searchParams.get('metric'), limit: 10 });
    },
    { public: true }
  );

  const view = () => {
    const s = statusPage.settings(store);
    return { showFeed: Boolean(s.showFeed), showBoards: s.showBoards !== false, publicServers: s.servers.length, enabled: s.enabled };
  };

  router.get('/api/community/settings', ({ user }) => {
    requireAdmin(user);
    return view();
  });

  router.put('/api/community/settings', ({ user, body }) => {
    requireAdmin(user);
    statusPage.update(store, { showFeed: body?.showFeed, showBoards: body?.showBoards });
    store.addEvent('settings.community', `${user.username} changed the public join feed / leaderboards`);
    return view();
  });
};
