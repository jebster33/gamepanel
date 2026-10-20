'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const livemap = require('../../server/features/rust-livemap');
const { webRcon } = require('../../server/games/webrcon');

test('parseReply finds the JSON among other console lines', () => {
  assert.deepStrictEqual(livemap.parseReply('noise\n{"a":1}\n'), { a: 1 });
  assert.strictEqual(livemap.parseReply('Unknown command'), null);
});

test('only PNG and JPEG pictures are accepted', () => {
  assert.strictEqual(livemap.sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0])), 'png');
  assert.strictEqual(livemap.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.strictEqual(livemap.sniff(Buffer.from('<svg></svg>')), null);
});

test('the plugin installs into oxide/plugins and reports its state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-'));
  const server = { id: 's', dir };
  const manager = { vars: () => ({ INSTALL_OXIDE: 'true' }) };
  assert.strictEqual(livemap.pluginState(server), 'missing');
  assert.strictEqual(livemap.installPlugin(manager, server), 'installed');
  assert.ok(fs.existsSync(path.join(dir, 'oxide/plugins/GamePanelMap.cs')));
  fs.appendFileSync(path.join(dir, 'oxide/plugins/GamePanelMap.cs'), '//old');
  assert.strictEqual(livemap.pluginState(server), 'outdated');
  assert.throws(() => livemap.installPlugin({ vars: () => ({}) }, { id: 'v', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lm-')) }), /Oxide/);
});

test('webRcon rejects when nothing listens', async () => {
  const server = http.createServer().listen(0);
  const { port } = server.address();
  server.close();
  await assert.rejects(webRcon({ port, password: 'x', command: 'status', timeout: 1500 }));
});
