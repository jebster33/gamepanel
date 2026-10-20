'use strict';

const test = require('node:test');
const assert = require('node:assert');
const levels = require('../../server/features/ark-levels');
const G = require('../../server/features/ark-gameini');

const INI = ['[ServerSettings]', 'Foo=1', '', '[/script/shooter.shootergamemode]', 'MatingIntervalMultiplier=0.5', 'OverridePlayerLevelEngramPoints=1', 'OverridePlayerLevelEngramPoints=2', '', '[Other]', 'OverridePlayerLevelEngramPoints=9', ''].join('\r\n');

test('the calculator makes a rising ramp that ends on the target', () => {
  const ramp = levels.generateRamp({ cap: 150, firstXp: 5, finalXp: 9000000, curve: 2.4 });
  assert.strictEqual(ramp.length, 149);
  assert.strictEqual(ramp[0], 5);
  assert.strictEqual(ramp.at(-1), 9000000);
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i] > ramp[i - 1]);
  assert.deepStrictEqual(levels.generateRamp({ cap: 2, firstXp: 7, finalXp: 7 }), [7]);
  assert.throws(() => levels.generateRamp({ cap: 5000 }), /between 2 and/);
  assert.throws(() => levels.generateRamp({ cap: 100, firstXp: 5, finalXp: 50 }), /at least/);
  assert.deepStrictEqual(levels.generatePoints({ cap: 6, perLevel: 10, bonusEvery: 3, bonus: 5 }), [10, 10, 15, 10, 10, 15]);
});

test('a level cap is written as ramps, max XP and engram points, replacing only its own lines', () => {
  const player = levels.generateRamp({ cap: 10, firstXp: 10, finalXp: 1000 });
  const text = levels.apply(INI, {
    player: { ramp: player },
    dino: { ramp: levels.generateRamp({ cap: 5, finalXp: 500 }) },
    engramPoints: [8, 8, 9],
    engrams: [{ className: 'EngramEntry_Campfire_C', cost: 3, level: 2, hidden: false }],
    autoUnlocks: [{ className: 'EngramEntry_Spear_C', level: 1 }],
    onlyAllowSpecified: true,
  });
  assert.ok(text.includes('\r\n') && !/[^\r]\n/.test(text), 'keeps the file line endings');
  assert.match(text, /MatingIntervalMultiplier=0\.5/);
  assert.match(text, /\[Other\]\r\nOverridePlayerLevelEngramPoints=9/); // another section is untouched
  assert.match(text, /OverrideMaxExperiencePointsPlayer=1000/);
  assert.match(text, /OverrideEngramEntries=\(EngramClassName="EngramEntry_Campfire_C",EngramHidden=False,EngramPointsCost=3,EngramLevelRequirement=2,RemoveEngramPreReq=False\)/);
  assert.strictEqual((text.match(/OverridePlayerLevelEngramPoints=/g) || []).length, 3 + 1);
  const back = levels.parse(text);
  assert.strictEqual(back.player.cap, 10);
  assert.deepStrictEqual(back.player.ramp, player);
  assert.strictEqual(back.dino.cap, 5);
  assert.deepStrictEqual(back.engramPoints, [8, 8, 9]);
  assert.deepStrictEqual(back.engrams[0], { className: 'EngramEntry_Campfire_C', hidden: false, cost: 3, level: 2, removePrereq: false });
  assert.deepStrictEqual(back.autoUnlocks, [{ className: 'EngramEntry_Spear_C', level: 1 }]);
  assert.strictEqual(back.onlyAllowSpecified, true);
  // Saving the parsed values again changes nothing.
  assert.strictEqual(levels.apply(text, back), text);
});

test('bad level and engram input is refused', () => {
  const ok = { ramp: [5, 10, 20] };
  assert.throws(() => levels.build({ player: { ramp: [5, 5] } }), /more XP/);
  assert.throws(() => levels.build({ dino: ok }), /player levels too/);
  assert.throws(() => levels.build({ player: ok, engrams: [{ className: 'x"; quit', cost: 1 }] }), /not an engram class/);
  assert.throws(() => levels.build({ player: ok, engrams: [{ raw: 'OverrideEngramEntries=(A=1)\nquit' }] }), /not valid/);
  assert.throws(() => levels.build({ player: { ramp: [5, 1e12] } }), /whole number/);
});

test('Game.ini lines are replaced in place, or added in a new section', () => {
  assert.strictEqual(G.replaceEntries('', ['A'], ['A=1'], 'S'), '[S]\nA=1\n');
  const t = G.replaceEntries('[S]\nA=1\nB=2\nA=3\n[T]\nA=9\n', ['A'], ['A=7', 'A=8'], 'S');
  assert.strictEqual(t, '[S]\nA=7\nA=8\nB=2\n[T]\nA=9\n');
  assert.deepStrictEqual(G.readEntries(t, ['a'], 's').map((e) => e.value), ['7', '8']);
  assert.deepStrictEqual(G.parseTuple('(A=1,B="x,y",C=(1,2),D=((E=1),(E=2)))').pairs.map(([k]) => k), ['A', 'B', 'C', 'D']);
  assert.strictEqual(G.parseTuple('(A=1'), null);
});
