'use strict';

/**
 * One ban list for the whole panel. A ban added here reaches every server
 * that can ban players (Minecraft through its ban list, which works while the
 * server is stopped too; other games through their ban command while they
 * run), and lifting it lifts it everywhere. Servers can opt out.
 *
 * Banned players can appeal from a public page (off unless switched on):
 * they get a code to check on it, and administrators accept (which lifts the
 * ban) or deny with a reply.
 *
 * store.state.bans = { list: [{ id, name, reason, by, at, until }],
 *   appeals: [{ id, codeHash, banId, name, message, contact, at, status, reply, decidedBy, decidedAt }] }
 * server.sharedBans = false to opt out; server.appliedBans = [names applied there]
 */

const crypto = require('crypto');
const { uid, fail, logger } = require('../core/util');
const lists = require('../games/player-lists');
const players = require('../games/players');

const NAME_RE = /^[A-Za-z0-9_. -]{2,32}$/;
const MAX_BANS = 5000;
const MAX_OPEN_APPEALS = 500;

const stateOf = (store) => (store.state.bans ||= { list: [], appeals: [] });
const active = (store, now = Date.now()) => stateOf(store).list.filter((b) => !b.until || b.until > now);
const hash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/** How a server bans: its ban list (Minecraft Java) or a ban command; null when it cannot. */
function methodFor(manager, server) {
  const template = manager.template(server);
  if (lists.listsFor(template)?.bans) return 'list';
  const cmds = players.playerCommands(template);
  return cmds.ban ? 'command' : null;
}

const participates = (manager, server) => server.sharedBans !== false && Boolean(methodFor(manager, server)) && !server.node;

/* ----------------------------------------------------------------- apply -- */

