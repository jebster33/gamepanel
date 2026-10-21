'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mcroutes-data-'));
const { makeApp, load } = require('./support/routes');

test('minecraft routes: JVM flags are admin only, LuckPerms actions are validated before the server is touched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mcroutes-'));
  const server = { id: 's1', name: 'S', dir, templateId: 'minecraft-paper', memory: 4096, vars: {} };
  const sent = [];
  const app = makeApp({
    manager: {
      servers: [server],
      require: () => server,
      template: () => ({ variables: [{ name: 'JAVA_ARGS', default: '' }] }),
      update: (id, patch) => Object.assign(server.vars, patch.vars),
      rt: () => ({ status: 'running' }),
      sendCommand: async (id, c) => sent.push(c),
    },
  });
  const { call } = load('minecraft', app);
  const admin = { id: 'a', username: 'admin', role: 'admin' };
  const sub = { id: 'u', username: 'sub', role: 'user' };
  await assert.rejects(() => call('PUT', '/api/servers/s1/jvm', { user: sub, body: { preset: 'lowmem' } }), /Only administrators/);
  const r = await call('PUT', '/api/servers/s1/jvm', { user: admin, body: { preset: 'lowmem' } });
  assert.strictEqual(r.preset, 'lowmem');
  await assert.rejects(() => call('PUT', '/api/servers/s1/jvm', { user: admin, body: { preset: 'custom', custom: '-Xmx64G' } }), /./);

  fs.mkdirSync(path.join(dir, 'plugins/LuckPerms'), { recursive: true });
  await assert.rejects(() => call('POST', '/api/servers/s1/luckperms/action', { user: admin, body: { action: 'group.create', name: 'a; op x' } }), /./);
  assert.deepStrictEqual(sent, []);
  const ok = await call('POST', '/api/servers/s1/luckperms/action', { user: admin, body: { action: 'group.create', name: 'vip' } });
  assert.strictEqual(ok.command, 'lp creategroup vip');
  assert.deepStrictEqual(sent, ['lp creategroup vip']);
});
