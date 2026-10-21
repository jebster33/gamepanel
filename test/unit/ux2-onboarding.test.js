'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const onboarding = require('../../server/features/onboarding');

async function loadCore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ux2-'));
  const file = path.join(dir, 'core.mjs');
  fs.copyFileSync(path.join(__dirname, '../../public/js/ui/onboarding-core.js'), file);
  return import(pathToFileURL(file).href);
}

test('tour steps skip hidden targets and stop at the ends', async () => {
  const core = await loadCore();
  const steps = core.pickSteps(core.PANEL_STEPS, (sel) => !sel.includes('nodes'));
  assert.strictEqual(steps.length, core.PANEL_STEPS.length - 1);
  assert.strictEqual(core.stepAfter(0, -1, 5), 0);
  assert.strictEqual(core.stepAfter(2, 1, 5), 3);
  assert.strictEqual(core.stepAfter(4, 1, 5), 'done');
});

test('checklist progress and auto-open', async () => {
  const core = await loadCore();
  const items = [{ id: 'a', done: true }, { id: 'b', done: false, label: 'B' }];
  assert.deepStrictEqual(core.progress(items), { done: 1, total: 2, percent: 50, next: items[1] });
  assert.strictEqual(core.shouldAutoOpen({ items, hidden: false }), true);
  assert.strictEqual(core.shouldAutoOpen({ items, hidden: true }), false);
  assert.strictEqual(core.shouldAutoOpen({ items: [items[0]], hidden: false }), false);
});

test('tips cover the newer server types and fall back for unknown ones', async () => {
  const core = await loadCore();
  for (const id of ['rust', 'ark-survival-ascended', 'cs2', 'palworld', 'minecraft-velocity', 'minecraft-bedrock', 'minecraft-paper', 'project-zomboid', 'valheim']) {
    assert.ok(core.tipsFor(id).tips.length >= 3, id);
    assert.notStrictEqual(core.tipsFor(id).title, 'Your server', id);
  }
  assert.strictEqual(core.tipsFor('counter-strike-source').title, 'Source-engine game');
  assert.strictEqual(core.tipsFor('something-new').title, 'Your server');
});

function fakeApp(users, servers = []) {
  return {
    store: { state: { settings: {}, events: [] }, save() {} },
    manager: { servers, isActive: () => false },
    auth: {
      users,
      can: (u, cap) => u.role === 'admin' || (u.permissions || []).includes(cap),
      canAccessServer: (u, id) => u.role === 'admin' || (u.servers || []).includes(id),
    },
  };
}

test('checklist is per account: manual marks, auto ticks and role filtering', () => {
  const admin = { id: '1', role: 'admin', username: 'a' };
  const friend = { id: '2', role: 'user', username: 'f', permissions: ['console'] };
  const app = fakeApp([admin, friend]);
  let v = onboarding.view(app, admin);
  assert.ok(v.items.some((i) => i.id === 'staff' && i.done)); // two accounts exist
  assert.ok(v.items.some((i) => i.id === 'discord' && !i.done));
  assert.deepStrictEqual(onboarding.view(app, friend).items.map((i) => i.id), ['2fa', 'tour']);
  v = onboarding.update(app, admin, { id: 'discord', done: true });
  assert.strictEqual(v.items.find((i) => i.id === 'discord').skipped, true);
  assert.strictEqual(onboarding.view(app, friend).items.find((i) => i.id === '2fa').done, false);
  v = onboarding.update(app, admin, { id: 'discord', done: false });
  assert.strictEqual(v.items.find((i) => i.id === 'discord').done, false);
  onboarding.update(app, admin, { id: '../x', done: true });
  assert.strictEqual(admin.onboarding.done['../x'], undefined);
  assert.strictEqual(onboarding.update(app, admin, { tourDone: true }).tourDone, true);
  assert.strictEqual(onboarding.reset(app, admin).tourDone, false);
});
