'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-community-routes-'));
const { makeApp, load } = require('./support/routes');

function setup() {
  const app = makeApp();
  app.manager = { servers: [], require() {}, rt: () => ({}), template: () => ({}) };
  const portal = load('portal', app);
  const community = load('community', app);
  return { app, portal, community };
}

const admin = { id: 'a', username: 'root', role: 'admin' };
const req = (cookie) => ({ headers: cookie ? { cookie } : {}, socket: { remoteAddress: '203.0.113.9' } });

test('the portal is closed until an admin opens it, and only admins can open it', async () => {
  const { app, portal } = setup();
  await assert.rejects(portal.call('GET', '/api/portal/me', { req: req() }), /turned off/);
  await assert.rejects(portal.call('POST', '/api/portal/code', { req: req(), body: { name: 'Steve' } }), /turned off/);
  await assert.rejects(portal.call('PUT', '/api/portal/settings', { user: { id: 'u', role: 'user' }, body: { enabled: true } }), /administrators/);
  await portal.call('PUT', '/api/portal/settings', { user: admin, body: { enabled: true } });
  assert.strictEqual((await portal.call('GET', '/api/portal/config', { req: req() })).enabled, true);
  await assert.rejects(portal.call('GET', '/api/portal/me', { req: req() }), /Sign in/);
  assert.ok(app.store.state.settings.portal.enabled);
});

test('starting a name sign-in is rate limited per address', async () => {
  const { portal } = setup();
  await portal.call('PUT', '/api/portal/settings', { user: admin, body: { enabled: true } });
  let last;
  for (let i = 0; i < 12; i++) last = await portal.call('POST', '/api/portal/code', { req: req(), body: { name: 'Steve' } }).catch((e) => e);
  assert.ok(last instanceof Error);
  assert.strictEqual(last.code, 429);
});

test('community settings are admin only and the public feed stays off until chosen', async () => {
  const { app, community } = setup();
  await assert.rejects(community.call('GET', '/api/community/settings', { user: { id: 'u', role: 'user' } }), /administrators/);
  assert.strictEqual((await community.call('GET', '/api/community/settings', { user: admin })).showFeed, false);
  const out = await community.call('PUT', '/api/community/settings', { user: admin, body: { showFeed: true } });
  assert.strictEqual(out.showFeed, true);
  assert.strictEqual(app.store.state.settings.statusPage.showFeed, true);
  await assert.rejects(community.call('GET', '/api/public/status/nope/leaderboards', { req: req() }), /does not exist/);
});
