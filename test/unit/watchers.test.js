'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const watchers = require('../../server/servers/watchers');

const { newestMatch, portBound } = watchers._internal;

test('newest log file wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-tail-'));
  fs.mkdirSync(path.join(dir, 'Logs'));
  fs.writeFileSync(path.join(dir, 'Logs', 'old.log'), 'a');
  fs.utimesSync(path.join(dir, 'Logs', 'old.log'), new Date(1000), new Date(1000));
  fs.writeFileSync(path.join(dir, 'Logs', 'new.log'), 'b');
  fs.writeFileSync(path.join(dir, 'Logs', 'other.txt'), 'c');
  assert.strictEqual(path.basename(newestMatch(dir, 'Logs/*.log')), 'new.log');
  assert.strictEqual(newestMatch(dir, 'Logs/missing.log'), null);
  assert.throws(() => newestMatch(dir, '../outside/*.log'));
});

test('tailing follows new lines only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-tail-'));
  const file = path.join(dir, 'console.log');
  fs.writeFileSync(file, 'from last boot\n');
  fs.utimesSync(file, new Date(1000), new Date(1000));
  const out = [];
  const fake = { vars: () => ({}) };
  const stop = watchers.tailLogs.call(fake, { dir }, { tailFiles: ['console.log'] }, (buf) => out.push(buf.toString()));
  await new Promise((r) => setTimeout(r, 1200));
  fs.appendFileSync(file, 'Server ready\n');
  stop();
  assert.deepStrictEqual(out, ['Server ready\n']);
});

test('port probe sees bound tcp and udp ports', async () => {
  const srv = net.createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  assert.strictEqual(await portBound(srv.address().port, 'tcp'), true);
  const port = srv.address().port;
  srv.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(await portBound(port, 'tcp'), false);

  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, r));
  assert.strictEqual(await portBound(sock.address().port, 'udp'), true);
  sock.close();
});
