'use strict';

/**
 * Capacity view: for each machine, how much memory, CPU and disk it has, how much
 * each server reserves (its memory cap, its CPU cap) and how much it really uses.
 * Administrators only: it shows every server on every node.
 */

const { STATUS } = require('../servers/constants');

const ACTIVE = new Set([STATUS.STARTING, STATUS.RUNNING, STATUS.STOPPING]);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function entry(s, active, cpuCapPercent) {
  return {
    id: s.id,
    name: s.name,
    game: s.templateName || s.templateId || '',
    active,
    memReserved: num(s.memoryLimit) || num(s.memory) * 1024 * 1024 || num(s.memoryMb) * 1024 * 1024,
    memUsed: active ? num(s.memory) : 0,
    cpuCap: num(cpuCapPercent) / 100, // cores, 0 = no cap
    cpuUsed: active ? num(s.cpu) / 100 : 0,
    disk: num(s.diskBytes),
  };
}

function machine(name, local, host, servers, extra = {}) {
  return {
    name,
    local,
    online: true,
    memory: { total: num(host?.memory?.total), used: num(host?.memory?.used) },
    cpu: { cores: num(host?.cores ?? host?.cpu?.cores), percent: num(typeof host?.cpu === 'object' ? host.cpu.percent : host?.cpu) },
    disk: { total: num(host?.disk?.total), used: num(host?.disk?.used) },
    servers,
    ...extra,
  };
}

function build({ manager, nodes, hostMetrics }) {
  const host = hostMetrics.last;
  const local = manager.servers.map((s) => entry(manager.publicServer(s), manager.isActive(s.id), manager.effectiveCpuLimit(s)));
  const machines = [machine(nodes?.localName || 'This machine', true, host, local)];
  for (const node of nodes?.list || []) {
    const live = nodes.live.get(node.id) || {};
    machines.push(
      machine(node.name, false, live.host, (live.servers || []).map((s) => entry(s, ACTIVE.has(s.status), s.cpuLimit)), { online: Boolean(live.online) })
    );
  }
  return { machines, limits: manager.limits() };
}

module.exports = { build };
