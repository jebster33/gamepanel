'use strict';

/** Minecraft tools: plugin update check, world border, switch check, and the flame graph (Java servers). */

const { fail } = require('../../core/util');
const mc = require('../../features/mc-tools');
const flame = require('../../features/flame');

module.exports = (router, { store, manager }, { serverFor }) => {
  const local = (server) => {
    if (server.node) fail(400, 'This works on servers hosted by this panel, not on another node');
    return server;
  };

  router.get('/api/servers/:id/plugin-updates', async ({ user, params }) => mc.pluginUpdates(manager, local(serverFor(user, params.id, 'files'))));

  router.get('/api/servers/:id/worldborder', async ({ user, params }) => mc.borderInfo(manager, local(serverFor(user, params.id, 'files'))));

  router.put('/api/servers/:id/worldborder', async ({ user, params, body }) => {
    serverFor(user, params.id, 'console');
    const server = local(serverFor(user, params.id, 'files.write'));
    const out = await mc.setBorder(manager, server, body);
    store.addEvent('server.files', `${user.username} set the world border on ${server.name} to ${out.size} blocks`, { serverId: server.id });
    return out;
  });

  router.post('/api/servers/:id/switch-check', async ({ user, params, body }) =>
    mc.switchCheck(manager, local(serverFor(user, params.id, 'files')), { templateId: body?.templateId, version: body?.version }));

  router.get('/api/servers/:id/flame', ({ user, params }) => flame.status(serverFor(user, params.id, 'console').id));

  router.post('/api/servers/:id/flame', ({ user, params, body }) => flame.start(manager, local(serverFor(user, params.id, 'console')), { seconds: body?.seconds }));
};
