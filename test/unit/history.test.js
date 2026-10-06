'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = path.join(os.tmpdir(), `gp-history-${process.pid}`);
const history = require('../../server/servers/history');
const { offlineUuid } = require('../../server/games/player-lists');

test('player history records sessions, chat and restarts', () => {
  const rt = { status: 'offline', playerList: [], players: null };
  const m = Object.assign({ servers: [{ id: 's1' }], rt: () => rt }, history);
  m.observePlayers();
  rt.status = 'running';
  m.observePlayers();
  rt.playerList = ['Steve', 'Alex'];
  m.observePlayers();
  m.trackChat({ id: 's1' }, { query: { type: 'minecraft' } }, '[12:00:00] [Server thread/INFO]: <Steve> hello there');
  rt.playerList = ['Alex'];
  m.observePlayers();

  const types = m.activityLog('s1').entries.map((e) => `${e.type}:${e.name || ''}`);
  assert.deepStrictEqual(types, ['leave:Steve', 'chat:Steve', 'join:Alex', 'join:Steve', 'start:']);
  const { summary, players } = m.playerHistory('s1');
  assert.strictEqual(summary.unique, 2);
  assert.strictEqual(summary.online, 1);
  assert.strictEqual(players[0].name, 'Alex');
  assert.strictEqual(m.playerProfile('s1', 'Steve').recent.length, 1);
  assert.deepStrictEqual(m.activityLog('s1', { types: ['chat'], q: 'hello' }).entries.length, 1);
});

test('offline UUIDs match what Minecraft generates', () => {
  assert.strictEqual(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
});

test('sessions end when the account signs out everywhere', () => {
  const { Auth } = require('../../server/core/auth');
  const store = { state: { users: [] }, save() {}, addEvent() {} };
  const auth = new Auth(store, 'x'.repeat(32));
  auth.createUser({ username: 'chris', password: 'correct horse battery', role: 'admin' });
  const { token } = auth.login('chris', 'correct horse battery', '1.1.1.1');
  assert.ok(auth.userFromToken(token));
  auth.revokeSessions(auth.users[0].id);
  assert.strictEqual(auth.userFromToken(token), null);
  assert.throws(() => auth.setPassword(auth.users[0].id, 'password123'), /attackers try/);
  assert.throws(() => auth.setPassword(auth.users[0].id, 'chris-is-cool'), /username/);
});

test('an empty server stops after its idle limit', () => {
  const rt = { status: 'running', playerList: [], players: 0, startedAt: Date.now() - 3600_000 };
  let stopped = false;
  const server = { id: 's2', idleStopMinutes: 10 };
  const m = Object.assign(
    { servers: [server], rt: () => rt, template: () => ({}), pushConsole() {}, store: { addEvent() {} }, stop: async () => (stopped = true) },
    history
  );
  m.checkIdle(server, rt, 0, Date.now());
  assert.strictEqual(stopped, false);
  m.checkIdle(server, rt, 0, Date.now() + 11 * 60_000);
  assert.strictEqual(stopped, true);
});

test('world maps: Rust from size and seed, Valheim seed read from the .fwl file', () => {
  const maps = require('../../server/games/world-maps');
  assert.strictEqual(maps.worldMap({ templateId: 'rust', vars: { WORLD_SIZE: 4000, WORLD_SEED: 1337 } }).url, 'https://rustmaps.com/map/4000_1337');
  // How Valheim writes it: int32 length, int32 version, then 7-bit length-prefixed strings.
  const str = (s) => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)]);
  const body = Buffer.concat([Buffer.from([34, 0, 0, 0]), str('Dedicated'), str('HHcLC5acQt'), Buffer.from([0x39, 0x30, 0, 0])]);
  const fwl = Buffer.concat([Buffer.from([body.length, 0, 0, 0]), body]);
  assert.deepStrictEqual(maps.parseFwl(fwl), { name: 'Dedicated', seedName: 'HHcLC5acQt', seed: 12345 });
  assert.strictEqual(maps.worldMap({ templateId: 'satisfactory' }), null);
});
