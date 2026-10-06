'use strict';

/**
 * What a full restore would do, before it does it: which files come back,
 * which change, and which were added since the backup (a restore leaves
 * those, unless asked to make the server exactly like the backup). Plugins,
 * mods and server.properties are compared by name and key, since those are
 * what people usually restore for.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { fail, logger } = require('../core/util');
const backups = require('./backups');

const MAX_FILES = 200_000;
const LIST = 300;
// Rebuilt or panel-owned: never compared, never deleted.
const SKIP = [...backups.EXCLUDES.map((e) => e.replace(/^\.\//, '')), '.gamepanel'];
const skipped = (rel) => SKIP.some((s) => rel === s || rel.startsWith(`${s}/`));
const JAR_DIRS = ['plugins', 'mods'];

/** Every file under the server folder now: Map(rel -> { size, mtime }). */
async function current(dir) {
  const out = new Map();
  const stack = [''];
  while (stack.length && out.size < MAX_FILES) {
    const rel = stack.pop();
    let list;
    try {
      list = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skipped(r)) continue;
      if (e.isDirectory()) stack.push(r);
      else {
        const st = await fsp.lstat(path.join(dir, r)).catch(() => null);
        if (st) out.set(r, { size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  return { files: out, truncated: out.size >= MAX_FILES };
}

/** "world", "plugins", or "(top folder)" for loose files. */
const area = (rel) => (rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(top folder)');

function props(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#!=\s][^=]*?)\s*=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

async function compare(server, name) {
  const backup = backups.list(server.id).find((b) => b.name === name);
  if (!backup) fail(404, 'Backup not found');
  const [{ entries, truncated: bTrunc, unparsed = 0 }, { files: now, truncated: nTrunc }] = await Promise.all([backups.contents(server.id, name), current(server.dir)]);
  const then = new Map();
  for (const e of entries) if (!e.dir && !skipped(e.path)) then.set(e.path, e);

  const comeBack = [];
  const changed = [];
  const addedSince = [];
  let same = 0;
  const areas = new Map();
  const bump = (rel, key, bytes = 0) => {
    const a = areas.get(area(rel)) || { area: area(rel), comeBack: 0, changed: 0, addedSince: 0, bytes: 0 };
    a[key]++;
    a.bytes += bytes;
    areas.set(a.area, a);
  };
  for (const [rel, b] of then) {
    const n = now.get(rel);
    if (!n) {
      comeBack.push({ path: rel, size: b.size });
      bump(rel, 'comeBack', b.size);
    } else if (n.size !== b.size || (b.mtime && n.mtime > b.mtime + 60_000)) {
      changed.push({ path: rel, size: b.size, nowSize: n.size, modified: n.mtime });
      bump(rel, 'changed', b.size);
    } else same++;
  }
  for (const [rel, n] of now) {
    if (then.has(rel)) continue;
    addedSince.push({ path: rel, size: n.size, modified: n.mtime });
    bump(rel, 'addedSince', 0);
  }
  return { backup, then, now, comeBack, changed, addedSince, same, areas: [...areas.values()], truncated: bTrunc || nTrunc, unparsed };
}

async function preview(manager, server, name) {
  const c = await compare(server, name);
  // Plugins and mods by file name: what the restore brings back, and what it leaves (or removes).
  const jars = {};
  for (const dir of JAR_DIRS) {
    const at = (map) => new Set([...map.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/') && /\.jar(\.disabled)?$/i.test(p)).map((p) => p.slice(dir.length + 1)));
    const t = at(c.then);
    const n = at(c.now);
    const back = [...t].filter((x) => !n.has(x));
    const since = [...n].filter((x) => !t.has(x));
    if (back.length || since.length) jars[dir] = { comeBack: back.sort(), addedSince: since.sort() };
  }
  // server.properties, key by key.
  let properties = [];
  if (c.then.has('server.properties') && c.now.has('server.properties')) {
    const old = props((await backups.readFile(server, name, 'server.properties').catch(() => null))?.toString('utf8'));
    const cur = props((() => { try { return require('../core/safefs').readText(path.join(server.dir, 'server.properties'), 1024 * 1024); } catch { return ''; } })());
    properties = [...new Set([...Object.keys(old), ...Object.keys(cur)])]
      .filter((k) => old[k] !== cur[k] && !/password|secret|token/i.test(k))
      .sort()
      .map((k) => ({ key: k, then: old[k] ?? null, now: cur[k] ?? null }));
  }
  const bySize = (a, b) => (b.size || 0) - (a.size || 0);
  c.areas.sort((a, b) => b.comeBack + b.changed + b.addedSince - (a.comeBack + a.changed + a.addedSince));
  return {
    backup: { name, createdAt: c.backup.createdAt, kind: c.backup.kind || 'archive' },
    running: manager.isActive(server.id),
    counts: { comeBack: c.comeBack.length, changed: c.changed.length, addedSince: c.addedSince.length, same: c.same },
    bytes: { comeBack: c.comeBack.reduce((n, f) => n + f.size, 0), changed: c.changed.reduce((n, f) => n + f.size, 0), addedSince: c.addedSince.reduce((n, f) => n + f.size, 0) },
    areas: c.areas.slice(0, 40),
    jars,
    properties: properties.slice(0, 60),
    comeBack: c.comeBack.sort(bySize).slice(0, LIST),
    changed: c.changed.sort((a, b) => b.modified - a.modified).slice(0, LIST),
    addedSince: c.addedSince.sort((a, b) => b.modified - a.modified).slice(0, LIST),
    truncated: c.truncated,
  };
}

/**
 * Restore, optionally making a backup of the current state first and
 * removing files that were added since (so the folder ends up exactly like
 * the backup). Returns what was done.
 */
async function restore(manager, server, name, { backupFirst = false, exact = false } = {}) {
  if (manager.isActive(server.id)) fail(409, 'Stop the server before restoring a backup');
  let safety = null;
  if (backupFirst) safety = await backups.create(server, 'before-restore');
  // Worked out before the restore: afterwards every file from the backup is there again.
  let extra = [];
  if (exact) {
    const c = await compare(server, name);
    // A listing that was cut short, or had lines that could not be read, would call real backup files "added since" and delete them.
    if (c.truncated || c.unparsed) fail(400, 'This server is too large (or has file names the panel cannot list) for "exactly like the backup". Restore without it.');
    extra = c.addedSince.map((f) => f.path);
  }
  await backups.restore(server, name);
  let removed = 0;
  for (const rel of extra) {
    if (skipped(rel) || rel.split('/').includes('..')) continue;
    try {
      await fsp.rm(path.join(server.dir, rel), { force: true });
      removed++;
    } catch (err) {
      logger.warn(`Exact restore of ${server.name}: could not remove ${rel}: ${err.message}`);
    }
  }
  // Folders left empty by that.
  if (removed) {
    const dirs = [...new Set(extra.map((r) => path.dirname(r)).filter((d) => d !== '.'))].sort((a, b) => b.length - a.length);
    for (const d of dirs) {
      for (let cur = d; cur && cur !== '.'; cur = path.dirname(cur)) {
        try {
          fs.rmdirSync(path.join(server.dir, cur));
        } catch {
          break;
        }
      }
    }
  }
  return { ok: true, safety: safety?.name || null, removed };
}

module.exports = { preview, restore, props };
