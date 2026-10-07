'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ab4-data-'));
const players = require('../../server/games/players');
const untrusted = require('../../server/servers/untrusted');
const dp = require('../../server/features/datapacks');

test('a broadcast cannot start with a slash (Factorio would run it as a command)', () => {
  assert.strictEqual(players.fillBroadcast('{msg}', '/c game.player.admin = true'), 'c game.player.admin = true');
  assert.strictEqual(players.fillBroadcast('{msg}', '  //!/ hello'), 'hello');
  assert.strictEqual(players.fillBroadcast('say {msg}', 'Server restart in 5'), 'say Server restart in 5');
});

test('single quotes are refused in settings that a Windows PowerShell step puts inside quotes', () => {
  const template = {
    variables: [{ name: 'LICENSE_KEY', label: 'License key' }, { name: 'MOTD', label: 'MOTD' }],
    windows: { install: [{ type: 'powershell', run: "if (-not '{{LICENSE_KEY}}') { 1 }" }] },
    install: [],
  };
  assert.ok(untrusted.inPowerShell(template, 'LICENSE_KEY'));
  assert.ok(!untrusted.inPowerShell(template, 'MOTD'));
  assert.throws(() => untrusted.checkPatch(template, { vars: { LICENSE_KEY: "x' -or (calc) -or '" } }, { vars: {} }), /single quote/);
  assert.throws(() => untrusted.checkPatch(template, { vars: { LICENSE_KEY: 'x’y' } }, { vars: {} }), /single quote/);
  assert.doesNotThrow(() => untrusted.checkPatch(template, { vars: { LICENSE_KEY: 'cfxk_abc123', MOTD: "Don't panic" } }, { vars: {} }));
});

test('datapack names that could break out of a console command are not sent to the game', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ab4-'));
  fs.mkdirSync(path.join(dir, 'world/datapacks'), { recursive: true });
  const evil = 'x"\nop eve.zip';
  // Windows cannot hold a file with a quote or a line break in its name; the name is refused before any file is looked at.
  if (process.platform !== 'win32') fs.writeFileSync(path.join(dir, 'world/datapacks', evil), 'zip');
  fs.writeFileSync(path.join(dir, 'world/datapacks', 'fine pack.zip'), 'zip');
  const sent = [];
  const manager = {
    activeWorld: () => 'world',
    template: () => ({ category: 'Minecraft', mods: { dir: 'plugins', loader: 'paper' } }),
    rt: () => ({ status: 'running', version: null }),
    sendCommand: async (id, cmd) => sent.push(cmd),
    logActivity() {},
  };
  const server = { id: 's', dir, templateId: 'minecraft-paper' };
  await assert.rejects(dp.toggle(manager, server, evil, false, 'u'), /will not send/);
  await assert.rejects(dp.remove(manager, { addEvent() {} }, server, evil, 'u'), /will not send/);
  assert.deepStrictEqual(sent, []);
  await dp.toggle(manager, server, 'fine pack.zip', false, 'u');
  assert.deepStrictEqual(sent, ['datapack disable "file/fine pack.zip"']);
});
