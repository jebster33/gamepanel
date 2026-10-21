'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-community-data-'));
const portal = require('../../server/features/portal');
const welcome = require('../../server/features/welcome');
const leaderboards = require('../../server/features/leaderboards');
const statusPage = require('../../server/features/status-page');
const { Auth } = require('../../server/core/auth');

function world() {
  const store = { state: { users: [], settings: { statusPage: { enabled: true, slug: 'abc', servers: ['s1', 's2'], showPlayers: true } } }, save() {}, addEvent() {} };
  const servers = [
    { id: 's1', name: 'Survival', templateId: 'minecraft', dir: os.tmpdir() },
    { id: 's2', name: 'Arena', templateId: 'cs2', dir: os.tmpdir() },
  ];
  const players = {
    s1: [
      { name: 'Alex', seconds: 7200, sessions: 4, first: 1000, last: 5000, online: true },
      { name: 'Bo', seconds: 3600, sessions: 9, first: 1000, last: 4000, online: false },
    ],
    s2: [{ name: 'alex', seconds: 3600, sessions: 2, first: 1000, last: 3000, online: false }],
  };
  const logs = { s1: [{ t: 120_000 + 5000, type: 'join', name: 'Alex' }, { t: 1, type: 'chat', name: 'Alex', text: 'secret' }, { t: 300_000, type: 'leave', name: 'Bo' }], s2: [] };
  const sent = [];
  const props = {};
  const manager = {
    store,
    servers,
    rt: () => ({ status: 'running', players: 3 }),
    template: (s) => ({ name: s.templateId === 'cs2' ? 'Counter-Strike 2' : 'Minecraft', wipe: false }),
    playerHistory: (id) => ({ players: players[id] }),
    history: (id) => ({ log: logs[id], wipes: [] }),
    playerStats: (s, name) => (s.templateId === 'minecraft' && name === 'Bo' ? { deaths: 2, mobKills: 50, playerKills: 1, mined: 900, km: 12.5, advancements: 7 } : null),
    setProperties: (s, v) => Object.assign(props, v),
    sent,
    props,
  };
  return { store, manager, servers };
}

test('a name is linked by saying the code in chat, only by the right player', () => {
  const { store, manager, servers } = world();
  const a = portal.beginCode({ subject: 'discord:1' });
  assert.match(a.code, /^GP-[A-Z2-9]{6}$/);
  portal.onChat(manager, servers[0], 'Alex', `hello ${a.code.toLowerCase()} there`);
  assert.deepStrictEqual(store.state.portal.claims['discord:1'].map((c) => c.name), ['Alex']);
  // A used code does nothing twice.
  portal.onChat(manager, servers[0], 'Mallory', a.code);
  assert.strictEqual(store.state.portal.claims['discord:1'].length, 1);

  // Name sign-in: only that name may say the code.
  const b = portal.beginCode({ name: 'Bo' });
  assert.strictEqual(portal.codeStatus(store, b.ticket).state, 'waiting');
  portal.onChat(manager, servers[0], 'Mallory', b.code);
  assert.strictEqual(portal.codeStatus(store, b.ticket).state, 'waiting');
  portal.onChat(manager, servers[0], 'bo', b.code);
  const done = portal.codeStatus(store, b.ticket);
  assert.strictEqual(done.state, 'verified');
  assert.strictEqual(done.subject, 'name:bo');
  assert.strictEqual(portal.codeStatus(store, b.ticket).state, 'expired', 'handed over once');
  assert.throws(() => portal.beginCode({ name: '"; rm -rf' }), /in-game name/);
});

test('codes expire', () => {
  const { store, manager, servers } = world();
  const now = Date.now();
  const a = portal.beginCode({ subject: 'steam:76561198000000001', now });
  portal.onChat(manager, servers[0], 'Alex', a.code, now + 11 * 60_000);
  assert.ok(!store.state.portal?.claims['steam:76561198000000001']);
  assert.strictEqual(portal.codeStatus(store, a.ticket, now + 11 * 60_000).state, 'expired');
});

test('the portal shows a player only their own data, and no admin fields', () => {
  const { store, manager } = world();
  store.state.bans = { list: [{ id: 'b1', name: 'Bo', reason: 'Griefing', by: 'admin-person', at: 10, until: null }, { id: 'b2', name: 'Other', reason: 'x', by: 'admin-person', at: 10 }], appeals: [{ id: 'a1', banId: 'b1', status: 'denied', reply: 'No.', at: 20, contact: 'secret@example.com', codeHash: 'h', message: 'private' }] };
  store.state.portal = { claims: { 'steam:76561198000000001': [{ serverId: 's1', name: 'Bo', at: 1 }, { serverId: 'gone', name: 'Zed', at: 1 }] }, accounts: { 'steam:76561198000000001': 'Bo (7656)' } };
  const v = portal.viewFor(store, manager, 'steam:76561198000000001');
  assert.strictEqual(v.profiles.length, 1);
  assert.strictEqual(v.profiles[0].hours, 1);
  assert.strictEqual(v.profiles[0].stats.mobKills, 50);
  assert.deepStrictEqual(v.profiles[0].rank, { place: 2, of: 2 });
  assert.strictEqual(v.bans.length, 1);
  assert.deepStrictEqual(v.bans[0].appeal, { status: 'denied', reply: 'No.', at: 20 });
  const text = JSON.stringify(v);
  for (const secret of ['admin-person', 'secret@example.com', 'private', 'Other']) assert.ok(!text.includes(secret), `leaked ${secret}`);
  assert.deepStrictEqual(v.accounts.map((a) => a.kind), ['steam', 'game']);
});

