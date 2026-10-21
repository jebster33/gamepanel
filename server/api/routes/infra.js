'use strict';

/** Servers as a file, and the repository-backed config sync. Administrators only. */

const { fail } = require('../../core/util');
const infra = require('../../features/infra-as-code');
const sync = require('../../features/config-sync');
const { RateLimiter } = require('../../core/ratelimit');

module.exports = (router, { store, manager }, { requireAdmin }) => {
  const text = (body) => {
    const t = typeof body?.text === 'string' ? body.text : '';
    if (!t.trim()) fail(400, 'Paste or load the servers file first');
    return t;
  };

  router.get('/api/infra/export', ({ user }) => {
    requireAdmin(user);
    return { yaml: infra.exportYaml(manager) };
  });
  router.post('/api/infra/plan', ({ user, body }) => {
    requireAdmin(user);
    return infra.publicPlan(infra.computePlan(manager, text(body)));
  });
  router.post('/api/infra/apply', async ({ user, body }) => {
    requireAdmin(user);
    return infra.apply(manager, text(body), user, { confirmPrune: body?.confirmPrune === true });
  });

  /* -------------------------------------------------------- config sync -- */
  const heavy = new RateLimiter({ limit: 20, windowMs: 3_600_000 });
  const limited = (user) => {
    if (!heavy.take(user.id)) fail(429, 'Too many syncs this hour. Try again later.');
  };

  router.get('/api/config-sync', ({ user }) => {
    requireAdmin(user);
    return sync.view(store, manager);
  });
  router.put('/api/config-sync', ({ user, body }) => {
    requireAdmin(user);
    sync.save(store, body || {});
    return sync.view(store, manager);
  });
  router.post('/api/config-sync/run', async ({ user }) => {
    requireAdmin(user);
    limited(user);
    const result = await sync.sync({ store, manager }, { reason: `Sync by ${user.username}` });
    return { result, state: sync.view(store, manager) };
  });
  router.post('/api/config-sync/restore/preview', async ({ user }) => {
    requireAdmin(user);
    limited(user);
    return sync.restorePreview({ store, manager });
  });
  router.post('/api/config-sync/restore/apply', async ({ user, body }) => {
    requireAdmin(user);
    return sync.restoreApply({ store, manager }, { settings: body?.settings === true, servers: body?.servers === true, files: body?.files === true }, user);
  });
};
