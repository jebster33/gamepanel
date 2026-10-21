'use strict';

/** Ways to let people in without port forwarding: playit.gg, Tailscale/ZeroTier, and the wizard. Administrators only. */

const playit = require('../../features/playit');
const vpn = require('../../features/vpn-fallback');

module.exports = (router, { store, manager, bridge }, { requireAdmin, serverFor }) => {
  /* ---------------------------------------------------------- playit.gg -- */
  router.get('/api/hosting/playit', async ({ user }) => {
    requireAdmin(user);
    return playit.status(store, manager);
  });
  router.post('/api/hosting/playit/install', async ({ user }) => {
    requireAdmin(user);
    const r = await playit.install(store);
    return { ...r, status: await playit.status(store, manager) };
  });
  router.post('/api/hosting/playit/start', async ({ user }) => {
    requireAdmin(user);
    playit.start(store);
    return playit.status(store, manager);
  });
  router.post('/api/hosting/playit/stop', async ({ user }) => {
    requireAdmin(user);
    playit.stop();
    return playit.status(store, manager);
  });
  router.post('/api/hosting/playit/reset', async ({ user }) => {
    requireAdmin(user);
    playit.reset(store);
    store.addEvent('playit.reset', `playit link removed by ${user.username}`);
    return playit.status(store, manager);
  });
  router.put('/api/hosting/playit', async ({ user, body }) => {
    requireAdmin(user);
    playit.setAutoStart(store, body?.autoStart);
    return playit.status(store, manager);
  });

  /* ------------------------------------------------ Tailscale / ZeroTier -- */
  router.get('/api/hosting/vpn', async ({ user }) => {
    requireAdmin(user);
    return vpn.status(store, manager);
  });
  router.post('/api/hosting/vpn/install', async ({ user, body }) => {
    requireAdmin(user);
    const r = await vpn.installTool(String(body?.which || ''));
    store.addEvent('vpn.installed', `${body.which} installed by ${user.username}`);
    return r;
  });
  router.post('/api/hosting/vpn/join', async ({ user, body }) => {
    requireAdmin(user);
    if (body?.which === 'zerotier') await vpn.joinZeroTier(store, body.networkId);
    else await vpn.joinTailscale(store, { authKey: body?.authKey, hostname: body?.hostname, remember: body?.remember === true });
    store.addEvent('vpn.joined', `${body?.which === 'zerotier' ? 'ZeroTier' : 'Tailscale'} joined by ${user.username}`);
    return vpn.status(store, manager);
  });
  router.post('/api/hosting/vpn/leave', async ({ user, body }) => {
    requireAdmin(user);
    await vpn.leave(store, String(body?.which || ''), body?.networkId);
    return vpn.status(store, manager);
  });

  /* ------------------------------------------------------------- wizard -- */
  router.post('/api/hosting/wizard', async ({ user, body }) => {
    requireAdmin(user);
    const server = body?.serverId ? serverFor(user, String(body.serverId)) : null;
    return vpn.wizard({ store, manager, bridge, playit }, server, { check: body?.check === true });
  });
};
