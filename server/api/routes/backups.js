'use strict';

const fs = require('fs');
const { fail } = require('../../core/util');
const backups = require('../../features/backups');
const { cloudBackups } = require('../../features/cloud');

module.exports = (router, { store, manager }, { requireAdmin, requireCap, serverFor }) => {
  // Listens for new backups and copies them off-site when turned on.
  const cloud = cloudBackups(store, manager);

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
    store.addEvent('backup.created', `Backup created for ${server.name}`, { serverId: server.id, backup: backup.name });
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

  /** Look inside a backup, and put single files or folders back from it. */
  router.get('/api/servers/:id/backups/:name/contents', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    return backups.contents(server.id, params.name);
  });

  router.post('/api/servers/:id/backups/:name/restore-files', async ({ user, params, body }) => {
    // Same rule as a full restore: picking every folder would amount to one.
    requireAdmin(user);
    const server = serverFor(user, params.id, 'backups');
    const result = await backups.restorePaths(server, params.name, body?.paths);
    const what = result.restored.length === 1 ? result.restored[0] : `${result.restored.length} files and folders`;
    store.addEvent('backup.restored', `${user.username} restored ${what} on ${server.name} from ${params.name}`, { serverId: server.id });
    return { ...result, running: manager.isActive(server.id) };
  });

  router.delete('/api/servers/:id/backups/:name', ({ user, params }) => {
    const server = serverFor(user, params.id);
    requireCap(user, 'backups.restore', server.id);
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
  /* ------------------------------------------------------ cloud copies -- */

  router.get('/api/servers/:id/backups/cloud', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    if (!cloud.enabled) return { enabled: false, backups: [], uploads: {} };
    try {
      return { enabled: true, backups: await cloud.list(server.id), uploads: cloud.statusFor(server.id) };
    } catch (err) {
      return { enabled: true, backups: [], uploads: cloud.statusFor(server.id), error: `Could not reach the bucket: ${err.message}` };
    }
  });

  router.post('/api/servers/:id/backups/:name/upload', ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    if (!cloud.enabled) fail(400, 'Turn on cloud backups in Settings first');
    backups.resolve(server.id, params.name);
    cloud.queue(server.id, params.name);
    return { ok: true, queued: true };
  });

  router.post('/api/servers/:id/backups/cloud/:name/fetch', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    requireCap(user, 'backups.restore', server.id);
    if (!cloud.enabled) fail(400, 'Turn on cloud backups in Settings first');
    return cloud.fetch(server.id, params.name);
  });

  router.delete('/api/servers/:id/backups/cloud/:name', async ({ user, params }) => {
    const server = serverFor(user, params.id);
    requireCap(user, 'backups.restore', server.id);
    if (!cloud.enabled) fail(400, 'Turn on cloud backups in Settings first');
    await cloud.removeRemote(server.id, params.name);
    return { ok: true };
  });

  router.get('/api/cloud-backups', ({ user }) => {
    requireAdmin(user);
    return { settings: cloud.publicSettings() };
  });

  router.patch('/api/cloud-backups', ({ user, body }) => {
    requireAdmin(user);
    const settings = cloud.update(body);
    store.addEvent('settings.cloud_backups', `Cloud backups ${settings.enabled ? 'on' : 'off'} (${user.username})`);
    return { settings };
  });

  router.post('/api/cloud-backups/test', async ({ user, body }) => {
    requireAdmin(user);
    try {
      return await cloud.test(body || {});
    } catch (err) {
      return fail(400, `The bucket said no: ${err.message}`);
    }
  });
};
