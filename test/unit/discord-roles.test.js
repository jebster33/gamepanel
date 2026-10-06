'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const roles = require('../../server/features/discord-roles');

const member = (id, roleIds, nick) => ({ user: { id, username: `user${id}` }, roles: roleIds, nick });

test('links: valid names only, one Discord account per name', () => {
  const store = { state: {}, save() {} };
  assert.strictEqual(roles.link(store, '1', 'Steve'), 'Steve');
  assert.throws(() => roles.link(store, '2', 'steve'), /already linked/);
  assert.throws(() => roles.link(store, '2', 'no spaces'), /not a Minecraft name/);
  assert.strictEqual(roles.link(store, '1', 'Steve2'), 'Steve2'); // relinking yourself is fine
  assert.strictEqual(roles.unlink(store, '1'), 'Steve2');
});

test('who should be whitelisted: role holders with a linked name (or a usable nickname)', () => {
  const store = { state: { discordLinks: { 1: { name: 'Steve' }, 2: { name: 'Alex' } } }, save() {} };
  const list = [member('1', ['r1']), member('2', ['r9']), member('3', ['r1'], 'Herobrine'), member('4', ['r1'], 'not valid!')];
  assert.deepStrictEqual([...roles.wanted(store, { roles: ['r1'], source: 'link' }, list).values()], ['Steve']);
  assert.deepStrictEqual([...roles.wanted(store, { roles: ['r1'], source: 'nickname' }, list).values()], ['Steve', 'Herobrine']);
});

test('sync adds role holders and removes only names it added', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-dw-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), 'online-mode=false\n');
  fs.writeFileSync(path.join(dir, 'whitelist.json'), JSON.stringify([{ uuid: 'x', name: 'HandAdded' }]));
  const server = { id: 'mc', name: 'SMP', dir, discordWhitelist: { enabled: true, guildId: '123456789012345678', roles: ['r1'], source: 'link' } };
  const manager = { template: () => ({ id: 'minecraft-paper', query: { type: 'minecraft' } }), rt: () => ({ status: 'offline' }), logActivity() {} };
  const store = { state: { discordLinks: { 1: { name: 'Steve' }, 2: { name: 'Alex' } } }, save() {}, addEvent() {} };
  const names = () => JSON.parse(fs.readFileSync(path.join(dir, 'whitelist.json'), 'utf8')).map((e) => e.name).sort();

  let r = await roles.syncServer(manager, store, server, [member('1', ['r1']), member('2', ['r1'])]);
  assert.deepStrictEqual(r.added.sort(), ['Alex', 'Steve']);
  assert.deepStrictEqual(names(), ['Alex', 'HandAdded', 'Steve']);

  // Alex loses the role: off the list. HandAdded was never ours: stays.
  r = await roles.syncServer(manager, store, server, [member('1', ['r1']), member('2', [])]);
  assert.deepStrictEqual(r.removed, ['Alex']);
  assert.deepStrictEqual(names(), ['HandAdded', 'Steve']);
  assert.deepStrictEqual(server.discordWhitelisted, ['Steve']);
  fs.rmSync(dir, { recursive: true, force: true });
});
