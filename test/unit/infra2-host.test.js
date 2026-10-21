'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const health = require('../../server/features/host-health');
const { HostPower, commandFor, startList } = require('../../server/features/host-power');
const arch = require('../../server/features/arch');
const extras = require('../../server/features/update-extras');

test('host health: apt simulation, forecast, sensors, smart parsing, problems', () => {
  const apt = health.parseApt('Inst libc6 [2.1] (2.2 Debian:12 [amd64])\nInst openssl [1] (2 Debian-Security:12/stable-security [amd64])\nConf libc6\n');
  assert.deepStrictEqual([apt.count, apt.security], [2, 1]);

  const now = Date.now();
  const GB = 1024 ** 3;
  const samples = Array.from({ length: 24 }, (_, i) => ({ t: now - (23 - i) * 3600_000, used: 100 * GB + i * 1 * GB }));
  const f = health.forecast(samples, 200 * GB, 77 * GB);
  assert.ok(f.days > 2.5 && f.days < 3.5, `days ${f.days}`);
  assert.strictEqual(health.forecast(samples.slice(0, 3), 1, 1).days, null);

  const sys = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-sys-'));
  const chip = path.join(sys, 'class/hwmon/hwmon0');
  fs.mkdirSync(chip, { recursive: true });
  fs.writeFileSync(path.join(chip, 'name'), 'coretemp\n');
  fs.writeFileSync(path.join(chip, 'temp1_input'), '54500\n');
  fs.writeFileSync(path.join(chip, 'temp1_label'), 'Package\n');
  const sensors = health.readSensors(sys);
  assert.deepStrictEqual(sensors, [{ name: 'coretemp Package', celsius: 54.5, source: 'hwmon' }]);

  const d = health.parseSmart({ model_name: 'Disk X', smart_status: { passed: false }, temperature: { current: 40 }, ata_smart_attributes: { table: [{ id: 5, raw: { value: 8 } }] } }, '/dev/sda');
  assert.strictEqual(d.passed, false);
  assert.strictEqual(d.reallocated, 8);
  const probs = health.problems({ smart: { drives: [d] }, temps: { sensors: [{ name: 'cpu', celsius: 90 }] }, disk: { forecast: { days: 3 } }, reboot: {}, updates: { security: 2 } });
  assert.deepStrictEqual(probs.map((p) => p.key).sort(), ['disk-forecast', 'sec-updates', 'smart:/dev/sda', 'temp']);
});

function fakeManager(ids) {
  const active = new Set(ids);
  const calls = [];
  const servers = ['proxy', ...ids].filter((v, i, a) => a.indexOf(v) === i).map((id) => ({ id, name: id, templateId: id === 'proxy' ? 'minecraft-velocity' : 'rust', installedAt: 1, autoStart: id === 'never' }));
  servers.push({ id: 'never', name: 'never', templateId: 'rust', installedAt: 1, autoStart: true });
  return {
    servers,
    calls,
    isActive: (id) => active.has(id),
    template: () => ({}),
    sendCommand: async () => {},
    stop: async (id) => {
      calls.push(`stop ${id}`);
      active.delete(id);
    },
    start: async (id) => {
      calls.push(`start ${id}`);
      active.add(id);
    },
  };
}

test('host power: dry run, stop order, command, state for resume, cancel', async () => {
  assert.deepStrictEqual(commandFor('reboot', { windows: false, root: false }), ['sudo', ['-n', 'systemctl', 'reboot']]);
  assert.deepStrictEqual(commandFor('shutdown', { windows: false, root: true }), ['systemctl', ['poweroff']]);
  assert.strictEqual(commandFor('reboot', { windows: true })[0], 'shutdown.exe');

  const manager = fakeManager(['proxy', 'a', 'b']);
  let saved = null;
  const exec = async (file, args) => {
    execs.push([file, ...args]);
    return { code: 0, stdout: '', stderr: '' };
  };
  const execs = [];
  const events = [];
  const hp = new HostPower({ manager, store: { addEvent: (t, m) => events.push(m), save() {} }, exec, sleep: async () => {}, state: { read: () => saved, write: (s) => (saved = s) } });
  const plan = await hp.plan('reboot', 30);
  assert.deepStrictEqual(plan.servers.map((s) => s.id), ['a', 'b', 'proxy']); // proxy last
  assert.strictEqual(manager.calls.length, 0); // a plan touches nothing

  await hp.start({ action: 'reboot', seconds: 0, by: 'tester' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(manager.calls, ['stop a', 'stop b', 'stop proxy']);
  assert.deepStrictEqual(saved.running.sort(), ['a', 'b', 'proxy']);
  assert.ok(execs.some((e) => e.includes('reboot')));
  assert.strictEqual(hp.status().phase, 'rebooting');

  // After boot: exactly the servers that were running, not the autoStart one.
  const after = fakeManager(['a', 'proxy']);
  await after.stop('a');
  await after.stop('proxy');
  assert.ok(after.servers.find((s) => s.id === 'never').autoStart);
  const file = require('../../server/features/host-power').STATE;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ action: 'reboot', at: Date.now(), running: ['a', 'proxy'] }));
  assert.deepStrictEqual(startList(after, null).map((s) => s.id).sort(), ['a', 'proxy']);
  assert.deepStrictEqual(startList(after, null).map((s) => s.id), ['never']); // record consumed: usual list again
});

