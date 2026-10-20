'use strict';

/**
 * Server notes: a markdown page per server for staff (rules, wipe plans,
 * passwords to rotate). Anyone with access to the server reads it; editing
 * needs the "settings" permission. Kept in <data>/notes/<server id>.json.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { fail } = require('../core/util');

const MAX_CHARS = 100_000;
const fileFor = (serverId) => path.join(config.dataDir, 'notes', `${String(serverId).replace(/[^\w.-]/g, '_')}.json`);

function get(serverId) {
  try {
    const { text = '', updatedAt = null, updatedBy = null } = JSON.parse(fs.readFileSync(fileFor(serverId), 'utf8'));
    return { text, updatedAt, updatedBy };
  } catch {
    return { text: '', updatedAt: null, updatedBy: null };
  }
}

/** `basedOn` is the updatedAt the editor started from; a newer save by someone else is refused rather than overwritten. */
function set(serverId, text, actor, basedOn) {
  if (typeof text !== 'string') fail(400, 'notes must be text');
  if (text.length > MAX_CHARS) fail(400, `Notes can be up to ${MAX_CHARS.toLocaleString('en')} characters`);
  const current = get(serverId);
  if ((current.updatedAt || null) !== (basedOn || null)) fail(409, `${current.updatedBy || 'Someone'} changed these notes while you were editing. Copy what you wrote, reload and merge it.`);
  const next = { text, updatedAt: Date.now(), updatedBy: actor };
  const file = fileFor(serverId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next));
  fs.renameSync(`${file}.tmp`, file);
  return next;
}

function forget(serverId) {
  fs.rmSync(fileFor(serverId), { force: true });
}

module.exports = { get, set, forget, MAX_CHARS };
