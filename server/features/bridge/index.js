'use strict';

/**
 * Bridge: reach game servers through the panel instead of opening ports.
 *
 * Each "connection" is a person with their own client download. The client
 * opens WebSockets to the panel's existing port, runs TLS inside them pinned
 * to the panel's own key (identity.js), signs in, and then carries TCP and
 * UDP for exactly the servers and ports that connection was given. Nothing
 * else on the machine is reachable through it.
 *
 * Inside the TLS stream every tunnel starts with one JSON line from the
 * client and one JSON line back:
 *
 *   hello         {conn, key}                    → {state: "login" | "set-password"}
 *   set-password  {conn, key, password, device}  → {token}   (new or reset account)
 *   login         {conn, key, password, device}  → {token}
 *   control       {conn, key, token}             → {forwards}, then live updates
 *   tcp | udp     {conn, key, token, forward}    → {ok}, then raw bytes / framed datagrams
 *   logout        {conn, key, token}             → {ok}
 *
 * `key` is baked into the download (HMAC of the connection id with the panel
 * secret), so a copy stops working when the admin issues a new one. The
 * password is scrypt-hashed like panel passwords, and device tokens are 256
 * random bits stored only as SHA-256 hashes.
 */

const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { config } = require('../../core/config');
const { logger, uid, fail } = require('../../core/util');
const { hashPassword, verifyPassword, checkPasswordStrength } = require('../../core/auth');
const { serverPorts } = require('../network');
const { loadIdentity } = require('./identity');
const { acceptUpgrade, WsStream } = require('./wsstream');

const MAX_REQUEST = 16 * 1024;
const HANDSHAKE_MS = 15_000;
const CONTROL_IDLE_MS = 90_000;
const UDP_IDLE_MS = 180_000;
const MAX_TUNNELS_PER_CONNECTION = 512;
const MAX_PENDING_PER_IP = 32;
const MAX_DEVICES = 20;
const MAX_UDP_BACKLOG = 1024 * 1024;
const USERNAME = /^[A-Za-z0-9_.-]{3,32}$/;
const HOST = /^[A-Za-z0-9.:-]{1,253}$/;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

class Bridge {
  constructor({ store, manager, secret }) {
    this.store = store;
    this.manager = manager;
    this.secret = secret;
    this.sessions = new Set();
    this.failures = new Map(); // ip or conn:<id> -> { count, until }
    this.pending = new Map(); // ip -> handshakes in flight
    this._identity = null;
    this._timer = setInterval(() => this.refreshAll(), 5000);
    this._timer.unref?.();
  }

  /* ------------------------------------------------------------- state -- */

  get settings() {
    const s = this.store.state.settings;
    if (!s.bridge) s.bridge = { enabled: false, publicUrl: '' };
    return s.bridge;
  }

  get enabled() {
    return this.settings.enabled === true;
  }

  get connections() {
    if (!this.store.state.bridge) this.store.state.bridge = { connections: [] };
    return this.store.state.bridge.connections;
  }

  identity() {
    if (!this._identity) this._identity = loadIdentity(path.join(config.dataDir, 'bridge'));
    return this._identity;
  }

  keyFor(conn) {
    return crypto.createHmac('sha256', this.secret).update(`gamepanel-bridge:${conn.id}:${conn.keyVersion}`).digest('base64url');
  }

  find(id) {
    const conn = this.connections.find((c) => c.id === id);
    if (!conn) fail(404, 'Connection not found');
    return conn;
  }

  /* --------------------------------------------------------- admin side -- */

  setSettings({ enabled, publicUrl }) {
    const s = this.settings;
    if (publicUrl !== undefined) {
      const value = String(publicUrl || '').trim().replace(/\/+$/, '');
      if (value) {
        let url;
        try {
          url = new URL(value);
        } catch {
          fail(400, 'The public address must be a full URL, like http://203.0.113.5:8420');
        }
        if (!['http:', 'https:'].includes(url.protocol)) fail(400, 'The public address must start with http:// or https://');
        if (url.username || url.password || url.search || url.hash) fail(400, 'The public address cannot include a login, query or #');
      }
      s.publicUrl = value;
    }
    if (enabled !== undefined) {
      s.enabled = Boolean(enabled);
      if (s.enabled) this.identity();
      else this.closeSessions(() => true);
    }
    this.store.save();
    return s;
  }

