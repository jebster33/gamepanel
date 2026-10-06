'use strict';

/**
 * SFTP with panel accounts (Settings → SFTP): FileZilla, WinSCP or any SFTP
 * client signs in with the panel username and password (plus the
 * authenticator code when the account has two-factor sign-in) and sees the
 * folders of the servers it may browse. Uploads, deletes and renames need
 * "Upload, edit and delete files" for that server; nothing outside a server
 * folder is reachable.
 *
 *   alice        →  /<server id>/…  for every server Alice can browse
 *   alice.<id>   →  /…  is that one server's folder (like Pterodactyl)
 *
 * settings.sftp = { enabled, port }; the host key is <data>/sftp_host_ed25519.pem.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../core/config');
const { logger } = require('../core/util');
const ssh = require('../core/ssh');
const { containedPath } = require('./files');

const T = { INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, FSTAT: 8, SETSTAT: 9, FSETSTAT: 10, OPENDIR: 11, READDIR: 12, REMOVE: 13, MKDIR: 14, RMDIR: 15, REALPATH: 16, STAT: 17, RENAME: 18, READLINK: 19, SYMLINK: 20, STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105, EXTENDED: 200, EXTENDED_REPLY: 201 };
const S = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, BAD_MESSAGE: 5, OP_UNSUPPORTED: 8 };
const F = { READ: 1, WRITE: 2, APPEND: 4, CREAT: 8, TRUNC: 0x10, EXCL: 0x20 };
const A = { SIZE: 1, UIDGID: 2, PERMISSIONS: 4, ACMODTIME: 8 };
const MAX_HANDLES = 256;
const MAX_READ = 256 * 1024;

const { u32, str, byte } = ssh;
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(n))));
  return b;
};

class SftpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const deny = (msg = 'Permission denied') => {
  throw new SftpError(S.PERMISSION_DENIED, msg);
};

function errCode(err) {
  if (err instanceof SftpError) return err.code;
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return S.NO_SUCH_FILE;
  if (err.code === 'EACCES' || err.code === 'EPERM' || err.status === 400 || err.code === 400) return S.PERMISSION_DENIED;
  return S.FAILURE;
}

/* ------------------------------------------------------------ attributes -- */

function attrsOf(st) {
  const mode = st.mode & 0o170777;
  return Buffer.concat([u32(A.SIZE | A.UIDGID | A.PERMISSIONS | A.ACMODTIME), u64(st.size), u32(0), u32(0), u32(mode), u32(Math.floor(st.atimeMs / 1000)), u32(Math.floor(st.mtimeMs / 1000))]);
}

const DIR_ATTRS = () => attrsOf({ mode: 0o40755, size: 4096, atimeMs: Date.now(), mtimeMs: Date.now() });

function readAttrs(r) {
  const flags = r.u32();
  const out = {};
  if (flags & A.SIZE) out.size = r.u64();
  if (flags & A.UIDGID) {
    r.u32();
    r.u32();
  }
  if (flags & A.PERMISSIONS) out.mode = r.u32();
  if (flags & A.ACMODTIME) {
    out.atime = r.u32();
    out.mtime = r.u32();
  }
  if (flags & 0x80000000) {
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      r.string();
      r.string();
    }
  }
  return out;
}

function longname(name, st) {
  const isDir = (st.mode & 0o170000) === 0o040000;
  const perms = (st.mode & 0o777)
    .toString(2)
    .padStart(9, '0')
    .split('')
    .map((b, i) => (b === '1' ? 'rwx'[i % 3] : '-'))
    .join('');
  const d = new Date(st.mtimeMs);
  const month = d.toLocaleString('en', { month: 'short' });
  const when = `${month} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${isDir ? 'd' : '-'}${perms} 1 panel panel ${String(st.size).padStart(10)} ${when} ${name}`;
}

/* --------------------------------------------------------------- session -- */

/**
 * One SFTP session for a signed-in panel account.
 * session = { user, servers: [server], single: server|null, can(serverId, cap) }
 */
