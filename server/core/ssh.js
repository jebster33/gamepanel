'use strict';

/**
 * A small SSH-2 server, enough for SFTP: no shells, no exec, no forwarding.
 *
 *   key exchange   curve25519-sha256 (RFC 8731), with OpenSSH's strict KEX
 *                  (sequence numbers reset at NEWKEYS: the Terrapin fix)
 *   host key       ssh-ed25519
 *   ciphers        aes256-ctr, aes128-ctr     MACs  hmac-sha2-256, hmac-sha2-512
 *   sign-in        password, keyboard-interactive (password, then a code
 *                  when the account has two-factor sign-in)
 *   channels       "session" with the "sftp" subsystem only
 *
 * Everything is Node's crypto. The caller supplies `authenticate` and
 * `subsystem`; see createServer.
 */

const net = require('net');
const crypto = require('crypto');

const MSG = {
  DISCONNECT: 1, IGNORE: 2, UNIMPLEMENTED: 3, DEBUG: 4, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, EXT_INFO: 7,
  KEXINIT: 20, NEWKEYS: 21, KEX_ECDH_INIT: 30, KEX_ECDH_REPLY: 31,
  USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, USERAUTH_BANNER: 53, USERAUTH_INFO_REQUEST: 60, USERAUTH_INFO_RESPONSE: 61,
  GLOBAL_REQUEST: 80, REQUEST_SUCCESS: 81, REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90, CHANNEL_OPEN_CONFIRMATION: 91, CHANNEL_OPEN_FAILURE: 92, CHANNEL_WINDOW_ADJUST: 93, CHANNEL_DATA: 94, CHANNEL_EXTENDED_DATA: 95,
  CHANNEL_EOF: 96, CHANNEL_CLOSE: 97, CHANNEL_REQUEST: 98, CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100,
};
const VERSION = 'SSH-2.0-GamePanel_SFTP';
const KEX = ['curve25519-sha256', 'curve25519-sha256@libssh.org'];
const CIPHERS = { 'aes256-ctr': { key: 32, iv: 16, name: 'aes-256-ctr' }, 'aes128-ctr': { key: 16, iv: 16, name: 'aes-128-ctr' } };
const MACS = { 'hmac-sha2-256': { key: 32, len: 32, hash: 'sha256' }, 'hmac-sha2-512': { key: 64, len: 64, hash: 'sha512' } };
const MAX_PACKET = 256 * 1024;
const WINDOW = 2 * 1024 * 1024;
const CHANNEL_PACKET = 32 * 1024;

/* ------------------------------------------------------------- encoding -- */

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const str = (s) => {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(String(s));
  return Buffer.concat([u32(b.length), b]);
};
const bool = (v) => Buffer.from([v ? 1 : 0]);
const byte = (v) => Buffer.from([v]);
/** An unsigned big-endian number as an SSH mpint. */
function mpint(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  let b = buf.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return str(b);
}

class Reader {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  need(n) {
    if (this.pos + n > this.buf.length) throw new Error('message too short');
  }

  byte() {
    this.need(1);
    return this.buf[this.pos++];
  }

  bool() {
    return this.byte() !== 0;
  }

