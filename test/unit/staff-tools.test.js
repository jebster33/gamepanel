'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp, load } = require('./support/routes');
const staff = require('../../server/features/staff');

const PW = 'correct-horse-battery-9X!';

function setup() {
  const mc = { id: 'mc', name: 'SMP' };
  const manager = {
    servers: [mc],
    require: (id) => {
      if (id !== 'mc') throw Object.assign(new Error('Server not found'), { code: 404 });
      return mc;
    },
    template: () => ({}),
  };
  const app = makeApp({ manager });
  app.store.addEvent = () => {};
  app.auth.createUser({ username: 'boss', password: PW, role: 'admin' });
  const created = app.auth.createUser({ username: 'helper1', password: PW, role: 'user', servers: [], permissions: ['console'] });
  const admin = app.auth.users.find((u) => u.username === 'boss');
  const subRec = app.auth.users.find((u) => u.id === created.id);
  return { app, mc, admin, subRec };
}

test('activity: counts moderation per staff member, per day and week, from audit, bans and notes', () => {
  const { app } = setup();
  const now = Date.parse('2026-10-20T12:00:00Z');
  const audit = [
    { at: now - 1000, user: 'alice', action: 'players action (kick)', status: 200, details: { name: 'Bob' }, server: 'SMP' },
    { at: now - 2000, user: 'alice', action: 'create bans', status: 200 },
    { at: now - 3000, user: 'alice', action: 'create bans', status: 403 }, // refused: not counted
    { at: now - 86_400_000, user: 'carol', action: 'change players note', status: 200 },
    { at: now - 5000, user: 'carol', action: 'create backups', status: 200 }, // not moderation
  ];
  app.store.state.bans = { list: [{ name: 'Eve', by: 'dave', at: now - 9000 }], appeals: [] };
  const out = staff.summary({ store: app.store, auth: app.auth, now, auditList: () => audit });
  const alice = out.staff.find((p) => p.user === 'alice');
  assert.strictEqual(alice.total, 2);
  assert.deepStrictEqual(alice.kinds, { kick: 1, ban: 1 });
  assert.strictEqual(alice.days['2026-10-20'], 2);
  assert.strictEqual(alice.weeks['2026-10-19'], 2); // Monday
  assert.strictEqual(out.staff.find((p) => p.user === 'carol').kinds.note, 1);
  assert.strictEqual(out.staff.find((p) => p.user === 'dave').total, 1); // only in the ban list
});

test('reason templates: saved, validated, applied to a ban, and admin-only to change', async () => {
  const { app, admin, subRec } = setup();
  const { call } = load('staff', app);
  const asAdmin = { user: admin };
  const asSub = { user: subRec };
  const { template } = await call('POST', '/api/staff/reasons', { ...asAdmin, body: { name: 'Griefing', reason: 'Griefing is not allowed', hours: 24, appeal: 'Appeal at x.io' } });
  assert.strictEqual((await call('GET', '/api/staff/reasons', asSub)).templates.length, 1);
  await assert.rejects(() => call('POST', '/api/staff/reasons', { ...asSub, body: { name: 'x' } }), /administrator/i);
  await assert.rejects(() => call('POST', '/api/staff/reasons', { ...asAdmin, body: { name: 'griefing' } }), /already exists/);
  await assert.rejects(() => call('POST', '/api/staff/reasons', { ...asAdmin, body: { name: 'Long', hours: 99999 } }), /Duration/);
  const applied = staff.applyReason(app.store, { template: template.id });
  assert.strictEqual(applied.reason, 'Griefing is not allowed - Appeal at x.io');
  assert.strictEqual(applied.hours, 24);
  assert.strictEqual(staff.applyReason(app.store, { template: template.id, reason: 'Custom', hours: 2 }).hours, 2);
  assert.throws(() => staff.applyReason(app.store, { template: 'gone' }), /no longer/);
  await call('DELETE', `/api/staff/reasons/${template.id}`, { ...asAdmin, params: { id: template.id } });
  assert.strictEqual(staff.reasonList(app.store).length, 0);
});

