'use strict';

/**
 * Minimal RFC 6455 WebSocket server.
 *
 * The panel only needs text frames, ping/pong and close, so instead of pulling
 * in a dependency (and forcing users through an npm install that can fail on a
 * fresh box) we speak the protocol directly.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { logger } = require('./util');

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F';

const OPCODE = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

const MAX_MESSAGE = 1024 * 1024; // 1 MiB is plenty for console commands

class WebSocketConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.alive = true;
    this.closed = false;
    this.subscriptions = new Set();
    this.user = null;

    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      logger.debug('ws socket error:', err.message);
      this._destroy();
    });
    socket.on('close', () => this._destroy());
  }

  _onData(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    // Parse as many complete frames as the buffer holds.
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (this.closed) break;
    }
  }

  _readFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_MESSAGE)) {
        this.close(1009, 'Message too large');
        return null;
      }
      len = Number(big);
      offset += 8;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (len > MAX_MESSAGE) {
      this.close(1009, 'Message too large');
      return null;
    }
    if (buf.length < offset + len) return null;

    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this._buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.PING:
        this._send(OPCODE.PONG, frame.payload);
        break;
      case OPCODE.PONG:
        this.alive = true;
        break;
      case OPCODE.CLOSE:
        this.close(1000, '');
        break;
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (frame.fin) {
          this._emitMessage(frame.opcode, frame.payload);
        } else {
          this._fragmentOpcode = frame.opcode;
          this._fragments = [frame.payload];
        }
        break;
      case OPCODE.CONT: {
        this._fragments.push(frame.payload);
        const total = this._fragments.reduce((n, b) => n + b.length, 0);
        if (total > MAX_MESSAGE) {
          this.close(1009, 'Message too large');
          return;
        }
        if (frame.fin) {
          const payload = Buffer.concat(this._fragments);
          const op = this._fragmentOpcode;
          this._fragments = [];
          this._fragmentOpcode = null;
          this._emitMessage(op, payload);
        }
        break;
      }
      default:
        this.close(1002, 'Unsupported opcode');
    }
  }

  _emitMessage(opcode, payload) {
    if (opcode !== OPCODE.TEXT) return; // binary uplink is not used
    const text = payload.toString('utf8');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return; // ignore malformed client frames
    }
    this.emit('message', data);
  }

  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (err) {
      logger.debug('ws write failed:', err.message);
      this._destroy();
    }
  }

  send(obj) {
    this._send(OPCODE.TEXT, Buffer.from(JSON.stringify(obj)));
  }

  ping() {
    this._send(OPCODE.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this._send(OPCODE.CLOSE, body);
    this._destroy();
  }

  _destroy() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
    this.emit('close');
  }
}

class WebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
    this._heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (!client.alive) {
          client.close(1001, 'Heartbeat timeout');
          continue;
        }
        client.alive = false;
        client.ping();
      }
    }, 30000);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return null;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    socket.setTimeout(0);

    const conn = new WebSocketConnection(socket, req);
    if (head && head.length) conn._onData(head);
    this.clients.add(conn);
    conn.on('close', () => this.clients.delete(conn));
    this.emit('connection', conn, req);
    return conn;
  }

  /** Send to every authenticated client subscribed to `topic`. */
  broadcast(topic, payload) {
    const message = { topic, ...payload };
    for (const client of this.clients) {
      if (!client.user) continue;
      if (client.subscriptions.has(topic) || client.subscriptions.has('*')) {
        client.send(message);
      }
    }
  }

  close() {
    clearInterval(this._heartbeat);
    for (const client of this.clients) client.close(1001, 'Server shutting down');
  }
}

module.exports = { WebSocketServer, WebSocketConnection };
