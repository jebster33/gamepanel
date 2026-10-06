'use strict';

/**
 * Memory and settings advice for one server, from what the panel already
 * knows: its memory and player history, crashes, the console, how many mods
 * or plugins it loads, its TPS and its server.properties. Each piece of
 * advice says why, and the safe ones can be applied with one click.
 *
 * Advice: { id, level: 'warn'|'tip'|'good', title, detail, action?: { kind: 'memory'|'property'|'var', key?, value, label } }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fail } = require('../core/util');

const MB = 1024 * 1024;
const roundUp = (mb, step = 512) => Math.ceil(mb / step) * step;
const gb = (mb) => (mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

// Aikar's flags (mcflags.emc.gs), without the options newer Java versions no longer accept.
function aikar(memoryMb) {
  const big = memoryMb >= 12288;
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    `-XX:G1NewSizePercent=${big ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${big ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${big ? 16 : 8}M`,
    `-XX:G1ReservePercent=${big ? 15 : 20}`,
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${big ? 20 : 15}`,
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true',
  ].join(' ');
}

/** The end of a text file (logs can be huge). */
function tail(file, bytes = 2 * MB) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

const countJars = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => /\.jar$/i.test(f)).length;
  } catch {
    return 0;
  }
};

function recentCrashText(server, days = 7) {
  const dir = path.join(server.dir, 'crash-reports');
  try {
    return fs
      .readdirSync(dir)
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((x) => Date.now() - x.t < days * 86400_000)
      .slice(-5)
      .map((x) => tail(path.join(dir, x.f), 64 * 1024))
      .join('\n');
  } catch {
    return '';
  }
}