  createConnection(username) {
    username = String(username || '').trim();
    if (!USERNAME.test(username)) fail(400, 'Username must be 3-32 characters (letters, numbers, . _ -)');
    if (this.connections.some((c) => c.username.toLowerCase() === username.toLowerCase())) fail(409, 'There is already a connection with that username');
    const conn = {
      id: uid(12),
      username,
      enabled: true,
      keyVersion: 1,
      password: null,
      servers: [],
      ports: [],
      devices: [],
      createdAt: Date.now(),
    };
    this.connections.push(conn);
    this.store.save();
    return conn;
  }

  updateConnection(id, body) {
    const conn = this.find(id);
    if (body.enabled !== undefined) conn.enabled = Boolean(body.enabled);
    if (Array.isArray(body.servers)) {
      const known = new Set(this.manager.servers.map((s) => s.id));
      conn.servers = [...new Set(body.servers.map(String))].filter((sid) => known.has(sid));
    }
    if (Array.isArray(body.ports)) {
      if (body.ports.length > 64) fail(400, 'At most 64 custom ports per connection');
      conn.ports = body.ports.map((p) => cleanPort(p, conn.ports));
    }
    this.store.save();
    if (!conn.enabled) this.closeSessions((s) => s.conn === conn, 'disabled');
    else this.refresh(conn);
    return conn;
  }

  /** Forget the password and sign every device out; the next launch asks for a new one. */
  resetPassword(id) {
    const conn = this.find(id);
    conn.password = null;
    conn.devices = [];
    this.store.save();
    this.closeSessions((s) => s.conn === conn, 'password-reset');
    return conn;
  }

  /** Issue a new download key: every copy handed out before stops working. */
  rotateKey(id) {
    const conn = this.find(id);
    conn.keyVersion = (conn.keyVersion || 1) + 1;
    conn.devices = [];
    this.store.save();
    this.closeSessions((s) => s.conn === conn, 'replaced');
    return conn;
  }

  removeDevice(id, deviceId) {
    const conn = this.find(id);
    const before = conn.devices.length;
    conn.devices = conn.devices.filter((d) => d.id !== deviceId);
    if (conn.devices.length === before) fail(404, 'Device not found');
    this.store.save();
    this.closeSessions((s) => s.conn === conn && s.deviceId === deviceId, 'signed-out');
    return conn;
  }

  deleteConnection(id) {
    const conn = this.find(id);
    this.store.state.bridge.connections = this.connections.filter((c) => c !== conn);
    this.store.save();
    this.closeSessions((s) => s.conn === conn, 'deleted');
  }

  /** Drop servers that no longer exist from every connection. */
  forgetServer(serverId) {
    let changed = false;
    for (const conn of this.connections) {
      if (conn.servers.includes(serverId)) {
        conn.servers = conn.servers.filter((s) => s !== serverId);
        changed = true;
      }
    }
    if (changed) this.store.save();
  }

  publicConnection(conn) {
    const live = [...this.sessions].filter((s) => s.conn === conn);
    const onlineDevices = new Set(live.filter((s) => s.kind === 'control').map((s) => s.deviceId));
    return {
      id: conn.id,
      username: conn.username,
      enabled: conn.enabled,
      passwordSet: Boolean(conn.password),
      servers: conn.servers,
      ports: conn.ports,
      createdAt: conn.createdAt,
      online: onlineDevices.size > 0,
      tunnels: live.filter((s) => s.kind !== 'control').length,
      forwards: this.forwardsFor(conn),
      devices: conn.devices.map((d) => ({
        id: d.id,
        name: d.name,
        os: d.os,
        createdAt: d.createdAt,
        lastSeen: d.lastSeen,
        lastIp: d.lastIp,
        online: onlineDevices.has(d.id),
      })),
    };
  }

  /* ----------------------------------------------------------- forwards -- */

