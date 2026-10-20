'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ct-data-'));
const secrets = require('../../server/core/secrets');
const { makeApp } = require('./support/routes');
const { CloudBackups } = require('../../server/features/cloud');
const targets = require('../../server/features/cloud-targets');

test('Drive, Dropbox and SFTP secrets are sealed on disk and readiness follows the chosen target', () => {
  const app = makeApp();
  const cloud = new CloudBackups(app.store, { servers: [] });
  cloud.update({ provider: 'gdrive', gdrive: { clientId: 'cid', clientSecret: 'shh' } });
  assert.ok(secrets.isSealed(app.store.state.settings.cloudBackups.gdrive.clientSecret));
  assert.strictEqual(cloud.ready(cloud.settings), false, 'not connected yet');
  assert.throws(() => cloud.update({ enabled: true }), /Connect Google Drive/);
  cloud.connected('gdrive', 'refresh-1');
  assert.ok(secrets.isSealed(app.store.state.settings.cloudBackups.gdrive.refreshToken));
  cloud.update({ enabled: true });
  assert.strictEqual(cloud.enabled, true);
  const pub = cloud.publicSettings();
  assert.strictEqual(pub.gdrive.clientSecret, '');
  assert.strictEqual(pub.gdrive.connected, true);
  cloud.update({ gdrive: { clientId: 'cid2' } });
  assert.strictEqual(cloud.settings.gdrive.clientSecret, 'shh', 'saving other fields keeps the secret');

  cloud.update({ provider: 'sftp', enabled: false, sftp: { host: 'h.example', username: 'bob', password: 'pw' } });
  assert.ok(secrets.isSealed(app.store.state.settings.cloudBackups.sftp.password));
  assert.strictEqual(cloud.ready(cloud.settings), true);
  assert.throws(() => cloud.update({ sftp: { host: 'a b' } }), /host name/);
  assert.throws(() => cloud.update({ prefix: '../x' }), /\.\./);
  cloud.update({ sftp: { clearKey: true } });
  assert.strictEqual(secrets.sealSettings(app.store.state.settings), false, 'nothing left unsealed');
});

test('an sftp listing is read into names, sizes and dates', () => {
  const now = new Date(Date.UTC(2026, 9, 20, 12, 0));
  const out = targets.parseListing(
    ['-rw-r--r--    1 bob      bob      12345 Oct 19 08:30 a.tar.gz', '-rw-r--r--    1 bob      bob          7 Mar  1  2025 old.tar.gz', 'drwxr-xr-x    2 bob      bob       4096 Oct 19 08:30 sub'].join('\n'),
    'gamepanel/mc/',
    now
  );
  assert.deepStrictEqual(out.map((o) => [o.key, o.size]), [['gamepanel/mc/a.tar.gz', 12345], ['gamepanel/mc/old.tar.gz', 7]]);
  assert.strictEqual(out[0].modified, Date.UTC(2026, 9, 19, 8, 30));
  assert.strictEqual(out[1].modified, Date.UTC(2025, 2, 1));
});

test('Dropbox lists, uploads and deletes through its API', async () => {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push([String(url), init.headers?.['Dropbox-API-Arg'] || init.body]);
    const json = (o) => new Response(JSON.stringify(o));
    if (String(url).includes('oauth2/token')) return json({ access_token: 'at', expires_in: 3600 });
    if (String(url).endsWith('files/list_folder')) return json({ entries: [{ '.tag': 'file', name: 'a.tar.gz', size: 5, server_modified: '2026-10-19T08:30:00Z' }, { '.tag': 'folder', name: 'x' }], has_more: false });
    return json({});
  };
  try {
    const d = new targets.Dropbox({ clientId: 'k', clientSecret: 's', refreshToken: 'r' });
    assert.deepStrictEqual((await d.list('gamepanel/mc/')).map((o) => [o.key, o.size]), [['gamepanel/mc/a.tar.gz', 5]]);
    const file = path.join(process.env.GP_DATA_DIR, 'x.tar.gz');
    fs.writeFileSync(file, 'data');
    await d.putFile('gamepanel/mc/b.tar.gz', file);
    await d.remove('gamepanel/mc/b.tar.gz');
    assert.ok(calls.some(([u, a]) => u.endsWith('files/upload') && /"path":"\/gamepanel\/mc\/b.tar.gz"/.test(a)));
    assert.ok(calls.some(([u]) => u.endsWith('files/delete_v2')));
  } finally {
    global.fetch = real;
  }
});
