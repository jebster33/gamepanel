'use strict';

/**
 * Which map a Rust server loads. The panel keeps the choice in `server.map`:
 *
 *   { mode: 'procedural' }                       size + seed from the settings (the default)
 *   { mode: 'official', level: 'HapisIsland' }   a map that ships with the game (+server.level)
 *   { mode: 'url', url: 'https://…/x.map' }      any hosted .map file (+server.levelurl)
 *   { mode: 'file', file: 'x.map', token }       a .map uploaded to the server's custom-maps folder,
 *                                                served to the game by the panel (+server.levelurl)
 *
 * The launch line gets the result as {{MAP_ARGS}}. A new map needs a wipe: the
 * old save belongs to the old map.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { fail } = require('../core/util');
const { containedPath } = require('./files');
const { config } = require('../core/config');

const DIR = 'custom-maps';
const OFFICIAL = [
  ['Barren', 'Barren'],
  ['HapisIsland', 'Hapis Island'],
  ['CraggyIsland', 'Craggy Island'],
  ['SavasIsland', 'Savas Island'],
  ['SavasIsland_koth', 'Savas Island (King of the Hill)'],
];
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}\.map$/;

const mapOf = (server) => server.map || { mode: 'procedural' };

/** Fixed maps ignore the size and seed, so a wipe has nothing to reseed. */
const isFixed = (server) => ['official', 'url', 'file'].includes(mapOf(server).mode);

/** Only a plain web address: it is placed inside quotes on the game's command line. */
function checkUrl(value) {
  const url = String(value || '').trim();
  if (url.length > 500 || !/^https?:\/\/[^\s"'`$\;&|<>(){}]+$/i.test(url)) fail(400, 'That is not a plain http(s) link to a .map file');
  return url;
}

function files(server) {
  let dir;
  try {
    dir = containedPath(server.dir, DIR);
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && FILE_NAME.test(e.name))
      .map((e) => ({ name: e.name, size: fs.statSync(path.join(dir, e.name)).size }));
  } catch {
    return [];
  }
}

/** Where the game reaches the panel: this machine for a plain process, the host for a container. */
function panelBase(manager, server) {
  const host = manager.runtimeFor(server) === 'docker' ? 'host.docker.internal' : '127.0.0.1';
  return `http://${host}:${config.port}`;
}

/** The text {{MAP_ARGS}} turns into. */
function args(manager, server) {
  const map = mapOf(server);
  if (map.mode === 'official' && OFFICIAL.some(([id]) => id === map.level)) return `+server.level "${map.level}"`;
  if (map.mode === 'url' && map.url) return `+server.levelurl "${checkUrl(map.url)}"`;
  if (map.mode === 'file' && map.file && map.token && FILE_NAME.test(map.file)) {
    return `+server.levelurl "${panelBase(manager, server)}/api/public/rust-map/${server.id}/${map.token}/${encodeURIComponent(map.file)}"`;
  }
  return '';
}

function describe(server) {
  return { map: { ...mapOf(server), token: undefined }, official: OFFICIAL.map(([id, label]) => ({ id, label })), files: files(server), dir: DIR };
}

/** Change the map; returns what describe() would. */
function set(manager, store, server, input = {}) {
  const mode = String(input.mode || 'procedural');
  const prev = mapOf(server);
  let next;
  if (mode === 'procedural') next = { mode };
  else if (mode === 'official') {
    if (!OFFICIAL.some(([id]) => id === input.level)) fail(400, 'Unknown official map');
    next = { mode, level: input.level };
  } else if (mode === 'url') next = { mode, url: checkUrl(input.url) };
  else if (mode === 'file') {
    const file = String(input.file || '');
    if (!FILE_NAME.test(file) || !files(server).some((f) => f.name === file)) fail(400, `Upload the .map file to the ${DIR} folder first`);
    next = { mode, file, token: prev.token || crypto.randomBytes(18).toString('hex') };
  } else fail(400, 'Unknown map mode');
  server.map = next;
  store.save();
  return describe(server);
}

/** The public download the game makes for an uploaded map. */
function openFile(server, token, name) {
  const map = mapOf(server);
  const given = Buffer.from(String(token));
  const real = Buffer.from(String(map.token || ''));
  if (map.mode !== 'file' || !real.length || given.length !== real.length || !crypto.timingSafeEqual(given, real)) return null;
  if (name !== map.file || !FILE_NAME.test(name)) return null;
  try {
    const file = containedPath(server.dir, `${DIR}/${name}`);
    return { file, size: fs.statSync(file).size };
  } catch {
    return null;
  }
}

module.exports = { args, describe, set, openFile, isFixed, OFFICIAL, DIR };