  /** Every port this connection may reach, with where it really goes. */
  forwardsFor(conn) {
    const out = [];
    for (const serverId of conn.servers) {
      const server = this.manager.servers.find((s) => s.id === serverId);
      if (!server) continue;
      const template = this.manager.template(server);
      const host = server.ip && server.ip !== '0.0.0.0' && server.ip !== '::' ? server.ip : '127.0.0.1';
      for (const p of serverPorts(server, template)) {
        if (!(p.port > 0 && p.port < 65536)) continue;
        out.push({
          id: `s:${server.id}:${p.name}:${p.protocol}`,
          kind: 'server',
          group: server.name,
          name: p.name,
          port: p.port,
          localPort: p.port,
          protocol: p.protocol,
          target: { host, port: p.port },
        });
      }
    }
    for (const p of conn.ports) {
      for (const protocol of p.protocol === 'both' ? ['tcp', 'udp'] : [p.protocol]) {
        out.push({
          id: `c:${p.id}:${protocol}`,
          kind: 'custom',
          group: 'Custom ports',
          name: p.name,
          port: p.port,
          localPort: p.localPort || p.port,
          protocol,
          target: { host: p.host || '127.0.0.1', port: p.port },
        });
      }
    }
    return out;
  }

  /** What the client is told: no internal hosts. */
  clientForwards(conn) {
    return this.forwardsFor(conn).map(({ target, ...rest }) => rest);
  }

  /* ----------------------------------------------------------- sessions -- */

  closeSessions(match, reason) {
    for (const session of [...this.sessions]) if (match(session)) session.close(reason);
  }

  refresh(conn) {
    const allowed = new Set(this.forwardsFor(conn).map((f) => f.id));
    for (const session of [...this.sessions]) {
      if (session.conn !== conn) continue;
      if (session.kind === 'control') session.push?.();
      else if (!allowed.has(session.forwardId)) session.close('forbidden');
    }
  }

  /** Server ports can change underneath a connection (edits, deletes). */
  refreshAll() {
    if (!this.sessions.size) return;
    for (const conn of new Set([...this.sessions].map((s) => s.conn))) this.refresh(conn);
  }

  /* ------------------------------------------------------- rate limits -- */

  locked(id) {
    const entry = this.failures.get(id);
    return entry && entry.until > Date.now() ? Math.ceil((entry.until - Date.now()) / 1000) : 0;
  }

  failed(id) {
    const entry = this.failures.get(id) || { count: 0, until: 0 };
    entry.count++;
    if (entry.count >= 5) entry.until = Date.now() + Math.min(15 * 60_000, 2 ** (entry.count - 5) * 30_000);
    this.failures.set(id, entry);
    if (this.failures.size > 10_000) {
      const now = Date.now();
      for (const [k, v] of this.failures) if (v.until < now) this.failures.delete(k);
    }
  }

  /* ------------------------------------------------------------- tunnel -- */

  /** An HTTP upgrade on /bridge/tunnel. */
  handleUpgrade(req, socket, head, ip) {
    if (!this.enabled) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if ((this.pending.get(ip) || 0) >= MAX_PENDING_PER_IP) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!acceptUpgrade(req, socket)) return;

    this.pending.set(ip, (this.pending.get(ip) || 0) + 1);
    let pendingDone = false;
    const donePending = () => {
      if (pendingDone) return;
      pendingDone = true;
      const n = (this.pending.get(ip) || 1) - 1;
      if (n > 0) this.pending.set(ip, n);
      else this.pending.delete(ip);
    };

    const ws = new WsStream(socket, head);
    const { key, cert } = this.identity();
    const secure = new tls.TLSSocket(ws, {
      isServer: true,
      secureContext: tls.createSecureContext({ key, cert, minVersion: 'TLSv1.3' }),
    });
    const timer = setTimeout(() => secure.destroy(), HANDSHAKE_MS);
    const kill = () => {
      clearTimeout(timer);
      donePending();
      ws.destroy();
    };
    secure.on('error', (err) => {
      logger.debug('bridge tunnel error:', err.message);
      kill();
    });
    ws.on('error', () => secure.destroy());
    secure.on('close', kill);

