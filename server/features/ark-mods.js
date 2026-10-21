'use strict';

/**
 * ARK mod load order. ARK loads mods first to last, and a mod that comes later
 * can override one before it, so the order matters.
 *
 *  - Survival Evolved: ActiveMods=1,2,3 in GameUserSettings.ini [ServerSettings]
 *    (the same list the Workshop installer edits). The game rewrites that file
 *    when it shuts down, so it is only edited while the server is off.
 *  - Survival Ascended: the MODS variable (comma separated CurseForge IDs), which
 *    the start command passes as -mods=.
 */

const { fail } = require('../core/util');
const { patchKeyValue } = require('../servers/config-files');
const G = require('./ark-gameini');
const manifest = require('./mods/manifest');

const ID = /^\d{1,12}$/;
const MAX_MODS = 200;

/** "-mods=1,2,3" (or nothing) for the start command. Only digits and commas get through. */
function asaArgs(value) {
  const ids = String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ID.test(s));
  return ids.length ? `-mods=${[...new Set(ids)].join(',')}` : '';
}

function cleanIds(input) {
  if (!Array.isArray(input)) fail(400, 'Send the mod IDs as a list');
  if (input.length > MAX_MODS) fail(400, `At most ${MAX_MODS} mods`);
  const ids = input.map((v) => String(v).trim());
  for (const id of ids) if (!ID.test(id)) fail(400, `"${id.slice(0, 20)}" is not a mod ID (they are numbers)`);
  if (new Set(ids).size !== ids.length) fail(400, 'A mod is listed twice');
  return ids;
}

const isAsa = (server) => server.templateId === 'ark-survival-ascended';

/** The saved order, with the names the panel knows. */
function read(manager, server) {
  if (!G.isArk(server)) fail(400, 'Only ARK servers have a mod load order');
  let ids;
  if (isAsa(server)) ids = String(server.vars?.MODS ?? '').split(',');
  else ids = (G.readEntries(G.readText(G.iniPath(manager, server, 'GameUserSettings.ini')), ['ActiveMods'], 'ServerSettings').pop()?.value || '').split(',');
  ids = [...new Set(ids.map((s) => s.trim()).filter((s) => ID.test(s)))];
  const known = new Map(manifest.load(server).filter((m) => m.projectId).map((m) => [String(m.projectId), m]));
  return {
    game: isAsa(server) ? 'asa' : 'ase',
    applied: isAsa(server) ? 'the start command (-mods=)' : 'ActiveMods in GameUserSettings.ini',
    running: manager.isActive(server.id),
    mods: ids.map((id) => ({ id, name: known.get(id)?.name || null })),
  };
}

/** Save the order. The ASE file is only touched while the server is off. */
function write(manager, server, input, actor) {
  if (!G.isArk(server)) fail(400, 'Only ARK servers have a mod load order');
  const ids = cleanIds(input);
  if (isAsa(server)) {
    manager.update(server.id, { vars: { MODS: ids.join(',') } }, { trusted: true, actor: actor || 'panel', source: 'ark-mods' });
  } else {
    if (manager.isActive(server.id)) fail(409, 'Stop the server first. ARK rewrites its settings file when it shuts down and would undo the change.');
    const file = G.iniPath(manager, server, 'GameUserSettings.ini');
    G.writeText(file, patchKeyValue(G.readText(file), { ActiveMods: ids.join(',') }, { section: 'ServerSettings' }));
  }
  return read(manager, server);
}

module.exports = { asaArgs, cleanIds, read, write };
