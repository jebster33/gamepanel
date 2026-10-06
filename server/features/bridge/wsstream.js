'use strict';

/**
 * A WebSocket carrying a plain byte stream: binary frames in, binary frames
 * out, exposed as a Duplex so TLS can run straight over it.
 *
 * WebSocket (rather than a raw socket) is only there so the bridge passes
 * through anything that passes the dashboard: nginx, Caddy, Cloudflare
 * Tunnel. Unlike core/ws.js this one streams, honours backpressure both ways
 * and supports half-close, which the tunnel needs.
 */

const crypto = require('crypto');
const { Duplex } = require('stream');

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F';
const MAX_FRAME = 1024 * 1024;
const OUT_CHUNK = 64 * 1024;
const PING_EVERY_MS = 25_000;
const DEAD_AFTER_MS = 80_000; // nothing at all (not even a pong) for this long: the peer is gone
const PROTOCOL = 'gamepanel-bridge.v1';

/** Complete the HTTP upgrade. Returns false (and closes) on a bad request. */
function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return false;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      (offered.includes(PROTOCOL) ? `Sec-WebSocket-Protocol: ${PROTOCOL}\r\n` : '') +
      '\r\n'
  );
  return true;
}

class WsStream extends Duplex {
  constructor(socket, head) {
    super({ allowHalfOpen: true });
    this.socket = socket;
    this._buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this._closeSent = false;
    this._gotEnd = false;

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    this._heard = Date.now();
    socket.on('data', (chunk) => {
      this._heard = Date.now();
      this._onData(chunk);
    });
    socket.on('end', () => this._eof());
    socket.on('error', (err) => this.destroy(err));
    socket.on('close', () => {
      this._eof();
      if (!this.destroyed) this.destroy();
    });

    // Keeps idle tunnels alive through proxies that drop quiet connections.
    this._pinger = setInterval(() => {
      if (Date.now() - this._heard > DEAD_AFTER_MS) return this.destroy();
      this._frame(0x9, Buffer.alloc(0));
    }, PING_EVERY_MS);
    this._pinger.unref?.();
    if (this._buf.length) setImmediate(() => this._onData(Buffer.alloc(0)));
  }

  _eof() {
    if (this._gotEnd) return;
    this._gotEnd = true;
    this.push(null);
  }

  _onData(chunk) {
    if (chunk.length) this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (!this.destroyed) {
      const buf = this._buf;
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80;
      const opcode = buf[0] & 0x0f;
      if (!(buf[1] & 0x80)) return this._fail('client frames must be masked');
      let size = buf[1] & 0x7f;
      let at = 2;
      if (size === 126) {
        if (buf.length < 4) return;
        size = buf.readUInt16BE(2);
        at = 4;
      } else if (size === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return this._fail('frame too large');
        size = Number(big);
        at = 10;
      }
      if (size > MAX_FRAME) return this._fail('frame too large');
      if (buf.length < at + 4 + size) return;
      const mask = buf.subarray(at, at + 4);
      const payload = Buffer.from(buf.subarray(at + 4, at + 4 + size));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this._buf = buf.subarray(at + 4 + size);

      if (opcode === 0x2 || opcode === 0x0) {
        if (payload.length && !this._gotEnd && !this.push(payload)) this.socket.pause();
      } else if (opcode === 0x8) {
        this._eof();
        this._sendClose();
        this.socket.end();
        return;
      } else if (opcode === 0x9) {
        if (!fin || size > 125) return this._fail('bad ping');
        this._frame(0xa, payload);
      } else if (opcode === 0xa) {
        /* pong: nothing to do */
      } else {
        return this._fail('unexpected frame');
      }
    }
  }

  _fail(reason) {
    this.destroy(new Error(`bridge websocket: ${reason}`));
  }

  _frame(opcode, payload, cb) {
    if (this.socket.destroyed || this._closeSent) {
      cb?.();
      return true;
    }
    const n = payload.length;
    const header = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (n >= 126 && n < 65536) {
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(n, 2);
    } else if (n >= 65536) {
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(n), 2);
    }
    this.socket.write(header);
    return this.socket.write(payload, cb);
  }

  _sendClose() {
    if (this._closeSent || this.socket.destroyed) return;
    this._frame(0x8, Buffer.from([0x03, 0xe8])); // 1000, normal closure
    this._closeSent = true;
  }

  _read() {
    if (this.socket.isPaused()) this.socket.resume();
  }

  _write(chunk, _enc, cb) {
    if (this.socket.destroyed || this._closeSent) return cb(new Error('bridge websocket is closed'));
    let ok = true;
    for (let i = 0; i < chunk.length; i += OUT_CHUNK) ok = this._frame(0x2, chunk.subarray(i, i + OUT_CHUNK));
    if (ok) cb();
    else this.socket.once('drain', () => cb());
  }

  // Half-close: our side is done sending, but the peer may still be talking.
  // The WebSocket closes once both directions are finished.
  _final(cb) {
    const finish = () => {
      this._sendClose();
      this.socket.end();
    };
    if (this._gotEnd) finish();
    else this.once('end', finish);
    cb();
  }

  _destroy(err, cb) {
    clearInterval(this._pinger);
    if (!this.socket.destroyed) {
      if (!err) this._sendClose();
      this.socket.destroy();
    }
    cb(err);
  }
}

module.exports = { acceptUpgrade, WsStream, PROTOCOL };
