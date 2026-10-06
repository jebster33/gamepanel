'use strict';

/**
 * Wake on join (optional, Minecraft Java). While a server that has it on is
 * stopped, the panel listens on its game port and speaks just enough of the
 * Minecraft protocol: the server list shows it as asleep, and joining starts
 * it (the player is told to join again in a moment). Together with "Stop
 * when empty" a server only uses memory while someone plays.
 *
 * Banned players never wake a server, and with the whitelist on only
 * whitelisted players do. A server is woken at most once a minute.
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { logger } = require('../core/util');
const safefs = require('../core/safefs');
const { STATUS } = require('../servers/constants');

const SYNC_MS = 15_000;
const WAKE_GAP_MS = 60_000;
const MAX_PACKET = 4096;

const listeners = new Map(); // serverId -> { srv, port, host, sockets:Set }
const state = new Map(); // serverId -> { error, wokenAt, by }
let app = null;

const supports = (server) => /^minecraft-(?!bedrock$)/.test(String(server.templateId || ''));

/* --------------------------------------------------------- the protocol -- */

function varint(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/** A VarInt at `pos`: [value, next position], or null when the buffer ends first. */
function readVarint(buf, pos) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (pos + i >= buf.length) return null;
    const b = buf[pos + i];
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [value | 0, pos + i + 1];
  }
  throw new Error('VarInt too long');
}

function readString(buf, pos) {
  const len = readVarint(buf, pos);
  if (!len) return null;
  const end = len[1] + len[0];
  if (len[0] < 0 || end > buf.length) return null;
  return [buf.toString('utf8', len[1], end), end];
}

const str = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varint(b.length), b]);
};
const packet = (id, ...parts) => {
  const body = Buffer.concat([varint(id), ...parts]);
  return Buffer.concat([varint(body.length), body]);
};

/** Pull whole packets ({ id, data }) off the front of a buffer. */
function takePackets(buf) {
  const out = [];
  let pos = 0;
  for (;;) {
    const len = readVarint(buf, pos);
    if (!len) break;
    if (len[0] < 1 || len[0] > MAX_PACKET) throw new Error('bad packet length');
    if (len[1] + len[0] > buf.length) break;
    const body = buf.subarray(len[1], len[1] + len[0]);
    const id = readVarint(body, 0);
    out.push({ id: id[0], data: body.subarray(id[1]) });
    pos = len[1] + len[0];
  }
  return { packets: out, rest: buf.subarray(pos) };
}

/* ----------------------------------------------------- what it answers -- */

function properties(server) {
  try {
    return safefs.readText(path.join(server.dir, 'server.properties'), 1024 * 1024);
  } catch {
    return '';
  }
}
const prop = (text, key) => (text.match(new RegExp(`^${key.replace('.', '\\.')}=(.*)$`, 'm')) || [])[1]?.trim();

function favicon(server) {
  try {
    const png = safefs.readRegular(path.join(server.dir, 'server-icon.png'), 64 * 1024);
    return png.length < 64 * 1024 ? `data:image/png;base64,${png.toString('base64')}` : undefined;
  } catch {
    return undefined;
  }
}

function statusJson(server, protocol, waking) {
  const text = properties(server);
  const motd = (prop(text, 'motd') || server.name).replace(/\\u00A7/gi, '§').split('\n')[0].slice(0, 60);
  return JSON.stringify({
    version: { name: waking ? 'Starting…' : 'Asleep', protocol },
    players: { max: Number(prop(text, 'max-players')) || server.maxPlayers || 20, online: 0, sample: [] },
    description: { text: `${motd}\n${waking ? '§eStarting up: join again in a moment' : '§7Asleep · §ajoin to wake it up'}` },
    favicon: favicon(server),
  });
}

const readJson = (server, file) => {
  try {
    return JSON.parse(safefs.readText(path.join(server.dir, file), 4 * 1024 * 1024));
  } catch {
    return [];
  }
};

/** May this player start the server? */
function allowed(server, name) {
  const lower = String(name || '').toLowerCase();
  if (!/^[a-z0-9_.]{1,16}$/i.test(lower)) return { ok: false, why: 'That name cannot join this server.' };
  if (readJson(server, 'banned-players.json').some((b) => String(b.name).toLowerCase() === lower)) return { ok: false, why: 'You are banned from this server.' };
  const text = properties(server);
  if (prop(text, 'white-list') === 'true' && !readJson(server, 'whitelist.json').some((w) => String(w.name).toLowerCase() === lower)) {
    return { ok: false, why: 'You are not whitelisted on this server.' };
  }
  return { ok: true };
}

/* ------------------------------------------------------------- a socket -- */

// The status reply (with its icon) is built at most once every 10 seconds per server and protocol.
const statusCache = new Map();
function cachedStatus(server, protocol, waking) {
  const key = `${server.id}:${protocol}:${waking}`;
  const hit = statusCache.get(key);
  if (hit && Date.now() - hit.at < 10_000) return hit.value;
  const value = statusJson(server, protocol, waking);
  statusCache.set(key, { at: Date.now(), value });
  if (statusCache.size > 200) statusCache.clear();
  return value;
}

