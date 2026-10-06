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
const crypto = require('crypto');
const safefs = require('../../core/safefs');
const { containedPath } = require('../files');

const FILE = path.join('.gamepanel', 'mods.json');

const keyOf = (provider, projectId) => `${provider}:${projectId}`;

/*
 * This file sits in the server's own folder, where a game, a mod or someone with
 * file access can edit it. Its file and folder names end up in deletes, renames
 * and the start command, so only plain names are believed: one path segment of
 * ordinary characters (no "..", slashes, quotes, $ or spaces that could split a command).
 */
const NAME = /^@?[\w.+\-()\[\]]{1,200}$/;
const plain = (v) => typeof v === 'string' && NAME.test(v) && v !== '.' && v !== '..';
const relPath = (v) => typeof v === 'string' && v.length < 300 && v.split('/').every((p) => plain(p));

function clean(mod) {
  if (!mod || typeof mod !== 'object' || typeof mod.key !== 'string') return null;
  const out = { ...mod };
  for (const field of ['file', 'folder']) if (out[field] !== undefined && out[field] !== null && !plain(String(out[field]).replace(/\.disabled$/, ''))) delete out[field];
  if (out.paks !== undefined) out.paks = (Array.isArray(out.paks) ? out.paks : []).filter(relPath);
  if (out.keys !== undefined) out.keys = (Array.isArray(out.keys) ? out.keys : []).filter(plain);
  return out;
}

function load(server) {
  try {
    const data = JSON.parse(safefs.readText(containedPath(server.dir, FILE), 8 * 1024 * 1024));
    return Array.isArray(data.mods) ? data.mods.map(clean).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function save(server, mods) {
  const target = containedPath(server.dir, FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // An exclusive temp file with a random name: a link planted at a predictable name is never written through.
  const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, mods }, null, 2), { flag: 'wx' });
  fs.renameSync(tmp, target);
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
