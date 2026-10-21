'use strict';

/**
 * CPU core pinning. A server can be kept on certain cores so a busy one never
 * steals time from the others (or from the panel itself):
 *
 *   server.cpuAffinity = '' (off) | 'auto' | '2-5' | '0,1,4'
 *
 * 'auto' gives each auto-pinned server its own block of cores, in the order
 * the servers were created, sized from its CPU limit (two cores when it has
 * none) and leaving core 0 to the system on hosts with four cores or more.
 * Blocks wrap around when there are more servers than cores.
 *
 * Linux processes: taskset. Linux containers: the container's cpuset.
 * Windows processes: the process's affinity mask (PowerShell).
 */

const os = require('os');
const { fail, logger } = require('../core/util');
const { run, powershell, isWindows, isLinux } = require('../core/platform');

const SPEC = /^(\d{1,3}(-\d{1,3})?)(,\d{1,3}(-\d{1,3})?)*$/;

const coreCount = () => os.cpus().length || 1;

/** "0-2,5" → [0,1,2,5], dropping cores the host does not have. */
function parse(spec, cores = coreCount()) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let i = a; i <= (b ?? a) && i - a < 1024; i++) if (i < cores) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

const format = (list) => {
  const ranges = [];
  for (const n of list) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',');
};

function validate(spec) {
  const text = String(spec ?? '').trim().toLowerCase();
  if (!text || text === 'off') return '';
  if (text === 'auto') return 'auto';
  if (!SPEC.test(text)) fail(400, 'Use cores like 0-3 or 2,3,6, or "auto"');
  if (!parse(text).length) fail(400, `This machine has ${coreCount()} core${coreCount() === 1 ? '' : 's'} (0-${coreCount() - 1})`);
  return format(parse(text));
}

/** Core blocks for every auto-pinned server: { serverId: '2-3' }. */
function autoPlan(servers, cores = coreCount()) {
  const reserved = cores >= 4 ? 1 : 0;
  const pool = cores - reserved;
  const plan = {};
  let next = 0;
  for (const s of servers.filter((x) => x.cpuAffinity === 'auto')) {
    const want = Math.max(1, Math.min(pool, Math.ceil((Number(s.cpuLimit) || 200) / 100)));
    const list = [];
    for (let i = 0; i < want; i++) list.push(reserved + ((next + i) % pool));
    next += want;
    plan[s.id] = format([...new Set(list)].sort((a, b) => a - b));
  }
  return plan;
}

/** The cores a server should be on, or '' for no pinning. */
function coresFor(manager, server) {
  if (!server.cpuAffinity || !isSupported()) return '';
  if (server.cpuAffinity === 'auto') return autoPlan(manager.servers.filter((s) => !s.node))[server.id] || '';
  return format(parse(server.cpuAffinity));
}

const isSupported = () => isLinux || isWindows;

/** Pin a running process (container servers get the cpuset at creation). */
async function apply(manager, server) {
  const cores = coresFor(manager, server);
  const rt = manager.rt(server.id);
  if (!cores || manager.runtimeFor(server) === 'docker' || !rt.pid) return { cores, applied: false };
  try {
    let r;
    if (isWindows) {
      const mask = parse(cores).reduce((m, c) => m + 2 ** c, 0);
      r = await powershell(`(Get-Process -Id ${Number(rt.pid)}).ProcessorAffinity = ${mask}`, { timeout: 10_000 });
    } else {
      // -a: every thread of the process, so threads the game starts later inherit it too.
      r = await run('taskset', ['-a', '-c', '-p', cores, String(Number(rt.pid))], { timeout: 10_000 });
    }
    if (r.code !== 0) throw new Error((r.stderr || r.error || `exit ${r.code}`).trim());
    manager.pushConsole(server, `CPU cores: pinned to ${cores}`, 'system');
    return { cores, applied: true };
  } catch (err) {
    logger.warn(`Could not pin ${server.name} to cores ${cores}: ${err.message}`);
    manager.pushConsole(server, `CPU cores: could not pin (${err.message.split('\n')[0]})`, 'system');
    return { cores, applied: false, error: err.message };
  }
}

function view(manager, server) {
  return { cores: coreCount(), supported: isSupported(), spec: server.cpuAffinity || '', resolved: coresFor(manager, server), plan: autoPlan(manager.servers.filter((s) => !s.node)), docker: manager.runtimeFor(server) === 'docker' };
}

module.exports = { validate, parse, format, autoPlan, coresFor, apply, view, coreCount };