    readLine(secure, MAX_REQUEST)
      .then((line) => {
        clearTimeout(timer);
        donePending();
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          return reject(secure, 'bad-request', 'Malformed request');
        }
        return this.dispatch(secure, request || {}, ip);
      })
      .catch((err) => {
        logger.debug('bridge request failed:', err.message);
        secure.destroy();
      });
  }

  async dispatch(socket, req, ip) {
    if (!this.enabled) return reject(socket, 'disabled', 'The bridge is turned off on this panel');
    const wait = this.locked(ip);
    if (wait) return reject(socket, 'rate-limited', `Too many failed attempts. Try again in ${wait}s`);

    const conn = this.connections.find((c) => c.id === String(req.conn || ''));
    if (!conn || !safeEqual(String(req.key || ''), this.keyFor(conn))) {
      this.failed(ip);
      return reject(socket, 'bad-key', 'This copy of GamePanel Bridge is no longer valid. Download a new one from the panel.');
    }
    if (!conn.enabled) return reject(socket, 'disabled', 'This connection has been turned off by the panel administrator');
    const panel = this.store.state.settings.panelName || 'GamePanel';

    switch (req.op) {
      case 'hello':
        return finish(socket, { ok: true, state: conn.password ? 'login' : 'set-password', username: conn.username, panel });

      case 'set-password': {
        if (conn.password) return reject(socket, 'exists', 'This account already has a password. Sign in instead.');
        const password = String(req.password || '');
        // Same rules as panel passwords.
        try {
          checkPasswordStrength(password, conn.username);
        } catch (err) {
          return reject(socket, 'weak-password', err.message);
        }
        conn.password = hashPassword(password);
        const token = this.issueDevice(conn, req.device, ip);
        this.store.addEvent('bridge.password_set', `${conn.username} set their bridge password`, { ip });
        return finish(socket, { ok: true, token, username: conn.username, panel });
      }

      case 'login': {
        const lockKey = `conn:${conn.id}`;
        const connWait = this.locked(lockKey);
        if (connWait) return reject(socket, 'rate-limited', `Too many failed attempts. Try again in ${connWait}s`);
        if (!conn.password) return reject(socket, 'needs-password', 'This account needs a new password');
        if (!verifyPassword(String(req.password || ''), conn.password)) {
          this.failed(ip);
          this.failed(lockKey);
          return reject(socket, 'bad-password', 'Incorrect password');
        }
        this.failures.delete(lockKey);
        const token = this.issueDevice(conn, req.device, ip);
        return finish(socket, { ok: true, token, username: conn.username, panel });
      }

      default:
        break;
    }

    const device = this.deviceFor(conn, req.token);
    if (!device) return reject(socket, conn.password ? 'bad-token' : 'needs-password', 'This device is signed out. Sign in again.');

    switch (req.op) {
      case 'control':
        return this.control(socket, conn, device, ip, panel);
      case 'tcp':
      case 'udp': {
        const forward = this.forwardsFor(conn).find((f) => f.id === String(req.forward || '') && f.protocol === req.op);
        if (!forward) return reject(socket, 'forbidden', 'That port is not shared with you');
        if ([...this.sessions].filter((s) => s.conn === conn).length >= MAX_TUNNELS_PER_CONNECTION) {
          return reject(socket, 'busy', 'Too many open connections');
        }
        return req.op === 'tcp' ? this.tcp(socket, conn, device, forward) : this.udp(socket, conn, device, forward);
      }
      case 'logout':
        conn.devices = conn.devices.filter((d) => d !== device);
        this.store.save();
        this.closeSessions((s) => s.conn === conn && s.deviceId === device.id, 'signed-out');
        return finish(socket, { ok: true });
      default:
        return reject(socket, 'bad-request', 'Unknown request');
    }
  }

  issueDevice(conn, device, ip) {
    const token = crypto.randomBytes(32).toString('base64url');
    conn.devices.push({
      id: uid(10),
      name: clean(device?.name, 64) || 'Unknown device',
      os: clean(device?.os, 32),
      tokenHash: sha256(token).toString('hex'),
      createdAt: Date.now(),
      lastSeen: Date.now(),
      lastIp: ip,
    });
    if (conn.devices.length > MAX_DEVICES) {
      conn.devices.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      conn.devices.length = MAX_DEVICES;
    }
    this.store.save();
    return token;
  }

  deviceFor(conn, token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
    const hash = sha256(token);
    return conn.devices.find((d) => crypto.timingSafeEqual(Buffer.from(d.tokenHash, 'hex'), hash)) || null;
  }

  track(session) {
    this.sessions.add(session);
    return () => this.sessions.delete(session);
  }

  control(socket, conn, device, ip, panel) {
    let last = '';
    let idle;
    const send = (msg) => {
      if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(msg) + '\n');
    };
    const session = {
      kind: 'control',
      conn,
      deviceId: device.id,
      push() {
        const forwards = bridge.clientForwards(conn);
        const json = JSON.stringify(forwards);
        if (json === last) return;
        last = json;
        send({ type: 'forwards', forwards });
      },
      close(reason) {
        if (reason) send({ type: 'revoked', reason });
        socket.end();
        setTimeout(() => socket.destroy(), 2000).unref?.();
      },
    };
    const bridge = this;
    const untrack = this.track(session);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => socket.destroy(), CONTROL_IDLE_MS);
    };

    device.lastSeen = Date.now();
    device.lastIp = ip;
    this.store.save();
    if (![...this.sessions].some((s) => s !== session && s.kind === 'control' && s.deviceId === device.id)) {
      this.store.addEvent('bridge.connected', `${conn.username} connected through the bridge (${device.name})`, { ip });
    }

    last = JSON.stringify(this.clientForwards(conn));
    send({ ok: true, username: conn.username, panel, forwards: JSON.parse(last), urls: this.urls() });
    bump();

    let buf = '';
    socket.setEncoding('utf8');
    socket.resume();
    socket.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_REQUEST) return socket.destroy();
      let at;
      while ((at = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        bump();
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.type === 'ping') {
          device.lastSeen = Date.now();
          send({ type: 'pong' });
        }
      }
    });
    socket.on('end', () => socket.end());
    socket.on('close', () => {
      clearTimeout(idle);
      untrack();
      device.lastSeen = Date.now();
      this.store.save();
    });
  }

  tcp(socket, conn, device, forward) {
    const target = net.connect({ host: forward.target.host, port: forward.target.port });
    target.setNoDelay(true);
    let connected = false;
    const session = {
      kind: 'tcp',
      conn,
      deviceId: device.id,
      forwardId: forward.id,
      close: () => {
        target.destroy();
        socket.destroy();
      },
    };
    const untrack = this.track(session);
    const timer = setTimeout(() => target.destroy(new Error('timed out')), 10_000);

    target.once('connect', () => {
      clearTimeout(timer);
      connected = true;
      socket.write(JSON.stringify({ ok: true }) + '\n');
      // pipe() ends the other side when one finishes, which is exactly a
      // TCP half-close carried across the tunnel.
      socket.pipe(target);
      target.pipe(socket);
    });
    target.on('error', (err) => {
      clearTimeout(timer);
      if (!connected) {
        reject(socket, 'unreachable', `Nothing answered on port ${forward.port} (${err.code || err.message}). Is the server running?`);
      } else socket.destroy();
    });
    socket.on('error', () => target.destroy());
    socket.on('close', () => {
      clearTimeout(timer);
      target.destroy();
      untrack();
    });
    target.on('close', () => {
      if (!socket.writableEnded) socket.end();
    });
  }

  udp(socket, conn, device, forward) {
    dns.lookup(forward.target.host, (err, address, family) => {
      if (err || socket.destroyed) return reject(socket, 'unreachable', `Could not resolve ${forward.target.host}`);
      const udp = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
      let idle;
      const session = {
        kind: 'udp',
        conn,
        deviceId: device.id,
        forwardId: forward.id,
        close: () => socket.destroy(),
      };
      const untrack = this.track(session);
      const bump = () => {
        clearTimeout(idle);
        idle = setTimeout(() => socket.destroy(), UDP_IDLE_MS);
      };
      const cleanup = () => {
        clearTimeout(idle);
        untrack();
        try {
          udp.close();
        } catch {
          /* already closed */
        }
      };
      udp.on('error', () => {
        /* ICMP unreachable while the game restarts, etc. Keep going. */
      });
      udp.on('message', (msg) => {
        bump();
        // Datagrams may be dropped; queueing without bound may not.
        if (socket.destroyed || socket.writableLength > MAX_UDP_BACKLOG) return;
        const header = Buffer.alloc(2);
        header.writeUInt16BE(msg.length);
        socket.write(Buffer.concat([header, msg]));
      });
      udp.connect(forward.target.port, address, () => {
        if (socket.destroyed) return cleanup();
        socket.write(JSON.stringify({ ok: true }) + '\n');
        bump();
        let buf = Buffer.alloc(0);
        socket.resume();
        socket.on('data', (chunk) => {
          bump();
          buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
          while (buf.length >= 2) {
            const size = buf.readUInt16BE(0);
            if (buf.length < 2 + size) break;
            const datagram = buf.subarray(2, 2 + size);
            buf = buf.subarray(2 + size);
            if (size) udp.send(datagram, () => {});
          }
        });
        socket.on('end', () => socket.end());
      });
      socket.on('close', cleanup);
    });
  }

  /** The addresses a client should try, best first. */
  urls(origin) {
    const list = [this.settings.publicUrl, origin].filter(Boolean);
    return [...new Set(list.map((u) => u.replace(/\/+$/, '')))];
  }

  /** What gets stamped into a download for this connection. */
  stamp(conn, origin) {
    const urls = this.urls(origin);
    if (!urls.length) fail(400, 'Set the public address clients should connect to first');
    return {
      v: 1,
      panel: this.store.state.settings.panelName || 'GamePanel',
      urls,
      pin: this.identity().pin,
      conn: conn.id,
      key: this.keyFor(conn),
      user: conn.username,
    };
  }

  stop() {
    clearInterval(this._timer);
    this.closeSessions(() => true);
  }
}