async function applyOne(manager, server, name, action, reason) {
  const method = methodFor(manager, server);
  if (method === 'list') {
    try {
      await lists.changeList(manager, server, { list: 'bans', action, name, reason }, 'shared ban list');
    } catch (err) {
      // Lifting a ban that is not there (removed by hand) is fine.
      if (action === 'remove' && (err.code === 404 || err.status === 404)) return true;
      throw err;
    }
    return true;
  }
  if (!manager.isActive(server.id)) return false; // applied when it next runs
  const cmds = players.playerCommands(manager.template(server));
  const command = action === 'add' ? cmds.ban : cmds.unban;
  if (!command) {
    // Some games only unban by ID (Rust, Unturned) or by editing a file: say so instead.
    if (action === 'remove') manager.pushConsole(server, `The shared ban on ${name} was lifted. This game cannot unban by name from the console; remove it from its ban list by hand.`, 'system');
    return action === 'remove';
  }
  await manager.sendCommand(server.id, command.replace(/\{name\}/g, name.replace(/["\r\n;]/g, '')));
  manager.logActivity(server.id, { type: action === 'add' ? 'ban' : 'unban', name, by: 'shared ban list', ...(reason ? { text: reason } : {}) });
  return true;
}

/** Bring one server in line with the shared list. Returns what changed. */
const syncing = new Set();
const failedAt = new Map(); // server id -> when a sync last failed, so the minute tick backs off
const RETRY_MS = 10 * 60_000;
async function syncServer(manager, store, server, { force = true } = {}) {
  if (syncing.has(server.id)) return { added: 0, removed: 0 };
  if (!force && Date.now() - (failedAt.get(server.id) || 0) < RETRY_MS) return { added: 0, removed: 0 };
  syncing.add(server.id);
  try {
    const want = participates(manager, server) ? new Map(active(store).map((b) => [b.name.toLowerCase(), b])) : new Map();
    // Names as they were banned (some games are case-sensitive), compared without case.
    const have = new Map((server.appliedBans || []).map((n) => [n.toLowerCase(), n]));
    let added = 0;
    let removed = 0;
    for (const [key, ban] of want) {
      if (have.has(key)) continue;
      try {
        if (await applyOne(manager, server, ban.name, 'add', ban.reason)) {
          have.set(key, ban.name);
          added++;
        }
      } catch (err) {
        failedAt.set(server.id, Date.now());
        logger.warn(`Shared ban of ${ban.name} on ${server.name}: ${err.message}`);
      }
    }
    for (const [key, name] of [...have]) {
      if (want.has(key)) continue;
      try {
        if (await applyOne(manager, server, name, 'remove')) {
          have.delete(key);
          removed++;
        }
      } catch (err) {
        failedAt.set(server.id, Date.now());
        logger.warn(`Lifting the shared ban of ${name} on ${server.name}: ${err.message}`);
      }
    }
    if (added || removed) {
      server.appliedBans = [...have.values()];
      store.save();
    }
    return { added, removed };
  } finally {
    syncing.delete(server.id);
  }
}

async function syncAll(manager, store, opts) {
  for (const server of manager.servers) {
    if (server.node) continue;
    if (!methodFor(manager, server) && !server.appliedBans?.length) continue;
    await syncServer(manager, store, server, opts);
  }
}

/** Once a minute: expire temporary bans and catch up servers that were off. */
async function tick(manager, store, now = Date.now()) {
  const s = stateOf(store);
  const expired = s.list.filter((b) => b.until && b.until <= now);
  if (expired.length) {
    s.list = s.list.filter((b) => !expired.includes(b));
    for (const b of expired) store.addEvent('player.unban', `The shared ban on ${b.name} ran out`);
    store.save();
  }
  await syncAll(manager, store, { force: false });
}

/* ------------------------------------------------------------------ bans -- */

function cleanName(name) {
  const n = String(name || '').trim();
  if (!NAME_RE.test(n)) fail(400, 'Enter the player name (2 to 32 letters, numbers or _)');
  return n;
}

async function ban(manager, store, { name, reason, hours }, by) {
  const s = stateOf(store);
  name = cleanName(name);
  if (active(store).some((b) => b.name.toLowerCase() === name.toLowerCase())) fail(409, `${name} is already on the shared ban list`);
  if (s.list.length >= MAX_BANS) fail(400, 'The ban list is full');
  const h = Number(hours) || 0;
  const entry = {
    id: uid(8),
    name,
    reason: String(reason || '').replace(/[\r\n]/g, ' ').trim().slice(0, 200),
    by,
    at: Date.now(),
    until: h > 0 ? Date.now() + Math.min(h, 24 * 365) * 3_600_000 : null,
  };
  s.list = s.list.filter((b) => b.name.toLowerCase() !== name.toLowerCase());
  s.list.unshift(entry);
  store.save();
  store.addEvent('player.ban', `${by} added ${name} to the shared ban list${entry.until ? ` for ${h} hours` : ''}${entry.reason ? `: ${entry.reason}` : ''}`);
  await syncAll(manager, store);
  return entry;
}

async function unban(manager, store, id, by, note = '') {
  const s = stateOf(store);
  const entry = s.list.find((b) => b.id === id);
  if (!entry) fail(404, 'That ban is not on the list');
  s.list = s.list.filter((b) => b !== entry);
  store.save();
  store.addEvent('player.unban', `${by} lifted the shared ban on ${entry.name}${note}`);
  await syncAll(manager, store);
  return entry;
}

async function setServer(manager, store, server, enabled) {
  if (!methodFor(manager, server)) fail(400, 'This game has no way to ban players');
  server.sharedBans = Boolean(enabled);
  store.save();
  return syncServer(manager, store, server);
}

/* --------------------------------------------------------------- appeals -- */

const appealSettings = (store) => ({ enabled: false, intro: '', ...(store.state.settings.appeals || {}) });

function updateAppealSettings(store, input) {
  const intro = String(input.intro ?? appealSettings(store).intro).slice(0, 1000);
  store.state.settings.appeals = { enabled: Boolean(input.enabled ?? appealSettings(store).enabled), intro };
  store.save();
  return appealSettings(store);
}

/** A banned player asks to be let back in. Returns the code they check on it with. */
function submitAppeal(store, { name, message, contact }) {
  if (!appealSettings(store).enabled) fail(404, 'Appeals are not open');
  name = cleanName(name);
  const text = String(message || '').trim();
  if (text.length < 20) fail(400, 'Tell us a little more (at least 20 characters)');
  if (text.length > 2000) fail(400, 'Keep it under 2000 characters');
  const target = active(store).find((b) => b.name.toLowerCase() === name.toLowerCase());
  if (!target) fail(404, `There is no ban for ${name} on this panel's list`);
  const s = stateOf(store);
  if (s.appeals.some((a) => a.banId === target.id && a.status === 'open')) fail(409, 'There is already an open appeal for this ban. Use your code to check on it.');
  if (s.appeals.filter((a) => a.status === 'open').length >= MAX_OPEN_APPEALS) fail(503, 'Too many open appeals right now. Try again later.');
  const code = crypto.randomBytes(6).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X');
  s.appeals.unshift({
    id: uid(8),
    codeHash: hash(code),
    banId: target.id,
    name: target.name,
    message: text,
    contact: String(contact || '').trim().slice(0, 120),
    at: Date.now(),
    status: 'open',
    reply: '',
  });
  s.appeals = s.appeals.slice(0, 2000);
  store.save();
  store.addEvent('ban.appeal', `${target.name} appealed their ban`);
  return { code };
}

function appealStatus(store, code) {
  const a = stateOf(store).appeals.find((x) => x.codeHash === hash(String(code || '').trim().toUpperCase()));
  if (!a) fail(404, 'No appeal with that code');
  return { name: a.name, status: a.status, reply: a.reply || '', at: a.at, decidedAt: a.decidedAt || null };
}

async function decide(manager, store, id, { decision, reply }, by) {
  const a = stateOf(store).appeals.find((x) => x.id === id);
  if (!a) fail(404, 'Appeal not found');
  if (a.status !== 'open') fail(409, 'This appeal was already decided');
  if (!['accept', 'deny'].includes(decision)) fail(400, 'Accept or deny');
  a.status = decision === 'accept' ? 'accepted' : 'denied';
  a.reply = String(reply || '').trim().slice(0, 1000);
  a.decidedBy = by;
  a.decidedAt = Date.now();
  store.save();
  if (decision === 'accept') {
    const banEntry = stateOf(store).list.find((b) => b.id === a.banId);
    if (banEntry) await unban(manager, store, banEntry.id, by, ' (appeal accepted)');
  } else store.addEvent('ban.appeal_denied', `${by} denied the appeal from ${a.name}`);
  return a;
}

/* ------------------------------------------------------------------ view -- */

function view(manager, store) {
  const s = stateOf(store);
  return {
    bans: active(store).map((b) => ({ ...b })),
    appeals: s.appeals.slice(0, 200).map(({ codeHash, ...a }) => a),
    servers: manager.servers
      .filter((x) => !x.node)
      .map((x) => ({ id: x.id, name: x.name, method: methodFor(manager, x), enabled: participates(manager, x), applied: (x.appliedBans || []).length })),
    appealSettings: appealSettings(store),
  };
}

module.exports = { ban, unban, setServer, syncServer, syncAll, tick, view, submitAppeal, appealStatus, decide, appealSettings, updateAppealSettings, methodFor };
