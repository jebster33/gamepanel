'use strict';

/**
 * A map of the world for games that have one on the web:
 *
 *   Rust      rustmaps.com renders procedural maps from the size and seed
 *   Valheim   valheim-map.world draws the world from its seed name, read from the .fwl file
 *   Terraria  TerraMap's web viewer opens a .wld file in the browser (nothing is uploaded)
 *
 * Minecraft has BlueMap, a live map the server runs itself (servers/livemap.js).
 */

const fs = require('fs');
const path = require('path');
const { containedPath } = require('../features/files');

/** C# BinaryWriter strings: a 7-bit encoded length, then UTF-8. */
function readString(buf, offset) {
  let length = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[offset++];
    length |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80 && shift < 35);
  if (offset + length > buf.length) throw new Error('truncated');
  return [buf.toString('utf8', offset, offset + length), offset + length];
}

/** Valheim's world metadata (.fwl): length, version, world name, seed name, seed. */
function parseFwl(buf) {
  let offset = 8; // int32 data length, int32 version
  const [name, afterName] = readString(buf, offset);
  offset = afterName;
  const [seedName, afterSeed] = readString(buf, offset);
  const seed = buf.readInt32LE(afterSeed);
  return { name, seedName, seed };
}

function valheimWorld(server) {
  const world = String(server.vars?.WORLD_NAME || 'Dedicated');
  for (const dir of ['savedir/worlds_local', 'savedir/worlds']) {
    try {
      return parseFwl(fs.readFileSync(containedPath(server.dir, path.posix.join(dir, `${world}.fwl`))));
    } catch {
      /* try the next place */
    }
  }
  return null;
}

/**
 * What the panel can offer for this server's world:
 *   { kind: 'link', url, label, note } | { kind: 'file', path, viewer, label, note } | { kind: 'none', note }
 * or null when the game has no web map at all.
 */
function worldMap(server) {
  switch (server.templateId) {
    case 'rust': {
      const size = Number(server.vars?.WORLD_SIZE) || 3500;
      const seed = Number(server.vars?.WORLD_SEED);
      if (!Number.isInteger(seed)) return { kind: 'none', note: 'Set a world seed on the Settings tab to get a map.' };
      return { kind: 'link', url: `https://rustmaps.com/map/${size}_${seed}`, label: 'Open on RustMaps', note: `Procedural map, size ${size}, seed ${seed}. It changes when the seed or size does (a wipe).` };
    }
    case 'valheim': {
      const world = valheimWorld(server);
      if (!world?.seedName) return { kind: 'none', note: 'Start the server once so it creates the world; the map is drawn from its seed.' };
      return {
        kind: 'link',
        url: `https://valheim-map.world/?seed=${encodeURIComponent(world.seedName)}&offset=0%2C0&zoom=0.600&view=0`,
        label: 'Open on valheim-map.world',
        note: `World "${world.name}", seed ${world.seedName}. Shows the whole generated world; spoilers included.`,
      };
    }
    case 'terraria': {
      const name = String(server.vars?.WORLD_NAME || 'World');
      const rel = `worlds/${name}.wld`;
      let exists = false;
      try {
        exists = fs.statSync(containedPath(server.dir, rel)).isFile();
      } catch {
        exists = false;
      }
      if (!exists) return { kind: 'none', note: 'Start the server once so it creates the world.' };
      return { kind: 'file', path: rel, viewer: 'https://terramap.github.io/', label: 'Download the world', note: 'Open the file in TerraMap, which shows it in your browser without uploading it. Stop the server first for the newest state, or use a backup.' };
    }
    default:
      return null;
  }
}

/** A plain link for the public server list, where there is one. */
function publicMapUrl(server) {
  const map = worldMap(server);
  return map?.kind === 'link' ? map.url : null;
}

module.exports = { worldMap, publicMapUrl, parseFwl };
