'use strict';

/** Per-game tools from features/game-kits.js. */

const { fail } = require('../../core/util');
const kits = require('../../features/game-kits');

module.exports = (router, { store, manager }, { serverFor, requireAdmin }) => {
  const local = (server) => {
    if (server.node) fail(400, 'This works on servers hosted by this panel, not on another node');
    return server;
  };
  const ev = (type, text, server) => store.addEvent(type, text, { serverId: server.id });
  const q = (url, k) => url.searchParams.get(k) || '';

  router.get('/api/servers/:id/fivem/resources', ({ user, params }) => kits.fivemResources(local(serverFor(user, params.id, 'files'))));
  router.put('/api/servers/:id/fivem/resources/:name', ({ user, params, body }) => {
    const server = local(serverFor(user, params.id, 'files.write'));
    const out = kits.fivemToggle(server, params.name, Boolean(body?.enabled));
    ev('server.files', `${user.username} ${body?.enabled ? 'enabled' : 'disabled'} resource ${params.name} on ${server.name}`, server);
    return out;
  });

  router.get('/api/servers/:id/dayz/types', ({ user, params, url }) => kits.dayzTypes(local(serverFor(user, params.id, 'files')), { q: q(url, 'q'), page: q(url, 'page') }));
  router.put('/api/servers/:id/dayz/types/:name', ({ user, params, body }) => {
    const server = local(serverFor(user, params.id, 'files.write'));
    const out = kits.dayzSetType(server, params.name, body);
    ev('server.files', `${user.username} changed the loot of ${params.name} on ${server.name}`, server);
    return out;
  });

  router.get('/api/servers/:id/valheim/modifiers', ({ user, params }) => kits.valheimView(serverFor(user, params.id, 'settings')));
  router.put('/api/servers/:id/valheim/modifiers', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    const out = kits.valheimSet(manager, server, body, user.username);
    ev('server.settings', `${user.username} changed the world modifiers on ${server.name}`, server);
    return out;
  });

  router.get('/api/servers/:id/factorio/saves', ({ user, params }) => kits.factorioSaves(local(serverFor(user, params.id, 'files'))));
  router.put('/api/servers/:id/factorio/saves', ({ user, params, body }) => {
    const server = local(serverFor(user, params.id, 'files.write'));
    const out = kits.factorioUse(manager, server, body?.name, user.username);
    ev('server.settings', `${user.username} set the Factorio save of ${server.name} to ${body.name}`, server);
    return out;
  });

  router.get('/api/servers/:id/unturned/frameworks', ({ user, params }) => kits.unturnedFrameworks(local(serverFor(user, params.id, 'files'))));
  // Downloads and unpacks code the game then runs: admins only.
  router.post('/api/servers/:id/unturned/frameworks', async ({ user, params, body }) => {
    requireAdmin(user);
    const server = local(serverFor(user, params.id, 'files.write'));
    const out = await kits.unturnedInstall(manager, server, body?.id);
    ev('server.files', `${user.username} installed ${body.id} ${out.version} on ${server.name}`, server);
    return out;
  });

  router.get('/api/servers/:id/reforger', ({ user, params }) => kits.reforgerView(serverFor(user, params.id, 'settings')));
  router.put('/api/servers/:id/reforger', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    const out = kits.reforgerSet(manager, server, body, user.username);
    ev('server.settings', `${user.username} changed the scenario or mods on ${server.name}`, server);
    return out;
  });
};
