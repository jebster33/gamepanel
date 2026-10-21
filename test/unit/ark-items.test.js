'use strict';

const test = require('node:test');
const assert = require('node:assert');
const items = require('../../server/features/ark-items');

test('the catalog is searchable by name words', () => {
  assert.ok(items.catalog().items.length > 300);
  const metal = items.search({ query: 'metal ingot' });
  assert.ok(metal.items.some((i) => i.name === 'Metal Ingot'));
  assert.match(metal.items[0].path, /^\/Game\//);
  assert.strictEqual(items.search({ query: 'zzzz-nothing' }).total, 0);
  const rifle = items.search({ query: 'rifle', category: 'Weapons' });
  assert.ok(rifle.items.length && rifle.items.every((i) => i.category === 'Weapons'));
});

test('give commands are built from checked fields, with quality tiers or a number', () => {
  const path = items.search({ query: 'metal ingot' }).items.find((i) => i.name === 'Metal Ingot').path;
  const a = items.build({ playerId: '12345', path, quantity: 100, tier: 'ascended', blueprint: false });
  assert.strictEqual(a.command, `GiveItemToPlayer 12345 "Blueprint'${path}.${path.split('/').pop()}'" 100 5 0`);
  assert.strictEqual(a.send, true);
  assert.match(items.build({ playerId: 1, path, quality: 700, blueprint: true }).command, / 1 700 1$/);
  assert.match(items.build({ style: 'GiveItemNumToPlayer', playerId: 9, itemNum: 12, quantity: 2, tier: 'primitive' }).command, /^GiveItemNumToPlayer 9 12 2 0 0$/);
  assert.strictEqual(items.build({ style: 'giveitem', path, quantity: 1 }).send, false);
});

test('give commands refuse anything that is not a plain field', () => {
  const path = items.search({ query: 'metal ingot' }).items[0].path;
  assert.throws(() => items.build({ playerId: '1; quit', path }), /Player ID/);
  assert.throws(() => items.build({ playerId: 1, path: '/Game/Evil" ; quit' }), /Pick an item/);
  assert.throws(() => items.build({ playerId: 1, path: '/Game/Mods/Thing/Item', custom: false }), /Pick an item/);
  assert.match(items.build({ playerId: 1, path: '/Game/Mods/Thing/Item', custom: true }).command, /Blueprint'\/Game\/Mods\/Thing\/Item\.Item'/);
  assert.throws(() => items.build({ playerId: 1, path: '/Game/A/B"; x', custom: true }), /Pick an item/);
  assert.throws(() => items.build({ playerId: 1, path, quantity: 0 }), /Quantity/);
  assert.throws(() => items.build({ playerId: 1, path, quantity: 1.5 }), /Quantity/);
  assert.throws(() => items.build({ playerId: 1, path, quality: 'high' }), /Quality/);
  assert.throws(() => items.build({ playerId: 1, path, tier: 'godly' }), /tier/);
  assert.throws(() => items.build({ style: 'quit', playerId: 1, path }), /style/);
});
