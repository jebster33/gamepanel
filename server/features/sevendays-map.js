'use strict';

/**
 * 7 Days to Die: a preview of the generated world. Once the game has made
 * the world, its folder holds biomes.png (one coloured pixel per area),
 * prefabs.xml (every building, with its place) and map_info.xml (the size).
 * This reads those files; the browser paints the picture and the markers.
 *
 * Before the world exists there is nothing to read: the game generates it
 * on the first start, and the panel cannot do that without running it.
 */

const fs = require('fs');
const path = require('path');
const { fail } = require('../core/util');
const { containedPath } = require('./files');

// Where generated worlds live (UserDataFolder is <server>/data in the panel's template) and where the game keeps its own.
const ROOTS = ['data/GeneratedWorlds', 'Data/Worlds'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const IMAGES = new Set(['biomes.png', 'radiation.png']);
const MAX_IMAGE = 40 * 1024 * 1024;
const MAX_XML = 16 * 1024 * 1024;
const MAX_POIS = 6000;

const readSmall = (file, max) => {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > max) throw new Error('too big');
  return fs.readFileSync(file, 'utf8');
};

/** World folders that have been generated: [{ name, root, files }]. */
function worlds(server) {
  const out = [];
  for (const root of ROOTS) {
    let entries;
    try {
      entries = fs.readdirSync(containedPath(server.dir, root), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !NAME.test(e.name) || out.some((w) => w.name === e.name)) continue;
      const have = (f) => {
        try {
          return fs.statSync(containedPath(server.dir, `${root}/${e.name}/${f}`)).isFile();
        } catch {
          return false;
        }
      };
      const files = { biomes: have('biomes.png'), prefabs: have('prefabs.xml'), info: have('map_info.xml') };
      if (files.biomes || files.prefabs) out.push({ name: e.name, root, files });
    }
  }
  return out;
}

function attrs(text) {
  const out = {};
  for (const m of text.matchAll(/([A-Za-z_]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const pretty = (name) =>
  String(name)
    .replace(/_\d+$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

/** The size (metres) from map_info.xml: <property name="HeightMapSize" value="6144,6144"/>. */
function parseSize(xml) {
  const m = /name="HeightMapSize"\s+value="(\d+)\s*,\s*(\d+)"/i.exec(xml) || /value="(\d+)\s*,\s*(\d+)"\s+name="HeightMapSize"/i.exec(xml);
  return m ? Number(m[1]) : null;
}

/** Buildings out of prefabs.xml: <decoration type="model" name="army_camp_01" position="-300,33,1200" rotation="2"/>. */
function parsePrefabs(xml) {
  const pois = [];
  for (const m of xml.matchAll(/<decoration\s+([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    const [x, y, z] = String(a.position || '').split(',').map(Number);
    if (!a.name || !Number.isFinite(x) || !Number.isFinite(z)) continue;
    pois.push({ name: pretty(a.name), id: a.name, x: Math.round(x), z: Math.round(z) });
    if (pois.length >= MAX_POIS) break;
  }
  return pois;
}

/** What the map card needs, or { available: false } with the reason. */
function preview(server, name) {
  const list = worlds(server);
  if (!list.length) {
    return {
      available: false,
      message: 'A preview is only available after the world exists. 7 Days to Die builds the world the first time the server starts, so start the server once and come back here.',
    };
  }
  const world = (name && list.find((w) => w.name === name)) || list[0];
  const dir = `${world.root}/${world.name}`;
  let size = null;
  let pois = [];
  try {
    if (world.files.info) size = parseSize(readSmall(containedPath(server.dir, `${dir}/map_info.xml`), MAX_XML));
  } catch {
    /* the picture still works without the size */
  }
  try {
    if (world.files.prefabs) pois = parsePrefabs(readSmall(containedPath(server.dir, `${dir}/prefabs.xml`), MAX_XML));
  } catch {
    /* no markers */
  }
  const counts = {};
  for (const p of pois) counts[p.name] = (counts[p.name] || 0) + 1;
  return {
    available: true,
    worlds: list.map((w) => w.name),
    world: world.name,
    hasImage: world.files.biomes,
    size,
    pois,
    summary: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, c]) => ({ name: n, count: c })),
    note: world.files.biomes ? null : 'The world has no biomes.png yet, so only the markers can be shown.',
  };
}

/** A picture from the world folder (only the known file names). */
function image(server, name, file = 'biomes.png') {
  if (!IMAGES.has(file)) fail(400, 'Unknown image');
  const world = worlds(server).find((w) => w.name === name);
  if (!world) fail(404, 'That world has not been generated yet');
  const target = containedPath(server.dir, `${world.root}/${world.name}/${file}`);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    fail(404, 'That image does not exist');
  }
  if (!stat.isFile() || stat.size > MAX_IMAGE) fail(413, 'That image is too big to show');
  return { file: target, size: stat.size, name: path.basename(target) };
}

module.exports = { worlds, preview, image, parsePrefabs, parseSize, pretty };
