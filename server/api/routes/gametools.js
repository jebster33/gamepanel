'use strict';

/**
 * Per-game tools: /api/servers/:id/gametools/<game>/...
 *   cs2          presets, map pool + end-of-match vote, Metamod/CounterStrikeSharp installs, opt-in skin changer (admin)
 *   squad        layer rotation editor
 *   garrysmod    gamemode / map switcher
 *   satisfactory save manager (API + save files)
 *   palworld     player data reset (admin, server stopped)
 *   space-engineers  world cleanup (admin, server stopped)
 */

const fs = require('fs');
const { fail } = require('../../core/util');
const cs2 = require('../../features/gametools/cs2');
const skins = require('../../features/gametools/cs2-skins');
const squad = require('../../features/gametools/squad');
const gmod = require('../../features/gametools/gmod');
const satisfactory = require('../../features/gametools/satisfactory');
const palworld = require('../../features/gametools/palworld');
const se = require('../../features/gametools/space-engineers');

module.exports = (router, { store, manager }, { requireAdmin, requireCap, serverFor }) => {
  const base = '/api/servers/:id/gametools';

  /** The server, only when it runs this game (and on this machine, since the tools read its folder). */
  const target = (user, id, templateId, cap) => {
    const server = serverFor(user, id, cap);
    if (server.templateId !== templateId) fail(400, `These tools are only for ${templateId} servers`);
    if (server.node) fail(400, 'These tools work on servers hosted by this panel, not on another node');
    return server;
  };
  const event = (type, text, server) => store.addEvent(type, text, { serverId: server.id });

  /* ------------------------------------------------------------------ CS2 -- */

  router.get(`${base}/cs2`, ({ user, params }) => cs2.describe(manager, target(user, params.id, 'cs2', 'settings')));

  router.post(`${base}/cs2/preset`, ({ user, params, body }) => {
    const server = target(user, params.id, 'cs2', 'settings');
    requireCap(user, 'files.write', server.id);
    const out = cs2.applyPreset(manager, store, server, body || {});
    event('server.cs2_preset', `${user.username} set the ${out.preset} preset on ${server.name}`, server);
    return out;
  });

  router.put(`${base}/cs2/maps`, ({ user, params, body }) => {
    const server = target(user, params.id, 'cs2', 'settings');
    requireCap(user, 'files.write', server.id);
    const out = cs2.setPool(manager, store, server, body || {});
    event('server.cs2_maps', `${user.username} changed the map pool of ${server.name} (${out.maps.length} maps)`, server);
    return out;
  });

  // Downloads and unpacks code the game will run: admin only.
  router.post(`${base}/cs2/plugins/:plugin`, async ({ user, params }) => {
    requireAdmin(user);
    const server = target(user, params.id, 'cs2');
    const out = await cs2.installPlugin(manager, server, params.plugin);
    event('server.cs2_plugin', `${user.username} installed ${params.plugin} on ${server.name}`, server);
    return { ...out, ...cs2.describe(manager, server) };
  });

  // Skin changer: opt-in, admin only everywhere.
  const skinServer = (user, id) => {
    requireAdmin(user);
    return target(user, id, 'cs2');
  };
  router.get(`${base}/cs2/skins`, ({ user, params }) => skins.view(skinServer(user, params.id)));
  router.get(`${base}/cs2/skins/catalog`, async ({ user, params, url }) => {
    skinServer(user, params.id);
    return skins.catalog({ refresh: url.searchParams.get('refresh') === '1' });
  });
  router.put(`${base}/cs2/skins/enabled`, ({ user, params, body }) => {
    const server = skinServer(user, params.id);
    const out = skins.enable(store, server, body || {}, user.username);
    event('server.cs2_skins', `${user.username} ${out.enabled ? 'ACCEPTED THE GSLT-BAN WARNING and turned on' : 'turned off'} the skin changer on ${server.name}`, server);
    return out;
  });
  router.put(`${base}/cs2/skins/database`, ({ user, params, body }) => skins.setDb(store, skinServer(user, params.id), body || {}));
  router.put(`${base}/cs2/skins/players/:steamid`, async ({ user, params, body }) => {
    const server = skinServer(user, params.id);
    await skins.pick(store, server, params.steamid, body || {});
    return skins.view(server);
  });
  router.delete(`${base}/cs2/skins/players/:steamid`, ({ user, params, url }) => {
    const server = skinServer(user, params.id);
    skins.unpick(store, server, params.steamid, url.searchParams.get('key') || '');
    return skins.view(server);
  });
  router.post(`${base}/cs2/skins/config`, ({ user, params }) => skins.writePluginConfig(manager, skinServer(user, params.id)));
  router.post(`${base}/cs2/skins/sync`, async ({ user, params }) => skins.sync(skinServer(user, params.id)));
  router.get(
    `${base}/cs2/skins/sql`,
    ({ user, params, res }) => {
      const text = skins.sql(skinServer(user, params.id));
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="weaponpaints.sql"' });
      res.end(text);
      return undefined;
    },
    { raw: true }
  );

  /* ---------------------------------------------------------------- Squad -- */

  router.get(`${base}/squad`, ({ user, params, url }) => squad.read(target(user, params.id, 'squad', 'files'), url.searchParams.get('file')));
  router.put(`${base}/squad`, ({ user, params, url, body }) => {
    const server = target(user, params.id, 'squad', 'files.write');
    const out = squad.save(manager, server, url.searchParams.get('file'), body || {});
    event('server.squad_rotation', `${user.username} saved the layer rotation of ${server.name} (${out.layers.length} layers)`, server);
    return out;
  });

  /* ---------------------------------------------------------- Garry's Mod -- */

  router.get(`${base}/garrysmod`, ({ user, params }) => gmod.describe(manager, target(user, params.id, 'garrysmod', 'settings')));
  router.put(`${base}/garrysmod`, ({ user, params, body }) => {
    const server = target(user, params.id, 'garrysmod', 'settings');
    const out = gmod.apply(manager, store, server, body || {});
    event('server.gmod_gamemode', `${user.username} set ${server.name} to ${out.current.gamemode} on ${out.current.map || 'its current map'}`, server);
    return out;
  });
  router.post(`${base}/garrysmod/workshop`, async ({ user, params, body }) => {
    const server = target(user, params.id, 'garrysmod', 'mods');
    const { installWorkshop } = require('../../features/mods/workshop');
    const result = await installWorkshop(server, manager.template(server), manager, { input: String(body?.input || '') }, store.state.settings.integrations || {});
    event('mod.installed', `Workshop ${result.items.join(', ')} added to ${server.name}`, server);
    return result;
  });

  /* --------------------------------------------------------- Satisfactory -- */

  const sat = (user, id, cap = 'files') => target(user, id, 'satisfactory', cap);
  router.get(`${base}/satisfactory`, ({ user, params }) => ({ ...satisfactory.status(sat(user, params.id)), ...satisfactory.listFiles(sat(user, params.id)) }));
  router.post(`${base}/satisfactory/trust`, async ({ user, params }) => {
    requireAdmin(user);
    return satisfactory.trustCertificate(store, sat(user, params.id));
  });
  router.post(`${base}/satisfactory/login`, async ({ user, params, body }) => {
    requireAdmin(user);
    return satisfactory.login(store, sat(user, params.id), body || {});
  });
  router.post(`${base}/satisfactory/logout`, ({ user, params }) => {
    requireAdmin(user);
    return satisfactory.logout(store, sat(user, params.id));
  });
  router.get(`${base}/satisfactory/sessions`, async ({ user, params }) => satisfactory.sessions(sat(user, params.id)));
  router.post(`${base}/satisfactory/load`, async ({ user, params, body }) => {
    const server = sat(user, params.id, 'files.write');
    requireCap(user, 'power', server.id);
    await satisfactory.loadSave(server, body?.name, body?.advanced);
    event('server.sf_load', `${user.username} loaded save "${body?.name}" on ${server.name}`, server);
    return { ok: true };
  });
  router.post(`${base}/satisfactory/save`, async ({ user, params, body }) => {
    const server = sat(user, params.id, 'files.write');
    await satisfactory.saveNow(server, body?.name);
    return { ok: true };
  });
  router.post(`${base}/satisfactory/new`, async ({ user, params, body }) => {
    const server = sat(user, params.id, 'files.write');
    requireCap(user, 'power', server.id);
    await satisfactory.newGame(server, body || {});
    event('server.sf_new', `${user.username} started a new game "${body?.sessionName}" on ${server.name}`, server);
    return { ok: true };
  });
  router.delete(`${base}/satisfactory/save`, async ({ user, params, url }) => {
    const server = sat(user, params.id, 'files.write');
    await satisfactory.deleteSave(server, url.searchParams.get('name'));
    event('server.sf_delete', `${user.username} deleted save "${url.searchParams.get('name')}" on ${server.name}`, server);
    return { ok: true };
  });
  router.delete(`${base}/satisfactory/session`, async ({ user, params, url }) => {
    const server = sat(user, params.id, 'files.write');
    await satisfactory.deleteSession(server, url.searchParams.get('name'));
    event('server.sf_delete', `${user.username} deleted session "${url.searchParams.get('name')}" on ${server.name}`, server);
    return { ok: true };
  });
  router.get(
    `${base}/satisfactory/download`,
    async ({ user, params, url, res }) => {
      const server = sat(user, params.id);
      await satisfactory.download(server, url.searchParams.get('name'), res);
      return undefined;
    },
    { raw: true }
  );
  router.post(
    `${base}/satisfactory/upload`,
    async ({ user, params, url, req }) => {
      const server = sat(user, params.id, 'files.write');
      return satisfactory.upload(server, url.searchParams.get('name'), req, req.headers['content-length'], { load: url.searchParams.get('load') === '1' });
    },
    { rawBody: true }
  );
  // The same on the files, for when the API is not reachable (server stopped, no token).
  router.get(
    `${base}/satisfactory/file`,
    ({ user, params, url, res }) => {
      const found = satisfactory.openFile(sat(user, params.id), url.searchParams.get('name'));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': found.size, 'Content-Disposition': `attachment; filename="${found.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"` });
      fs.createReadStream(found.file).pipe(res);
      return undefined;
    },
    { raw: true }
  );
  router.post(
    `${base}/satisfactory/file`,
    async ({ user, params, url, req }) => satisfactory.uploadFile(manager, sat(user, params.id, 'files.write'), url.searchParams.get('name'), req),
    { rawBody: true }
  );
  router.delete(`${base}/satisfactory/file`, ({ user, params, url }) => {
    const server = sat(user, params.id, 'files.write');
    const out = satisfactory.deleteFile(manager, server, url.searchParams.get('name'));
    event('server.sf_delete', `${user.username} removed save file "${url.searchParams.get('name')}" from ${server.name}`, server);
    return out;
  });

  /* ------------------------------------------------------------- Palworld -- */

  router.get(`${base}/palworld/players`, async ({ user, params }) => palworld.list(manager, target(user, params.id, 'palworld', 'files')));
  router.post(`${base}/palworld/reset`, ({ user, params, body }) => {
    requireAdmin(user);
    const server = target(user, params.id, 'palworld');
    const out = palworld.reset(manager, store, server, body || {});
    event('server.palworld_reset', `${user.username} reset player ${body?.guid} on ${server.name} (backup ${out.backup})`, server);
    return out;
  });
  router.post(`${base}/palworld/restore`, ({ user, params, body }) => {
    requireAdmin(user);
    const server = target(user, params.id, 'palworld');
    const out = palworld.restore(manager, store, server, body || {});
    event('server.palworld_restore', `${user.username} restored a player backup on ${server.name}`, server);
    return out;
  });

  /* ------------------------------------------------------ Space Engineers -- */

  router.get(`${base}/space-engineers`, ({ user, params, url }) => {
    requireAdmin(user);
    const q = url.searchParams;
    return se.scan(target(user, params.id, 'space-engineers'), { world: q.get('world') || undefined, days: q.get('days'), smallBlocks: q.get('smallBlocks') ?? undefined });
  });
  router.post(`${base}/space-engineers/remove`, ({ user, params, body }) => {
    requireAdmin(user);
    const server = target(user, params.id, 'space-engineers');
    const out = se.remove(manager, server, body || {});
    event('server.se_cleanup', `${user.username} removed ${out.removed} entities from the world of ${server.name} (backup ${out.backup})`, server);
    return out;
  });
};