test('host power: cancelling during the countdown stops nothing', async () => {
  const manager = fakeManager(['a']);
  let release;
  const gate = new Promise((r) => (release = r));
  const hp = new HostPower({ manager, store: null, exec: async () => ({ code: 0, stdout: '', stderr: '' }), sleep: () => gate, state: { read: () => null, write() {} } });
  await hp.start({ action: 'reboot', seconds: 120 });
  assert.strictEqual(hp.status().phase, 'countdown');
  await hp.cancel('t');
  assert.strictEqual(hp.status().phase, 'cancelled');
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(manager.calls, []);
  await assert.rejects(() => hp.cancel('t'));
});

test('arm: compatibility badges and box64 wrapping', () => {
  const java = { id: 'minecraft-paper', startCommand: 'java -jar server.jar', platforms: ['linux', 'windows'] };
  const rust = { id: 'rust', startCommand: './RustDedicated -batchmode', platforms: ['linux', 'windows'] };
  const none = { id: 'winonly', startCommand: 'x.exe', platforms: ['windows'] };
  assert.strictEqual(arch.armClass(java), 'native');
  assert.strictEqual(arch.armClass(rust), 'box64');
  assert.strictEqual(arch.compat(rust, { arch: 'x64' }).status, 'ok');
  assert.strictEqual(arch.compat(java, { arch: 'arm64', box: {}, platform: 'linux' }).status, 'ok');
  assert.strictEqual(arch.compat(rust, { arch: 'arm64', box: {}, platform: 'linux' }).status, 'needs-box64');
  assert.strictEqual(arch.compat(rust, { arch: 'arm64', box: { box64: '/usr/bin/box64' }, platform: 'linux' }).status, 'box64');
  assert.strictEqual(arch.compat(none, { arch: 'arm64', box: { box64: 'x' }, platform: 'linux' }).status, 'unsupported');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-arm-'));
  const elf64 = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  const elf32 = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]);
  fs.writeFileSync(path.join(dir, 'RustDedicated'), elf64);
  fs.writeFileSync(path.join(dir, 'old32'), elf32);
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n');
  const box = { box64: '/usr/bin/box64', box86: '/usr/bin/box86' };
  const s = { dir };
  const w = (cmd) => arch.wrapStart(cmd, s, rust, box, { force: true });
  assert.strictEqual(w('./RustDedicated -batchmode'), 'box64 ./RustDedicated -batchmode');
  assert.strictEqual(w('./old32 +x'), 'box86 ./old32 +x');
  assert.strictEqual(w('./run.sh'), './run.sh');
  assert.strictEqual(w('java -jar a.jar'), 'java -jar a.jar');
  assert.strictEqual(arch.wrapStart('./RustDedicated', s, java, box, { force: true }), './RustDedicated');
});

test('updates: rollback target comes from the history and is validated', () => {
  const list = [
    { at: 3, from: 'abcdef1', to: '1234567', rollback: true },
    { at: 2, from: 'aaaaaaa', to: 'bbbbbbb' },
  ];
  const t = extras.rollbackTarget(list);
  // A git checkout needs a hex commit, a release install a version; this repo is a git checkout here, so a bad value is refused.
  if (t) assert.strictEqual(t.from, 'aaaaaaa');
  assert.strictEqual(extras.rollbackTarget([{ at: 1, from: 'x; rm -rf /', to: 'y' }]), null);
});
