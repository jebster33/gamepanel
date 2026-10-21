'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-steam-data-'));
const steam = require('../../server/features/steam-openid');
const oauth = require('../../server/features/oauth');
const { Auth } = require('../../server/core/auth');

const RETURN_TO = 'https://panel.example.com/api/auth/oauth/steam/callback?state=abc.def';
const ID = '76561198000000001';

/** What Steam sends back, as the browser would deliver it. */
function answer(over = {}, now = Date.now()) {
  const p = {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${ID}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${ID}`,
    'openid.return_to': RETURN_TO,
    'openid.response_nonce': `${new Date(now).toISOString().replace(/\.\d+Z$/, 'Z')}${Math.random().toString(36).slice(2)}`,
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'c2ln',
    ...over,
  };
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  return new URLSearchParams(p);
}

/** A stand-in for steamcommunity.com that records what it was asked. */
function fakeSteam(valid = true) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(String(init.body)) });
    return { ok: true, text: async () => `ns:http://specs.openid.net/auth/2.0\nis_valid:${valid}\n` };
  };
  return { fn, calls };
}

test('a valid answer is confirmed with Steam and gives the SteamID', async () => {
  const s = fakeSteam();
  const id = await steam.verify(answer(), { returnTo: RETURN_TO, fetchFn: s.fn });
  assert.strictEqual(id, ID);
  assert.strictEqual(s.calls.length, 1);
  assert.strictEqual(s.calls[0].url, 'https://steamcommunity.com/openid/login');
  assert.strictEqual(s.calls[0].body.get('openid.mode'), 'check_authentication');
  assert.strictEqual(s.calls[0].body.get('openid.sig'), 'c2ln');
});

test('Steam saying no, or being unreachable, refuses the sign-in', async () => {
  await assert.rejects(steam.verify(answer(), { returnTo: RETURN_TO, fetchFn: fakeSteam(false).fn }), /did not confirm/);
  await assert.rejects(steam.verify(answer(), { returnTo: RETURN_TO, fetchFn: async () => { throw new Error('offline'); } }), /did not answer/);
});

test('a replayed answer is refused the second time', async () => {
  const a = answer();
  await steam.verify(a, { returnTo: RETURN_TO, fetchFn: fakeSteam().fn });
  await assert.rejects(steam.verify(a, { returnTo: RETURN_TO, fetchFn: fakeSteam().fn }), /already used/);
});

test('answers for another address, provider, identity or time are refused before asking Steam', async () => {
  const s = fakeSteam();
  const opts = { returnTo: RETURN_TO, fetchFn: s.fn };
  await assert.rejects(steam.verify(answer({ 'openid.return_to': 'https://evil.example/cb' }), opts), /another address/);
  await assert.rejects(steam.verify(answer({ 'openid.op_endpoint': 'https://evil.example/openid/login' }), opts), /wrong provider/);
  await assert.rejects(steam.verify(answer({ 'openid.claimed_id': 'https://steamcommunity.com.evil.example/openid/id/76561198000000001', 'openid.identity': 'https://steamcommunity.com.evil.example/openid/id/76561198000000001' }), opts), /not a Steam account/);
  await assert.rejects(steam.verify(answer({ 'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000002' }), opts), /not a Steam account/);
  await assert.rejects(steam.verify(answer({ 'openid.signed': 'signed,op_endpoint' }), opts), /not signed/);
  await assert.rejects(steam.verify(answer({ 'openid.mode': 'setup_needed' }), opts), /not a sign-in answer/);
  await assert.rejects(steam.verify(answer({}, Date.now() - 20 * 60_000), opts), /expired/);
  await assert.rejects(steam.verify(answer({ 'openid.response_nonce': 'not-a-time' }), opts), /expired/);
  await assert.rejects(steam.verify(new URLSearchParams({ 'openid.mode': 'cancel' }), opts), /cancelled/);
  assert.strictEqual(s.calls.length, 0, 'Steam is never asked about a bad answer');
});

test('the Steam button needs the panel address, and the realm comes from it', () => {
  const store = { state: { users: [], settings: {} }, save() {}, addEvent() {} };
  const auth = new Auth(store, 'x'.repeat(40));
  assert.throws(() => oauth.update(store, { steam: { enabled: true } }), /panel address/);
  oauth.update(store, { publicUrl: 'https://panel.example.com', steam: { enabled: true } });
  assert.ok(oauth.enabled(store).some((p) => p.id === 'steam' && p.label === 'Steam'));
  // The Host header is ignored: a forged one cannot move the realm or return address.
  const req = { headers: { host: 'evil.example' }, socket: {} };
  const { url, cookie } = oauth.start(store, auth, req, 'steam');
  const u = new URL(url);
  assert.strictEqual(u.origin + u.pathname, 'https://steamcommunity.com/openid/login');
  assert.strictEqual(u.searchParams.get('openid.realm'), 'https://panel.example.com');
  assert.match(u.searchParams.get('openid.return_to'), /^https:\/\/panel\.example\.com\/api\/auth\/oauth\/steam\/callback\?state=/);
  assert.match(cookie, /^gp_oauth=/);
  assert.ok(!JSON.stringify(oauth.adminView(store, req).providers).includes('steam'), 'no client id form for Steam');
});

test('finishing a Steam sign-in links an account and finds it again', async () => {
  const store = { state: { users: [], settings: {} }, save() {}, addEvent() {} };
  const auth = new Auth(store, 'x'.repeat(40));
  auth.createUser({ username: 'alex', password: 'correct horse battery', role: 'admin' });
  oauth.update(store, { publicUrl: 'https://panel.example.com', steam: { enabled: true } });
  const req0 = { headers: { host: 'panel.example.com' }, socket: {} };
  const started = oauth.start(store, auth, req0, 'steam', { linkUserId: auth.users[0].id });
  const returnTo = new URL(started.url).searchParams.get('openid.return_to');
  const state = new URL(returnTo).searchParams.get('state');
  const nonce = started.cookie.split(';')[0].split('=')[1];
  const q = answer({ 'openid.return_to': returnTo, 'openid.response_nonce': `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}link1` });
  q.set('state', state);
  const realFetch = global.fetch;
  global.fetch = async (url, init) => (String(url).includes('openid/login') ? fakeSteam().fn(url, init) : { ok: false, text: async () => '' });
  try {
    const req = { headers: { host: 'panel.example.com', cookie: `gp_oauth=${nonce}` }, socket: {} };
    const res = await oauth.finish(store, auth, req, 'steam', q);
    assert.strictEqual(res.identity.id, ID);
    oauth.link(store, auth, res.linkUserId, 'steam', res.identity);
    assert.strictEqual(oauth.findUser(auth, 'steam', { id: ID }).username, 'alex');
    // Another browser (no cookie) cannot finish it.
    await assert.rejects(oauth.finish(store, auth, { headers: { host: 'panel.example.com' }, socket: {} }, 'steam', q), /another browser|expired/);
  } finally {
    global.fetch = realFetch;
  }
});