/* ------------------------------------------------------------- helpers -- */

function cleanPort(p, existing) {
  const name = String(p?.name || '').trim().slice(0, 40);
  if (!name) fail(400, 'Every custom port needs a name');
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(400, `${name}: the port must be 1-65535`);
  const localPort = p.localPort === undefined || p.localPort === '' || p.localPort === null ? null : Number(p.localPort);
  if (localPort !== null && (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)) fail(400, `${name}: the local port must be 1-65535`);
  const protocol = ['tcp', 'udp', 'both'].includes(p.protocol) ? p.protocol : 'tcp';
  const host = String(p.host || '127.0.0.1').trim();
  if (!HOST.test(host)) fail(400, `${name}: that host is not valid`);
  const id = existing.some((e) => e.id === p.id) ? p.id : uid(8);
  return { id, name, port, localPort, protocol, host };
}

function clean(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function safeEqual(a, b) {
  const ha = sha256(a);
  const hb = sha256(b);
  return crypto.timingSafeEqual(ha, hb);
}

/** Read one newline-terminated line, leaving anything after it unread. */
function readLine(socket, max) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const at = buf.indexOf(0x0a);
      if (at === -1) {
        if (buf.length > max) done(new Error('request too long'));
        return;
      }
      done(null, buf.subarray(0, at).toString('utf8'), buf.subarray(at + 1));
    };
    const onEnd = () => done(new Error('closed before the request'));
    const done = (err, line, rest) => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      if (err) return reject(err);
      socket.pause();
      if (rest && rest.length) socket.unshift(rest);
      resolve(line);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
  });
}

function finish(socket, body) {
  if (socket.destroyed) return;
  socket.end(JSON.stringify(body) + '\n');
  // The client hangs up once it has the answer; don't wait forever if it doesn't.
  setTimeout(() => socket.destroy(), 5000).unref?.();
}

function reject(socket, code, error) {
  finish(socket, { ok: false, code, error });
}

module.exports = { Bridge };
