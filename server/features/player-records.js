'use strict';

/**
 * Warnings and notes on players, shared by all staff and all servers. Every
 * entry is kept with who wrote it and when, so a player's file reads like a
 * history: notes, warnings (with points that fade after a while), and the
 * actions the panel took on its own (a blocked VPN, a flagged alt).
 *
 * state.playerRecords = [{ id, key, name, kind: 'warning'|'note'|'action', text, points, by, at, serverId, expiresAt, revokedBy, revokedAt }]
 * settings.playerRecords = { expireDays, banAt, banHours, tell }
 *   expireDays  warning points stop counting after this many days (0 = never)
 *   banAt       points at which the player is put on the shared ban list (0 = never)
 */

const { uid, fail } = require('../core/util');

const NAME = /^[A-Za-z0-9_.\- ]{1,32}$/;
const MAX = 20_000;
const DEFAULTS = { expireDays: 90, banAt: 0, banHours: 0, tell: true };

const list = (store) => (store.state.playerRecords ||= []);
const settings = (store) => ({ ...DEFAULTS, ...(store.state.settings.playerRecords || {}) });
const keyOf = (name) => String(name || '').trim().toLowerCase();

function updateSettings(store, body = {}) {
  const s = settings(store);
  if (body.expireDays !== undefined) s.expireDays = Math.max(0, Math.min(3650, Math.round(Number(body.expireDays) || 0)));
  if (body.banAt !== undefined) s.banAt = Math.max(0, Math.min(1000, Math.round(Number(body.banAt) || 0)));
  if (body.banHours !== undefined) s.banHours = Math.max(0, Math.min(24 * 365, Math.round(Number(body.banHours) || 0)));
  if (body.tell !== undefined) s.tell = Boolean(body.tell);
  store.state.settings.playerRecords = s;
  store.save();
  return s;
}

const active = (store, r, now = Date.now()) => r.kind === 'warning' && !r.revokedAt && (!r.expiresAt || r.expiresAt > now);

function add(store, input = {}, by) {
  const name = String(input.name || '').trim();
  if (!NAME.test(name)) fail(400, 'Enter the player name');
  const kind = ['warning', 'note', 'action'].includes(input.kind) ? input.kind : 'note';
  const text = String(input.text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 500);
  if (!text) fail(400, kind === 'warning' ? 'Write the reason for the warning' : 'Write the note');
  const s = settings(store);
  const points = kind === 'warning' ? Math.max(1, Math.min(10, Math.round(Number(input.points) || 1))) : 0;
  const record = {
    id: uid(8),
    key: keyOf(name),
    name,
    kind,
    text,
    points,
    by: by || null,
    at: Date.now(),
    serverId: input.serverId ? String(input.serverId).slice(0, 60) : null,
    expiresAt: kind === 'warning' && s.expireDays ? Date.now() + s.expireDays * 86400_000 : null,
  };
  const all = list(store);
  all.push(record);
  if (all.length > MAX) all.splice(0, all.length - MAX);
  store.save();
  return record;
}

function revoke(store, id, by) {
  const r = list(store).find((x) => x.id === id);
  if (!r) fail(404, 'Record not found');
  r.revokedBy = by;
  r.revokedAt = Date.now();
  store.save();
  return r;
}

const pointsOf = (store, key, now = Date.now()) => list(store).filter((r) => r.key === key && active(store, r, now)).reduce((a, r) => a + r.points, 0);

/** One player's file, newest first, with the points that count now. */
function file(store, name, now = Date.now()) {
  const key = keyOf(name);
  const records = list(store).filter((r) => r.key === key).sort((a, b) => b.at - a.at).map((r) => ({ ...r, active: active(store, r, now) }));
  return { name: String(name), points: pointsOf(store, key, now), records };
}

/** Players with records, the ones with active warnings first. */
function overview(store, q = '', now = Date.now()) {
  const needle = keyOf(q);
  const by = new Map();
  for (const r of list(store)) {
    if (needle && !r.key.includes(needle)) continue;
    const e = by.get(r.key) || { name: r.name, points: 0, warnings: 0, notes: 0, last: 0 };
    if (active(store, r, now)) {
      e.points += r.points;
      e.warnings++;
    }
    if (r.kind === 'note') e.notes++;
    e.last = Math.max(e.last, r.at);
    by.set(r.key, e);
  }
  return [...by.values()].sort((a, b) => b.points - a.points || b.last - a.last).slice(0, 200);
}

/** Warn: record it, tell the player in game when they are online, and ban at the threshold. */
async function warn(manager, store, input, by) {
  const record = add(store, { ...input, kind: 'warning' }, by);
  const s = settings(store);
  const total = pointsOf(store, record.key);
  store.addEvent('player.warned', `${by} warned ${record.name}: ${record.text} (${total} point${total === 1 ? '' : 's'})`, record.serverId ? { serverId: record.serverId } : {});
  const out = { record, points: total, told: [], banned: false };
  if (s.tell) {
    const players = require('../games/players');
    for (const server of manager.servers) {
      if (server.node || !manager.isActive(server.id)) continue;
      const rt = manager.rt(server.id);
      if (!rt.playerList?.some((n) => keyOf(n) === record.key)) continue;
      const tpl = manager.template(server);
      const whisper = tpl?.players?.commands?.whisper || (tpl?.query?.type === 'minecraft' ? 'tell {name} {msg}' : null);
      const msg = `Warning from staff: ${record.text}`.replace(/["\r\n;]/g, ' ');
      try {
        if (whisper) await manager.sendCommand(server.id, whisper.replace('{name}', record.name.replace(/[^\w.\- ]/g, '')).replace('{msg}', msg));
        else if (players.broadcastCommand(tpl)) await manager.sendCommand(server.id, players.fillBroadcast(players.broadcastCommand(tpl), `${record.name}: ${msg}`));
        else continue;
        out.told.push(server.name);
      } catch {
        /* the player may have just left */
      }
    }
  }
  if (s.banAt && total >= s.banAt) {
    try {
      await require('./bans').ban(manager, store, { name: record.name, reason: `${total} warning points: ${record.text}`, hours: s.banHours }, 'warnings');
      add(store, { name: record.name, kind: 'action', text: `Banned automatically at ${total} warning points` }, 'panel');
      out.banned = true;
    } catch {
      /* already banned */
    }
  }
  return out;
}

/** The old single note on a player is part of the history too. */
function noteChanged(store, name, text, by) {
  if (!text) return;
  try {
    add(store, { name, kind: 'note', text }, by);
  } catch {
    /* a name the panel would not accept */
  }
}

module.exports = { add, revoke, warn, file, overview, settings, updateSettings, noteChanged, pointsOf, keyOf };