class Sftp {
  constructor(session, channel, { manager, store }) {
    this.session = session;
    this.channel = channel;
    this.manager = manager;
    this.store = store;
    this.buf = Buffer.alloc(0);
    this.handles = new Map();
    this.queue = Promise.resolve();
  }

  data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > 512 * 1024) {
        this.channel.close();
        return;
      }
      if (this.buf.length < 4 + len) return;
      const packet = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      // One at a time, in order: writes to the same file must not overtake each other.
      this.queue = this.queue.then(() => this.handle(packet)).catch((err) => logger.debug(`SFTP: ${err.message}`));
    }
  }

  end() {
    for (const h of this.handles.values()) if (h.fh) h.fh.close().catch(() => {});
    this.handles.clear();
  }

  reply(type, id, body = Buffer.alloc(0)) {
    const payload = Buffer.concat([byte(type), ...(id === null ? [] : [u32(id)]), body]);
    this.channel.write(Buffer.concat([u32(payload.length), payload]));
  }

  status(id, code, message = '') {
    const text = message || ['Success', 'End of file', 'No such file', 'Permission denied', 'Failure', 'Bad message', '', '', 'Operation unsupported'][code] || 'Failure';
    this.reply(T.STATUS, id, Buffer.concat([u32(code), str(text), str('en')]));
  }

  /* ----------------------------------------------------------- paths -- */

  /** "/a/../b" → ["b"]: always absolute, never above "/". */
  parts(p) {
    const out = [];
    for (const piece of String(p || '').replace(/\\/g, '/').split('/')) {
      if (!piece || piece === '.') continue;
      if (piece === '..') out.pop();
      else out.push(piece);
    }
    return out;
  }

  /**
   * Where a path leads: { root: true } for the list of servers, or
   * { server, full, rel } inside one of them.
   */
  resolve(p) {
    const parts = this.parts(p);
    let server = this.session.single;
    if (!server) {
      if (!parts.length) return { root: true, parts };
      server = this.session.servers.find((s) => s.id === parts[0]);
      if (!server) throw new SftpError(S.NO_SUCH_FILE, 'No such server');
      parts.shift();
    }
    // Access can change while connected: check every time.
    if (!this.session.can(server.id, 'files')) deny();
    const rel = parts.join('/');
    let full;
    try {
      full = containedPath(server.dir, rel);
    } catch {
      deny('That path leaves the server folder');
    }
    return { server, full, rel, parts };
  }

  writable(target) {
    if (target.root || !target.rel) deny('Server folders themselves cannot be changed');
    if (!this.session.can(target.server.id, 'files.write')) deny('You may only read files on this server');
  }

  canonical(p) {
    return `/${this.parts(p).join('/')}`;
  }

  /* -------------------------------------------------------- requests -- */

  async handle(packet) {
    const r = new ssh.Reader(packet);
    const type = r.byte();
    if (type === T.INIT) {
      this.reply(T.VERSION, null, Buffer.concat([u32(3), str('posix-rename@openssh.com'), str('1')]));
      return;
    }
    const id = r.u32();
    try {
      await this.dispatch(type, id, r);
    } catch (err) {
      this.status(id, errCode(err), err instanceof SftpError ? err.message : '');
    }
  }

  newHandle(value) {
    if (this.handles.size >= MAX_HANDLES) throw new SftpError(S.FAILURE, 'Too many open files');
    const h = crypto.randomBytes(8).toString('hex');
    this.handles.set(h, value);
    return h;
  }

  getHandle(r) {
    const h = this.handles.get(r.string());
    if (!h) throw new SftpError(S.FAILURE, 'Invalid handle');
    return h;
  }

  async dispatch(type, id, r) {
    switch (type) {
      case T.REALPATH: {
        const p = this.canonical(r.string());
        this.reply(T.NAME, id, Buffer.concat([u32(1), str(p), str(p), DIR_ATTRS()]));
        return;
      }
      case T.STAT:
      case T.LSTAT: {
        const t = this.resolve(r.string());
        if (t.root) return this.reply(T.ATTRS, id, DIR_ATTRS());
        const st = type === T.STAT ? await fsp.stat(t.full) : await fsp.lstat(t.full);
        this.reply(T.ATTRS, id, attrsOf(st));
        return;
      }
      case T.FSTAT: {
        const h = this.getHandle(r);
        if (!h.fh) throw new SftpError(S.FAILURE, 'Not a file');
        this.reply(T.ATTRS, id, attrsOf(await h.fh.stat()));
        return;
      }
      case T.OPENDIR: {
        const t = this.resolve(r.string());
        let entries;
        if (t.root) {
          entries = this.session.servers.filter((s) => this.session.can(s.id, 'files')).map((s) => ({ name: s.id, st: { mode: 0o40755, size: 4096, atimeMs: Date.now(), mtimeMs: Date.now() } }));
        } else {
          const st = await fsp.stat(t.full);
          if (!st.isDirectory()) throw new SftpError(S.NO_SUCH_FILE, 'Not a folder');
          entries = null;
        }
        this.reply(T.HANDLE, id, str(this.newHandle({ dir: true, target: t, entries, sent: false })));
        return;
      }
      case T.READDIR: {
        const h = this.getHandle(r);
        if (!h.dir) throw new SftpError(S.FAILURE, 'Not a folder');
        if (h.sent) return this.status(id, S.EOF);
        let entries = h.entries;
        if (!entries) {
          const names = await fsp.readdir(h.target.full);
          entries = [];
          for (const name of names) {
            const st = await fsp.lstat(path.join(h.target.full, name)).catch(() => null);
            if (st) entries.push({ name, st });
          }
        }
        h.sent = true;
        const list = [{ name: '.', st: { mode: 0o40755, size: 4096, atimeMs: Date.now(), mtimeMs: Date.now() } }, ...entries];
        this.reply(T.NAME, id, Buffer.concat([u32(list.length), ...list.map((e) => Buffer.concat([str(e.name), str(longname(e.name, e.st)), attrsOf(e.st)]))]));
        return;
      }
      case T.OPEN: {
        const t = this.resolve(r.string());
        const flags = r.u32();
        const attrs = readAttrs(r);
        if (t.root) deny();
        const writing = Boolean(flags & (F.WRITE | F.APPEND | F.CREAT | F.TRUNC));
        if (writing) {
          this.writable(t);
          this.manager.checkDiskRoom?.('upload files');
        }
        const exists = fs.existsSync(t.full);
        const plus = flags & F.READ ? '+' : '';
        let mode = 'r';
        if (writing) {
          if (flags & F.CREAT && flags & F.EXCL) mode = `wx${plus}`;
          else if (!exists && !(flags & F.CREAT)) throw new SftpError(S.NO_SUCH_FILE);
          else if (flags & F.TRUNC || !exists) mode = `w${plus}`;
          else if (flags & F.APPEND) mode = `a${plus}`;
          else mode = 'r+';
        }
        // Never write through a link that sits there now (a game or a mod could have made one).
        const st = await fsp.lstat(t.full).catch(() => null);
        if (st?.isSymbolicLink() && writing) deny('Writing through a symbolic link is not allowed');
        if (st?.isDirectory()) throw new SftpError(S.FAILURE, 'That is a folder');
        const fh = await fsp.open(t.full, mode, attrs.mode ? attrs.mode & 0o777 : 0o644);
        this.reply(T.HANDLE, id, str(this.newHandle({ fh, target: t, writing })));
        return;
      }
      case T.READ: {
        const h = this.getHandle(r);
        const offset = r.u64();
        const len = Math.min(r.u32(), MAX_READ);
        if (!h.fh) throw new SftpError(S.FAILURE, 'Not a file');
        const buf = Buffer.alloc(len);
        const { bytesRead } = await h.fh.read(buf, 0, len, offset);
        if (!bytesRead) return this.status(id, S.EOF);
        this.reply(T.DATA, id, str(buf.subarray(0, bytesRead)));
        return;
      }
      case T.WRITE: {
        const h = this.getHandle(r);
        const offset = r.u64();
        const data = r.bytes();
        if (!h.fh || !h.writing) deny();
        await h.fh.write(data, 0, data.length, offset);
        this.status(id, S.OK);
        return;
      }
      case T.CLOSE: {
        const key = r.string();
        const h = this.handles.get(key);
        if (!h) throw new SftpError(S.FAILURE, 'Invalid handle');
        this.handles.delete(key);
        if (h.fh) await h.fh.close();
        this.status(id, S.OK);
        return;
      }
      case T.SETSTAT:
      case T.FSETSTAT: {
        let t;
        let fh = null;
        if (type === T.SETSTAT) t = this.resolve(r.string());
        else {
          const h = this.getHandle(r);
          t = h.target;
          fh = h.fh;
        }
        const attrs = readAttrs(r);
        if (t.root) return this.status(id, S.OK);
        this.writable(t);
        if (attrs.size !== undefined) {
          if (fh) await fh.truncate(attrs.size);
          else await fsp.truncate(t.full, attrs.size);
        }
        // No set-uid/set-gid/sticky bits through here.
        if (attrs.mode !== undefined) await fsp.chmod(t.full, attrs.mode & 0o777);
        if (attrs.mtime !== undefined) await fsp.utimes(t.full, attrs.atime, attrs.mtime);
        this.status(id, S.OK);
        return;
      }
      case T.REMOVE: {
        const t = this.resolve(r.string());
        this.writable(t);
        const st = await fsp.lstat(t.full);
        if (st.isDirectory()) throw new SftpError(S.FAILURE, 'That is a folder');
        await fsp.unlink(t.full);
        this.status(id, S.OK);
        return;
      }
      case T.MKDIR: {
        const t = this.resolve(r.string());
        readAttrs(r);
        this.writable(t);
        await fsp.mkdir(t.full);
        this.status(id, S.OK);
        return;
      }
      case T.RMDIR: {
        const t = this.resolve(r.string());
        this.writable(t);
        await fsp.rmdir(t.full);
        this.status(id, S.OK);
        return;
      }
      case T.RENAME: {
        const from = this.resolve(r.string());
        const to = this.resolve(r.string());
        this.writable(from);
        this.writable(to);
        if (from.server.id !== to.server.id) throw new SftpError(S.OP_UNSUPPORTED, 'Move between servers by downloading and uploading');
        // SFTP v3 rename does not overwrite.
        if (fs.existsSync(to.full)) throw new SftpError(S.FAILURE, 'A file with that name is already there');
        await fsp.rename(from.full, to.full);
        this.status(id, S.OK);
        return;
      }
      case T.READLINK: {
        const t = this.resolve(r.string());
        if (t.root) throw new SftpError(S.NO_SUCH_FILE);
        const target = await fsp.readlink(t.full);
        this.reply(T.NAME, id, Buffer.concat([u32(1), str(target), str(target), DIR_ATTRS()]));
        return;
      }
      case T.SYMLINK:
        deny('Making symbolic links is not allowed');
        return;
      case T.EXTENDED: {
        const name = r.string();
        if (name === 'posix-rename@openssh.com') {
          const from = this.resolve(r.string());
          const to = this.resolve(r.string());
          this.writable(from);
          this.writable(to);
          if (from.server.id !== to.server.id) throw new SftpError(S.OP_UNSUPPORTED, 'Move between servers by downloading and uploading');
          await fsp.rename(from.full, to.full);
          return this.status(id, S.OK);
        }
        throw new SftpError(S.OP_UNSUPPORTED);
      }
      default:
        throw new SftpError(S.OP_UNSUPPORTED);
    }
  }
}

