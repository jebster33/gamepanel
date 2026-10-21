'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('forced wipe is the first Thursday at 19:00 UTC', () => {
  const c = require('../../server/features/calendar');
  assert.strictEqual(new Date(c.forcedWipe(2026, 9)).toISOString(), '2026-10-01T19:00:00.000Z');
  const next = c.nextForcedWipes(Date.UTC(2026, 9, 21), 2).map((t) => new Date(t).toISOString());
  assert.deepStrictEqual(next, ['2026-11-05T19:00:00.000Z', '2026-12-03T19:00:00.000Z']);
});

test('cpu pinning parses, formats and plans', () => {
  const p = require('../../server/features/cpu-pin');
  assert.deepStrictEqual(p.parse('0-2,5', 8), [0, 1, 2, 5]);
  assert.deepStrictEqual(p.parse('6-9', 8), [6, 7]);
  assert.strictEqual(p.format([0, 1, 2, 5]), '0-2,5');
  const plan = p.autoPlan([{ id: 'a', cpuAffinity: 'auto' }, { id: 'b', cpuAffinity: 'auto' }], 8);
  assert.notStrictEqual(plan.a, plan.b);
});

test('log explainer recognises common failures', () => {
  const l = require('../../server/features/log-explain');
  assert.strictEqual(l.explain('java.lang.OutOfMemoryError: Java heap space').id, 'oom');
});

test('flame graph parses thread dumps into a tree', () => {
  const f = require('../../server/features/flame');
  const dump = f.parseDump('"Server thread" #1 prio=5 tid=0x1 nid=0x2 runnable\n   java.lang.Thread.State: RUNNABLE\n\tat com.foo.Bar.baz(Bar.java:1)\n\tat net.minecraft.Server.run(S.java:2)\n');
  assert.strictEqual(dump[0].frames[0], 'com.foo.Bar.baz');
  const { tree, samples } = f.buildTree([dump, dump]);
  assert.strictEqual(samples, 2);
  assert.strictEqual(tree.value, 2);
  assert.strictEqual(f.hotPackages([dump])[0].pkg, 'com.foo.Bar');
});

test('minecraft tools: plugin.yml, versions and border input', () => {
  const m = require('../../server/features/mc-tools');
  assert.strictEqual(m.parsePluginYml("name: LuckPerms\nversion: '5.4.1'\n").version, '5.4.1');
  assert.strictEqual(m.newer('5.4.2', '5.4.1'), true);
  assert.strictEqual(m.newer('5.4.1', '5.4.1'), false);
  assert.strictEqual(m.cleanBorder({ size: 1000, centerX: 5 }).centerZ, 0);
  assert.throws(() => m.cleanBorder({ size: -1 }));
});

test('ARK settings diff finds changed values only', () => {
  const d = require('../../server/features/ark-ini-diff');
  const r = d.diff('GameUserSettings.ini', '[ServerSettings]\nXPMultiplier=3\nTamingSpeedMultiplier=1.0\nServerPVE=True\nFoo=1');
  assert.deepStrictEqual(r.changed.map((x) => x.key).sort(), ['ServerPVE', 'XPMultiplier']);
  assert.strictEqual(r.matching, 1);
  assert.strictEqual(r.unknown.length, 1);
});

test('game kits: Valheim modifiers, DayZ loot, FiveM resources', () => {
  const k = require('../../server/features/game-kits');
  assert.strictEqual(k.modifierArgs({ modifiers: { combat: 'hard' }, keys: ['nomap'] }), '-modifier combat hard -setkey nomap');
  assert.throws(() => k.modifierArgs({ modifiers: { combat: 'hard; rm -rf' } }));
  assert.throws(() => k.modifierArgs({ keys: ['x y'] }));
  assert.deepStrictEqual(k.parseModifierArgs('-modifier combat hard -setkey nomap'), { modifiers: { combat: 'hard' }, keys: ['nomap'] });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-kits-'));
  try {
    fs.mkdirSync(path.join(dir, 'mpmissions/m/db'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mpmissions/m/db/types.xml'), '<types><type name="Apple">\n<nominal>40</nominal><min>10</min></type></types>');
    const dayz = { templateId: 'dayz', dir, vars: { MISSION: 'm' } };
    const out = k.dayzSetType(dayz, 'Apple', { nominal: 99, lifetime: 5 });
    assert.strictEqual(out.nominal, 99);
    assert.strictEqual(out.lifetime, 5);
    assert.strictEqual(out.min, 10);
    assert.throws(() => k.dayzSetType(dayz, 'Apple', { nominal: 'lots' }));

    fs.mkdirSync(path.join(dir, 'server-data/resources/[x]/foo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server-data/resources/[x]/foo/fxmanifest.lua'), 'author "Me"\nversion "1.0"');
    fs.writeFileSync(path.join(dir, 'server-data/server.cfg'), 'ensure foo\n');
    const fivem = { templateId: 'fivem', dir, vars: {} };
    assert.strictEqual(k.fivemResources(fivem).items[0].enabled, true);
    assert.strictEqual(k.fivemToggle(fivem, 'foo', false).items[0].enabled, false);
    assert.strictEqual(k.fivemToggle(fivem, 'foo', true).items[0].enabled, true);
    assert.throws(() => k.fivemToggle(fivem, '../etc', true));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('game kits: Reforger mods are validated', () => {
  const k = require('../../server/features/game-kits');
  const vars = {};
  const manager = { update: (id, patch) => Object.assign(vars, patch.vars) };
  const server = { id: 's', templateId: 'arma-reforger', vars };
  const out = k.reforgerSet(manager, server, { mods: [{ modId: '591af5bda9f7ce8b', name: 'Good "mod"' }] });
  assert.strictEqual(out.mods[0].modId, '591AF5BDA9F7CE8B');
  assert.throws(() => k.reforgerSet(manager, server, { mods: [{ modId: 'nope' }] }));
  assert.throws(() => k.reforgerSet(manager, server, { scenario: 'x"; rm' }));
});

test('file search honours globs', () => {
  const f = require('../../server/features/file-search');
  assert.ok(f.globToRegex('*.yml').test('config.yml'));
  assert.ok(!f.globToRegex('*.yml').test('config.json'));
});