function handle(server, socket) {
  let buf = Buffer.alloc(0);
  let stage = 'handshake';
  let protocol = -1;
  let answered = false;
  socket.setTimeout(10_000, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    try {
      onData(chunk);
    } catch {
      socket.destroy(); // anything unexpected from the internet just ends the connection
    }
  });
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Nobody reading what we send is not our problem to buffer.
    if (socket.writableLength > 64 * 1024) return socket.destroy();
    if (buf.length > MAX_PACKET * 2) return socket.destroy();
    // The pre-1.7 server list ping starts with 0xFE: nothing useful to say to it.
    if (stage === 'handshake' && buf[0] === 0xfe) return socket.destroy();
    let taken;
    try {
      taken = takePackets(buf);
    } catch {
      return socket.destroy();
    }
    buf = Buffer.from(taken.rest);
    for (const p of taken.packets) {
      if (stage === 'handshake' && p.id === 0x00) {
        const v = readVarint(p.data, 0);
        const host = v && readString(p.data, v[1]);
        const next = host && readVarint(p.data, host[1] + 2);
        if (!next) return socket.destroy();
        protocol = v[0];
        stage = next[0] === 1 ? 'status' : 'login';
      } else if (stage === 'status' && p.id === 0x00) {
        // One status reply per connection, like the game itself: thousands of requests in one burst get one answer.
        if (answered) return socket.destroy();
        answered = true;
        socket.write(packet(0x00, str(cachedStatus(server, protocol, Boolean(state.get(server.id)?.waking)))));
      } else if (stage === 'status' && p.id === 0x01) {
        socket.end(packet(0x01, p.data.subarray(0, 8)));
      } else if (stage === 'login' && p.id === 0x00) {
        const name = readString(p.data, 0)?.[0] || '';
        const verdict = allowed(server, name);
        const message = verdict.ok ? wake(server, name) : verdict.why;
        socket.end(packet(0x00, str(JSON.stringify({ text: message }))));
      }
    }
  };
}

/** Start the server for a player. Returns what they are told. */
function wake(server, name) {
  const s = state.get(server.id) || {};
  const rt = app.manager.rt(server.id);
  if (rt.status === STATUS.STARTING || s.waking) return 'The server is starting. Join again in a moment.';
  if (s.wokenAt && Date.now() - s.wokenAt < WAKE_GAP_MS) return 'The server was just woken up. Join again in a moment.';
  state.set(server.id, { ...s, waking: true, wokenAt: Date.now(), by: name });
  app.store.addEvent('server.woken', `${name} joined ${server.name} while it was asleep, so it is starting`, { serverId: server.id });
  app.manager.logActivity?.(server.id, { type: 'wake', name });
  // Answer the player first; the listener has to let go of the port before the game takes it.
  setImmediate(() =>
    app.manager.start(server.id).catch((err) => {
      logger.warn(`Wake on join for ${server.name}: ${err.message}`);
      state.set(server.id, { ...state.get(server.id), waking: false, error: err.message });
      sync();
    })
  );
  return '§aThe server is starting up for you.§r Join again in about 30 seconds.';
}

/* ------------------------------------------------------------ listening -- */

function listen(server) {
  const port = Number(server.ports?.game);
  const host = server.ip || '0.0.0.0';
  if (!port) return;
  const sockets = new Set();
  const srv = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (sockets.size > 50) return socket.destroy();
    handle(server, socket);
  });
  const entry = { srv, port, host, sockets };
  listeners.set(server.id, entry);
  srv.on('error', (err) => {
    listeners.delete(server.id);
    state.set(server.id, { ...(state.get(server.id) || {}), error: err.code === 'EADDRINUSE' ? `Port ${port} is in use by something else` : err.message });
  });
  srv.listen(port, host, () => {
    state.set(server.id, { ...(state.get(server.id) || {}), error: null, waking: false });
  });
}

/** Stop listening for one server (before it starts, or when the option goes off). */
function release(serverId) {
  const entry = listeners.get(serverId);
  if (!entry) return Promise.resolve();
  listeners.delete(serverId);
  for (const s of entry.sockets) s.destroy();
  return new Promise((resolve) => entry.srv.close(() => resolve()));
}

/** Listen for every stopped server that wants it, and only those. */
function sync() {
  if (!app) return;
  for (const server of app.manager.servers) {
    const rt = app.manager.rt(server.id);
    const asleep = [STATUS.OFFLINE, STATUS.CRASHED].includes(rt.status) && server.installedAt;
    const want = Boolean(server.wakeOnJoin) && supports(server) && asleep;
    const entry = listeners.get(server.id);
    if (entry && (!want || entry.port !== Number(server.ports?.game))) release(server.id);
    else if (want && !entry) listen(server);
    if (!asleep && state.get(server.id)?.waking && rt.status === STATUS.RUNNING) state.set(server.id, { ...state.get(server.id), waking: false });
  }
  for (const id of listeners.keys()) if (!app.manager.servers.some((s) => s.id === id)) release(id);
}

function start(ctx) {
  app = ctx;
  sync();
  const timer = setInterval(sync, SYNC_MS);
  timer.unref?.();
  ctx.store.on('event', (e) => {
    if (/^server\.(stopped|crashed|idle_stopped|settings|updated|deleted)$/.test(e.type)) setTimeout(sync, 500);
  });
}

function view(serverId) {
  const s = state.get(serverId) || {};
  return { listening: listeners.has(serverId), error: s.error || null, wokenAt: s.wokenAt || null, by: s.by || null };
}

module.exports = { start, sync, release, view, supports, statusJson, allowed, takePackets, packet, str, varint, readVarint };
