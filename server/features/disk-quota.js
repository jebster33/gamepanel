'use strict';

/**
 * Disk quota per server. server.diskQuota = { gb, block } - warn at 80%, 95%
 * and 100% (once each as the server grows), and optionally refuse to start a
 * server that is over its quota. Size is the server folder (the panel already
 * measures it for the Disk tile); backups are not counted.
 */

const { fail } = require('../core/util');

const LEVELS = [100, 95, 80];

function usage(manager, server) {
  const q = server.diskQuota;
  const used = manager.rt(server.id).diskBytes || 0;
  if (!q?.gb) return { gb: 0, used, pct: null, level: 0, block: false };
  const pct = (used / (q.gb * 1024 ** 3)) * 100;
  return { gb: q.gb, used, pct, level: LEVELS.find((l) => pct >= l) || 0, block: Boolean(q.block) };
}

function set(manager, server, body = {}) {
  const gb = Number(body.gb);
  if (!Number.isFinite(gb) || gb < 0 || gb > 100_000) fail(400, 'The quota is a number of GB (0 turns it off)');
  server.diskQuota = gb ? { gb, block: Boolean(body.block), notified: 0 } : undefined;
  manager.store.save();
  manager.broadcastServers();
  return usage(manager, server);
}

function checkStart(manager, server) {
  const u = usage(manager, server);
  if (u.block && u.level >= 100) fail(409, `${server.name} is over its ${u.gb} GB disk quota. Free some space (the Storage tab shows what is big) or raise the quota on the Tools tab.`);
}

function tick(manager, store) {
  for (const server of manager.servers) {
    if (!server.diskQuota?.gb) continue;
    const u = usage(manager, server);
    const prev = server.diskQuota.notified || 0;
    if (u.level > prev) {
      store.addEvent('server.disk_quota', `${server.name} has used ${u.pct.toFixed(0)}% of its ${u.gb} GB disk quota`, { serverId: server.id });
    }
    if (u.level !== prev) {
      server.diskQuota.notified = u.level;
      store.save();
    }
  }
}

module.exports = { usage, set, checkStart, tick };
