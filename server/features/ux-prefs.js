'use strict';

/**
 * Per-account interface preferences kept on the user record: pinned servers,
 * server folders and tags, dashboard widget layout and recent palette picks.
 * Everything is validated and size-limited; unknown keys are dropped.
 */

const { fail } = require('../core/util');

const WIDGETS = ['host', 'counts', 'capacity', 'pinned', 'servers'];
const LIMITS = { pinned: 100, folders: 30, folderServers: 300, tagServers: 300, tagsPerServer: 8, tagLength: 24, nameLength: 40, recent: 10, bytes: 32 * 1024 };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const RECENT_KINDS = ['server', 'page', 'setting', 'template', 'player', 'action'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);

function ids(list, max, label) {
  if (!Array.isArray(list)) fail(400, `${label} must be a list`);
  if (list.length > max) fail(400, `${label} can hold at most ${max} entries`);
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !ID.test(raw)) fail(400, `${label} has an invalid id`);
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

function cleanFolders(list) {
  if (!Array.isArray(list)) fail(400, 'folders must be a list');
  if (list.length > LIMITS.folders) fail(400, `You can have at most ${LIMITS.folders} folders`);
  const seen = new Set();
  return list.map((f) => {
    if (!isObj(f) || typeof f.id !== 'string' || !ID.test(f.id) || seen.has(f.id)) fail(400, 'A folder has an invalid or repeated id');
    seen.add(f.id);
    const name = str(f.name, LIMITS.nameLength);
    if (!name) fail(400, 'A folder needs a name');
    return { id: f.id, name, servers: ids(f.servers || [], LIMITS.folderServers, 'folder servers'), collapsed: Boolean(f.collapsed) };
  });
}

function cleanTags(map) {
  if (!isObj(map)) fail(400, 'tags must be an object');
  const keys = Object.keys(map);
  if (keys.length > LIMITS.tagServers) fail(400, 'Too many tagged servers');
  const out = {};
  for (const key of keys) {
    if (!ID.test(key)) fail(400, 'tags has an invalid server id');
    if (!Array.isArray(map[key])) fail(400, 'Each server needs a list of tags');
    const tags = [];
    for (const raw of map[key].slice(0, 50)) {
      const tag = str(raw, LIMITS.tagLength).toLowerCase();
      if (tag && !tags.includes(tag)) tags.push(tag);
    }
    if (tags.length > LIMITS.tagsPerServer) fail(400, `A server can have at most ${LIMITS.tagsPerServer} tags`);
    if (tags.length) out[key] = tags;
  }
  return out;
}

function cleanWidgets(w) {
  if (!isObj(w)) fail(400, 'widgets must be an object');
  const pick = (list) => [...new Set((Array.isArray(list) ? list : []).filter((x) => WIDGETS.includes(x)))];
  return { order: pick(w.order), hidden: pick(w.hidden) };
}

function cleanRecent(list) {
  if (!Array.isArray(list)) fail(400, 'recent must be a list');
  const out = [];
  for (const r of list.slice(0, 50)) {
    if (!isObj(r) || !RECENT_KINDS.includes(r.kind)) continue;
    const key = str(r.key, 120);
    if (key && !out.some((o) => o.kind === r.kind && o.key === key)) out.push({ kind: r.kind, key, label: str(r.label, 80) });
    if (out.length >= LIMITS.recent) break;
  }
  return out;
}

const CLEANERS = {
  pinned: (v) => ids(v, LIMITS.pinned, 'pinned'),
  folders: cleanFolders,
  tags: cleanTags,
  widgets: cleanWidgets,
  recent: cleanRecent,
};

/** What an account has saved (defaults filled in). */
function read(record) {
  const p = isObj(record?.uiPrefs) ? record.uiPrefs : {};
  return {
    pinned: p.pinned || [],
    folders: p.folders || [],
    tags: p.tags || {},
    widgets: p.widgets || { order: [], hidden: [] },
    recent: p.recent || [],
  };
}

/**
 * Merge a partial update into the saved preferences. Only the keys sent are
 * replaced; a key set to null is reset. Returns the new full preferences.
 */
function update(record, body) {
  if (!isObj(body)) fail(400, 'Send an object of preferences');
  if (JSON.stringify(body).length > LIMITS.bytes) fail(413, 'Those preferences are too large');
  const next = { ...read(record) };
  for (const key of Object.keys(body)) {
    if (!CLEANERS[key]) fail(400, `Unknown preference: ${key.slice(0, 30)}`);
    next[key] = body[key] === null ? read({})[key] : CLEANERS[key](body[key]);
  }
  // A server lives in one folder only.
  const used = new Set();
  for (const f of next.folders) f.servers = f.servers.filter((id) => !used.has(id) && used.add(id));
  if (JSON.stringify(next).length > LIMITS.bytes) fail(413, 'Those preferences are too large');
  record.uiPrefs = next;
  return next;
}

module.exports = { WIDGETS, LIMITS, read, update };
