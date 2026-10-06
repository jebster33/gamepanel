'use strict';

/**
 * Audit log: every change anyone makes through the panel or the API, with who,
 * from where, on which server, and whether it worked. Read-only requests are
 * not logged. Kept as JSON lines in data/audit.log, rotated at 5 MB.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');

const FILE = path.join(config.dataDir, 'audit.log');
const MAX_BYTES = 5 * 1024 * 1024;
// Never written to the log, whatever the request carried.
const SECRET = /pass|secret|token|key|code|webhook|content|data|otp/i;

/** "/api/servers/:id/files/write" -> "files write" */
function describe(method, pattern, body) {
  const parts = pattern.split('/').filter((p) => p && p !== 'api' && !p.startsWith(':'));
  if (parts[0] === 'servers' && parts.length > 1) parts.shift();
  let action = parts.join(' ') || pattern;
  if (method === 'DELETE') action = `delete ${action}`;
  else if (method === 'POST' && parts.length === 1) action = `create ${action}`;
  else if (['PUT', 'PATCH'].includes(method)) action = `change ${action}`;
  if (body?.action && typeof body.action === 'string') action += ` (${body.action.slice(0, 40)})`;
  return action;
}

/** Small, safe summary of what was sent: plain values only, no secrets. */
function details(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (SECRET.test(k) || k === 'action') continue;
    if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = typeof v === 'string' ? v.slice(0, 120) : v;
    else if (Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === 'string')) out[k] = v.join(', ').slice(0, 200);
    if (Object.keys(out).length >= 8) break;
  }
  return Object.keys(out).length ? out : undefined;
}

function record(entry) {
  try {
    if (fs.existsSync(FILE) && fs.statSync(FILE).size > MAX_BYTES) fs.renameSync(FILE, `${FILE}.1`);
    fs.appendFileSync(FILE, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  } catch {
    /* the log must never break a request */
  }
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Newest first, filtered. */
function list({ q = '', user = '', serverId = '', limit = 200, before = Infinity } = {}) {
  const needle = String(q).toLowerCase();
  const out = [];
  for (const file of [FILE, `${FILE}.1`]) {
    const lines = readLines(file);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (e.at >= before) continue;
      if (user && e.user !== user) continue;
      if (serverId && e.serverId !== serverId) continue;
      if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) continue;
      out.push(e);
    }
  }
  return out;
}

module.exports = { record, list, describe, details };