  u32() {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  u64() {
    this.need(8);
    const v = this.buf.readBigUInt64BE(this.pos);
    this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('number too large');
    return Number(v);
  }

  bytes() {
    const len = this.u32();
    this.need(len);
    const b = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }

  string() {
    return this.bytes().toString('utf8');
  }

  list() {
    const s = this.string();
    return s ? s.split(',') : [];
  }

  rest() {
    return this.buf.subarray(this.pos);
  }
}

/* --------------------------------------------------------------- server -- */

/**
 * @param {object} opts
 * @param {crypto.KeyObject} opts.hostKey   Ed25519 private key
 * @param {(ctx) => Promise<object>} opts.authenticate
 *   ctx = { username, password, code, ip }. Resolve with a session object to let
 *   them in, with { needCode: true } when a two-factor code is also needed, or
 *   throw (with err.message shown to no one) to refuse.
 * @param {(session, name, channel) => object|null} opts.subsystem
 *   Return { data(buf), end() } to accept the subsystem; use channel.write(buf)
 *   and channel.close() to answer.
 * @param {(line) => void} [opts.log]
 */
function createServer({ hostKey, authenticate, subsystem, log = () => {}, banner = '', maxPerIp = 10, maxTotal = 100, maxUnauth = 20, maxUnauthPerIp = 3 }) {
  const hostPub = crypto.createPublicKey(hostKey).export({ format: 'jwk' });
  const hostBlob = Buffer.concat([str('ssh-ed25519'), str(Buffer.from(hostPub.x, 'base64url'))]);
  const perIp = new Map();
  // Connections that have not signed in yet are capped on their own, so a flood of idle ones cannot take every slot from the people who have.
  const unauthPerIp = new Map();
  let total = 0;
  let unauth = 0;
  const bump = (map, ip, by) => {
    const n = (map.get(ip) || 0) + by;
    if (n > 0) map.set(ip, n);
    else map.delete(ip);
  };

  const server = net.createServer((socket) => {
    const ip = socket.remoteAddress?.replace(/^::ffff:/, '') || 'unknown';
    if (total >= maxTotal || (perIp.get(ip) || 0) >= maxPerIp || unauth >= maxUnauth || (unauthPerIp.get(ip) || 0) >= maxUnauthPerIp) {
      socket.destroy();
      return;
    }
    total++;
    unauth++;
    bump(perIp, ip, 1);
    bump(unauthPerIp, ip, 1);
    let waiting = true;
    const signedIn = () => {
      if (!waiting) return;
      waiting = false;
      unauth--;
      bump(unauthPerIp, ip, -1);
    };
    socket.on('close', () => {
      total--;
      bump(perIp, ip, -1);
      signedIn();
    });
    new Connection(socket, { ip, hostKey, hostBlob, authenticate, subsystem, log, banner, onAuthed: signedIn });
  });
  server.fingerprint = `SHA256:${crypto.createHash('sha256').update(hostBlob).digest('base64').replace(/=+$/, '')}`;
  return server;
}

class Connection {
  constructor(socket, opts) {
    Object.assign(this, opts);
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.clientVersion = null;
    this.seqIn = 0;
    this.seqOut = 0;
    this.inKeys = null; // { decipher, macKey, mac }
    this.outKeys = null;
    this.pendingIn = null; // keys to switch to on the client's NEWKEYS
    this.kex = null; // { clientInit, serverInit, algs }
    this.sessionId = null;
    this.firstKex = true;
    this.strict = false;
    this.authed = null;
    this.authAttempts = 0;
    this.kbd = null; // keyboard-interactive state
    this.passwordOk = null; // { username, ticket } once a password was right but a code is due
    this.channels = new Map();
    this.nextChannel = 0;
    this.closed = false;

    socket.setNoDelay(true);
    socket.setTimeout(15 * 60_000, () => this.disconnect(11, 'idle'));
    // Sign in within half a minute or go.
    this.authTimer = setTimeout(() => !this.authed && this.disconnect(2, 'authentication timeout'), 30_000);
    socket.on('data', (d) => this.onData(d));
    socket.on('error', () => this.cleanup());
    socket.on('close', () => this.cleanup());
    socket.write(`${VERSION}\r\n`);
  }

