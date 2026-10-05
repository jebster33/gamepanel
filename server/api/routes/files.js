'use strict';

const fs = require('fs');
const path = require('path');
const { fail, readBody } = require('../../core/util');
const files = require('../../features/files');

module.exports = (router, app, { serverFor }) => {
  const rootOf = (user, id, capability = 'files') => serverFor(user, id, capability).dir;

  router.get('/api/servers/:id/files', async ({ user, params, url }) => files.list(rootOf(user, params.id), url.searchParams.get('path') || ''));

  router.get('/api/servers/:id/files/content', async ({ user, params, url }) => files.read(rootOf(user, params.id), url.searchParams.get('path') || ''));

  router.put('/api/servers/:id/files/content', async ({ user, params, url, body }) =>
    files.write(rootOf(user, params.id, 'files.write'), url.searchParams.get('path') || '', body.content)
  );

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
      const buf = await readBody(req, 1024 * 1024 * 1024);
      const target = files.containedPath(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      return { ok: true, path: rel, size: buf.length };
    },
    { rawBody: true }
  );
};
