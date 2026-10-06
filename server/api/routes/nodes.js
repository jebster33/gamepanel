'use strict';

/** Other machines this panel controls (see features/nodes.js). */
module.exports = (router, { store, nodes }, { requireAdmin }) => {
  router.get('/api/nodes', ({ user }) => {
    requireAdmin(user);
    return nodes.overview();
  });

  /** Name this machine, so it reads well next to the others. */
  router.put('/api/nodes/local', ({ user, body }) => {
    requireAdmin(user);
    store.state.settings.nodeName = String(body?.name || '').trim().slice(0, 40) || undefined;
    store.save();
    nodes.manager.broadcastServers();
    return nodes.overview();
  });

  router.post('/api/nodes', async ({ user, body }) => {
    requireAdmin(user);
    const node = await nodes.add(body || {});
    store.addEvent('node.added', `${user.username} added node ${node.name} (${node.url})`);
    nodes.manager.broadcastServers();
    return { node };
  });

  router.patch('/api/nodes/:id', ({ user, params, body }) => {
    requireAdmin(user);
    const node = nodes.update(params.id, body || {});
    nodes.manager.broadcastServers();
    return { node };
  });

  router.delete('/api/nodes/:id', ({ user, params }) => {
    requireAdmin(user);
    const node = nodes.require(params.id);
    nodes.remove(params.id);
    store.addEvent('node.removed', `${user.username} removed node ${node.name}`);
    return { ok: true };
  });
};
