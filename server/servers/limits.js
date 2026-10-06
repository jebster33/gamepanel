'use strict';

/**
 * Panel-wide resource limits, set in Settings → Limits. 0 means no limit.
 *
 *   memoryMb  how much memory the running servers may be capped at, together
 *   cpuCores  the most CPU any one server may use; servers without their own
 *             cap get this one (CPU time is shared, not reserved, so a total
 *             would only block servers that sit idle)
 *   diskGb    how much disk the servers and their backups may take, together
 *
 * Mixed into ServerManager (see manager.js).
 */

const { config } = require('../core/config');
const { fail } = require('../core/util');
const { directorySize } = require('../features/metrics');

const GB = 1024 ** 3;
const gb = (mb) => `${+(mb / 1024).toFixed(1)} GB`;

module.exports = {
  limits() {
    const l = this.store.state.settings.limits || {};
    return { memoryMb: Number(l.memoryMb) || 0, cpuCores: Number(l.cpuCores) || 0, diskGb: Number(l.diskGb) || 0 };
  },

  /** What the limits are measured against right now. */
  usage() {
    let memoryMb = 0;
    let diskBytes = this.backupBytes || 0;
    for (const server of this.servers) {
      if (this.isActive(server.id)) memoryMb += Number(server.memory) || 0;
      diskBytes += this.rt(server.id).diskBytes || 0;
    }
    return { memoryMb, diskBytes };
  },

  /** The CPU cap a server actually runs with, in percent of one core (0 = none). */
  effectiveCpuLimit(server) {
    const panel = this.limits().cpuCores * 100;
    const own = Number(server.cpuLimit) || 0;
    if (!panel) return own;
    return own ? Math.min(own, panel) : panel;
  },

  /** A single server's settings must fit inside the panel limits. */
  checkServerFits(server) {
    const { memoryMb } = this.limits();
    if (memoryMb && Number(server.memory) > memoryMb) {
      fail(400, `${server.name} asks for ${gb(server.memory)} of memory, but the panel limit is ${gb(memoryMb)}. Lower it or raise the limit in Settings.`);
    }
  },

  /** Starting must keep the running servers' memory within the panel limit. */
  checkCanStart(server) {
    const { memoryMb } = this.limits();
    if (!memoryMb) return;
    let used = 0;
    for (const s of this.servers) if (s.id !== server.id && this.isActive(s.id)) used += Number(s.memory) || 0;
    if (used + Number(server.memory) > memoryMb) {
      fail(
        409,
        `Starting ${server.name} would put ${gb(used + Number(server.memory))} of server memory in use, over the panel limit of ${gb(memoryMb)}. Stop another server or raise the limit in Settings.`
      );
    }
  },

  /** Installs, updates and backups need room under the storage limit. */
  checkDiskRoom(action) {
    const { diskGb } = this.limits();
    if (!diskGb) return;
    const used = this.usage().diskBytes;
    if (used >= diskGb * GB) {
      fail(507, `Can't ${action}: servers and backups already use ${(used / GB).toFixed(1)} GB of the ${diskGb} GB storage limit. Free some space or raise the limit in Settings.`);
    }
  },

  async refreshBackupUsage() {
    this.backupBytes = await directorySize(config.backupsDir).catch(() => 0);
  },
};
