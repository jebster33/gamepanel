'use strict';

const fs = require('fs');
const { fail } = require('../../core/util');
const { config } = require('../../core/config');
const network = require('../../features/network');
const clients = require('../../features/bridge/clients');

module.exports = (router, { store, bridge }, { requireAdmin }) => {
  const view = () => ({
    enabled: bridge.enabled,
    publicUrl: bridge.settings.publicUrl || '',
    port: config.port,
    clientVersion: clients.CLIENT_VERSION,
    platforms: clients.availability(),
    connections: bridge.connections.map((c) => bridge.publicConnection(c)),
  });

  router.get('/api/bridge', ({ user }) => {
    requireAdmin(user);
    return view();
  });

  router.patch('/api/bridge/settings', ({ user, body }) => {
    requireAdmin(user);
    const wasOn = bridge.enabled;
    bridge.setSettings({ enabled: body.enabled, publicUrl: body.publicUrl });
    if (wasOn !== bridge.enabled) store.addEvent('bridge.toggled', `Bridge turned ${bridge.enabled ? 'on' : 'off'} by ${user.username}`);
    return view();
  });

  /** Forward the panel's own port on the router, and allow it in the host firewall. */
  router.post('/api/bridge/reachable', async ({ user }) => {
    requireAdmin(user);
    const ports = [{ port: config.port, protocol: 'tcp' }];
    const result = { port: config.port };
    result.firewall = await network.firewallSet(ports, true).catch((err) => [{ ok: false, error: err.message }]);
    try {
      result.upnp = await network.upnpSet(ports, true, 'GamePanel bridge');
    } catch (err) {
      result.upnp = { error: err.message };
    }
    store.addEvent('network.opened', `Panel port ${config.port}/tcp opened for the bridge by ${user.username}`);
    return result;
  });

  router.post('/api/bridge/connections', ({ user, body }) => {
    requireAdmin(user);
    const conn = bridge.createConnection(body.username);
    if (body.servers || body.ports) bridge.updateConnection(conn.id, body);
    store.addEvent('bridge.created', `Bridge connection ${conn.username} added by ${user.username}`);
    return { connection: bridge.publicConnection(conn) };
  });

  router.patch('/api/bridge/connections/:id', ({ user, params, body }) => {
    requireAdmin(user);
    const conn = bridge.updateConnection(params.id, body);
    store.addEvent('bridge.updated', `Bridge connection ${conn.username} updated by ${user.username}`);
    return { connection: bridge.publicConnection(conn) };
  });

  router.post('/api/bridge/connections/:id/reset-password', ({ user, params }) => {
    requireAdmin(user);
    const conn = bridge.resetPassword(params.id);
    store.addEvent('bridge.password_reset', `Bridge password for ${conn.username} reset by ${user.username}`);
    return { connection: bridge.publicConnection(conn) };
  });

  router.post('/api/bridge/connections/:id/new-key', ({ user, params }) => {
    requireAdmin(user);
    const conn = bridge.rotateKey(params.id);
    store.addEvent('bridge.key_rotated', `Old bridge downloads for ${conn.username} revoked by ${user.username}`);
    return { connection: bridge.publicConnection(conn) };
  });

  router.delete('/api/bridge/connections/:id/devices/:device', ({ user, params }) => {
    requireAdmin(user);
    const conn = bridge.removeDevice(params.id, params.device);
    return { connection: bridge.publicConnection(conn) };
  });

  router.delete('/api/bridge/connections/:id', ({ user, params }) => {
    requireAdmin(user);
    const conn = bridge.find(params.id);
    bridge.deleteConnection(params.id);
    store.addEvent('bridge.deleted', `Bridge connection ${conn.username} removed by ${user.username}`);
    return { ok: true };
  });

  /** The personal client for one connection, stamped on the fly. */
  router.get('/api/bridge/connections/:id/client', async ({ user, params, url, res }) => {
    requireAdmin(user);
    if (!bridge.enabled) fail(400, 'Turn the bridge on first');
    const conn = bridge.find(params.id);
    const platform = url.searchParams.get('platform') || 'windows-amd64';
    if (!clients.PLATFORMS[platform]) fail(400, 'Unknown platform');
    const stamp = bridge.stamp(conn);
    const base = await clients.baseBinary(platform);
    const trailer = clients.trailer(stamp);
    const { size } = fs.statSync(base);
    const filename = `GamePanel-Bridge-${conn.username}${clients.PLATFORMS[platform].ext}`;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size + trailer.length,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    await new Promise((resolve, reject) => {
      const file = fs.createReadStream(base);
      file.on('error', reject);
      file.on('end', resolve);
      file.pipe(res, { end: false });
    });
    res.end(trailer);
    store.addEvent('bridge.downloaded', `Bridge client (${clients.PLATFORMS[platform].label}) for ${conn.username} downloaded by ${user.username}`);
    return undefined;
  });
};
