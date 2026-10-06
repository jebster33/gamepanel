'use strict';

const fs = require('fs');
const { fail } = require('../../core/util');
const backups = require('../../features/backups');
const { cloudBackups } = require('../../features/cloud');

module.exports = (router, { store, manager }, { requireAdmin, requireCap, serverFor }) => {
  // Listens for new backups and copies them off-site when turned on.
  const cloud = cloudBackups(store, manager);
  const secrets = require('../../core/secrets');
  const passphrase = () => secrets.open(store.state.settings.backupPassphrase || '') || null;
  backups.vault.configure({ passphrase });

  router.get('/api/servers/:id/backups', ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    const checked = backups.checks(server.id);
    return {
      backups: backups.list(server.id).map((b) => ({ ...b, check: checked[b.name] || null })),
      retention: server.backupRetention ?? 10,
      autoCheck: Boolean(store.state.settings.verifyBackups),
      mode: server.backupMode === 'incremental' ? 'incremental' : 'archive',
      encrypt: Boolean(server.backupEncrypt),
      vault: backups.vault.stats(backups.dirFor(server.id)),
      passphraseSet: Boolean(store.state.settings.backupPassphrase),
    };
  });

  /** Archive (.tar.gz, the default) or incremental backups, optionally encrypted. */
  router.put('/api/servers/:id/backup-mode', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'backups');
    const mode = body?.mode === 'incremental' ? 'incremental' : 'archive';
    const encrypt = mode === 'incremental' && Boolean(body?.encrypt);
    if (encrypt && !store.state.settings.backupPassphrase) fail(400, 'An administrator has to set a backup passphrase first (Settings → Backups)');
    server.backupMode = mode;
    server.backupEncrypt = encrypt;
    store.save();
    store.addEvent('server.settings', `${user.username} switched ${server.name} to ${mode === 'archive' ? 'archive' : encrypt ? 'encrypted incremental' : 'incremental'} backups`, { serverId: server.id });
    return { mode, encrypt };
  });

  /** The passphrase encrypted backups use. Changing it rewraps every vault's key; nothing is re-encrypted. */
  router.put('/api/settings/backup-passphrase', ({ user, body }) => {
    requireAdmin(user);
    const next = String(body?.passphrase || '');
    if (next.length < 12) fail(400, 'Use at least 12 characters: this passphrase is all that protects the encrypted backups');
    const current = passphrase();
    if (current) backups.vault.rewrapAll(require('../../core/config').config.backupsDir, current, next);
    store.state.settings.backupPassphrase = secrets.seal(next);
    store.save();
    store.addEvent('panel.settings', `${user.username} ${current ? 'changed' : 'set'} the backup passphrase`);
    return { ok: true };
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
    // Pruning deletes older backups: only for people who are allowed to delete them.
    let mayDelete = true;
    try {
      requireCap(user, 'backups.restore', server.id);
    } catch {
      mayDelete = false;
    }
    const pruned = mayDelete ? backups.prune(server.id, server.backupRetention) : [];
    store.addEvent('backup.created', `Backup created for ${server.name}`, { serverId: server.id, backup: backup.name });
    return { backup, pruned };
  });

  /** Test-restore one backup into a scratch folder. */
  router.post('/api/servers/:id/backups/:name/verify', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    const result = await backups.verify(server, params.name);
    if (!result.ok) store.addEvent('backup.verify_failed', `Backup ${params.name} of ${server.name} failed its check: ${result.error}`, { serverId: server.id });
    return result;
  });

  // "Check every backup after it is made" (Settings): in the background, one at a time.
  let queue = Promise.resolve();
  store.on('event', (event) => {
    if (event.type !== 'backup.created' || !event.backup || !store.state.settings.verifyBackups) return;
    const server = manager.find(event.serverId);
    if (!server) return;
    queue = queue
      .then(() => backups.verify(server, event.backup))
      .then((result) => {
        if (!result.ok) store.addEvent('backup.verify_failed', `Backup ${event.backup} of ${server.name} failed its check: ${result.error}`, { serverId: server.id });
      })
      .catch(() => {});
  });

  router.post('/api/servers/:id/backups/:name/restore', async ({ user, params, body }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    if (manager.isActive(server.id)) fail(409, 'Stop the server before restoring a backup');
    const result = await require('../../features/restore-preview').restore(manager, server, params.name, { backupFirst: Boolean(body?.backupFirst), exact: Boolean(body?.exact) });
    if (result.safety) store.addEvent('backup.created', `Backup ${result.safety} of ${server.name} made before a restore`, { serverId: server.id, backup: result.safety });
    store.addEvent('backup.restored', `Backup ${params.name} restored to ${server.name}${result.removed ? ` (${result.removed} newer files removed)` : ''}`, { serverId: server.id });
    return result;
  });

  /** What a full restore would change, before doing it. */
  router.get('/api/servers/:id/backups/:name/preview', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    return require('../../features/restore-preview').preview(manager, server, params.name);
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
      if (backups.vault.isSnapshot(params.name)) return backups.downloadSnapshot(server, params.name, res).then(() => undefined);
      const file = backups.resolve(server.id, params.name);
      const stat = fs.statSync(file);
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename="${params.name}"` });
      fs.createReadStream(file).pipe(res);
      return undefined;
    },
    { raw: true }
  );
  /* ------------------------------------------------- copies on a node -- */

  const nb = require('../../features/node-backups');
  const nodeCopies = nb.nodeBackups(store, manager);

  router.get('/api/servers/:id/backups/node', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    if (!nodeCopies.enabled) return { enabled: false, backups: [], sends: {} };
    const node = nodeCopies.node();
    try {
      return { enabled: true, node: node.name, backups: await nodeCopies.list(server.id), sends: nodeCopies.statusFor(server.id) };
    } catch (err) {
      return { enabled: true, node: node.name, backups: [], sends: nodeCopies.statusFor(server.id), error: `Could not reach ${node.name}: ${err.message}` };
    }
  });

  router.post('/api/servers/:id/backups/node/:name/send', ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    if (!nodeCopies.enabled) fail(400, 'Turn on copies to a node in Settings first');
    backups.resolve(server.id, params.name);
    nodeCopies.queue(server.id, params.name);
    return { ok: true, queued: true };
  });

  router.post('/api/servers/:id/backups/node/:name/fetch', ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    requireCap(user, 'backups.restore', server.id);
    if (!nodeCopies.enabled) fail(400, 'Turn on copies to a node in Settings first');
    return nodeCopies.fetch(server.id, params.name);
  });

  router.delete('/api/servers/:id/backups/node/:name', ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    requireCap(user, 'backups.restore', server.id);
    if (!nodeCopies.enabled) fail(400, 'Turn on copies to a node in Settings first');
    return nodeCopies.remove(server.id, params.name);
  });

  router.get('/api/node-backups', ({ user }) => {
    requireAdmin(user);
    return { settings: nodeCopies.publicSettings(), stored: nb.storedSummary() };
  });

  router.patch('/api/node-backups', ({ user, body }) => {
    requireAdmin(user);
    const settings = nodeCopies.update(body);
    store.addEvent('settings.node_backups', `Backup copies to a node ${settings.enabled ? 'on' : 'off'} (${user.username})`);
    return { settings };
  });

  // The other end: this panel keeping copies for another one. Administrator API keys only.
  router.put(
    '/api/backup-store/:source/:serverId/:name',
    ({ user, params, req }) => {
      requireAdmin(user);
      return nb.receive(req, params.source, params.serverId, params.name);
    },
    { rawBody: true }
  );
  router.get('/api/backup-store/:source/:serverId', ({ user, params }) => {
    requireAdmin(user);
    return { backups: nb.listStored(params.source, params.serverId) };
  });
  router.get(
    '/api/backup-store/:source/:serverId/:name',
    ({ user, params, res }) => {
      requireAdmin(user);
      const file = nb.storeFile(params.source, params.serverId, params.name);
      if (!fs.existsSync(file)) fail(404, 'No such copy');
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
      return undefined;
    },
    { raw: true }
  );
  router.delete('/api/backup-store/:source/:serverId/:name', ({ user, params }) => {
    requireAdmin(user);
    fs.rmSync(nb.storeFile(params.source, params.serverId, params.name), { force: true });
    return { ok: true };
  });

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
    if (backups.vault.isSnapshot(params.name)) fail(400, 'Cloud copies are for archive backups. Download this one as a .tar.gz to keep a copy elsewhere.');
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
