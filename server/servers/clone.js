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
const PORTABLE = ['templateId', 'name', 'vars', 'memory', 'cpuLimit', 'maxPlayers', 'autoRestart', 'updateOnStart', 'autoUpdate', 'startCommand', 'schedules', 'javaOverride', 'gameVersion', 'idleStopMinutes', 'hangRestartMinutes', 'alerts', 'backupRetention', 'notes', 'wakeOnJoin'];

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
  async exportServer(server, res, { forMove = false } = {}) {
    const { proc } = await this.exportStream(server, { unseal: forMove });
    const file = `${server.name.replace(/[^A-Za-z0-9._-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${file}"` });
    proc.stdout.pipe(res);
    proc.on('error', () => res.destroy());
    res.on('close', () => proc.kill());
    this.store.addEvent('server.exported', `${server.name} was ${forMove ? 'sent to another node' : 'exported'}`, { serverId: server.id });
  },

  /**
   * The export as a running tar process. `unseal` writes secret variables in
   * the clear, for a move to another node: they are sealed with this panel's
   * key, which the other one does not have. Downloads keep them sealed.
   */
  async exportStream(server, { unseal = false } = {}) {
    const manifest = { format: 1, exportedAt: new Date().toISOString(), panelVersion: require('../../package.json').version };
    for (const key of PORTABLE) if (server[key] !== undefined) manifest[key] = JSON.parse(JSON.stringify(server[key]));
    if (unseal && manifest.vars) {
      const secrets = require('../core/secrets');
      for (const [k, v] of Object.entries(manifest.vars)) manifest.vars[k] = secrets.open(v);
    }
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gp-export-'));
    await fsp.writeFile(path.join(tmp, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const proc = spawn(TAR, ['-czf', '-', '-C', tmp, MANIFEST, '-C', server.dir, '.'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    proc.on('close', () => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}));
    return { proc, stream: proc.stdout };
  },

  /**
   * The other end of a move (or any export): unpack an export arriving as a
   * stream into a new server. The archive is checked before anything is
   * unpacked, like uploads are.
   */
  async receiveServer(stream, actor, { name } = {}) {
    const { config } = require('../core/config');
    const { pipeline } = require('stream/promises');
    const files = require('../features/files');
    this.checkDiskRoom('receive a server');
    const tmp = path.join(config.serversDir, `.incoming-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    const unpacked = path.join(tmp, 'files');
    await fsp.mkdir(unpacked, { recursive: true });
    try {
      const archive = path.join(tmp, 'incoming.tar.gz');
      await pipeline(stream, fs.createWriteStream(archive));
      files.assertArchiveIsSafe(archive, tmp);
      await new Promise((resolve, reject) => {
        const proc = spawn(TAR, ['-xzf', archive, '-C', unpacked, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let err = '';
        proc.stderr.on('data', (c) => (err += c));
        proc.on('error', reject);
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n')[0] || `tar exited with ${code}`))));
      });
      await fsp.rm(archive, { force: true });
      const manifest = this.readManifest(unpacked);
      if (!manifest) fail(400, 'This is not a GamePanel server export');
      if (!this.templates.get(manifest.templateId)) fail(400, `This server needs the ${manifest.templateId} template, which this panel does not have`);
      const server = this.create({ ...manifest, name: name || manifest.name, autoStart: false }, actor);
      for (const key of ['schedules', 'javaOverride', 'gameVersion', 'idleStopMinutes', 'hangRestartMinutes', 'alerts', 'backupRetention', 'notes', 'wakeOnJoin']) if (manifest[key] !== undefined) server[key] = manifest[key];
      // Secrets arrive in the clear (see exportStream): seal them with this panel's key.
      const secrets = require('../core/secrets');
      for (const k of secrets.secretNames(this.template(server))) if (server.vars?.[k]) server.vars[k] = secrets.seal(secrets.open(server.vars[k]));
      await fsp.rm(server.dir, { recursive: true, force: true });
      await fsp.rename(unpacked, server.dir);
      fs.rmSync(path.join(server.dir, MANIFEST), { force: true });
      server.installedAt = Date.now();
      const template = this.template(server);
      if (template) this.writeConfigFiles(server, template, { overwrite: false });
      this.store.save();
      this.broadcastServers();
      this.store.addEvent('server.received', `${server.name} arrived from another node`, { serverId: server.id });
      return server;
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
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
