'use strict';

/**
 * Host benchmark: a short test of the processor (one core and all cores), memory
 * and disk, then what that means for game servers - which games fit, how many
 * of each could run, and which would be tight. It runs for about 15 seconds
 * and writes (then deletes) a 256 MB scratch file in the panel's data folder.
 *
 * The numbers are for comparing machines and games with each other, not
 * lab-grade: the single-core score is only roughly calibrated (a 2 GHz server
 * core scores about 1000, a fast desktop core 1500 or more).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { config } = require('../core/config');
const { fail } = require('../core/util');

const CPU_MS = 1500;
const REFERENCE_OPS_PER_MS = 21_000; // roughly 1000 on a 2 GHz server core

// What each game wants. single: a score the main thread needs (game logic is mostly one thread).
// cores: threads it makes use of. A game not listed is treated as 'medium'.
const CLASSES = {
  light: { single: 500, cores: 1, label: 'light' },
  medium: { single: 800, cores: 2, label: 'medium' },
  heavy: { single: 1100, cores: 3, label: 'heavy' },
  brutal: { single: 1400, cores: 4, label: 'very heavy' },
};
const GAME_CLASS = {
  light: ['terraria', 'tmodloader', 'mindustry', 'necesse', 'core-keeper', 'factorio', 'dont-starve-together', 'custom-command', 'minecraft-velocity', 'cs2', 'tf2', 'counter-strike-source', 'garrysmod', 'left4dead', 'left4dead2', 'half-life-2-deathmatch', 'day-of-defeat-source', 'sven-coop', 'no-more-room-in-hell', 'insurgency-2014', 'scp-secret-laboratory', 'barotrauma', 'killing-floor-2'],
  medium: ['minecraft-vanilla', 'minecraft-paper', 'minecraft-purpur', 'minecraft-fabric', 'minecraft-quilt', 'minecraft-forge', 'minecraft-neoforge', 'minecraft-bedrock', 'valheim', 'unturned', 'project-zomboid', 'fivem', 'avorion', 'eco', 'space-engineers', 'v-rising', 'abiotic-factor', 'mordhau', 'squad', 'squad-44', 'insurgency-sandstorm', 'arma3', 'arma-reforger', 'empyrion', 'dayz', 'satisfactory'],
  heavy: ['rust', 'seven-days-to-die', 'ark-survival-evolved', 'palworld', 'conan-exiles', 'enshrouded', 'sons-of-the-forest', 'icarus', 'minecraft-modpack'],
  brutal: ['ark-survival-ascended', 'soulmask'],
};
const classOf = (id) => Object.entries(GAME_CLASS).find(([, list]) => list.includes(id))?.[0] || 'medium';

const WORKER = `
const { parentPort, workerData } = require('worker_threads');
let ops = 0, x = 1, y = 0.5;
const end = Date.now() + workerData.ms;
while (Date.now() < end) {
  for (let i = 0; i < 20000; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; y = Math.sqrt(y * 3 + (x % 97)) + Math.sin(y); }
  ops += 20000;
}
parentPort.postMessage({ ops, sink: x + y });
`;

const spin = (ms) =>
  new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { eval: true, workerData: { ms } });
    w.once('message', (m) => resolve(m.ops / ms));
    w.once('error', reject);
  });

async function cpu() {
  const cores = os.cpus().length || 1;
  const single = await spin(CPU_MS);
  const all = await Promise.all(Array.from({ length: cores }, () => spin(CPU_MS)));
  const multiOps = all.reduce((a, b) => a + b, 0);
  return { cores, single: Math.round((single / REFERENCE_OPS_PER_MS) * 1000), multi: Math.round((multiOps / REFERENCE_OPS_PER_MS) * 1000), scaling: multiOps / single };
}

function memory() {
  const size = 64 * 1024 * 1024;
  const a = Buffer.alloc(size, 1);
  const b = Buffer.alloc(size);
  const start = process.hrtime.bigint();
  const rounds = 12;
  for (let i = 0; i < rounds; i++) a.copy(b);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { gbPerSec: Math.round(((size * rounds) / 1024 ** 3 / (ms / 1000)) * 10) / 10 };
}

async function disk() {
  const dir = path.join(config.dataDir, 'tmp');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `bench-${process.pid}.bin`);
  const total = 256 * 1024 * 1024;
  const chunk = Buffer.alloc(8 * 1024 * 1024, 7);
  try {
    const st = fs.statfsSync ? fs.statfsSync(dir) : null;
    if (st && st.bavail * st.bsize < total * 3) return { skipped: 'Not enough free disk space for the test' };
    const t0 = process.hrtime.bigint();
    const fh = await fsp.open(file, 'w');
    for (let n = 0; n < total; n += chunk.length) await fh.write(chunk);
    await fh.sync();
    await fh.close();
    const writeMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const t1 = process.hrtime.bigint();
    const rh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(8 * 1024 * 1024);
    while ((await rh.read(buf, 0, buf.length)).bytesRead > 0);
    await rh.close();
    const readMs = Number(process.hrtime.bigint() - t1) / 1e6;
    return { writeMBs: Math.round(total / 1048576 / (writeMs / 1000)), readMBs: Math.round(total / 1048576 / (readMs / 1000)) };
  } finally {
    await fsp.rm(file, { force: true }).catch(() => {});
  }
}

/** Which games fit this machine, given the results. `committedMb` is memory already promised to running servers. */
function fits(templates, result, totalMb, committedMb = 0) {
  const usable = Math.max(0, totalMb * 0.85 - 700 - committedMb); // keep room for the system and the panel
  return templates
    .filter((t) => t.id !== 'custom-command' && t.id !== 'generic-steamcmd')
    .map((t) => {
      const cls = CLASSES[classOf(t.id)];
      const mem = Number(t.defaultMemory) || 2048;
      const byMem = Math.floor(usable / mem);
      const byCpu = result.cpu.single >= cls.single ? Math.max(1, Math.floor(result.cpu.cores / cls.cores)) : 0;
      const count = Math.min(byMem, byCpu);
      const verdict = count >= 1 ? (result.cpu.single >= cls.single * 1.25 ? 'good' : 'tight') : 'no';
      const reason = byMem < 1 ? `needs about ${mem} MB of memory` : byCpu < 1 ? `a core this slow (${result.cpu.single}) will struggle; ${cls.label} games want ~${cls.single}` : '';
      return { id: t.id, name: t.name, category: t.category, icon: t.icon, memoryMb: mem, class: cls.label, count, verdict, reason };
    })
    .sort((a, b) => ({ good: 0, tight: 1, no: 2 })[a.verdict] - ({ good: 0, tight: 1, no: 2 })[b.verdict] || a.name.localeCompare(b.name));
}

let job = null;

function start(manager) {
  if (job?.state === 'running') fail(409, 'A benchmark is already running');
  const busy = manager.servers.filter((s) => !s.node && manager.isActive(s.id)).length;
  job = { state: 'running', startedAt: Date.now(), busy };
  (async () => {
    try {
      const c = await cpu();
      const mem = memory();
      const d = await disk();
      const totalMb = Math.round(os.totalmem() / 1048576);
      const committed = manager.servers.filter((s) => !s.node && manager.isActive(s.id)).reduce((a, s) => a + (s.memory || 0), 0);
      const result = { cpu: c, memory: mem, disk: d, totalMb, model: os.cpus()[0]?.model || '', busyServers: busy };
      job = { state: 'done', startedAt: job.startedAt, finishedAt: Date.now(), busy, result, fits: fits(manager.templates.list(), result, totalMb, committed) };
    } catch (err) {
      job = { state: 'failed', startedAt: job.startedAt, error: err.message };
    }
  })();
  return status();
}

const status = () => job || { state: 'idle' };

module.exports = { start, status, fits, classOf, CLASSES };
