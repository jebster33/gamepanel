'use strict';

/**
 * Per-game extras: Steam beta branches, tShock plugin installs, Project
 * Zomboid sandbox options, the 7 Days to Die map preview and Nexus Mods links.
 */

const fs = require('fs');
const { fail, HttpError } = require('../../core/util');
const steamBranch = require('../../features/steam-branch');
const tshock = require('../../features/tshock');
const zomboid = require('../../features/zomboid-sandbox');
const sevenDays = require('../../features/sevendays-map');
const nexus = require('../../features/nexus');
const history = require('../../features/config-history');

module.exports = (router, { store, manager }, { serverFor }) => {
  const needTemplate = (server, ...ids) => {
    const id = manager.template(server)?.id;
    if (!ids.includes(id)) fail(400, 'This game does not have that feature');
    return id;
  };

  /* ------------------------------------------------------ steam branch -- */

  router.get('/api/servers/:id/steam-branch', ({ user, params }) => steamBranch.view(manager, serverFor(user, params.id, 'settings')));

  router.get('/api/servers/:id/steam-branch/branches', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'settings');
    const app = steamBranch.steamApp(manager, server);
    if (!app) fail(400, 'This game is not installed through SteamCMD');
    return { appid: app.appid, branches: await steamBranch.listBranches(app.appid) };
  });

  router.put('/api/servers/:id/steam-branch', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    const view = steamBranch.set(manager, server, body || {});
    store.save();
    store.addEvent('server.steam_branch', `${user.username} set the Steam branch of ${server.name} to ${view.branch}`, { serverId: server.id });
    return view;
  });

  /* ------------------------------------------------------------ tshock -- */

  router.get('/api/servers/:id/tshock', ({ user, params }) => {
    const server = serverFor(user, params.id, 'mods');
    needTemplate(server, 'terraria');
    return tshock.status(server);
  });

  router.post('/api/servers/:id/tshock/install-url', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'mods');
    serverFor(user, params.id, 'files.write'); // an address can serve any code: same trust as uploading a file
    needTemplate(server, 'terraria');
    const written = await tshock.installFromUrl(server, body?.url);
    store.addEvent('mod.installed', `${written.join(', ')} installed on ${server.name} from a web address`, { serverId: server.id });
    return { ok: true, installed: written, restartNeeded: manager.isActive(server.id) };
  });

  router.post(
    '/api/servers/:id/tshock/upload',
    async ({ user, params, url, req }) => {
      const server = serverFor(user, params.id, 'mods');
      serverFor(user, params.id, 'files.write');
      needTemplate(server, 'terraria');
      const temp = tshock.tempFile(server);
      fs.mkdirSync(require('path').dirname(temp), { recursive: true });
      let size = 0;
      const limit = new (require('stream').Transform)({
        transform(chunk, enc, cb) {
          size += chunk.length;
          cb(size > tshock.MAX_BYTES ? new HttpError(413, 'That file is larger than 64 MB') : null, chunk);
        },
      });
      try {
        await require('stream/promises').pipeline(req, limit, fs.createWriteStream(temp, { flags: 'wx' }));
      } catch (err) {
        fs.rmSync(temp, { force: true });
        throw err;
      }
      const written = await tshock.installFile(server, temp, url.searchParams.get('name') || 'plugin.dll');
      store.addEvent('mod.installed', `${written.join(', ')} uploaded to ${server.name}`, { serverId: server.id });
      return { ok: true, installed: written, restartNeeded: manager.isActive(server.id) };
    },
    { rawBody: true }
  );

  /* ---------------------------------------------------- zomboid sandbox -- */

  router.get('/api/servers/:id/sandbox', ({ user, params, url }) => {
    const server = serverFor(user, params.id, 'settings');
    needTemplate(server, 'project-zomboid');
    const files = zomboid.listFiles(server);
    if (!files.length) return { files: [], missing: true };
    const wanted = url.searchParams.get('file');
    return { files, ...zomboid.form(server, wanted && files.includes(wanted) ? wanted : files[0]), running: manager.isActive(server.id) };
  });

  router.put('/api/servers/:id/sandbox', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    needTemplate(server, 'project-zomboid');
    // The game rewrites this file when it stops: an edit made while it runs would be lost.
    if (manager.isActive(server.id)) fail(409, 'Stop the server before changing sandbox options. The game rewrites the file when it shuts down.');
    const result = zomboid.save(server, String(body?.file || ''), { version: body?.version, changes: body?.changes });
    history.record(server.id, result.path, { before: result.before, after: result.after, by: user.username, source: 'sandbox' });
    store.addEvent('server.config_changed', `${user.username} changed sandbox options on ${server.name}`, { serverId: server.id });
    return { ok: true, version: result.version };
  });

  /* -------------------------------------------------------- 7dtd map -- */

  router.get('/api/servers/:id/sevendays-map', ({ user, params, url }) => {
    const server = serverFor(user, params.id, 'console');
    needTemplate(server, 'seven-days-to-die');
    return sevenDays.preview(server, url.searchParams.get('world') || '');
  });

  router.get(
    '/api/servers/:id/sevendays-map/image',
    ({ user, params, url, res }) => {
      const server = serverFor(user, params.id, 'console');
      needTemplate(server, 'seven-days-to-die');
      const img = sevenDays.image(server, url.searchParams.get('world') || '', url.searchParams.get('file') || 'biomes.png');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.size, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(img.file).pipe(res);
      return undefined;
    },
    { raw: true }
  );

  /* ------------------------------------------------------------ nexus -- */

  router.get('/api/servers/:id/nexus', ({ user, params, url }) => {
    const server = serverFor(user, params.id);
    const game = nexus.forTemplate(manager.template(server)?.id);
    if (!game) return { game: null };
    const query = url.searchParams.get('query');
    return { game: { ...game, searchUrl: nexus.searchUrl(game.domain, query) } };
  });
};
