'use strict';

/**
 * Space Engineers world cleanup, offline. Reads a world's SANDBOX_0_0_0_.sbc
 * (the sector: grids, floating objects, voxel maps) and Sandbox.sbc (the
 * identities, with last login times) with a small tolerant tag walker (no DOM,
 * no regular expressions over the whole file), classifies what it finds
 * (unowned grids, grids whose owners have not played for a while, floating
 * objects) and removes the entities the owner picks. The original file is
 * copied to gamepanel-backups/ first, and the result is checked to still have
 * balanced tags before it replaces the file. Only with the server stopped.
 */

const fs = require('fs');
const path = require('path');
const { fail } = require('../../core/util');
const { containedPath } = require('../files');
const safefs = require('../../core/safefs');
const common = require('./common');

const SAVES = 'Instance/Saves';
const SECTOR = 'SANDBOX_0_0_0_.sbc';
const CHECKPOINT = 'Sandbox.sbc';
const MAX_FILE = 400 * 1024 * 1024;
const WORLD = /^[A-Za-z0-9][A-Za-z0-9 ._()'-]{0,100}$/;
const DAY = 86400000;

/* ------------------------------------------------------------ tag walker -- */

/** Yield { kind: 'open' | 'close' | 'self', name, attrs, start, end } for every element tag; skips comments, declarations and CDATA. */
function* tags(text) {
  let pos = 0;
  const len = text.length;
  while (pos < len) {
    const i = text.indexOf('<', pos);
    if (i < 0) return;
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      pos = e < 0 ? len : e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9);
      pos = e < 0 ? len : e + 3;
      continue;
    }
    if (text[i + 1] === '?' || text[i + 1] === '!') {
      const e = text.indexOf('>', i);
      pos = e < 0 ? len : e + 1;
      continue;
    }
    // End of tag: the next '>' outside quotes.
    let j = i + 1;
    let quote = '';
    while (j < len) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    if (j >= len) fail(400, 'The world file ends in the middle of a tag; it looks damaged');
    const closing = text[i + 1] === '/';
    let k = i + (closing ? 2 : 1);
    const nameStart = k;
    while (k < j && !/[\s/]/.test(text[k])) k++;
    const name = text.slice(nameStart, k);
    const self = !closing && text[j - 1] === '/';
    yield { kind: closing ? 'close' : self ? 'self' : 'open', name, attrs: text.slice(k, self ? j - 1 : j), start: i, end: j + 1 };
    pos = j + 1;
  }
}

function attr(attrs, name) {
  const key = `${name}="`;
  const at = attrs.indexOf(key);
  if (at < 0) return null;
  const end = attrs.indexOf('"', at + key.length);
  return end < 0 ? null : attrs.slice(at + key.length, end);
}

const unescapeXml = (s) => s.replace(/&(lt|gt|amp|quot|apos);/g, (m, n) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[n]);

/** Text directly after an opening tag (up to the next tag). */
const textAfter = (text, tag) => unescapeXml(text.slice(tag.end, text.indexOf('<', tag.end) < 0 ? undefined : text.indexOf('<', tag.end)).trim());

/** True when every opening tag is closed in order. */
function balanced(text) {
  const stack = [];
  for (const t of tags(text)) {
    if (t.kind === 'open') stack.push(t.name);
    else if (t.kind === 'close') if (stack.pop() !== t.name) return false;
  }
  return stack.length === 0;
}

/* ------------------------------------------------------------- the sector -- */

/** Entities directly under SectorObjects, with their byte spans in `text`. */
function entitySpans(text) {
  const spans = [];
  const stack = [];
  let open = null;
  for (const t of tags(text)) {
    if (t.kind === 'open') {
      if (stack.length === 2 && stack[1] === 'SectorObjects') open = { start: t.start, tag: t };
      stack.push(t.name);
    } else if (t.kind === 'close') {
      stack.pop();
      if (stack.length === 2 && stack[1] === 'SectorObjects' && open) {
        spans.push({ start: open.start, end: t.end, tag: open.tag });
        open = null;
      }
    } else if (stack.length === 2 && stack[1] === 'SectorObjects') spans.push({ start: t.start, end: t.end, tag: t });
  }
  return spans;
}

