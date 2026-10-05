'use strict';

const network = require('../../features/network');

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
      manual: {
        firewall: network.manualSteps(ports),
        ufw: network.manualSteps(ports),
        forward: ports.map((p) => `${p.port}/${p.protocol.toUpperCase()} → ${lan}:${p.port}`),
      },
    };
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
