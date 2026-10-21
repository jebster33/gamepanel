'use strict';

/**
 * Trash bin for the file manager. Deleting a file or folder moves it to
 * <data>/trash/<server id>/<item>/ instead of removing it, so it can be
 * restored for two weeks. Trash is capped per server; the oldest items go
 * first, and anything too big to keep is deleted for real (the caller says so).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../core/config');
const { fail, logger } = require('../core/util');
const { containedPath } = require('./files');

const KEEP_MS = 14 * 86400_000;
const MAX_ITEM = 2 * 1024 ** 3;
const MAX_TOTAL = 5 * 1024 ** 3;
const ID = /^[a-z0-9]{6,40}$/;

const root = () => path.join(config.dataDir, 'trash');
const dirOf = (serverId) => path.join(root(), String(serverId).replace(/[^\w.-]/g, '_'));

/** Size of a path, giving up (returns Infinity) past `limit` bytes or a very large tree. */
async function sizeOf(target, limit) {
  let total = 0;
  let seen = 0;
  const walk = async (p) => {
    if (total > limit || seen++ > 200_000) return;
    const st = await fsp.lstat(p).catch(() => null);
    if (!st) return;
    if (st.isDirectory()) {
      for (const name of await fsp.readdir(p).catch(() => [])) await walk(path.join(p, name));
    } else total += st.size;
  };
  await walk(target);
  return total > limit || seen > 200_000 ? Infinity : total;
}

async function move(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.cp(from, to, { recursive: true, verbatimSymlinks: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/** Move `rel` to the trash. Returns the item, or null when it was too big (nothing was moved). */
async function put(server, rel, by) {
  const target = containedPath(server.dir, rel);
  if (path.resolve(target) === path.resolve(server.dir)) fail(400, 'Refusing to delete the server root');
  const st = await fsp.lstat(target).catch(() => null);
  if (!st) return { path: rel };
  const size = st.isDirectory() ? await sizeOf(target, MAX_ITEM) : st.size;
  if (size > MAX_ITEM) return null;
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const dir = path.join(dirOf(server.id), id);
  await fsp.mkdir(dir, { recursive: true });
  await move(target, path.join(dir, 'data'));
  const item = { id, path: rel.replace(/^\/+/, ''), name: path.basename(target), dir: st.isDirectory(), size, by: by || null, at: Date.now() };
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(item));
  prune(server.id).catch(() => {});
  return item;
}

async function list(serverId) {
  const base = dirOf(serverId);
  const out = [];
  for (const name of await fsp.readdir(base).catch(() => [])) {
    if (!ID.test(name)) continue;
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(base, name, 'meta.json'), 'utf8')));
    } catch {
      /* half-written item: pruned later */
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

function itemDir(serverId, id) {
  if (!ID.test(String(id))) fail(400, 'Not a trash item');
  return path.join(dirOf(serverId), id);
}

/** Put an item back where it was. A different name is used when that place is taken. */
async function restore(server, id) {
  const dir = itemDir(server.id, id);
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    fail(404, 'That item is no longer in the trash');
  }
  let rel = meta.path;
  let dest = containedPath(server.dir, rel);
  if (fs.existsSync(dest)) {
    const ext = path.extname(rel);
    rel = `${rel.slice(0, rel.length - ext.length)} (restored)${ext}`;
    dest = containedPath(server.dir, rel);
    if (fs.existsSync(dest)) fail(409, 'Something already exists where this was');
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await move(path.join(dir, 'data'), dest);
  await fsp.rm(dir, { recursive: true, force: true });
  return { path: rel };
}

async function discard(serverId, id) {
  await fsp.rm(itemDir(serverId, id), { recursive: true, force: true });
}

async function empty(serverId) {
  await fsp.rm(dirOf(serverId), { recursive: true, force: true });
}

/** Drop what is too old and, past the size cap, the oldest. */
async function prune(serverId, now = Date.now()) {
  const items = await list(serverId);
  let total = items.reduce((a, i) => a + (Number.isFinite(i.size) ? i.size : 0), 0);
  for (const item of items.slice().reverse()) {
    if (now - item.at > KEEP_MS || total > MAX_TOTAL) {
      await discard(serverId, item.id).catch(() => {});
      total -= item.size || 0;
    }
  }
}

async function tick(manager) {
  for (const server of manager.servers) await prune(server.id).catch((err) => logger.warn(`Trash cleanup for ${server.name}: ${err.message}`));
  for (const name of await fsp.readdir(root()).catch(() => [])) {
    if (!manager.servers.some((s) => dirOf(s.id) === path.join(root(), name))) await fsp.rm(path.join(root(), name), { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { put, list, restore, discard, empty, prune, tick, KEEP_MS, MAX_ITEM };
