'use strict';

const fs = require('fs');
const { fail } = require('../../core/util');
const backups = require('../../features/backups');

module.exports = (router, { store, manager }, { requireAdmin, requireCap, serverFor }) => {
  router.get('/api/servers/:id/backups', ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    return { backups: backups.list(server.id), retention: server.backupRetention ?? 10 };
  });

  router.post('/api/servers/:id/backups', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'backups');
    manager.checkDiskRoom('make a backup');
    let backup;
    try {
      backup = await backups.create(server, body.label || '');
    } catch (err) {
      store.addEvent('backup.failed', `Backup of ${server.name} failed: ${err.message}`, { serverId: server.id });
      throw err;
    }
    const pruned = backups.prune(server.id, server.backupRetention);
    store.addEvent('backup.created', `Backup created for ${server.name}`, { serverId: server.id });
    return { backup, pruned };
  });

  router.post('/api/servers/:id/backups/:name/restore', async ({ user, params }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    if (manager.isActive(server.id)) fail(409, 'Stop the server before restoring a backup');
    await backups.restore(server, params.name);
    store.addEvent('backup.restored', `Backup ${params.name} restored to ${server.name}`, { serverId: server.id });
    return { ok: true };
  });

  router.delete('/api/servers/:id/backups/:name', ({ user, params }) => {
    const server = serverFor(user, params.id);
    requireCap(user, 'backups.restore');
    return backups.remove(server.id, params.name);
  });

  router.get(
    '/api/servers/:id/backups/:name/download',
    ({ user, params, res }) => {
      const server = serverFor(user, params.id, 'backups');
      const file = backups.resolve(server.id, params.name);
      const stat = fs.statSync(file);
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename="${params.name}"` });
      fs.createReadStream(file).pipe(res);
      return undefined;
    },
    { raw: true }
  );
};
