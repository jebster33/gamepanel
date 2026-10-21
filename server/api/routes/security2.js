'use strict';

/**
 * Security and access: generic OpenID Connect settings, the IP allowlist,
 * connection flood blocking and backup test restores. Administrators only.
 */

const { fail } = require('../../core/util');
const { clientIp } = require('../helpers');
const oidc = require('../../features/oidc');
const allowlist = require('../../features/ip-allowlist');
const flood = require('../../features/flood');
const backupTest = require('../../features/backup-test');

module.exports = (router, app, { requireAdmin }) => {
  const { store, manager } = app;

  /* ------------------------------------------------------------ OIDC -- */

  router.get('/api/settings/oidc', ({ user, req }) => {
    requireAdmin(user);
    return oidc.adminView(store, req);
  });

  router.put('/api/settings/oidc', ({ user, req, body }) => {
    requireAdmin(user);
    oidc.update(store, body || {});
    store.addEvent('settings.oauth', `${user.username} changed single sign-on (OpenID Connect)`);
    return oidc.adminView(store, req);
  });

  router.post('/api/settings/oidc/test', async ({ user }) => {
    requireAdmin(user);
    return oidc.test(store);
  });

  /* ----------------------------------------------------- IP allowlist -- */

  router.get('/api/settings/ip-allowlist', ({ user, req }) => {
    requireAdmin(user);
    return allowlist.view(store, user, req);
  });

  router.put('/api/settings/ip-allowlist', ({ user, req, body }) => {
    requireAdmin(user);
    const settings = allowlist.update(store, user, clientIp(req), body || {});
    store.addEvent('settings.ip_allowlist', `${user.username} ${settings.enabled ? 'turned on' : 'turned off'} the IP allowlist (${settings.cidrs.length} entries)`, { ip: clientIp(req) });
    return allowlist.view(store, user, req);
  });

  router.put('/api/settings/ip-allowlist/accounts/:id', ({ user, req, params, body }) => {
    requireAdmin(user);
    const target = allowlist.setAccount(store, user, clientIp(req), params.id, body?.allowedIps || []);
    store.addEvent('settings.ip_allowlist', `${user.username} changed the allowed addresses of ${target.username}`, { ip: clientIp(req) });
    return allowlist.view(store, user, req);
  });

  /* ------------------------------------------------------- flood guard -- */

  router.get('/api/security/flood', async ({ user }) => {
    requireAdmin(user);
    return flood.get(app).view();
  });

  router.put('/api/security/flood', async ({ user, body }) => {
    requireAdmin(user);
    flood.updateSettings(store, body || {});
    return flood.get(app).view();
  });

  router.put('/api/security/flood/servers/:id', async ({ user, params, body }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    server.floodGuard = Boolean(body?.enabled);
    store.save();
    return flood.get(app).view();
  });

  router.post('/api/security/flood/blocks', async ({ user, body }) => {
    requireAdmin(user);
    const server = manager.require(String(body?.serverId || ''));
    const minutes = Number(body?.minutes) || undefined;
    if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080)) fail(400, 'Minutes must be 1 to 10080');
    const engine = flood.get(app);
    await engine.block({ ip: String(body?.ip || ''), server, ports: engine.portsOf(server), reason: `blocked by ${user.username}`, minutes, manual: true });
    return engine.view();
  });

  router.delete('/api/security/flood/blocks/:id', async ({ user, params }) => {
    requireAdmin(user);
    const engine = flood.get(app);
    const record = await engine.unblock(params.id);
    store.addEvent('security.flood_unblocked', `${user.username} unblocked ${record.ip} on ${record.serverName}`, { serverId: record.serverId });
    return engine.view();
  });

  /* --------------------------------------------------- backup testing -- */

  router.get('/api/security/backup-tests', ({ user }) => {
    requireAdmin(user);
    return backupTest.view(store, manager);
  });

  router.put('/api/security/backup-tests', ({ user, body }) => {
    requireAdmin(user);
    store.state.settings.backupTest = { weekly: Boolean(body?.weekly) };
    store.save();
    return backupTest.view(store, manager);
  });

  router.post('/api/security/backup-tests/run', async ({ user, body }) => {
    requireAdmin(user);
    const server = manager.require(String(body?.serverId || ''));
    const result = await backupTest.run(store, manager, server, body?.backup ? String(body.backup) : null, { manual: true });
    return { result, ...backupTest.view(store, manager) };
  });
};
