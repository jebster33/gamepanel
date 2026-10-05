'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = path.join(os.tmpdir(), `gp-alerts-${process.pid}`);
const alerts = require('../../server/servers/alerts');
const worlds = require('../../server/servers/worlds');

test('resource alerts wait two minutes, then cool down', () => {
  const events = [];
  const rt = { status: 'running', cpu: 250, memory: 0, diskBytes: 0 };
  const server = { id: 's1', name: 'SMP', memory: 1024, alerts: alerts.cleanAlerts({ cpu: 200, memory: 90 }) };
  const m = Object.assign({ servers: [server], rt: () => rt, store: { addEvent: (type, msg) => events.push(msg) } }, alerts);
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    m.checkAlerts();
    now += 60_000;
    m.checkAlerts();
    assert.strictEqual(events.length, 0);
    now += 61_000;
    m.checkAlerts();
    assert.strictEqual(events.length, 1);
    assert.match(events[0], /CPU has been at 250%/);
    now += 5 * 60_000;
    m.checkAlerts();
    assert.strictEqual(events.length, 1); // still cooling down
    rt.memory = 1000 * 1024 * 1024;
    m.checkAlerts();
    now += 121_000;
    m.checkAlerts();
    assert.strictEqual(events.length, 2);
    assert.match(events.at(-1), /Memory has been at 98%/);
  } finally {
    Date.now = realNow;
  }
});

test('worlds: list, switch and reset with a new seed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-worlds-'));
  for (const w of ['world', 'world_nether', 'creative']) {
    fs.mkdirSync(path.join(dir, w));
    fs.writeFileSync(path.join(dir, w, 'level.dat'), 'x');
  }
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=hi\nlevel-name=world\nlevel-seed=\n');
  const server = { id: 's1', name: 'SMP', dir, templateId: 'minecraft-paper' };
  const m = Object.assign(
    { require: () => server, isActive: () => false, pushConsole() {}, store: { addEvent() {} } },
    worlds
  );
  const list = await m.listWorlds(server);
  assert.deepStrictEqual(list.worlds.map((w) => [w.name, w.active, w.dimensions]), [
    ['world', true, 2],
    ['creative', false, 1],
  ]);
  await m.useWorld('s1', 'creative');
  assert.match(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'), /^level-name=creative$/m);
  await m.resetWorld('s1', { name: 'world', seed: '42', backup: false });
  assert.ok(!fs.existsSync(path.join(dir, 'world')) && !fs.existsSync(path.join(dir, 'world_nether')));
  assert.match(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'), /^level-seed=42$/m);
  await assert.rejects(m.useWorld('s1', '../etc'), /World names/);
});
