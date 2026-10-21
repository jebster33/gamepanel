'use strict';

const { fail } = require('../../core/util');
const playerEdit = require('../../features/player-data-edit');
const worldConvert = require('../../features/world-convert');
const luckperms = require('../../features/luckperms');
const jvm = require('../../features/jvm-presets');
const skins = require('../../features/mc-skins');

const isJavaTemplate = (manager, server) => /^minecraft-(?!bedrock$|velocity$)/.test(String(server.templateId || '')) && manager.template(server);

module.exports = (router, { store, manager }, { requireAdmin, serverFor }) => {
  /* ------------------------------------------------ inventory editor -- */

  router.get('/api/servers/:id/players/:name/inventory/edit', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'files');
    if (!isJavaTemplate(manager, server)) fail(400, 'Inventories can be edited on Minecraft Java servers');
    return playerEdit.view(manager, server, params.name);
  });

  router.put('/api/servers/:id/players/:name/inventory/edit', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'files.write');
    if (!isJavaTemplate(manager, server)) fail(400, 'Inventories can be edited on Minecraft Java servers');
    return playerEdit.save(manager, store, server, params.name, body || {}, user.username);
  });

  /* ------------------------------------------------- world converter -- */

  router.post('/api/servers/:id/worlds/inspect', ({ user, params, body }) => worldConvert.inspect(serverFor(user, params.id, 'files.write'), body?.path));

  router.post('/api/servers/:id/worlds/convert', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'files.write');
    return worldConvert.convert(
      manager,
      server,
      { path: body?.path, name: body?.name, layout: body?.layout, use: body?.use !== false, replace: Boolean(body?.replace) },
      user.username
    );
  });

  /* ---------------------------------------------------------- LuckPerms -- */

  router.get('/api/servers/:id/luckperms', ({ user, params }) => luckperms.installed(serverFor(user, params.id, 'command')));

  router.get('/api/servers/:id/luckperms/data', async ({ user, params }) => luckperms.read(manager, serverFor(user, params.id, 'command')));

  router.post('/api/servers/:id/luckperms/action', async ({ user, params, body }) => luckperms.run(manager, serverFor(user, params.id, 'command'), body || {}, user.username));

  /* ----------------------------------------------------- JVM presets -- */

  router.get('/api/servers/:id/jvm', ({ user, params }) => jvm.view(manager, serverFor(user, params.id, 'settings')));

  // Flags run inside the start command: administrators only (sub-users cannot edit JAVA_ARGS either).
  router.put('/api/servers/:id/jvm', ({ user, params, body }) => {
    requireAdmin(user);
    return jvm.apply(manager, serverFor(user, params.id), body || {}, user.username);
  });

  /* ------------------------------------------------------------ skins -- */

  router.get('/api/servers/:id/players/:name/skin', async ({ user, params, res }) => {
    const server = serverFor(user, params.id);
    if (!String(server.templateId || '').startsWith('minecraft') || server.templateId === 'minecraft-velocity') fail(404, 'No skins for this game');
    const skin = await skins.skinFor(manager, server, params.name);
    if (!skin) fail(404, 'No skin');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': skin.png.length,
      'Cache-Control': 'private, max-age=3600',
      'X-Skin-Model': skin.slim ? 'slim' : 'classic',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(skin.png);
    return undefined;
  });
};
