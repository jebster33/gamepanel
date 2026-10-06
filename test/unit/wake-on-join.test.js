'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-wake-data-'));
const wake = require('../../server/features/wake-on-join');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** Connect, send packets, collect every packet the panel answers until it hangs up. */
function talk(port, packets) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    c.on('connect', () => c.write(Buffer.concat(packets)));
    c.on('data', (d) => (buf = Buffer.concat([buf, d])));
    c.on('close', () => resolve(wake.takePackets(buf).packets));
    c.on('error', reject);
    setTimeout(() => c.destroy(), 3000);
  });
}

const handshake = (port, next) => wake.packet(0x00, wake.varint(767), wake.str('localhost'), Buffer.from([port >> 8, port & 0xff]), wake.varint(next));
const text = (p) => JSON.parse(p.data.subarray(wake.readVarint(p.data, 0)[1]).toString('utf8'));

test('a sleeping server answers pings and starts when an allowed player joins', async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-wake-srv-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=Castle SMP\nmax-players=40\nwhite-list=false\n');
  fs.writeFileSync(path.join(dir, 'banned-players.json'), JSON.stringify([{ name: 'Griefer' }]));
  const server = { id: 'mc', name: 'Castle', dir, templateId: 'minecraft-paper', installedAt: 1, wakeOnJoin: true, ports: { game: port }, ip: '127.0.0.1' };
  const rt = { status: 'offline' };
  const started = [];
  const store = Object.assign(new EventEmitter(), { addEvent: () => {} });
  const manager = {
    servers: [server],
    rt: () => rt,
    logActivity: () => {},
    start: async (id) => {
      await wake.release(id);
      started.push(id);
      rt.status = 'starting';
    },
  };
  wake.start({ store, manager });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(wake.view('mc').listening, true);

  // Server list ping.
  const ping = await talk(port, [handshake(port, 1), wake.packet(0x00), wake.packet(0x01, Buffer.from('12345678'))]);
  const status = text(ping[0]);
  assert.strictEqual(status.players.max, 40);
  assert.strictEqual(status.version.protocol, 767);
  assert.match(status.description.text, /Castle SMP\n.*wake it up/);
  assert.strictEqual(ping[1].id, 0x01);
  assert.strictEqual(ping[1].data.toString(), '12345678');
  assert.deepStrictEqual(started, []);

  // A banned player is turned away and does not wake it.
  const banned = await talk(port, [handshake(port, 2), wake.packet(0x00, wake.str('Griefer'))]);
  assert.match(text(banned[0]).text, /banned/);
  assert.deepStrictEqual(started, []);

  // With the whitelist on, only whitelisted players wake it.
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=Castle SMP\nwhite-list=true\n');
  fs.writeFileSync(path.join(dir, 'whitelist.json'), JSON.stringify([{ name: 'Alex' }]));
  const stranger = await talk(port, [handshake(port, 2), wake.packet(0x00, wake.str('Steve'))]);
  assert.match(text(stranger[0]).text, /not whitelisted/);

  const alex = await talk(port, [handshake(port, 2), wake.packet(0x00, wake.str('Alex'))]);
  assert.match(text(alex[0]).text, /starting up for you/);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(started, ['mc']);
  assert.strictEqual(wake.view('mc').listening, false, 'the port is free for the game');
  assert.strictEqual(wake.view('mc').by, 'Alex');

  // Junk is dropped, and turning the option off stops listening.
  rt.status = 'offline';
  wake.sync();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(await talk(port, [Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])]), []);
  assert.strictEqual(wake.view('mc').listening, true);
  server.wakeOnJoin = false;
  wake.sync();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(wake.view('mc').listening, false);
});
