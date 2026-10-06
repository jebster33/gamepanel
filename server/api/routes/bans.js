'use strict';

const { fail } = require('../../core/util');
const { RateLimiter } = require('../../core/ratelimit');
const { clientIp } = require('../helpers');
const bans = require('../../features/bans');

module.exports = (router, { store, manager }, { requireAdmin, serverFor }) => {
  router.get('/api/bans', ({ user }) => {
    requireAdmin(user);
    return bans.view(manager, store);
  });

  router.post('/api/bans', async ({ user, body }) => {
    requireAdmin(user);
    await bans.ban(manager, store, body || {}, user.username);
    return bans.view(manager, store);
  });

  router.delete('/api/bans/:id', async ({ user, params }) => {
    requireAdmin(user);
    await bans.unban(manager, store, params.id, user.username);
    return bans.view(manager, store);
  });

  router.put('/api/bans/servers/:id', async ({ user, params, body }) => {
    requireAdmin(user);
    await bans.setServer(manager, store, serverFor(user, params.id), Boolean(body?.enabled));
    return bans.view(manager, store);
  });

  router.put('/api/bans/appeal-settings', ({ user, body }) => {
    requireAdmin(user);
    bans.updateAppealSettings(store, body || {});
    return bans.view(manager, store);
  });

  router.post('/api/bans/appeals/:id', async ({ user, params, body }) => {
    requireAdmin(user);
    await bans.decide(manager, store, params.id, body || {}, user.username);
    return bans.view(manager, store);
  });

  /* ----------------------------------------------------- public appeals -- */

  // Anyone can post, so a few per hour per address.
  const appealLimit = new RateLimiter({ limit: 5, windowMs: 3_600_000 });

  router.get(
    '/api/public/appeals',
    () => {
      const s = bans.appealSettings(store);
      const page = store.state.settings.statusPage || {};
      return { enabled: s.enabled, intro: s.intro, panelName: store.state.settings.panelName || 'GamePanel', accent: page.accent || null };
    },
    { public: true }
  );

  router.post(
    '/api/public/appeals',
    ({ req, body }) => {
      const ip = clientIp(req);
      if (!appealLimit.take(ip)) fail(429, 'Too many appeals from your address. Try again later.');
      return bans.submitAppeal(store, body || {});
    },
    { public: true }
  );

  router.get('/api/public/appeals/:code', ({ params }) => bans.appealStatus(store, params.code), { public: true });
};
