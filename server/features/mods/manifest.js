'use strict';

/**
 * The record of what the panel installed into a server: which project each
 * file came from, which version, and whether it was pulled in as a
 * dependency. It lives in the server directory (so it travels with backups)
 * at .gamepanel/mods.json.
 *
 * Entry: { key, provider, projectId, slug, name, version, versionId, file,
 *          icon, url, auto, requiredBy[], installedAt }
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join('.gamepanel', 'mods.json');

const keyOf = (provider, projectId) => `${provider}:${projectId}`;

function load(server) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(server.dir, FILE), 'utf8'));
    return Array.isArray(data.mods) ? data.mods : [];
  } catch {
    return [];
  }
}

function save(server, mods) {
  const target = path.join(server.dir, FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.tmp`, JSON.stringify({ version: 1, mods }, null, 2));
  fs.renameSync(`${target}.tmp`, target);
}

function find(mods, provider, projectId) {
  return mods.find((m) => m.key === keyOf(provider, projectId)) || null;
}

/** Dependencies nobody needs any more, after `removedKey` is gone. */
function orphans(mods) {
  const out = [];
  let changed = true;
  let remaining = mods.slice();
  while (changed) {
    changed = false;
    for (const mod of remaining) {
      if (!mod.auto) continue;
      const needed = (mod.requiredBy || []).some((k) => remaining.some((m) => m.key === k));
      if (!needed) {
        out.push(mod);
        remaining = remaining.filter((m) => m !== mod);
        changed = true;
      }
    }
  }
  return out;
}

module.exports = { load, save, find, orphans, keyOf, FILE };
