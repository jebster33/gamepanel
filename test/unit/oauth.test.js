'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const oauth = require('../../server/features/oauth');
const { Auth } = require('../../server/core/auth');

/** A stand-in for Discord: hands out a token for the code "good", and says who it belongs to. */
function fakeProvider() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/token') {
          const p = new URLSearchParams(body);
          if (p.get('code') !== 'good' || p.get('client_secret') !== 'shh') return res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
          return res.end(JSON.stringify({ access_token: 'tok' }));
        }
        if (req.url === '/me' && req.headers.authorization === 'Bearer tok') return res.end(JSON.stringify({ id: '42', username: 'alex' }));
        res.writeHead(401).end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('link an account, then sign in with it; a link from another browser is refused', async () => {
  const fake = await fakeProvider();
  const base = `http://127.0.0.1:${fake.address().port}`;
  const discord = oauth.PROVIDERS.discord;
  const saved = { token: discord.token, identity: discord.identity };
  discord.token = `${base}/token`;
  discord.identity = async (token) => {
    const me = await (await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
    return { id: String(me.id), name: `@${me.username}` };
  };
  try {
    const store = { state: { users: [], settings: {} }, save: () => {}, addEvent: () => {} };
    const auth = new Auth(store, 'x'.repeat(40));
    auth.createUser({ username: 'alex', password: 'correct horse battery', role: 'admin' });
    const alex = auth.users[0];
    oauth.update(store, { publicUrl: 'https://panel.example.com', discord: { clientId: 'cid', clientSecret: 'shh' } });
    assert.deepStrictEqual(oauth.enabled(store), [{ id: 'discord', label: 'Discord' }]);

    const req = { headers: { host: 'panel.example.com' }, socket: {} };
    const started = oauth.start(store, auth, req, 'discord', { linkUserId: alex.id });
    const url = new URL(started.url);
    assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://panel.example.com/api/auth/oauth/discord/callback');
    const nonce = started.cookie.split(';')[0].split('=')[1];
    const back = (code, cookieNonce = nonce, state = url.searchParams.get('state')) =>
      oauth.finish(store, auth, { headers: { host: 'panel.example.com', cookie: `gp_session=abc.def; gp_oauth=${cookieNonce}` }, socket: {} }, 'discord', new URLSearchParams({ code, state }));

    await assert.rejects(back('good', 'someone-else'), /another browser/);
    await assert.rejects(back('bad'), /invalid_grant/);
    const linked = await back('good');
    assert.strictEqual(linked.linkUserId, alex.id);
    oauth.link(store, auth, alex.id, 'discord', linked.identity);
    assert.strictEqual(oauth.findUser(auth, 'discord', { id: '42' }), alex);
    assert.strictEqual(auth.publicUser(alex).identities.discord, '@alex');

    // A second panel account cannot take the same Discord account.
    auth.createUser({ username: 'sam', password: 'correct horse battery 2' });
    assert.throws(() => oauth.link(store, auth, auth.users[1].id, 'discord', linked.identity), /already linked/);

    // Signing in: a session, or the code step for accounts with two-factor.
    assert.ok(auth.loginLinked(alex).token);
    alex.totp = { secret: 'JBSWY3DPEHPK3PXP' };
    assert.ok(auth.loginLinked(alex).twoFactor);
    // The state token is not a session.
    assert.strictEqual(auth.userFromToken(url.searchParams.get('state')), null);
  } finally {
    Object.assign(discord, saved);
    fake.close();
  }
});
