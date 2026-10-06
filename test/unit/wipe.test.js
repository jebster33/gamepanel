'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = path.join(os.tmpdir(), `gp-wipe-${process.pid}`);
const { wipe, plan, glob } = require('../../server/features/wipe');
const { nextRun } = require('../../server/features/scheduler');

const rust = JSON.parse(fs.readFileSync(path.join(__dirname, '../../templates/rust.json'), 'utf8'));

function fakeManager(server) {
  let active = true;
  const calls = [];
  return {
    calls,
    store: { save() {} },
    template: () => rust,
    isActive: () => active,
    stop: async () => {
      calls.push('stop');
      active = false;
    },
    start: async () => {
      calls.push('start');
      active = true;
    },
    updateGame: async () => calls.push('update'),
    update: (id, patch) => Object.assign(server.vars, patch.vars),
  };
}

test('glob matches whole file names only', () => {
  assert.ok(glob('*.sav').test('proc_4500_1337.sav'));
  assert.ok(glob('*.sav.*').test('proc_4500_1337.sav.1'));
  assert.ok(!glob('*.sav').test('proc.sav.1'));
  assert.ok(!glob('player.blueprints.*.db').test('player.states.5.db'));
});

test('a wipe deletes the map and, when asked, blueprints; nothing else', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-rust-'));
  const save = path.join(dir, 'server', 'gamepanel');
  fs.mkdirSync(path.join(save, 'cfg'), { recursive: true });
  for (const f of ['proc_4500_1337.map', 'proc_4500_1337.sav', 'proc_4500_1337.sav.1', 'player.states.248.db', 'sv.files.0.db', 'player.blueprints.5.db', 'player.identities.5.db']) {
    fs.writeFileSync(path.join(save, f), 'x');
  }
  fs.writeFileSync(path.join(save, 'cfg', 'server.cfg'), 'keep');
  const server = { id: 'r1', dir, vars: { WORLD_SEED: 1337 } };
  const m = fakeManager(server);

  assert.strictEqual(plan(m, server).files.length, 5);
  assert.strictEqual(plan(m, server, { blueprints: true }).files.length, 6);

  const lines = [];
  const r = await wipe(m, server, { newSeed: true, updateFirst: true }, (l) => lines.push(l));
  assert.strictEqual(r.deleted, 5);
  assert.deepStrictEqual(m.calls, ['stop', 'update', 'start']);
  assert.ok(fs.existsSync(path.join(save, 'player.blueprints.5.db')));
  assert.ok(fs.existsSync(path.join(save, 'player.identities.5.db')));
  assert.ok(fs.existsSync(path.join(save, 'cfg', 'server.cfg')));
  assert.notStrictEqual(server.vars.WORLD_SEED, 1337);
  assert.strictEqual(server.lastWipe.seed, r.seed);

  const r2 = await wipe(m, server, { blueprints: true });
  assert.strictEqual(r2.deleted, 1);
  assert.ok(!fs.existsSync(path.join(save, 'player.blueprints.5.db')));
  assert.strictEqual(r2.seed, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('games without a wipe spec refuse', async () => {
  const server = { id: 'x', dir: os.tmpdir(), vars: {} };
  const m = { ...fakeManager(server), template: () => ({}) };
  await assert.rejects(() => wipe(m, server), /no wipe/);
});

test('"first Thursday of the month" lands in days 1 to 7', () => {
  const from = new Date(2026, 9, 6, 12, 0); // Tue 6 Oct 2026
  const next = new Date(nextRun('0 19 * * 4', from, { firstOfMonth: true }));
  assert.strictEqual(next.getDay(), 4);
  assert.ok(next.getDate() <= 7);
  assert.strictEqual(next.getMonth(), 10); // 1 Oct was the first Thursday, so November
  assert.strictEqual(next.getDate(), 5);
});