test('portal sessions are signed and separate from panel sessions', () => {
  const { store } = world();
  const auth = new Auth(store, 'y'.repeat(40));
  const cookie = portal.cookieFor(auth, 'discord:42', 'Alex', false);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\/api\/portal/);
  const req = { headers: { cookie: cookie.split(';')[0] } };
  assert.deepStrictEqual(portal.sessionFrom(auth, req), { subject: 'discord:42', label: 'Alex' });
  assert.strictEqual(portal.sessionFrom(auth, { headers: { cookie: `${portal.COOKIE}=${cookie.split(';')[0].slice(portal.COOKIE.length + 1).slice(0, -3)}xyz` } }), null);
  // The portal cookie is not a panel session.
  assert.strictEqual(auth.userFromRequest(req), null);
  // A panel-signed token for something else is not a portal session.
  const other = auth.sign({ purpose: 'oauth', sub: 'discord:42', exp: Date.now() + 1000 });
  assert.strictEqual(portal.sessionFrom(auth, { headers: { cookie: `${portal.COOKIE}=${other}` } }), null);
});

test('welcome placeholders, first-time versus every join, and MOTD rotation', () => {
  const { manager, servers } = world();
  assert.strictEqual(welcome.expand('Hi {player} on {server}, {online} here ${&}', { player: 'Al', server: 'Survival', online: 3 }), 'Hi Al on Survival, 3 here ${&}');
  const s = servers[0];
  s.welcome = { enabled: true, message: 'Hey {player}, {online} online', mode: 'first' };
  assert.strictEqual(welcome.welcomeText(manager, s, 'Al', true), 'Hey Al, 3 online');
  assert.strictEqual(welcome.welcomeText(manager, s, 'Al', false), null);
  s.welcome.mode = 'every';
  assert.strictEqual(welcome.welcomeText(manager, s, 'Al', false), 'Hey Al, 3 online');

  const saved = welcome.save(manager, s, { motd: { enabled: true, messages: ['&aWelcome to {server}', 'Café {online} on'], everyMinutes: 1 } });
  assert.strictEqual(saved.motd.everyMinutes, 15, 'at least every 15 minutes');
  assert.strictEqual(manager.props.motd, '§aWelcome to Survival'.replace('§', '\\u00a7'));
  const now = Date.now();
  welcome.tick(manager, now + 60_000);
  assert.strictEqual(manager.props.motd, '\\u00a7aWelcome to Survival', 'not due yet');
  welcome.tick(manager, now + 16 * 60_000);
  assert.strictEqual(manager.props.motd, 'Caf\\u00e9 3 on');
  assert.throws(() => welcome.save(manager, servers[1], { motd: { enabled: true, messages: ['x'] } }), /Minecraft Java/);
});

test('leaderboards add names across servers, filter by game and offer game stats', () => {
  const { manager, servers } = world();
  const all = leaderboards.compute(manager, servers, {});
  assert.deepStrictEqual(all.games.map((g) => g.id), ['minecraft', 'cs2']);
  assert.strictEqual(all.rows[0].name, 'Alex');
  assert.strictEqual(all.rows[0].value, 3, '2h + 1h across two servers');
  assert.strictEqual(all.rows[0].servers, 2);
  const cs = leaderboards.compute(manager, servers, { game: 'cs2' });
  assert.deepStrictEqual(cs.metrics.map((m) => m.id), ['playtime', 'sessions']);
  const mc = leaderboards.compute(manager, servers, { game: 'minecraft', metric: 'mobKills' });
  assert.deepStrictEqual(mc.rows.map((r) => [r.name, r.value]), [['Bo', 50]]);
  assert.strictEqual(leaderboards.compute(manager, servers, { metric: 'nope' }).metric, 'playtime');
});

test('the join feed is off by default, names only, and never leaks chat', () => {
  const { store, manager } = world();
  assert.strictEqual(statusPage.joinFeed(store, manager), undefined);
  statusPage.update(store, { showFeed: true });
  const feed = statusPage.joinFeed(store, manager);
  assert.deepStrictEqual(feed.map((e) => [e.type, e.name, e.server]), [['leave', 'Bo', 'Survival'], ['join', 'Alex', 'Survival']]);
  assert.ok(feed.every((e) => Object.keys(e).sort().join() === 'name,server,t,type'));
  statusPage.update(store, { showPlayers: false });
  assert.strictEqual(statusPage.joinFeed(store, manager), undefined);
  assert.strictEqual(statusPage.publicServers(store, manager, 'wrong'), null);
});
