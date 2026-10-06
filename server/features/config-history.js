'use strict';

/**
 * Config history: every time a text file is saved through the panel (the
 * file editor, the Game settings form, a revert), the new content is kept,
 * so a bad edit can be compared with an earlier one and undone.
 *
 *   <data>/config-history/<server id>/<hash of path>/index.json   versions, newest first
 *   <data>/config-history/<server id>/<hash of path>/<id>.txt     their content
 *
 * The first save of a file also keeps what was there before, so the original
 * can always be brought back.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../core/config');
const { fail } = require('../core/util');

const KEEP = 50; // versions per file
const MAX_BYTES = 1024 * 1024;

const root = (serverId) => path.join(config.dataDir, 'config-history', String(serverId).replace(/[^\w.-]/g, '_'));
const normal = (rel) => String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
const folderFor = (serverId, rel) => path.join(root(serverId), crypto.createHash('sha1').update(normal(rel)).digest('hex').slice(0, 20));

function readIndex(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeIndex(dir, index) {
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
}

/** Only text that fits in the editor is worth versioning. */
const isText = (content) => typeof content === 'string' && Buffer.byteLength(content) <= MAX_BYTES && !content.includes('\u0000');

/**
 * Keep `after` as the newest version of a file. `before` is what the file held
 * until now (null when it did not exist); it is kept too on the first save.
 */
function record(serverId, rel, { before = null, after, by = 'panel', source = 'editor', note = '' }) {
  rel = normal(rel);
  if (!rel || !isText(after)) return null;
  const dir = folderFor(serverId, rel);
  fs.mkdirSync(dir, { recursive: true });
  const index = readIndex(dir) || { path: rel, versions: [] };
  const add = (content, meta) => {
    const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(path.join(dir, `${id}.txt`), content);
    index.versions.unshift({ id, at: Date.now(), size: Buffer.byteLength(content), hash: crypto.createHash('sha1').update(content).digest('hex'), ...meta });
  };
  if (!index.versions.length && before !== null && isText(before) && before !== after) add(before, { by: 'original', source: 'original', note: 'Before the first change made in the panel' });
  const hash = crypto.createHash('sha1').update(after).digest('hex');
  if (index.versions[0]?.hash === hash) return index.versions[0];
  add(after, { by, source, note: String(note).slice(0, 120) });
  for (const old of index.versions.splice(KEEP)) fs.rmSync(path.join(dir, `${old.id}.txt`), { force: true });
  writeIndex(dir, index);
  return index.versions[0];
}

/** Files of one server that have history, most recently changed first. */
function files(serverId) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(root(serverId));
  } catch {
    return [];
  }
  return dirs
    .map((d) => readIndex(path.join(root(serverId), d)))
    .filter((index) => index?.versions?.length)
    .map((index) => ({ path: index.path, versions: index.versions.length, lastAt: index.versions[0].at, lastBy: index.versions[0].by }))
    .sort((a, b) => b.lastAt - a.lastAt);
}

function versions(serverId, rel) {
  const index = readIndex(folderFor(serverId, rel));
  return { path: normal(rel), versions: (index?.versions || []).map(({ hash, ...v }) => v) };
}

function content(serverId, rel, id) {
  if (!/^[a-z0-9]+$/.test(String(id))) fail(400, 'Unknown version');
  const dir = folderFor(serverId, rel);
  const version = readIndex(dir)?.versions.find((v) => v.id === id);
  if (!version) fail(404, 'That version is gone');
  return { ...version, hash: undefined, path: normal(rel), content: fs.readFileSync(path.join(dir, `${id}.txt`), 'utf8') };
}

function forget(serverId) {
  fs.rmSync(root(serverId), { recursive: true, force: true });
}

module.exports = { record, files, versions, content, forget, normal, KEEP };
