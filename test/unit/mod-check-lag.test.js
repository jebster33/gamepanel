'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const zip = require('../../server/core/zip');
const check = require('../../server/features/mods/check');
const lag = require('../../server/features/lag');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-check-'));
const messages = (r) => r.issues.map((i) => i.message);

test('Rust: missing required plugin, duplicate plugin, no Oxide', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'oxide', 'plugins'), { recursive: true });
  const put = (name, text) => fs.writeFileSync(path.join(dir, 'oxide', 'plugins', name), text);
  put('Kits.cs', '// Requires: ImageLibrary\n[Info("Kits", "x", "1.0.0")]\nclass Kits {}');
  put('Kits2.cs', '[Info("Kits", "x", "1.1.0")]\nclass Kits {}');
  const template = { id: 'rust', mods: { dir: 'oxide/plugins', game: 'rust' } };
  const r = check.run({ id: 'r', dir, vars: {} }, template);
  assert.ok(messages(r).some((m) => /needs the ImageLibrary plugin/.test(m)));
  assert.ok(messages(r).some((m) => /same plugin/.test(m)));
  assert.ok(messages(r).some((m) => /neither Oxide nor Carbon/.test(m)));
});

test('Factorio: missing dependency, incompatible mod, wrong game version', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'mods'));
  const mod = (name, info) => fs.writeFileSync(path.join(dir, 'mods', `${name}_1.0.0.zip`), zip.build({ [`${name}_1.0.0/info.json`]: JSON.stringify({ name, version: '1.0.0', factorio_version: '1.1', ...info }) }));
  mod('a', { dependencies: ['base', 'b >= 2.0.0', '? c', '! d'] });
  mod('b', {});
  mod('d', { factorio_version: '2.0' });
  const r = check.run({ id: 'f', dir, vars: {}, gameVersion: '1.1.110' }, { id: 'factorio', mods: { dir: 'mods' } });
  const msgs = messages(r);
  assert.ok(msgs.some((m) => /needs b >= 2.0.0/.test(m)));
  assert.ok(msgs.some((m) => /does not work together with d/.test(m)));
  assert.ok(msgs.some((m) => /made for Factorio 2.0/.test(m)));
  assert.ok(!msgs.some((m) => /needs c/.test(m)));
});

test('the record: a missing file and a switched-off dependency', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'mods'));
  fs.mkdirSync(path.join(dir, '.gamepanel'));
  fs.writeFileSync(path.join(dir, 'mods', 'lib.jar.disabled'), 'x');
  fs.writeFileSync(
    path.join(dir, '.gamepanel', 'mods.json'),
    JSON.stringify({ mods: [{ key: 'modrinth:a', name: 'A', file: 'a.jar', requiredBy: [] }, { key: 'modrinth:lib', name: 'Lib', file: 'lib.jar', disabled: true, auto: true, requiredBy: ['modrinth:a'] }] })
  );
  fs.writeFileSync(path.join(dir, 'mods', 'a.jar'), 'x');
  const r = check.run({ id: 'g', dir, vars: {} }, { id: 'x', mods: { dir: 'mods', game: 'other' } });
  assert.ok(messages(r).some((m) => /Lib is switched off, but A needs it/.test(m)));
  assert.ok(!messages(r).some((m) => /recorded as installed/.test(m)));
});

test('lag: spark link is picked up from the console and saved', async () => {
  const dir = tmp();
  const server = { id: 's1', dir, name: 'S', memory: 2048, loader: 'paper', gameVersion: '1.21', vars: {} };
  fs.mkdirSync(path.join(dir, 'plugins'));
  fs.writeFileSync(path.join(dir, 'plugins', 'spark-1.10.jar'), 'x');
  const rt = { seq: 0, console: [], startedAt: Date.now(), players: 3, tps: 19.5 };
  const manager = {
    store: { addEvent() {} },
    template: () => ({ id: 'minecraft-paper', category: 'Minecraft', mods: { dir: 'plugins', loader: 'paper' } }),
    rt: () => rt,
    isActive: () => true,
    getHistory: () => [{ t: Date.now(), cpu: 40, mem: 1.5e9, memMax: 1.6e9, players: 3, playersMax: 4 }],
    sendCommand: async (id, cmd) => {
      assert.match(cmd, /^spark profiler start --timeout 30$/);
      setTimeout(() => rt.console.push({ seq: ++rt.seq, stream: 'stdout', line: '[⚡] Profiler stopped & save complete! https://spark.lucko.me/AbC123' }), 50);
      return { ok: true };
    },
  };
  assert.equal(lag.status(manager, server).kind, 'spark');
  assert.equal(lag.status(manager, server).sparkInstalled, true);
  await lag.start(manager, server, { mode: 'profile', seconds: 30 }, 'chris');
  await assert.rejects(() => lag.start(manager, server, {}), /already running/);
  for (let i = 0; i < 40 && lag.status(manager, server).active; i++) await new Promise((r) => setTimeout(r, 250));
  const reports = lag.status(manager, server).reports;
  assert.equal(reports.length, 1);
  assert.equal(reports[0].url, 'https://spark.lucko.me/AbC123');
  assert.equal(reports[0].snapshot.cpuAvg, 40);
});

test('lag: findings point at what stands out', () => {
  const f = lag.findings({ tps: 12, behindLines: 4, cpuPeak: 99, memoryLimitMb: 2048, memoryPeakMb: 2040 });
  assert.equal(f.length, 4);
  assert.match(lag.findings({ tps: 20, behindLines: 0, cpuPeak: 10 })[0], /Nothing stands out/);
});