  cleanup() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.authTimer);
    for (const ch of this.channels.values()) ch.handler?.end?.();
    this.channels.clear();
  }

  disconnect(code, reason) {
    if (this.closed) return;
    try {
      this.send(Buffer.concat([byte(MSG.DISCONNECT), u32(code), str(reason), str('')]));
    } catch {
      /* the socket is gone */
    }
    this.socket.end();
    this.cleanup();
  }

  /* ----------------------------------------------------- packet layer -- */

  onData(data) {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, data]);
    try {
      if (!this.clientVersion) {
        const nl = this.buf.indexOf('\n');
        if (nl === -1) {
          if (this.buf.length > 8192) throw new Error('no version line');
          return;
        }
        const line = this.buf.subarray(0, nl).toString('latin1').replace(/\r$/, '');
        this.buf = this.buf.subarray(nl + 1);
        if (!line.startsWith('SSH-')) return this.onData(Buffer.alloc(0)); // lines before the version are allowed
        if (!line.startsWith('SSH-2.0-') && !line.startsWith('SSH-1.99-')) throw new Error('only SSH 2 is supported');
        this.clientVersion = line;
        this.sendKexInit();
      }
      for (;;) {
        const packet = this.readPacket();
        if (!packet) return;
        const pending = this.handle(packet);
        if (pending?.catch) {
          pending.catch((err) => {
            this.log(`SSH ${this.ip}: ${err.message}`);
            this.disconnect(2, 'protocol error');
          });
        }
      }
    } catch (err) {
      this.log(`SSH ${this.ip}: ${err.message}`);
      this.disconnect(2, 'protocol error');
    }
  }

  readPacket() {
    const block = this.inKeys ? 16 : 8;
    if (this.buf.length < block) return null;
    if (!this.inKeys) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_PACKET || len < 5) throw new Error('bad packet length');
      if (this.buf.length < 4 + len) return null;
      const packet = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.seqIn = (this.seqIn + 1) >>> 0;
      return packet.subarray(1, packet.length - packet[0]);
    }
    // Encrypted: the first block holds the length.
    if (!this.inFirst) {
      this.inFirst = this.inKeys.decipher.update(this.buf.subarray(0, block));
      this.buf = this.buf.subarray(block);
    }
    const len = this.inFirst.readUInt32BE(0);
    if (len > MAX_PACKET || len < 5 || (len + 4) % block) throw new Error('bad packet length');
    const restLen = len + 4 - block;
    const macLen = this.inKeys.mac.len;
    if (this.buf.length < restLen + macLen) return null;
    const plain = Buffer.concat([this.inFirst, this.inKeys.decipher.update(this.buf.subarray(0, restLen))]);
    const mac = this.buf.subarray(restLen, restLen + macLen);
    this.buf = this.buf.subarray(restLen + macLen);
    this.inFirst = null;
    const want = crypto.createHmac(this.inKeys.mac.hash, this.inKeys.macKey).update(u32(this.seqIn)).update(plain).digest();
    if (!crypto.timingSafeEqual(want, mac)) throw new Error('bad MAC');
    this.seqIn = (this.seqIn + 1) >>> 0;
    const padding = plain[4];
    return plain.subarray(5, plain.length - padding);
  }

  send(payload) {
    if (this.closed) return;
    // While keys are being changed, only transport messages may go out; the rest waits.
    if (this.rekeying && payload[0] >= 50) {
      this.deferred.push(payload);
      return;
    }
    const block = this.outKeys ? 16 : 8;
    let padding = block - ((payload.length + 5) % block);
    if (padding < 4) padding += block;
    const packet = Buffer.concat([u32(payload.length + padding + 1), byte(padding), payload, crypto.randomBytes(padding)]);
    if (!this.outKeys) {
      this.socket.write(packet);
    } else {
      const mac = crypto.createHmac(this.outKeys.mac.hash, this.outKeys.macKey).update(u32(this.seqOut)).update(packet).digest();
      this.socket.write(Buffer.concat([this.outKeys.cipher.update(packet), mac]));
    }
    this.seqOut = (this.seqOut + 1) >>> 0;
  }

  /* ------------------------------------------------------ key exchange -- */

  sendKexInit() {
    const payload = Buffer.concat([
      byte(MSG.KEXINIT),
      crypto.randomBytes(16),
      str([...KEX, 'kex-strict-s-v00@openssh.com'].join(',')),
      str('ssh-ed25519'),
      str(Object.keys(CIPHERS).join(',')),
      str(Object.keys(CIPHERS).join(',')),
      str(Object.keys(MACS).join(',')),
      str(Object.keys(MACS).join(',')),
      str('none'),
      str('none'),
      str(''),
      str(''),
      bool(false),
      u32(0),
    ]);
    this.kex = { ...(this.kex || {}), serverInit: payload, sent: true };
    this.rekeying = true;
    this.deferred ||= [];
    this.send(payload);
  }

  onKexInit(payload) {
    if (!this.kex?.sent) this.sendKexInit();
    const r = new Reader(payload, 17);
    const lists = Array.from({ length: 10 }, () => r.list());
    const pick = (client, ours, what) => {
      const hit = client.find((a) => ours.includes(a));
      if (!hit) throw new Error(`no common ${what}`);
      return hit;
    };
    if (this.firstKex) this.strict = lists[0].includes('kex-strict-c-v00@openssh.com');
    this.kex.clientInit = payload;
    this.kex.algs = {
      kex: pick(lists[0], KEX, 'key exchange'),
      cipherIn: pick(lists[2], Object.keys(CIPHERS), 'cipher'),
      cipherOut: pick(lists[3], Object.keys(CIPHERS), 'cipher'),
      macIn: pick(lists[4], Object.keys(MACS), 'MAC'),
      macOut: pick(lists[5], Object.keys(MACS), 'MAC'),
    };
    if (!lists[1].includes('ssh-ed25519')) throw new Error('the client does not accept ed25519 host keys');
    if (!lists[6].includes('none') || !lists[7].includes('none')) throw new Error('compression is not supported');
  }

  onKexEcdhInit(payload) {
    const r = new Reader(payload, 1);
    const qc = r.bytes();
    if (qc.length !== 32) throw new Error('bad client key');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const qs = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    const peer = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: qc.toString('base64url') }, format: 'jwk' });
    const secret = crypto.diffieHellman({ privateKey, publicKey: peer });
    if (secret.every((b) => b === 0)) throw new Error('bad shared secret');
    const K = mpint(secret);
    const H = crypto
      .createHash('sha256')
      .update(Buffer.concat([str(this.clientVersion), str(VERSION), str(this.kex.clientInit), str(this.kex.serverInit), str(this.hostBlob), str(qc), str(qs), K]))
      .digest();
    if (!this.sessionId) this.sessionId = H;
    const sig = Buffer.concat([str('ssh-ed25519'), str(crypto.sign(null, H, this.hostKey))]);
    this.send(Buffer.concat([byte(MSG.KEX_ECDH_REPLY), str(this.hostBlob), str(qs), str(sig)]));

    const derive = (letter, size) => {
      let out = crypto.createHash('sha256').update(Buffer.concat([K, H, Buffer.from(letter), this.sessionId])).digest();
      while (out.length < size) out = Buffer.concat([out, crypto.createHash('sha256').update(Buffer.concat([K, H, out])).digest()]);
      return out.subarray(0, size);
    };
    const { cipherIn, cipherOut, macIn, macOut } = this.kex.algs;
    const ci = CIPHERS[cipherIn];
    const co = CIPHERS[cipherOut];
    this.pendingIn = {
      decipher: crypto.createDecipheriv(ci.name, derive('C', ci.key), derive('A', ci.iv)),
      mac: MACS[macIn],
      macKey: derive('E', MACS[macIn].key),
    };
    // Ours switch right after NEWKEYS goes out.
    this.send(byte(MSG.NEWKEYS));
    this.outKeys = { cipher: crypto.createCipheriv(co.name, derive('D', co.key), derive('B', co.iv)), mac: MACS[macOut], macKey: derive('F', MACS[macOut].key) };
    if (this.strict) this.seqOut = 0;
    this.rekeying = false;
    const held = this.deferred || [];
    this.deferred = [];
    for (const p of held) this.send(p);
  }

  onNewKeys() {
    if (!this.pendingIn) throw new Error('NEWKEYS out of order');
    this.inKeys = this.pendingIn;
    this.pendingIn = null;
    if (this.strict) this.seqIn = 0;
    this.firstKex = false;
    this.kex = null;
  }

  /* ---------------------------------------------------------- messages -- */

  handle(payload) {
    const type = payload[0];
    // Strict KEX: nothing but the key exchange until the first one is done.
    if (this.firstKex && this.strict && ![MSG.KEXINIT, MSG.KEX_ECDH_INIT, MSG.NEWKEYS].includes(type)) throw new Error('unexpected message during key exchange');
    switch (type) {
      case MSG.KEXINIT:
        return this.onKexInit(payload);
      case MSG.KEX_ECDH_INIT:
        return this.onKexEcdhInit(payload);
      case MSG.NEWKEYS:
        return this.onNewKeys();
      case MSG.DISCONNECT:
        this.socket.end();
        return this.cleanup();
      case MSG.IGNORE:
      case MSG.DEBUG:
      case MSG.UNIMPLEMENTED:
        return undefined;
      case MSG.SERVICE_REQUEST: {
        const name = new Reader(payload, 1).string();
        if (name !== 'ssh-userauth' || !this.inKeys) return this.disconnect(7, 'service not available');
        return this.send(Buffer.concat([byte(MSG.SERVICE_ACCEPT), str(name)]));
      }
      case MSG.USERAUTH_REQUEST:
        return this.onUserauth(payload);
      case MSG.USERAUTH_INFO_RESPONSE:
        return this.onInfoResponse(payload);
      default:
        if (!this.authed) return this.disconnect(2, 'not signed in');
        return this.onConnectionMessage(type, payload);
    }
  }

  /* ----------------------------------------------------------- sign-in -- */

  fail(partial = false, methods = 'password,keyboard-interactive') {
    this.send(Buffer.concat([byte(MSG.USERAUTH_FAILURE), str(methods), bool(partial)]));
  }

  async tryPassword(username, password, code) {
    try {
      const result = await this.authenticate({ username, password, code, ip: this.ip });
      if (result?.needCode) return 'code';
      this.authed = result;
      this.onAuthed?.();
      clearTimeout(this.authTimer);
      this.send(byte(MSG.USERAUTH_SUCCESS));
      return 'ok';
    } catch (err) {
      this.authAttempts++;
      this.log(`SFTP sign-in refused for ${username} from ${this.ip}: ${err.message}`);
      if (this.authAttempts >= 5) this.disconnect(14, 'too many failed sign-ins');
      return 'no';
    }
  }

  async onUserauth(payload) {
    if (this.authed) return undefined;
    const r = new Reader(payload, 1);
    const username = r.string().slice(0, 100);
    const service = r.string();
    const method = r.string();
    if (service !== 'ssh-connection') return this.disconnect(7, 'service not available');
    if (method === 'password') {
      if (r.bool()) return this.fail(); // password change: not supported
      const password = r.string();
      const outcome = await this.tryPassword(username, password);
      if (outcome === 'code') {
        // Password right; the code comes through keyboard-interactive.
        this.passwordOk = { username, password };
        return this.fail(true, 'keyboard-interactive');
      }
      if (outcome === 'no') return this.fail();
      return undefined;
    }
    if (method === 'keyboard-interactive') {
      const needPassword = !(this.passwordOk && this.passwordOk.username === username);
      this.kbd = { username, step: needPassword ? 'password' : 'code' };
      return this.prompt(needPassword ? 'Password: ' : 'Authenticator code: ');
    }
    return this.fail();
  }

  prompt(text) {
    this.send(Buffer.concat([byte(MSG.USERAUTH_INFO_REQUEST), str('GamePanel'), str(''), str(''), u32(1), str(text), bool(false)]));
  }

  async onInfoResponse(payload) {
    if (!this.kbd || this.authed) return undefined;
    const r = new Reader(payload, 1);
    const n = r.u32();
    const answer = n ? r.string() : '';
    const { username, step } = this.kbd;
    if (step === 'password') {
      const outcome = await this.tryPassword(username, answer);
      if (outcome === 'code') {
        this.passwordOk = { username, password: answer };
        this.kbd.step = 'code';
        return this.prompt('Authenticator code: ');
      }
      if (outcome === 'no') {
        this.kbd = null;
        return this.fail();
      }
      return undefined;
    }
    const outcome = await this.tryPassword(username, this.passwordOk?.password, answer);
    this.kbd = null;
    if (outcome !== 'ok') {
      this.passwordOk = null;
      return this.fail();
    }
    return undefined;
  }

  /* ---------------------------------------------------------- channels -- */

  onConnectionMessage(type, payload) {
    const r = new Reader(payload, 1);
    switch (type) {
      case MSG.GLOBAL_REQUEST: {
        r.string();
        if (r.bool()) this.send(byte(MSG.REQUEST_FAILURE));
        return undefined;
      }
      case MSG.CHANNEL_OPEN: {
        const kind = r.string();
        const remote = r.u32();
        const window = r.u32();
        const maxPacket = r.u32();
        if (kind !== 'session' || this.channels.size >= 4) {
          return this.send(Buffer.concat([byte(MSG.CHANNEL_OPEN_FAILURE), u32(remote), u32(kind === 'session' ? 4 : 1), str('not available'), str('')]));
        }
        const id = this.nextChannel++;
        const ch = { id, remote, window, maxPacket: Math.min(maxPacket, CHANNEL_PACKET), localWindow: WINDOW, queue: [], handler: null, closed: false };
        this.channels.set(id, ch);
        return this.send(Buffer.concat([byte(MSG.CHANNEL_OPEN_CONFIRMATION), u32(remote), u32(id), u32(WINDOW), u32(CHANNEL_PACKET)]));
      }
      case MSG.CHANNEL_REQUEST: {
        const ch = this.channels.get(r.u32());
        const kind = r.string();
        const wantReply = r.bool();
        if (!ch) return undefined;
        let ok = false;
        if (kind === 'subsystem' && !ch.handler) {
          const name = r.string();
          const channel = { write: (buf) => this.channelWrite(ch, buf), close: () => this.channelClose(ch) };
          ch.handler = this.subsystem(this.authed, name, channel);
          ok = Boolean(ch.handler);
        }
        // No shells, commands, terminals or agent forwarding: SFTP only.
        if (wantReply) this.send(Buffer.concat([byte(ok ? MSG.CHANNEL_SUCCESS : MSG.CHANNEL_FAILURE), u32(ch.remote)]));
        return undefined;
      }
      case MSG.CHANNEL_DATA: {
        const ch = this.channels.get(r.u32());
        const data = r.bytes();
        if (!ch || ch.closed) return undefined;
        ch.localWindow -= data.length;
        if (ch.localWindow < 0) throw new Error('window exceeded');
        if (ch.localWindow < WINDOW / 2) {
          this.send(Buffer.concat([byte(MSG.CHANNEL_WINDOW_ADJUST), u32(ch.remote), u32(WINDOW - ch.localWindow)]));
          ch.localWindow = WINDOW;
        }
        ch.handler?.data(data);
        return undefined;
      }
      case MSG.CHANNEL_WINDOW_ADJUST: {
        const ch = this.channels.get(r.u32());
        if (!ch) return undefined;
        ch.window = Math.min(ch.window + r.u32(), 0xffffffff);
        this.flush(ch);
        return undefined;
      }
      case MSG.CHANNEL_EOF: {
        // The client is done (sftp's "bye"): finish what is queued and close.
        const ch = this.channels.get(r.u32());
        if (ch) this.channelClose(ch);
        return undefined;
      }
      case MSG.CHANNEL_CLOSE: {
        const ch = this.channels.get(r.u32());
        if (ch) this.channelClose(ch);
        return undefined;
      }
      case MSG.CHANNEL_EXTENDED_DATA:
        return undefined;
      default:
        return this.send(Buffer.concat([byte(MSG.UNIMPLEMENTED), u32((this.seqIn - 1) >>> 0)]));
    }
  }

  channelWrite(ch, buf) {
    if (ch.closed || this.closed) return;
    ch.queue.push(buf);
    this.flush(ch);
    // A client that asks for data and never opens its window would make this queue grow without end.
    if (ch.queue.length > 64) {
      ch.queue.length = 0;
      this.finishClose(ch);
    }
  }

  /** Send what the client's window allows; the rest waits for WINDOW_ADJUST. */
  flush(ch) {
    while (ch.queue.length && ch.window > 0) {
      let buf = ch.queue[0];
      const n = Math.min(buf.length, ch.window, ch.maxPacket);
      this.send(Buffer.concat([byte(MSG.CHANNEL_DATA), u32(ch.remote), str(buf.subarray(0, n))]));
      ch.window -= n;
      buf = buf.subarray(n);
      if (buf.length) ch.queue[0] = buf;
      else ch.queue.shift();
    }
    if (!ch.queue.length && ch.closing) this.finishClose(ch);
  }

  channelClose(ch) {
    if (ch.closed) return;
    if (ch.queue.length) {
      ch.closing = true;
      return;
    }
    this.finishClose(ch);
  }

  finishClose(ch) {
    if (ch.closed) return;
    ch.closed = true;
    ch.handler?.end?.();
    this.send(Buffer.concat([byte(MSG.CHANNEL_EOF), u32(ch.remote)]));
    this.send(Buffer.concat([byte(MSG.CHANNEL_CLOSE), u32(ch.remote)]));
    this.channels.delete(ch.id);
  }
}

module.exports = { createServer, Reader, u32, str, byte, bool, mpint, MSG };
