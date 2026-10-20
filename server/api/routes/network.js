'use strict';

const network = require('../../features/network');
const { fail } = require('../../core/util');

module.exports = (router, { store, manager }, { serverFor }) => {
  /** What stands between this server's ports and the players. */
  router.get('/api/servers/:id/network', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'settings');
    const ports = network.serverPorts(server, manager.template(server));
    const [firewall, upnp] = await Promise.all([network.firewallStatus(), network.upnpStatus()]);
    const lan = network.lanAddress();
    return {
      ports: ports.map((p) => ({ ...p, openInFirewall: network.isOpen(firewall, p.port, p.protocol) })),
      firewall,
      upnp,
      lanIp: lan,
      autoPorts: Boolean(server.autoPorts),
      manual: {
        firewall: network.manualSteps(ports),
        ufw: network.manualSteps(ports),
        forward: ports.map((p) => `${p.port}/${p.protocol.toUpperCase()} → ${lan}:${p.port}`),
      },
    };
  });

  /** Ask a service on the internet whether it can reach this server. */
  router.post('/api/servers/:id/network/check', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    const host = body?.host || require('../../features/dns').playerAddress(server)?.replace(/:\d+$/, '') || store.state.settings.statusPage?.host || '';
    return require('../../features/reachability').check(manager, server, { host });
  });

  /** Is the server on the Steam server list? (Steam games with a query port.) */
  router.get('/api/servers/:id/server-list', ({ user, params }) => {
    const server = serverFor(user, params.id, 'settings');
    return require('../../features/server-list').view(manager, server, store.state.settings.integrations?.steamApiKey);
  });

  router.put('/api/servers/:id/server-list', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    const list = require('../../features/server-list');
    const ip = String(body?.ip || '').trim();
    if (ip && !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) fail(400, 'Enter the public IPv4 address Steam should find the server at, or leave it empty');
    server.serverList = { enabled: Boolean(body?.enabled), ip };
    store.save();
    const key = store.state.settings.integrations?.steamApiKey;
    // Turning it on (or asking) answers straight away instead of in five minutes.
    if (body?.check !== false && server.serverList.enabled && key && list.supports(manager, server) && manager.rt(server.id).status === 'running') await list.check(manager, server, key);
    return list.view(manager, server, key);
  });

  router.post('/api/servers/:id/network', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    const ports = network.serverPorts(server, manager.template(server));
    const open = body.open !== false;
    const result = {};
    if (body.firewall !== false) result.firewall = await network.firewallSet(ports, open);
    if (body.upnp) result.upnp = await network.upnpSet(ports, open, `GamePanel ${server.name}`);
    store.addEvent(
      open ? 'network.opened' : 'network.closed',
      `${server.name} ports ${open ? 'opened' : 'closed'} (${ports.map((p) => `${p.port}/${p.protocol}`).join(', ')})`,
      { serverId: server.id }
    );
    return result;
  });
};
