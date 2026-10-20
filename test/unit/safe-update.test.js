'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = path.join(os.tmpdir(), `gp-safeupd-${process.pid}`);
const safe = require('../../server/features/safe-update');
const backups = require('../../server/features/backups');
const { ServerManager } = require('../../server/servers/manager');

const fakeManager = (server) => {
  const events = [];
  return {
    rt: () => ({}),
    setTask() {},
    pushConsole() {},
    checkDiskRoom() {},
    isActive: () => false,
    store: { save() {}, addEvent: (...e) => events.push(e) },
    events,
  };
};

test('a snapshot can be rolled back by hand, removing what was added since', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-srv-'));
  fs.writeFileSync(path.join(dir, 'game.bin'), 'v1');
  const server = { id: `s${process.pid}`, name: 'Test', dir };
  const m = fakeManager(server);

  await safe.snapshot(m, server, 'game', 'chris');
  assert.strictEqual(safe.view(server).exists, true);
  // The "update" changes a file and adds one.
  fs.writeFileSync(path.join(dir, 'game.bin'), 'v2');
  fs.writeFileSync(path.join(dir, 'new.bin'), 'x');

  // The snapshot survives pruning.
  assert.deepStrictEqual(backups.prune(server.id, 1, [server.safeUpdate.backup]), []);

  const result = await safe.rollback(m, server, 'chris');
  assert.ok(result.ok);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'game.bin'), 'utf8'), 'v1');
  assert.ok(!fs.existsSync(path.join(dir, 'new.bin')));
  assert.strictEqual(server.safeUpdate, null);
  await assert.rejects(safe.rollback(m, server, 'chris'), /no snapshot/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings text leaves out secret variables', () => {
  const secrets = require('../../server/core/secrets');
  const m = Object.create(ServerManager.prototype);
  m.template = () => ({ variables: [{ name: 'STEAM_PASS', secret: true }, { name: 'MOTD' }] });
  const text = m.settingsText({ name: 'A', ports: { game: 25565 }, vars: { STEAM_PASS: secrets.seal('hunter2'), MOTD: 'hi', SEALED: secrets.seal('x') } });
  const data = JSON.parse(text);
  assert.deepStrictEqual(data.vars, { MOTD: 'hi' });
  assert.ok(!text.includes('hunter2') && !text.includes('enc:v1'));
  assert.strictEqual(data.ports.game, 25565);
});