/** What matters about one entity. */
function inspect(text, span) {
  const slice = text.slice(span.start, span.end);
  const type = attr(span.tag.attrs, 'xsi:type') || span.tag.name;
  const info = { id: null, type, name: '', blocks: 0, owners: [], builtBy: [], isStatic: false, position: null, item: null };
  const owners = new Set();
  const builders = new Set();
  const stack = [];
  for (const t of tags(slice)) {
    if (t.kind === 'close') {
      stack.pop();
      continue;
    }
    const depth = stack.length;
    const parent = stack[depth - 1];
    if (depth === 1) {
      if (t.name === 'EntityId') info.id = textAfter(slice, t);
      else if (t.name === 'DisplayName') info.name = textAfter(slice, t).slice(0, 100);
      else if (t.name === 'IsStatic') info.isStatic = textAfter(slice, t) === 'true';
    }
    if (t.name === 'Position' && parent === 'PositionAndOrientation') {
      const [x, y, z] = ['x', 'y', 'z'].map((a) => Math.round(Number(attr(t.attrs, a))));
      if ([x, y, z].every(Number.isFinite)) info.position = { x, y, z };
    }
    if (t.name === 'MyObjectBuilder_CubeBlock' && parent === 'CubeBlocks') info.blocks++;
    if (parent === 'MyObjectBuilder_CubeBlock' || (parent && stack[depth - 2] === 'CubeBlocks')) {
      if (t.name === 'Owner') owners.add(textAfter(slice, t));
      if (t.name === 'BuiltBy') builders.add(textAfter(slice, t));
    }
    if (t.name === 'SubtypeName' && parent === 'PhysicalContent' && !info.item) info.item = textAfter(slice, t).slice(0, 60);
    if (t.kind === 'open') stack.push(t.name);
  }
  info.owners = [...owners].filter((o) => /^\d+$/.test(o) && o !== '0');
  info.builtBy = [...builders].filter((o) => /^\d+$/.test(o) && o !== '0');
  return info;
}

/** Identities from Sandbox.sbc: id, name, last login (ms or null). */
function identities(text) {
  const out = new Map();
  const stack = [];
  let cur = null;
  for (const t of tags(text)) {
    if (t.kind === 'close') {
      stack.pop();
      if (t.name === 'MyObjectBuilder_Identity' && cur) {
        if (cur.id) out.set(cur.id, cur);
        cur = null;
      }
      continue;
    }
    if (t.name === 'MyObjectBuilder_Identity' && t.kind === 'open') cur = { id: null, name: '', lastLogin: null };
    else if (cur && stack[stack.length - 1] === 'MyObjectBuilder_Identity') {
      if (t.name === 'IdentityId') cur.id = textAfter(text, t);
      else if (t.name === 'DisplayName') cur.name = textAfter(text, t).slice(0, 60);
      else if (t.name === 'LastLoginTime') {
        const ms = Date.parse(textAfter(text, t));
        cur.lastLogin = Number.isFinite(ms) && ms > Date.parse('2000-01-01') ? ms : null;
      }
    }
    if (t.kind === 'open') stack.push(t.name);
  }
  return out;
}

function classify(info, ids, cutoff, smallBlocks) {
  const cats = [];
  const isGrid = /CubeGrid/.test(info.type);
  if (isGrid) {
    if (!info.owners.length) cats.push('unowned');
    else {
      const known = info.owners.map((o) => ids.get(o));
      if (known.every((p) => p && p.lastLogin && p.lastLogin < cutoff)) cats.push('abandoned');
    }
    if (info.blocks <= smallBlocks && !info.isStatic && (!info.owners.length || cats.includes('abandoned'))) cats.push('debris');
  } else if (/FloatingObject|ReplicableEntity/.test(info.type)) cats.push('floating');
  return cats;
}

/* --------------------------------------------------------------- the API -- */

