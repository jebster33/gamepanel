'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-dos-data-'));
const wake = require('../../server/features/wake-on-join');
const { WebSocketConnection: WsConnection } = require('../../server/core/ws');

test('wake on join: a burst of 4000 status requests gets one reply and a closed socket', async () => {
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-dos-srv-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=Hi\n');
  fs.writeFileSync(path.join(dir, 'server-icon.png'), Buffer.alloc(60 * 1024, 1));
  const server = { id: 'dos', name: 'D', dir, templateId: 'minecraft-paper', installedAt: 1, wakeOnJoin: true, ports: { game: port }, ip: '127.0.0.1' };
  wake.start({ store: Object.assign(new EventEmitter(), { addEvent() {} }), manager: { servers: [server], rt: () => ({ status: 'offline' }), logActivity() {}, start: async () => {} } });
  await new Promise((r) => setTimeout(r, 200));
  const hs = wake.packet(0x00, wake.varint(767), wake.str('x'), Buffer.from([port >> 8, port & 0xff]), wake.varint(1));
  const burst = Buffer.concat([hs, ...Array.from({ length: 4000 }, () => wake.packet(0x00))]);
  const got = await new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    let bytes = 0;
    c.on('connect', () => c.write(burst));
    c.on('data', (d) => (bytes += d.length));
    c.on('close', () => resolve(bytes));
    setTimeout(() => c.destroy(), 2000);
  });
  assert.ok(got > 0 && got < 200 * 1024, `received ${got} bytes`);
  // A varint that never ends is dropped quietly, and the listener keeps answering.
  await new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    c.on('connect', () => c.write(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, 0x00])));
    c.on('close', resolve);
    setTimeout(() => c.destroy(), 1000);
  });
  assert.strictEqual(wake.view('dos').listening, true);
  server.wakeOnJoin = false;
  wake.sync();
});

test('websocket: endless zero-length continuation frames are cut off quickly', () => {
  const frames = [];
  const sock = Object.assign(new EventEmitter(), { write: (b) => frames.push(b), end() {}, destroy() { this.destroyed = true; }, setNoDelay() {}, setTimeout() {}, setKeepAlive() {} });
  const conn = new WsConnection(sock, {});
  const closes = [];
  conn.close = (code) => closes.push(code);
  conn._handleFrame({ opcode: 0x1, fin: false, payload: Buffer.alloc(0) });
  const t = Date.now();
  for (let i = 0; i < 40_000; i++) {
    conn._handleFrame({ opcode: 0x0, fin: false, payload: Buffer.alloc(0) });
    if (closes.length) break;
  }
  assert.ok(closes.includes(1002), 'closed for bad fragments');
  assert.ok(Date.now() - t < 500, 'did not spin');
  const loose = new WsConnection(sock, {});
  const c2 = [];
  loose.close = (code) => c2.push(code);
  loose._handleFrame({ opcode: 0x0, fin: true, payload: Buffer.from('x') });
  assert.deepStrictEqual(c2, [1002], 'a continuation with nothing before it');
});
