'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-afs-data-'));
const secrets = require('../../server/core/secrets');
const { makeApp, load } = require('./support/routes');
const { Nodes } = require('../../server/features/nodes');
const { CloudBackups } = require('../../server/features/cloud');
const { DiscordBot } = require('../../server/features/discord-bot');
const oauth = require('../../server/features/oauth');
const nb = require('../../server/features/node-backups');

const legacySettings = () => ({
  integrations: { discordBot: { token: 'bot-token.abc.def', controllers: '' }, cloudflare: { token: 'cf-token', domain: 'example.com' } },
  nodes: [{ id: 'n1', name: 'Home', url: 'http://10.0.0.5:8420', key: 'gp_nodekey' }],
  cloudBackups: { endpoint: 'https://s3.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'S3SECRET' },
  oauth: { publicUrl: 'https://p.example.com', discord: { clientId: 'cid', clientSecret: 'discord-secret' }, google: { clientId: '', clientSecret: '' } },
});

test('tokens and keys saved in plain text by an older version are sealed at start, once', () => {
  const settings = legacySettings();
  assert.strictEqual(secrets.sealSettings(settings), true);
  const sealed = [settings.integrations.discordBot.token, settings.integrations.cloudflare.token, settings.nodes[0].key, settings.cloudBackups.secretAccessKey, settings.oauth.discord.clientSecret];
  for (const value of sealed) assert.ok(secrets.isSealed(value), value);
  assert.strictEqual(secrets.open(settings.nodes[0].key), 'gp_nodekey');
  assert.strictEqual(secrets.open(settings.cloudBackups.secretAccessKey), 'S3SECRET');
  assert.strictEqual(settings.oauth.google.clientSecret, '', 'empty stays empty');
  assert.strictEqual(settings.oauth.publicUrl, 'https://p.example.com');
  const again = JSON.stringify(settings);
  assert.strictEqual(secrets.sealSettings(settings), false);
  assert.strictEqual(JSON.stringify(settings), again, 'nothing is sealed twice');
  const view = secrets.maskSealed(settings);
  assert.ok(!JSON.stringify(view).includes('enc:v1:'));
  assert.strictEqual(view.integrations.cloudflare.domain, 'example.com');
});

test('the settings page gets no token back, and leaving the Cloudflare box empty keeps the saved one', async () => {
  const app = makeApp();
  const s = app.store.state.settings;
  Object.assign(s, legacySettings());
  secrets.sealSettings(s);
  app.hostMetrics = {};
  app.notifier = {};
  app.bridge = {};
  const admin = app.auth.createUser({ username: 'boss', password: 'correct horse 42', role: 'admin' });
  const user = app.auth.users.find((u) => u.id === admin.id);
  const api = load('system', app);
  const req = { headers: {} };
  const shown = JSON.stringify((await api.call('GET', '/api/settings', { user, req })).settings);
  assert.ok(!shown.includes('enc:v1:') && !shown.includes('cf-token'));
  assert.strictEqual((await api.call('GET', '/api/settings', { user, req })).settings.integrations.cloudflare.tokenSet, true);

  const saved = s.integrations.cloudflare.token;
  await api.call('PATCH', '/api/settings', { user, body: { integrations: { cloudflare: { token: '', domain: 'example.org' } } } });
  assert.strictEqual(s.integrations.cloudflare.token, saved, 'kept');
  assert.strictEqual(s.integrations.cloudflare.domain, 'example.org');
  await api.call('PATCH', '/api/settings', { user, body: { integrations: { cloudflare: { token: 'new-cf-token', domain: 'example.org' } } } });
  assert.strictEqual(secrets.open(s.integrations.cloudflare.token), 'new-cf-token');
  assert.ok(secrets.isSealed(s.integrations.cloudflare.token));
  await api.call('PATCH', '/api/settings', { user, body: { integrations: { cloudflare: { clearToken: true, domain: 'example.org' } } } });
  assert.strictEqual(s.integrations.cloudflare.token, '');

  // The Discord bot token is sealed too, and the presence settings beside it survive.
  s.integrations.discordBot = { presence: { mode: 'all' } };
  await api.call('PUT', '/api/settings/discord-bot', { user, body: { token: 'abc.def.ghi', controllers: '' } });
  assert.ok(secrets.isSealed(s.integrations.discordBot.token));
  assert.deepStrictEqual(s.integrations.discordBot.presence, { mode: 'all' });
  const bot = new DiscordBot(app.store, {});
  assert.strictEqual(bot.settings.token, 'abc.def.ghi', 'the bot itself reads it opened');
  await api.call('PUT', '/api/settings/discord-bot', { user, body: { controllers: '' } });
  assert.strictEqual(bot.settings.token, 'abc.def.ghi', 'no token in the request keeps the saved one');
});

test('cloud backup and sign-in provider secrets are stored sealed and used opened', () => {
  const app = makeApp();
  const cloud = new CloudBackups(app.store, { servers: [] });
  cloud.update({ endpoint: 'https://s3.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'S3SECRET' });
  assert.ok(secrets.isSealed(app.store.state.settings.cloudBackups.secretAccessKey));
  assert.strictEqual(cloud.settings.secretAccessKey, 'S3SECRET');
  assert.strictEqual(cloud.publicSettings().secretAccessKey, '');
  assert.strictEqual(cloud.publicSettings().hasSecret, true);
  cloud.update({ bucket: 'other' });
  assert.strictEqual(cloud.settings.secretAccessKey, 'S3SECRET', 'saving other fields does not lose it or seal it twice');

  oauth.update(app.store, { discord: { clientId: 'cid', clientSecret: 'shh' } });
  assert.ok(secrets.isSealed(app.store.state.settings.oauth.discord.clientSecret));
  oauth.update(app.store, { discord: { clientId: 'cid2' } });
  assert.strictEqual(secrets.open(app.store.state.settings.oauth.discord.clientSecret), 'shh');
  assert.strictEqual(oauth.adminView(app.store, { headers: { host: 'p' }, socket: {} }).providers.find((p) => p.id === 'discord').hasSecret, true);
});

test('a node key is stored sealed and still reaches the node as the bearer token', async () => {
  const seen = [];
  const remote = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ servers: [] }));
  });
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${remote.address().port}`;
  try {
    const app = makeApp();
    const nodes = new Nodes({ store: app.store, manager: { servers: [], broadcastServers() {} }, wss: {} });
    nodes.poll = async () => {};
    const added = await nodes.add({ name: 'Home', url, key: 'gp_firstkey' });
    assert.strictEqual(added.key, undefined);
    assert.ok(secrets.isSealed(nodes.list[0].key));
    await nodes.request(nodes.list[0], 'GET', '/api/servers');
    nodes.update(nodes.list[0].id, { key: 'gp_secondkey' });
    assert.ok(secrets.isSealed(nodes.list[0].key));
    await nodes.request(nodes.list[0], 'GET', '/api/servers');
    assert.deepStrictEqual(seen, ['Bearer gp_firstkey', 'Bearer gp_firstkey', 'Bearer gp_secondkey']);
    assert.ok(!JSON.stringify(nodes.overview()).includes('gp_'));
  } finally {
    remote.close();
  }
});

test('copies kept for another panel are filed under the key that sent them', async () => {
  const keyA = { gpApiKeyId: 'aaaa11112222' };
  const keyB = { gpApiKeyId: 'bbbb33334444' };
  const user = { id: 'u1' };
  const a = nb.scopedSource(keyA, user, 'panelX');
  const b = nb.scopedSource(keyB, user, 'panelX');
  assert.notStrictEqual(a, b, 'the same chosen name lands in different places');
  const body = Buffer.from('backup A');
  await nb.receive(Object.assign(Readable.from([body]), { headers: { 'x-backup-size': String(body.length) } }), a, 'mc-1', 'one.tar.gz');
  assert.strictEqual(nb.listStored(a, 'mc-1').length, 1);
  assert.deepStrictEqual(nb.listStored(b, 'mc-1'), [], 'another key cannot list it');
  assert.ok(!fs.existsSync(nb.storeFile(b, 'mc-1', 'one.tar.gz')), 'nor read or delete it');
  assert.throws(() => nb.scopedSource(keyA, user, '../panelX'), /Bad panel/);
  assert.throws(() => nb.scopedSource(keyA, user, 'x'.repeat(80)), /Bad panel/);
  // A session (no key) is filed under the account.
  assert.match(nb.scopedSource({}, user, 'p'), /^uu1-p$/);
});