function worlds(server) {
  try {
    return fs
      .readdirSync(containedPath(server.dir, SAVES), { withFileTypes: true })
      .filter((e) => e.isDirectory() && WORLD.test(e.name) && fs.existsSync(path.join(containedPath(server.dir, SAVES), e.name, SECTOR)))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function worldRel(server, world) {
  const all = worlds(server);
  const pick = world || (all.length === 1 ? all[0] : null);
  if (!pick || !all.includes(pick)) fail(400, all.length ? 'Pick a world' : `No world with a ${SECTOR} was found under ${SAVES}. Start the server once, or save the world.`);
  return `${SAVES}/${pick}`;
}

function load(server, world) {
  const rel = worldRel(server, world);
  const text = common.readRel(server, `${rel}/${SECTOR}`, MAX_FILE);
  const check = common.readRel(server, `${rel}/${CHECKPOINT}`, MAX_FILE);
  return { rel, text, ids: check ? identities(check) : new Map() };
}

function scan(server, input = {}) {
  const days = Math.max(1, Math.min(3650, Math.round(Number(input.days) || 60)));
  const smallBlocks = Math.max(0, Math.min(100, Math.round(Number(input.smallBlocks ?? 5))));
  const { rel, text, ids } = load(server, input.world);
  const cutoff = Date.now() - days * DAY;
  const entities = [];
  let total = 0;
  for (const span of entitySpans(text)) {
    total++;
    const info = inspect(text, span);
    const categories = classify(info, ids, cutoff, smallBlocks);
    if (!categories.length || !/^\d+$/.test(String(info.id))) continue;
    entities.push({
      id: info.id,
      type: info.type.replace(/^MyObjectBuilder_/, ''),
      name: info.name || info.item || '',
      blocks: info.blocks,
      isStatic: info.isStatic,
      position: info.position,
      owners: info.owners.map((o) => ({ id: o, name: ids.get(o)?.name || null, lastLogin: ids.get(o)?.lastLogin || null })),
      categories,
      bytes: span.end - span.start,
    });
    if (entities.length >= 5000) break;
  }
  const oldPlayers = [...ids.values()].filter((p) => p.lastLogin && p.lastLogin < cutoff).sort((a, b) => a.lastLogin - b.lastLogin).slice(0, 500);
  return { world: path.basename(rel), worlds: worlds(server), days, smallBlocks, total, entities, oldPlayers, players: ids.size };
}

/** Remove the entities with these ids; backs the file up and refuses a result that is not well formed. */
function remove(manager, server, input = {}) {
  common.requireStopped(manager, server, 'Cleaning the world');
  const wanted = new Set((Array.isArray(input.ids) ? input.ids : []).map(String));
  if (!wanted.size) fail(400, 'Pick at least one entity');
  if (wanted.size > 5000) fail(400, 'Remove at most 5000 at a time');
  for (const id of wanted) if (!/^\d{1,20}$/.test(id)) fail(400, 'Entity ids are numbers');
  const { rel, text } = load(server, input.world);
  const spans = entitySpans(text)
    .map((span) => ({ span, id: inspect(text, span).id }))
    .filter((e) => wanted.has(String(e.id)))
    .map((e) => e.span)
    .sort((a, b) => b.start - a.start);
  if (!spans.length) fail(404, 'None of those entities are in the world any more');
  let out = text;
  for (const s of spans) {
    // Take the line break and indentation before the entity along with it.
    let start = s.start;
    while (start > 0 && (out[start - 1] === ' ' || out[start - 1] === '\t')) start--;
    if (out[start - 1] === '\n') start--;
    if (out[start - 1] === '\r') start--;
    out = out.slice(0, start) + out.slice(s.end);
  }
  if (!balanced(out)) fail(500, 'Removing those would have left the file damaged, so nothing was changed.');
  const backup = common.backupRel(server, `${rel}/${SECTOR}`);
  common.writeRel(server, `${rel}/${SECTOR}`, out);
  return { ok: true, removed: spans.length, backup, savedBytes: text.length - out.length };
}

module.exports = { tags, balanced, entitySpans, inspect, identities, classify, scan, remove, worlds, SECTOR, SAVES };
