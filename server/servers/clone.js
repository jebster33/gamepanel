'use strict';

/**
 * Duplicating a server: same game, version and settings on fresh ports,
 * with or without a copy of its files (worlds, mods, configs). Also exporting
 * a server as one archive that another panel can import.
 * Mixed into ServerManager (see manager.js), so `this` is the manager.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fail, logger } = require('../core/util');

const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const MANIFEST = 'gamepanel-server.json';
// Settings an export carries to another panel. Ports are not: the new panel picks free ones.
const PORTABLE = ['templateId', 'name', 'vars', 'memory', 'cpuLimit', 'maxPlayers', 'autoRestart', 'updateOnStart', 'startCommand', 'schedules', 'javaOverride', 'gameVersion', 'idleStopMinutes', 'hangRestartMinutes', 'alerts', 'backupRetention', 'notes'];

const CARRY = ['javaOverride', 'resolvedVersion', 'gameVersion', 'idleStopMinutes', 'hangRestartMinutes', 'alerts', 'backupRetention', 'notes', 'installedAt'];

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

  /**
   * The whole server as one .tar.gz, with a gamepanel-server.json describing
   * its game and settings, so another panel can import it as-is.
   */
  async exportServer(server, res) {
    const manifest = { format: 1, exportedAt: new Date().toISOString(), panelVersion: require('../../package.json').version };
    for (const key of PORTABLE) if (server[key] !== undefined) manifest[key] = server[key];
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gp-export-'));
    await fsp.writeFile(path.join(tmp, MANIFEST), JSON.stringify(manifest, null, 2));
    const file = `${server.name.replace(/[^A-Za-z0-9._-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${file}"` });
    const proc = spawn(TAR, ['-czf', '-', '-C', tmp, MANIFEST, '-C', server.dir, '.'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    proc.stdout.pipe(res);
    const tidy = () => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    proc.on('error', () => res.destroy());
    proc.on('close', tidy);
    res.on('close', () => proc.kill());
    this.store.addEvent('server.exported', `${server.name} was exported`, { serverId: server.id });
  },

  /** Settings from an export's gamepanel-server.json, if the folder has one. */
  readManifest(dir) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
      if (data?.format !== 1 || typeof data.templateId !== 'string') return null;
      const out = {};
      for (const key of PORTABLE) if (data[key] !== undefined) out[key] = data[key];
      return out;
    } catch {
      return null;
    }
  },
};
