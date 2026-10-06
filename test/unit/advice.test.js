'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-adv-data-'));
const advice = require('../../server/features/advice');

const MB = 1024 * 1024;
const DAY = 86400_000;

function setup({ templateId = 'minecraft-paper', memory = 2048, props = '', mods = 0, log = '', week = [], rt = {}, vars = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-adv-srv-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), props);
  if (mods) {
    fs.mkdirSync(path.join(dir, 'mods'));
    for (let i = 0; i < mods; i++) fs.writeFileSync(path.join(dir, 'mods', `mod${i}.jar`), '');
  }
  if (log) {
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), log);
  }
  const server = { id: 's1', name: 'S', dir, templateId, memory, vars };
  const applied = [];
  const manager = {
    servers: [server],
    template: () => ({ id: templateId, variables: templateId.startsWith('minecraft') ? [{ name: 'JAVA_ARGS', default: '-XX:+UseG1GC' }] : [] }),
    rt: () => ({ status: 'running', ...rt }),
    getHistory: (id, range) => (range === '7d' ? week : []),
    readProperties: () => props,
    isActive: () => true,
    update: (id, patch) => applied.push(patch),
    setProperties: (s, values) => applied.push({ props: values }),
  };
  return { server, manager, applied };
}
const ids = (r) => r.advice.map((a) => a.id);

test('a modded server with too little memory, lag and a big view distance', () => {
  const { server, manager } = setup({ templateId: 'minecraft-fabric', memory: 3072, mods: 180, props: 'view-distance=16\nsimulation-distance=12\n', log: "Can't keep up!\n".repeat(25), rt: { tps: 14.2 } });
  const r = advice.advise(manager, server);
  assert.ok(ids(r).includes('mem-low'));
  const low = r.advice.find((a) => a.id === 'mem-low');
  assert.ok(low.action.value >= 7168, `suggested ${low.action.value}`);
  assert.ok(ids(r).includes('lag'));
  assert.strictEqual(r.advice.find((a) => a.id === 'view-distance').action.value, '8');
  assert.ok(ids(r).includes('simulation-distance'));
  assert.ok(!ids(r).includes('sync-chunk-writes'), 'not suggested for modded servers');
  assert.strictEqual(r.advice[0].level, 'warn');
});

test('an out-of-memory crash wins, and applying it changes the memory', () => {
  const { server, manager, applied } = setup({ memory: 4096, log: 'java.lang.OutOfMemoryError: Java heap space' });
  const r = advice.advise(manager, server);
  assert.strictEqual(r.advice[0].id, 'mem-oom');
  assert.strictEqual(r.advice[0].action.value, 6144);
  const store = { addEvent: () => {} };
  assert.deepStrictEqual(advice.apply(manager, store, server, 'mem-oom', 'admin'), { ok: true, applied: 'It ran out of memory', restartNeeded: true });
  assert.deepStrictEqual(applied, [{ memory: 6144 }]);
  assert.throws(() => advice.apply(manager, store, server, 'nope', 'admin'), /no longer applies/);
});

test("Aikar's flags for big Java heaps, never with an expired option", () => {
  const { server, manager } = setup({ memory: 8192 });
  const a = advice.advise(manager, server).advice.find((x) => x.id === 'java-aikar');
  assert.ok(a);
  assert.match(a.action.value, /G1NewSizePercent=30/);
  assert.doesNotMatch(a.action.value, /G1RSetUpdatingPauseTimeTarget/);
  assert.match(advice.aikar(16384), /G1HeapRegionSize=16M/);
  const done = setup({ memory: 8192, vars: { JAVA_ARGS: advice.aikar(8192) } });
  assert.ok(!ids(advice.advise(done.manager, done.server)).includes('java-aikar'));
});

test('other games: memory from what they really used', () => {
  const now = Date.now();
  const full = setup({ templateId: 'valheim', memory: 4096, week: [{ t: now - 2 * DAY, memMax: 1000 * MB }, { t: now, memMax: 3900 * MB }] });
  const peak = advice.advise(full.manager, full.server).advice.find((a) => a.id === 'mem-peak');
  assert.strictEqual(peak.action.value, 5120);
  const idle = setup({ templateId: 'valheim', memory: 8192, week: [{ t: now - 5 * DAY, memMax: 900 * MB }, { t: now, memMax: 1200 * MB }] });
  assert.strictEqual(advice.advise(idle.manager, idle.server).advice.find((a) => a.id === 'mem-spare').action.value, 2048);
  const fine = setup({ templateId: 'valheim', memory: 4096, week: [{ t: now - 5 * DAY, memMax: 2000 * MB }, { t: now, memMax: 2500 * MB }] });
  // (On a machine with little RAM a host warning may appear too; only memory advice matters here.)
  assert.ok(!ids(advice.advise(fine.manager, fine.server)).some((id) => id.startsWith('mem-')));
});
