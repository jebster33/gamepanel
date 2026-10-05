'use strict';

/**
 * Duplicating a server: same game, version and settings on fresh ports,
 * with or without a copy of its files (worlds, mods, configs).
 * Mixed into ServerManager (see manager.js), so `this` is the manager.
 */

const fsp = require('fs/promises');
const { fail, logger } = require('../core/util');

const CARRY = ['javaOverride', 'resolvedVersion', 'gameVersion', 'idleStopMinutes', 'alerts', 'backupRetention', 'notes', 'installedAt'];

module.exports = {
  async cloneServer(id, { name, copyFiles = true } = {}, actor = null) {
    const source = this.require(id);
    if (!this.template(source)) fail(400, 'The template this server was created from is no longer available');
    if (copyFiles && this.isActive(id)) fail(409, 'Stop the server first so its world is copied cleanly');

    const copy = this.create(
      {
        templateId: source.templateId,
        name: String(name || `${source.name} copy`).trim(),
        ip: source.ip,
        vars: { ...source.vars },
        memory: source.memory,
        cpuLimit: source.cpuLimit,
        maxPlayers: source.maxPlayers,
        autoStart: false,
        autoRestart: source.autoRestart,
        updateOnStart: source.updateOnStart,
        startCommand: source.startCommand,
      },
      actor
    );

    if (!copyFiles) {
      this.install(copy.id).catch((err) => logger.error('Install error:', err.message));
      return { server: this.publicServer(copy) };
    }

    this.setTask?.(copy, 'Copying files');
    try {
      await fsp.cp(source.dir, copy.dir, { recursive: true, force: true, verbatimSymlinks: true });
    } catch (err) {
      this.setTask?.(copy, null);
      fail(500, `Copying the files failed: ${err.message}`);
    }
    this.setTask?.(copy, null);
    for (const key of CARRY) if (source[key] !== undefined) copy[key] = JSON.parse(JSON.stringify(source[key]));
    copy.notes = `Copied from ${source.name}${copy.notes ? `\n${copy.notes}` : ''}`;
    this.store.save();
    this.broadcastServers();
    this.pushConsole(copy, `Copied from ${source.name}. The game's ports are updated on first start.`, 'system');
    return { server: this.publicServer(copy) };
  },
};
