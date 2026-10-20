'use strict';

const fs = require('fs');
const { fail } = require('../../core/util');
const backups = require('../../features/backups');
const { cloudBackups } = require('../../features/cloud');

module.exports = (router, { store, manager, auth }, { requireAdmin, requireCap, serverFor }) => {
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
    const pruned = mayDelete ? backups.prune(server.id, server.backupRetention, [server.safeUpdate?.backup]) : [];
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

  /* ------------------------------------------------------ safe updates -- */

  const safe = require('../../features/safe-update');

  router.get('/api/servers/:id/safe-update', ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    return { snapshot: safe.view(server), canUpdate: manager.publicServer(server).canUpdate, lastRollback: server.lastRollback || null };
  });

  /** Back up, then update the game files. Rolling back is a separate, manual step. */
  router.post('/api/servers/:id/safe-update', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'power');
    requireCap(user, 'backups', server.id);
    // Fails early (stopped server, nothing to update); the backup and update run in the background.
    const template = manager.template(server);
    if (manager.isActive(server.id)) fail(409, 'Stop the server before updating it');
    if (!manager.publicServer(server).canUpdate || !template) fail(400, 'This game is updated by reinstalling it');
    safe.updateGame(manager, server, user.username).catch((err) => manager.pushConsole(server, `Safe update failed: ${err.message}`, 'system'));
    return { ok: true, started: true };
  });

  router.post('/api/servers/:id/safe-update/rollback', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'power');
    requireCap(user, 'backups.restore', server.id);
    return safe.rollback(manager, server, user.username);
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
      return nb.receive(req, nb.scopedSource(req, user, params.source), params.serverId, params.name);
    },
    { rawBody: true }
  );
  router.get('/api/backup-store/:source/:serverId', ({ user, params, req }) => {
    requireAdmin(user);
    return { backups: nb.listStored(nb.scopedSource(req, user, params.source), params.serverId) };
  });
  router.get(
    '/api/backup-store/:source/:serverId/:name',
    ({ user, params, req, res }) => {
      requireAdmin(user);
      const file = nb.storeFile(nb.scopedSource(req, user, params.source), params.serverId, params.name);
      if (!fs.existsSync(file)) fail(404, 'No such copy');
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
      return undefined;
    },
    { raw: true }
  );
  router.delete('/api/backup-store/:source/:serverId/:name', ({ user, params, req }) => {
    requireAdmin(user);
    fs.rmSync(nb.storeFile(nb.scopedSource(req, user, params.source), params.serverId, params.name), { force: true });
    return { ok: true };
  });

  /* ------------------------------------------------------ cloud copies -- */

  router.get('/api/servers/:id/backups/cloud', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    if (!cloud.enabled) return { enabled: false, backups: [], uploads: {} };
    try {
      return { enabled: true, backups: await cloud.list(server.id), uploads: cloud.statusFor(server.id) };
    } catch (err) {
      return { enabled: true, backups: [], uploads: cloud.statusFor(server.id), error: `Could not reach the backup target: ${err.message}` };
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

  /* Google Drive and Dropbox sign-in: the administrator's own app, redirected back here. */
  const OAUTH_COOKIE = 'gp_cloud_oauth';
  const OAUTH_PATH = '/api/cloud-backups/oauth';
  const targets = require('../../features/cloud-targets');
  const oauth = require('../../features/oauth');
  const { isSecure } = require('../helpers');
  const callbackUrl = (req) => `${oauth.baseUrl(store, req)}${OAUTH_PATH}/callback`;
  const clearCookie = `${OAUTH_COOKIE}=; Path=${OAUTH_PATH}; HttpOnly; SameSite=Lax; Max-Age=0`;
  const back = (res, query) => {
    res.writeHead(302, { Location: `/?${query}#/settings/cloud`, 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store' });
    res.end();
  };

  router.get('/api/cloud-backups/oauth/redirect-uri', ({ user, req }) => {
    requireAdmin(user);
    return { redirectUri: callbackUrl(req), consoles: { gdrive: targets.OAUTH.gdrive.console, dropbox: targets.OAUTH.dropbox.console } };
  });

  router.get(`${OAUTH_PATH}/:provider/start`, ({ user, req, res, params }) => {
    requireAdmin(user);
    if (req.gpApiKey) fail(403, 'Connect a backup target while signed in, not with an API key');
    const spec = targets.OAUTH[params.provider];
    if (!spec) fail(404, 'Unknown backup target');
    const cfg = cloud.settings[params.provider];
    if (!cfg.clientId || !cfg.clientSecret) fail(400, `Save the ${spec.label} client ID and secret first`);
    const nonce = require('crypto').randomBytes(16).toString('base64url');
    const state = auth.sign({ purpose: 'cloud-oauth', p: params.provider, n: nonce, u: user.id, exp: Date.now() + 10 * 60_000 });
    const query = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: callbackUrl(req), response_type: 'code', state, ...spec.extra });
    res.writeHead(302, {
      Location: `${spec.authorize}?${query}`,
      'Set-Cookie': `${OAUTH_COOKIE}=${nonce}; Path=${OAUTH_PATH}; HttpOnly; SameSite=Lax; Max-Age=600${isSecure(req) ? '; Secure' : ''}`,
      'Cache-Control': 'no-store',
    });
    res.end();
    return undefined;
  });

  router.get(
    `${OAUTH_PATH}/callback`,
    async ({ req, res, url }) => {
      try {
        const q = url.searchParams;
        if (q.get('error')) throw new Error(q.get('error_description') || q.get('error'));
        const state = auth.verify(String(q.get('state') || ''));
        const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((c) => c.length === 2));
        if (!state || state.purpose !== 'cloud-oauth' || !cookies[OAUTH_COOKIE] || cookies[OAUTH_COOKIE] !== state.n) throw new Error('That connect link expired or was started in another browser. Try again.');
        const me = auth.userFromRequest(req);
        if (!me || me.id !== state.u || me.role !== 'admin') throw new Error('Sign in as the administrator who started this, then try again.');
        const spec = targets.OAUTH[state.p];
        const { refreshToken } = await targets.exchangeCode(state.p, cloud.settings[state.p], String(q.get('code') || ''), callbackUrl(req));
        cloud.connected(state.p, refreshToken);
        store.addEvent('settings.cloud_backups', `${spec.label} connected for backups (${me.username})`);
        back(res, `cloud_connected=${encodeURIComponent(spec.label)}`);
      } catch (err) {
        back(res, `cloud_error=${encodeURIComponent(err.message)}`);
      }
      return undefined;
    },
    { public: true }
  );

  router.post('/api/cloud-backups/test', async ({ user, body }) => {
    requireAdmin(user);
    try {
      return await cloud.test(body || {});
    } catch (err) {
      return fail(400, `The backup target said no: ${err.message}`);
    }
  });
};
