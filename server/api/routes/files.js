'use strict';

const fs = require('fs');
const path = require('path');
const { fail, HttpError } = require('../../core/util');
const files = require('../../features/files');
const history = require('../../features/config-history');

/** A file's text before it is overwritten, for its history (null when missing or too big). */
function readIfSmall(file) {
  try {
    return fs.statSync(file).size <= 1024 * 1024 ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

module.exports = (router, app, { serverFor }) => {
  const rootOf = (user, id, capability = 'files') => serverFor(user, id, capability).dir;

  router.get('/api/servers/:id/files', async ({ user, params, url }) => files.list(rootOf(user, params.id), url.searchParams.get('path') || ''));

  router.get('/api/servers/:id/files/search', async ({ user, params, url }) => files.search(rootOf(user, params.id), url.searchParams.get('q')));

  router.get('/api/servers/:id/files/content', async ({ user, params, url }) => files.read(rootOf(user, params.id), url.searchParams.get('path') || ''));

  router.put('/api/servers/:id/files/content', async ({ user, params, url, body }) => {
    const root = rootOf(user, params.id, 'files.write');
    const rel = url.searchParams.get('path') || '';
    const before = readIfSmall(files.containedPath(root, rel));
    const result = await files.write(root, rel, body.content);
    history.record(params.id, rel, { before, after: String(body.content ?? ''), by: user.username, source: 'editor' });
    return result;
  });

  /* ------------------------------------------------- plugin config forms -- */

  const forms = require('../../features/config-forms');

  router.get('/api/servers/:id/configs', ({ user, params }) => ({ files: forms.list(serverFor(user, params.id, 'files')) }));

  router.get('/api/servers/:id/configs/form', ({ user, params, url }) => forms.form(serverFor(user, params.id, 'files'), url.searchParams.get('path') || ''));

  router.put('/api/servers/:id/configs/form', ({ user, params, url, body }) => {
    const server = serverFor(user, params.id, 'files.write');
    const rel = url.searchParams.get('path') || '';
    const result = forms.save(server, rel, { version: body?.version, changes: body?.changes || {} });
    if (result.changed) history.record(server.id, rel, { before: result.before, after: result.after, by: user.username, source: 'form' });
    return { ...forms.form(server, rel), changed: result.changed };
  });

  /* ------------------------------------------------------ config history -- */

  router.get('/api/servers/:id/config-history', ({ user, params }) => {
    serverFor(user, params.id, 'files');
    return { files: history.files(params.id) };
  });

  router.get('/api/servers/:id/config-history/versions', ({ user, params, url }) => {
    serverFor(user, params.id, 'files');
    return history.versions(params.id, url.searchParams.get('path'));
  });

  router.get('/api/servers/:id/config-history/version', ({ user, params, url }) => {
    serverFor(user, params.id, 'files');
    return history.content(params.id, url.searchParams.get('path'), url.searchParams.get('version'));
  });

  router.post('/api/servers/:id/config-history/revert', async ({ user, params, body }) => {
    const root = rootOf(user, params.id, 'files.write');
    const version = history.content(params.id, body?.path, body?.version);
    const before = readIfSmall(files.containedPath(root, version.path));
    await files.write(root, version.path, version.content);
    history.record(params.id, version.path, { before, after: version.content, by: user.username, source: 'revert', note: `Back to the version from ${new Date(version.at).toISOString().slice(0, 16).replace('T', ' ')}` });
    app.store.addEvent('server.config_reverted', `${user.username} reverted ${version.path} on ${serverFor(user, params.id).name}`, { serverId: params.id });
    return { ok: true, path: version.path };
  });

  router.post('/api/servers/:id/files/mkdir', async ({ user, params, body }) => files.mkdir(rootOf(user, params.id, 'files.write'), body.path));

  router.post('/api/servers/:id/files/rename', async ({ user, params, body }) => files.rename(rootOf(user, params.id, 'files.write'), body.from, body.to));

  router.delete('/api/servers/:id/files', async ({ user, params, url }) => files.remove(rootOf(user, params.id, 'files.write'), url.searchParams.get('path') || ''));

  router.post('/api/servers/:id/files/extract', async ({ user, params, body }) => files.extract(rootOf(user, params.id, 'files.write'), body.path));

  router.post('/api/servers/:id/files/compress', async ({ user, params, body }) =>
    files.compress(rootOf(user, params.id, 'files.write'), body.paths, body.name)
  );

  router.get(
    '/api/servers/:id/files/download',
    async ({ user, params, url, res }) => {
      const { file, size, name } = files.resolveDownload(rootOf(user, params.id), url.searchParams.get('path') || '');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
      });
      fs.createReadStream(file).pipe(res);
      return undefined;
    },
    { raw: true }
  );

  router.post(
    '/api/servers/:id/files/upload',
    async ({ user, params, url, req }) => {
      const root = rootOf(user, params.id, 'files.write');
      const rel = url.searchParams.get('path');
      if (!rel) fail(400, 'A target path is required');
      const target = files.containedPath(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Streamed to a temporary file (never held in memory), then moved into place; capped at 1 GiB.
      const tmp = `${target}.${require('crypto').randomBytes(6).toString('hex')}.upload`;
      let size = 0;
      const limit = new (require('stream').Transform)({
        transform(chunk, enc, cb) {
          size += chunk.length;
          cb(size > 1024 * 1024 * 1024 ? new HttpError(413, 'That file is larger than 1 GB') : null, chunk);
        },
      });
      try {
        await require('stream/promises').pipeline(req, limit, fs.createWriteStream(tmp, { flags: 'wx' }));
        fs.renameSync(tmp, target);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      return { ok: true, path: rel, size };
    },
    { rawBody: true }
  );
};