/** What the panel knows about the server, in plain numbers. */
function facts(manager, server) {
  const template = manager.template(server);
  const rt = manager.rt(server.id);
  const id = template?.id || server.templateId;
  const minecraft = /^minecraft-(?!bedrock$)/.test(id) && id !== 'minecraft-velocity';
  const modded = /^minecraft-(fabric|forge|neoforge|quilt|modpack)$/.test(id);
  const week = manager.getHistory(server.id, '7d');
  const day = manager.getHistory(server.id, '24h');
  const memPeak = week.reduce((m, p) => Math.max(m, p.memMax || p.mem || 0), 0) / MB;
  const playersPeak = Math.max(0, ...week.map((p) => p.playersMax ?? p.players ?? 0), ...day.map((p) => p.playersMax ?? p.players ?? 0));
  const span = week.length ? (week.at(-1).t - week[0].t) / 86400_000 : 0;
  const cpuAvg = day.length ? day.reduce((n, p) => n + (p.cpu || 0), 0) / day.length : null;
  const props = minecraft ? manager.readProperties(server) : '';
  const prop = (k) => (props.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
  const log = minecraft ? tail(path.join(server.dir, 'logs', 'latest.log')) : '';
  return {
    template,
    minecraft,
    modded,
    paper: /^minecraft-(paper|purpur)$/.test(id),
    memory: Number(server.memory) || 0,
    memPeak: Math.round(memPeak),
    days: +span.toFixed(1),
    playersPeak,
    cpuAvg: cpuAvg === null ? null : +cpuAvg.toFixed(1),
    cpuLimit: Number(server.cpuLimit) || 0,
    cores: os.cpus().length,
    mods: modded ? countJars(path.join(server.dir, 'mods')) : 0,
    plugins: minecraft && !modded ? countJars(path.join(server.dir, 'plugins')) : 0,
    tps: rt.tps ?? null,
    lagLines: (log.match(/Can't keep up!/g) || []).length,
    oom: /java\.lang\.OutOfMemoryError|There is insufficient memory for the Java Runtime/.test(`${log}\n${recentCrashText(server)}`),
    viewDistance: Number(prop('view-distance')) || null,
    simulationDistance: Number(prop('simulation-distance')) || null,
    syncChunkWrites: prop('sync-chunk-writes'),
    maxPlayers: Number(prop('max-players')) || Number(server.maxPlayers) || null,
    javaArgs: server.vars?.JAVA_ARGS ?? (template?.variables || []).find((v) => v.name === 'JAVA_ARGS')?.default ?? null,
    hasJavaArgs: (template?.variables || []).some((v) => v.name === 'JAVA_ARGS'),
    hostMb: Math.round(os.totalmem() / MB),
    committedMb: manager.servers.filter((s) => s.id === server.id || s.autoStart || manager.isActive(s.id)).reduce((n, s) => n + (Number(s.memory) || 0), 0),
  };
}

/** Roughly what a Minecraft server needs, by mods or plugins and players. */
function minecraftNeed(f) {
  const players = Math.max(f.playersPeak, 4);
  const base = f.modded ? 4096 + Math.min(f.mods, 400) * 20 : 2048 + Math.min(f.plugins, 100) * 24;
  return Math.min(16384, Math.max(1024, roundUp(base + Math.ceil(players / 10) * (f.modded ? 768 : 512))));
}

function advise(manager, server) {
  const f = facts(manager, server);
  const out = [];
  const add = (a) => out.push(a);

  /* ---- memory ---- */
  if (f.minecraft) {
    const need = minecraftNeed(f);
    const why = f.modded ? `${f.mods} mods` : `${f.plugins} plugin${f.plugins === 1 ? '' : 's'}`;
    if (f.oom) {
      const to = Math.min(32768, roundUp(Math.max(need, f.memory * 1.5)));
      add({ id: 'mem-oom', level: 'warn', title: 'It ran out of memory', detail: `The logs or a crash report from the last week show an out-of-memory error. Give it ${gb(to)} instead of ${gb(f.memory)}.`, action: { kind: 'memory', value: to, label: `Use ${gb(to)}` } });
    } else if (f.memory < need * 0.75) {
      add({ id: 'mem-low', level: 'warn', title: 'Probably too little memory', detail: `With ${why} and up to ${f.playersPeak} players online, about ${gb(need)} is a good start; it has ${gb(f.memory)}. Low memory shows up as lag spikes and then crashes.`, action: { kind: 'memory', value: need, label: `Use ${gb(need)}` } });
    } else if (f.memory > Math.max(need * 2, 8192)) {
      const to = roundUp(Math.max(need * 1.25, 4096));
      add({ id: 'mem-high', level: 'tip', title: 'More memory than it needs', detail: `About ${gb(need)} is plenty for ${why} and ${f.playersPeak} players; it has ${gb(f.memory)}. Java uses whatever it is given, and a very large heap means longer pauses. The rest could go to other servers.`, action: { kind: 'memory', value: to, label: `Use ${gb(to)}` } });
    }
  } else if (f.days >= 1 && f.memPeak > f.memory * 0.9 && f.memory) {
    const to = roundUp(f.memPeak * 1.3);
    add({ id: 'mem-peak', level: 'warn', title: 'Memory is nearly full', detail: `It peaked at ${gb(f.memPeak)} of ${gb(f.memory)} this week. Close to the limit the game slows down or gets stopped.`, action: { kind: 'memory', value: to, label: `Use ${gb(to)}` } });
  } else if (f.days >= 3 && f.memory >= 2048 && f.memPeak > 0 && f.memPeak < f.memory * 0.35) {
    const to = Math.max(1024, roundUp(f.memPeak * 1.6));
    add({ id: 'mem-spare', level: 'tip', title: 'Memory to spare', detail: `It never used more than ${gb(f.memPeak)} of its ${gb(f.memory)} in ${Math.floor(f.days)} days. ${gb(to)} would still leave room.`, action: { kind: 'memory', value: to, label: `Use ${gb(to)}` } });
  }
  if (f.committedMb > f.hostMb * 0.9) {
    add({ id: 'host-full', level: 'warn', title: 'More memory promised than the machine has', detail: `Servers that run or start on their own are set to ${gb(f.committedMb)} together; this machine has ${gb(f.hostMb)}. When they all run, the system starts swapping or kills one.` });
  }

  /* ---- Java ---- */
  if (f.minecraft && f.hasJavaArgs && f.memory >= 4096 && !/G1NewSizePercent/.test(f.javaArgs || '') && f.template?.id !== 'minecraft-modpack') {
    add({ id: 'java-aikar', level: 'tip', title: "Use Aikar's flags", detail: 'Tuned Java garbage-collector settings that most Minecraft hosts use. They cut the short freezes Java causes while cleaning up memory. Takes effect on the next start.', action: { kind: 'var', key: 'JAVA_ARGS', value: aikar(f.memory), label: 'Use them' } });
  }

  /* ---- lag ---- */
  const lagging = (f.tps !== null && f.tps < 18) || f.lagLines >= 20;
  if (lagging) {
    add({
      id: 'lag',
      level: 'warn',
      title: f.tps !== null && f.tps < 18 ? `The server is lagging (${f.tps} TPS)` : 'The server is falling behind',
      detail: `${f.lagLines ? `"Can't keep up" appears ${f.lagLines} times in the current log. ` : ''}Common causes: generating new chunks while players explore (pregenerate the world on the Game settings tab), high view distances, and heavy farms or plugins.${f.paper ? ' The spark plugin shows exactly what takes the time.' : ''}`,
    });
  }
  if (f.minecraft && f.viewDistance && f.viewDistance > 10 && (lagging || f.playersPeak >= 10)) {
    const to = lagging ? 8 : 10;
    add({ id: 'view-distance', level: 'tip', title: `View distance ${f.viewDistance} is high`, detail: `Every extra step loads more chunks around every player. ${to} looks almost the same and is much lighter.`, action: { kind: 'property', key: 'view-distance', value: String(to), label: `Set to ${to}` } });
  }
  if (f.minecraft && f.simulationDistance && f.simulationDistance > 6 && lagging) {
    add({ id: 'simulation-distance', level: 'tip', title: `Simulation distance ${f.simulationDistance}`, detail: 'How far away from players mobs move and crops grow. 6 is usually enough and saves a lot.', action: { kind: 'property', key: 'simulation-distance', value: '6', label: 'Set to 6' } });
  }
  if (f.minecraft && f.syncChunkWrites === 'true' && !f.modded) {
    add({ id: 'sync-chunk-writes', level: 'tip', title: 'Chunks are saved while the game waits', detail: 'With sync-chunk-writes off, saving happens in the background. Hosts and Paper recommend it; the server still saves everything on a normal stop.', action: { kind: 'property', key: 'sync-chunk-writes', value: 'false', label: 'Turn it off' } });
  }
  if (f.minecraft && f.maxPlayers > 50 && f.memory < 4096) {
    add({ id: 'max-players', level: 'tip', title: `Room for ${f.maxPlayers} players on ${gb(f.memory)}`, detail: 'If that many players ever come, it will not hold. Either lower the player limit or plan for more memory.' });
  }

  /* ---- CPU ---- */
  const cpuCap = (f.cpuLimit || f.cores * 100) * 0.8;
  if (f.cpuAvg !== null && f.cpuAvg > cpuCap) {
    add({ id: 'cpu-busy', level: 'warn', title: 'The CPU is busy all day', detail: `It averaged ${f.cpuAvg}% over the last day${f.cpuLimit ? `, against a limit of ${f.cpuLimit}%` : ''}. ${f.cpuLimit ? 'Raise the CPU limit in Settings, or' : 'Consider'} moving it to a less busy machine.` });
  }

  if (!out.some((a) => a.level !== 'good')) add({ id: 'ok', level: 'good', title: 'Nothing to change', detail: f.days < 1 ? 'Run it for a day or so and this gets more precise.' : 'Memory, CPU and settings look right for how it is used.' });
  const order = { warn: 0, tip: 1, good: 2 };
  out.sort((a, b) => order[a.level] - order[b.level]);
  const { template, ...shown } = f;
  return { advice: out, facts: { ...shown, javaArgs: undefined, need: f.minecraft ? minecraftNeed(f) : null } };
}

/** Apply one piece of advice by id. */
function apply(manager, store, server, id, actor) {
  const item = advise(manager, server).advice.find((a) => a.id === id);
  if (!item?.action) fail(404, 'That advice no longer applies');
  const a = item.action;
  if (a.kind === 'memory') manager.update(server.id, { memory: a.value });
  else if (a.kind === 'var') manager.update(server.id, { vars: { [a.key]: a.value } });
  else if (a.kind === 'property') manager.setProperties(server, { [a.key]: a.value });
  store.addEvent('server.settings', `${actor} applied advice on ${server.name}: ${item.title} (${a.label})`, { serverId: server.id });
  return { ok: true, applied: item.title, restartNeeded: manager.isActive(server.id) };
}

module.exports = { advise, apply, facts, minecraftNeed, aikar };
