'use strict';

/**
 * Squad layer rotation: SquadGame/ServerConfig/LayerRotation.cfg is one layer
 * name per line (Gorodok_RAAS_v1); lines starting with // are comments. The
 * editor reads it, offers the official layers, keeps the order the owner sets
 * and writes it back with a backup. Layers can also be typed by hand because
 * the list below can lag behind a game update.
 */

const { fail } = require('../../core/util');
const common = require('./common');

const DIR = 'SquadGame/ServerConfig';
const FILES = { LayerRotation: `${DIR}/LayerRotation.cfg`, MapRotation: `${DIR}/MapRotation.cfg` };
const LAYER = /^[A-Za-z0-9][A-Za-z0-9_]{2,79}$/;

/** map -> layers (without the map prefix). Modes: AAS, RAAS, Invasion, TC, Skirmish, Destruction, Seed, Insurgency. */
const MAPS = {
  AlBasrah: ['AAS_v1', 'Invasion_v1', 'Invasion_v2', 'RAAS_v1', 'RAAS_v2', 'RAAS_v3', 'Skirmish_v1', 'TC_v1'],
  Anvil: ['AAS_v1', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'TC_v1'],
  Belaya: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'RAAS_v3', 'Skirmish_v1', 'TC_v1'],
  BlackCoast: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'TC_v1'],
  Chora: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'Skirmish_v1', 'TC_v1'],
  Fallujah: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'Invasion_v2', 'RAAS_v1', 'RAAS_v2', 'Skirmish_v1', 'TC_v1'],
  FoolsRoad: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'Skirmish_v1', 'TC_v1'],
  GooseBay: ['AAS_v1', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'TC_v1'],
  Gorodok: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'Invasion_v2', 'RAAS_v1', 'RAAS_v2', 'RAAS_v3', 'Skirmish_v1', 'TC_v1'],
  Harju: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'RAAS_v3', 'Skirmish_v1', 'TC_v1'],
  Kamdesh: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'Skirmish_v1', 'TC_v1'],
  Kohat: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'RAAS_v3', 'Skirmish_v1', 'TC_v1'],
  Kokan: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'Skirmish_v1', 'TC_v1'],
  Lashkar: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'Skirmish_v1', 'TC_v1'],
  Logar: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'Skirmish_v1', 'TC_v1'],
  Manicouagan: ['AAS_v1', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'TC_v1'],
  Mestia: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'Skirmish_v1', 'TC_v1'],
  Mutaha: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'RAAS_v3', 'Skirmish_v1', 'TC_v1'],
  Narva: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'Skirmish_v1', 'TC_v1'],
  Sanxian: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'Skirmish_v1', 'TC_v1'],
  Skorpo: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'RAAS_v3', 'Skirmish_v1', 'TC_v1'],
  Sumari: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'Skirmish_v1', 'TC_v1'],
  Tallil: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'RAAS_v1', 'RAAS_v2', 'RAAS_v3', 'Skirmish_v1', 'TC_v1'],
  Yehorivka: ['AAS_v1', 'AAS_v2', 'Invasion_v1', 'Invasion_v2', 'RAAS_v1', 'RAAS_v2', 'RAAS_v3', 'Skirmish_v1', 'TC_v1'],
};

const CATALOG = Object.entries(MAPS).flatMap(([map, layers]) => layers.map((l) => `${map}_${l}`));

const catalog = () => Object.entries(MAPS).map(([map, layers]) => ({ map, layers: layers.map((l) => ({ id: `${map}_${l}`, mode: l.split('_')[0], version: l.split('_')[1] })) }));

function fileOf(name) {
  const rel = FILES[name || 'LayerRotation'];
  if (!rel) fail(400, 'Unknown rotation file');
  return rel;
}

/** Split a cfg into its layer lines, and the comment lines to keep on top. */
function parse(text) {
  const layers = [];
  const header = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('//') || line.startsWith('#')) {
      if (!layers.length) header.push(line);
      continue;
    }
    // A trailing // comment after a layer name is dropped.
    const name = line.split('//')[0].trim();
    if (name) layers.push(name);
  }
  return { layers, header };
}

const serialise = (layers, header = []) => [...header, ...layers].join('\n') + '\n';

function read(server, name) {
  const rel = fileOf(name);
  const text = common.readRel(server, rel, 1024 * 1024);
  const parsed = parse(text);
  return {
    file: rel,
    exists: text !== null,
    layers: parsed.layers.map((id) => ({ id, official: CATALOG.includes(id) })),
    catalog: catalog(),
    files: Object.keys(FILES),
  };
}

function save(manager, server, name, input = {}) {
  const rel = fileOf(name);
  const layers = Array.isArray(input.layers) ? input.layers.map((l) => String(l).trim()) : null;
  if (!layers) fail(400, 'Send the layers as a list');
  if (!layers.length) fail(400, 'The rotation needs at least one layer');
  if (layers.length > 500) fail(400, 'That rotation is too long');
  for (const l of layers) if (!LAYER.test(l)) fail(400, `"${l.slice(0, 60)}" is not a layer name (letters, digits and underscores, like Gorodok_RAAS_v1)`);
  const existing = common.readRel(server, rel, 1024 * 1024);
  const header = existing === null ? ['// Written by GamePanel. One layer per line, played top to bottom.'] : parse(existing).header;
  const backup = common.backupRel(server, rel);
  common.writeRel(server, rel, serialise(layers, header));
  return { ...read(server, name), backup, note: manager.isActive(server.id) ? 'Saved. Squad reads the rotation when a match ends or the server restarts.' : 'Saved.' };
}

module.exports = { MAPS, CATALOG, LAYER, parse, serialise, read, save, catalog };
