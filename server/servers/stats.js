'use strict';

/**
 * Live numbers for each server: CPU, memory, connections, players, ping and
 * disk use, plus the history behind the charts.
 * Mixed into ServerManager (see manager.js).
 */

const { query } = require('../games/query');
const { sampleProcessTree, cpuPercent, countConnections, directorySize } = require('../features/metrics');
const { STATUS } = require('./constants');

module.exports = {
  collectMetrics() {
    const summary = [];
    for (const server of this.servers) {
      const rt = this.rt(server.id);
      const ports = Object.values(server.ports || {});
      if (rt.docker?.id) {
        // CPU, memory and network arrive from the Docker stats stream.
        rt.connections = countConnections(ports);
      } else if (rt.proc?.pid) {
        const sample = sampleProcessTree(rt.proc.pid);
        if (sample) {
          rt.cpu = cpuPercent(rt.prevCpuSample, sample);
          rt.memory = sample.rss;
          rt.processes = sample.procs;
          rt.prevCpuSample = sample;
        }
        rt.connections = countConnections(ports);
      } else {
        rt.cpu = 0;
        rt.memory = 0;
        rt.connections = 0;
      }
      rt.history.push({
        t: Date.now(),
        cpu: Number(rt.cpu.toFixed(1)),
        mem: rt.memory,
        players: rt.players ?? 0,
        ping: rt.ping ?? 0,
        conns: rt.connections,
        rx: rt.networkRx || 0,
        tx: rt.networkTx || 0,
      });
      summary.push({
        id: server.id,
        status: rt.status,
        cpu: Number(rt.cpu.toFixed(1)),
        memory: rt.memory,
        memoryLimit: server.memory * 1024 * 1024,
        players: rt.players,
        maxPlayers: rt.maxPlayers ?? server.maxPlayers,
        ping: rt.ping,
        connections: rt.connections,
        networkRx: rt.networkRx || 0,
        networkTx: rt.networkTx || 0,
        uptime: rt.startedAt ? Date.now() - rt.startedAt : 0,
      });
    }
    if (summary.length) this.bus.broadcast('stats', { servers: summary });
  },

  getHistory(id) {
    return this.rt(id).history.toArray();
  },

  async refreshDiskUsage() {
    if (this.diskBusy) return;
    this.diskBusy = true;
    try {
      for (const server of this.servers) {
        this.rt(server.id).diskBytes = await directorySize(server.dir).catch(() => 0);
      }
    } finally {
      this.diskBusy = false;
    }
  },

  /** Ask each running server how it is doing over its query protocol. */
  async runQueries() {
    const jobs = this.servers
      .filter((s) => this.rt(s.id).status === STATUS.RUNNING)
      .map(async (server) => {
        const template = this.template(server);
        const q = template?.query;
        const rt = this.rt(server.id);
        // The universal templates let the user pick the protocol per server.
        const type = server.vars?.QUERY_TYPE || q?.type;
        if (!type || type === 'none') return;

        let port = server.ports[q?.port || 'query'] ?? server.ports.game;
        if (q?.portOffset) port = Number(server.ports.game) + Number(q.portOffset);

        const host = server.ip && server.ip !== '0.0.0.0' ? server.ip : '127.0.0.1';
        const result = await query({ type, host, port });
        if (result.online) {
          rt.ping = result.latency;
          rt.queryError = null;
          if (typeof result.players === 'number') rt.players = result.players;
          if (typeof result.maxPlayers === 'number' && result.maxPlayers > 0) rt.maxPlayers = result.maxPlayers;
          if (result.playerList?.length) rt.playerList = result.playerList;
          if (result.version) rt.version = result.version;
          if (result.motd) rt.motd = result.motd;
          if (result.map) rt.map = result.map;
        } else {
          rt.ping = null;
          rt.queryError = result.reason || 'No response';
        }
      });
    await Promise.allSettled(jobs);
  },
};