test('role templates: defaults ship, can be changed and reset, and apply through serverPerms validation', async () => {
  const { app, admin, subRec } = setup();
  const { call } = load('staff', app);
  const ids = staff.roles(app.store).map((r) => r.id);
  assert.ok(['moderator', 'builder', 'helper'].every((id) => ids.includes(id)));
  await call('POST', `/api/servers/mc/access/${subRec.id}/role`, { user: admin, body: { role: 'moderator' } });
  assert.deepStrictEqual(subRec.serverPerms.mc, ['console', 'command', 'activity']);
  assert.ok(subRec.servers.includes('mc'));
  // Junk and panel-wide capabilities never enter a role.
  const { role } = await call('POST', '/api/staff/roles', { user: admin, body: { name: 'Mixed', permissions: ['files', 'deploy', 'nonsense'] } });
  assert.deepStrictEqual(role.permissions, ['files']);
  await call('PUT', '/api/staff/roles/moderator', { user: admin, body: { name: 'Moderator', permissions: ['console'] } });
  assert.deepStrictEqual(staff.roles(app.store).find((r) => r.id === 'moderator').permissions, ['console']);
  await call('DELETE', '/api/staff/roles/moderator', { user: admin });
  assert.strictEqual(staff.roles(app.store).find((r) => r.id === 'moderator').modified, false);
  await assert.rejects(() => call('DELETE', '/api/staff/roles/builder', { user: admin }), /Built-in/);
  await assert.rejects(() => call('POST', `/api/servers/mc/access/${admin.id}/role`, { user: admin, body: { role: 'helper' } }), /Administrators/);
});

test('timed access: granted, removed at expiry and at boot, previous access restored, validated', async () => {
  const { app, admin, subRec } = setup();
  const { call } = load('staff', app);
  const { grant } = await call('POST', '/api/servers/mc/access-grants', { user: admin, body: { userId: subRec.id, role: 'helper', hours: 2 } });
  assert.ok(grant.expiresAt > Date.now());
  assert.strictEqual(grant.prev, undefined);
  assert.ok(app.auth.canAccessServer(subRec, 'mc'));
  assert.strictEqual((await call('GET', '/api/servers/mc/access-grants', { user: admin })).grants.length, 1);
  // Not yet.
  assert.strictEqual(staff.expireGrants(app.store, app.auth, app.manager, Date.now() + 3_600_000), 0);
  // "Boot" after it ran out: removed.
  assert.strictEqual(staff.expireGrants(app.store, app.auth, app.manager, Date.now() + 3 * 3_600_000), 1);
  assert.ok(!app.auth.canAccessServer(subRec, 'mc'));
  assert.strictEqual(subRec.serverPerms?.mc, undefined);
  assert.strictEqual(staff.grantsFor(app.store, 'mc').length, 0);

  // Someone with permanent access gets it back, not removed.
  subRec.servers = ['mc'];
  subRec.serverPerms = { mc: ['console'] };
  const g2 = staff.createGrant(app.store, app.auth, { serverId: 'mc', userId: subRec.id, role: 'manager', hours: 1 });
  assert.ok(subRec.serverPerms.mc.includes('power'));
  await call('DELETE', `/api/servers/mc/access-grants/${g2.id}`, { user: admin });
  assert.deepStrictEqual(subRec.serverPerms.mc, ['console']);
  assert.ok(app.auth.canAccessServer(subRec, 'mc'));

  // An administrator who removed them meanwhile is not overruled.
  const g3 = staff.createGrant(app.store, app.auth, { serverId: 'mc', userId: subRec.id, role: 'helper', hours: 1 });
  subRec.servers = [];
  delete subRec.serverPerms.mc;
  staff.expireGrants(app.store, app.auth, app.manager, g3.expiresAt + 1);
  assert.ok(!app.auth.canAccessServer(subRec, 'mc'));

  // Validation and permissions.
  const bad = (extra, re) => assert.throws(() => staff.createGrant(app.store, app.auth, { serverId: 'mc', userId: subRec.id, role: 'helper', hours: 1, ...extra }), re);
  bad({ hours: 0 }, /future/);
  bad({ hours: 99999 }, /year/);
  bad({ role: 'nope' }, /role/);
  await assert.rejects(() => call('POST', '/api/servers/mc/access-grants', { user: subRec, body: {} }), /administrator/i);
});