/* ---------------------------------------------------------------- server -- */

let running = null;

function hostKey() {
  const file = path.join(config.dataDir, 'sftp_host_ed25519.pem');
  if (!fs.existsSync(file)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  return crypto.createPrivateKey(fs.readFileSync(file));
}

const settingsOf = (store) => ({ enabled: false, port: 2022, ...(store.state.settings.sftp || {}) });

/** Panel sign-in, the same rules as the web page: lockouts, two-factor, the admin 2FA rule. */
function authenticator({ store, auth, manager }) {
  const tickets = new Map(); // username|ip -> 2FA ticket from a right password
  return async ({ username, password, code, ip }) => {
    // "alice.<server id>" opens that one server's folder as "/".
    const raw = String(username);
    const dot = raw.lastIndexOf('.');
    const suffix = dot > 0 ? raw.slice(dot + 1) : '';
    const single = suffix && manager.servers.some((s) => s.id === suffix) ? suffix : null;
    const name = single ? raw.slice(0, dot) : raw;
    let result;
    const key = `${name}|${ip}`;
    if (code !== undefined) {
      const ticket = tickets.get(key);
      tickets.delete(key);
      if (!ticket) throw new Error('no password step');
      result = auth.loginSecondFactor(ticket, code, ip);
    } else {
      result = auth.login(name, password, ip);
      if (result.twoFactor) {
        tickets.set(key, result.ticket);
        setTimeout(() => tickets.delete(key), 5 * 60_000).unref?.();
        return { needCode: true };
      }
    }
    const user = auth.users.find((u) => u.id === result.user.id);
    if (user.role === 'admin' && store.state.settings.requireAdmin2fa && !user.totp?.secret) throw new Error('administrators need an authenticator app for SFTP');
    const can = (serverId, cap) => auth.canAccessServer(user, serverId) && (user.role === 'admin' || auth.can(user, cap, serverId));
    const servers = manager.servers.filter((s) => !s.node && can(s.id, 'files'));
    const one = single ? servers.find((s) => s.id === single) : null;
    if (single && !one) throw new Error('no access to that server');
    store.addEvent('user.login', `${user.username} signed in over SFTP${one ? ` (${one.name})` : ''}`, { ip });
    return { user, servers, single: one, can };
  };
}

async function start({ store, auth, manager }) {
  await stop();
  const s = settingsOf(store);
  if (!s.enabled) return null;
  const server = ssh.createServer({
    hostKey: hostKey(),
    authenticate: authenticator({ store, auth, manager }),
    subsystem: (session, name, channel) => (name === 'sftp' ? new Sftp(session, channel, { manager, store }) : null),
    log: (line) => logger.debug(line),
  });
  await new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new Error(err.code === 'EADDRINUSE' ? `Port ${s.port} is taken by another program` : err.code === 'EACCES' ? `The panel is not allowed to use port ${s.port}` : err.message)));
    server.listen(s.port, config.host, resolve);
  });
  server.on('error', (err) => logger.warn(`SFTP: ${err.message}`));
  running = { server, port: s.port, fingerprint: server.fingerprint };
  logger.info(`SFTP listening on port ${s.port} (host key ${server.fingerprint})`);
  return running;
}

async function stop() {
  if (!running) return;
  const { server } = running;
  running = null;
  await new Promise((resolve) => server.close(() => resolve()));
}

function status(store) {
  const s = settingsOf(store);
  let fingerprint = running?.fingerprint || null;
  if (!fingerprint && fs.existsSync(path.join(config.dataDir, 'sftp_host_ed25519.pem'))) {
    const pub = crypto.createPublicKey(hostKey()).export({ format: 'jwk' });
    const blob = Buffer.concat([str('ssh-ed25519'), str(Buffer.from(pub.x, 'base64url'))]);
    fingerprint = `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  }
  return { settings: s, listening: running?.port || null, fingerprint };
}

function update(store, input) {
  const s = settingsOf(store);
  const port = Number(input.port ?? s.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === config.port) throw Object.assign(new Error('Pick a free port for SFTP'), { status: 400 });
  store.state.settings.sftp = { enabled: Boolean(input.enabled ?? s.enabled), port };
  store.save();
}

module.exports = { start, stop, status, update, Sftp };
