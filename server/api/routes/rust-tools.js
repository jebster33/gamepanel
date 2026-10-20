'use strict';

const { fail } = require('../../core/util');
const tools = require('../../features/rust-tools');
const afk = require('../../features/rust-afk');
const rustTeams = require('../../features/rust-teams');

/** Rust extras: loot and stack presets, day length, AFK kick, teams, entity counts, info card. */
module.exports = (router, { store, manager }, { serverFor }) => {
  const rustServer = (user, id, cap) => {
    const server = serverFor(user, id, cap);
    if (server.templateId !== 'rust') fail(400, 'This is only for Rust servers');
    return server;
  };
  const audit = (server, user, what) => store.addEvent('server.settings', `${user.username} changed ${what} on ${server.name}`, { serverId: server.id });

  router.get('/api/servers/:id/rust-tools', ({ user, params }) => {
    const server = rustServer(user, params.id, 'settings');
    return { ...tools.view(manager, server), afk: afk.settings(server) };
  });

  // A script the game runs, like uploading it by hand: file permission.
  router.post('/api/servers/:id/rust-tools/plugin', async ({ user, params, body }) => {
    const server = rustServer(user, params.id, 'files.write');
    const key = String(body?.plugin || '');
    if (!tools.PLUGINS[key]) fail(400, 'Pick BetterLoot or StackSizeController');
    const result = await tools.installPlugin(manager, server, key);
    audit(server, user, `${tools.PLUGINS[key].name} (${result})`);
    return { result, ...tools.view(manager, server) };
  });

  router.post('/api/servers/:id/rust-tools/loot', async ({ user, params, body }) => {
    const server = rustServer(user, params.id, 'settings');
    const result = await tools.applyPreset(manager, server, 'loot', tools.lootSpec(body || {}));
    audit(server, user, `the loot multiplier (${server.rustTools.loot.multiplier}x)`);
    return { ...result, ...tools.view(manager, server) };
  });

  router.post('/api/servers/:id/rust-tools/stack', async ({ user, params, body }) => {
    const server = rustServer(user, params.id, 'settings');
    const result = await tools.applyPreset(manager, server, 'stack', tools.stackSpec(body || {}));
    audit(server, user, 'the stack sizes');
    return { ...result, ...tools.view(manager, server) };
  });

  router.put('/api/servers/:id/rust-tools/time', async ({ user, params, body }) => {
    const server = rustServer(user, params.id, 'settings');
    const result = await tools.setTime(manager, server, body || {});
    audit(server, user, `day and night length (${result.day ?? 'default'} / ${result.night ?? 'default'} minutes)`);
    return { ...result, ...tools.view(manager, server) };
  });

  // Kicking players is a console job.
  router.put('/api/servers/:id/rust-tools/afk', ({ user, params, body }) => {
    const server = rustServer(user, params.id, 'command');
    const settings = afk.update(manager, server, body || {});
    audit(server, user, `the AFK and ping kick (${settings.enabled ? 'on' : 'off'})`);
    return { afk: settings };
  });

  // Names, positions and bases of players: console permission, like the live map.
  router.get('/api/servers/:id/rust-teams', ({ user, params }) => rustTeams.teams(manager, store, rustServer(user, params.id, 'console')));
  router.get('/api/servers/:id/rust-entities', ({ user, params }) => rustTeams.entities(manager, store, rustServer(user, params.id, 'console')));

  // Public-safe fields only; anyone who can see the server may open it.
  router.get('/api/servers/:id/rust-info', ({ user, params, req }) => {
    const server = rustServer(user, params.id);
    const host = String(req?.headers?.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '') || null;
    return rustTeams.infoCard(manager, server, server.node?.host || host);
  });
};
