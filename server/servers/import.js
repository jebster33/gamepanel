'use strict';

/**
 * Bringing a server that already exists on this machine under the panel:
 * point it at the folder and pick the game. Either the panel uses the folder
 * where it is, or copies it into its own servers directory.
 * Mixed into ServerManager (see manager.js).
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { fail, logger } = require('../core/util');
const { STATUS } = require('./constants');

/** Ports the server is already using, so players' saved addresses keep working. */
function detectPorts(dir) {
  const ports = {};
  try {
    const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    const port = props.match(/^server-port\s*=\s*(\d+)/m)?.[1];
    if (port) ports.game = Number(port);
    const rcon = props.match(/^rcon\.port\s*=\s*(\d+)/m)?.[1];
    if (rcon) ports.rcon = Number(rcon);
  } catch {
    /* not a Minecraft-style server */
  }
  return ports;
}

// Never treat these (or anything in them) as a game server's folder.
const SYSTEM_DIRS = new Set(['etc', 'usr', 'bin', 'sbin', 'lib', 'lib32', 'lib64', 'boot', 'dev', 'proc', 'sys', 'run', 'windows', 'program files', 'program files (x86)', 'programdata']);

function checkFolder(dir) {
  if (!dir || !path.isAbsolute(dir)) fail(400, 'Enter the full path of the server folder, like /home/me/minecraft or D:\\Servers\\Valheim');
  const resolved = path.resolve(dir);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fail(400, `The panel cannot see ${resolved}. Check the path, and that the panel's service account can read it.`);
  }
  if (!stat.isDirectory()) fail(400, `${resolved} is a file, not a folder`);
  const inside = (parent) => resolved === parent || resolved.startsWith(parent + path.sep);
  const parts = resolved.slice(path.parse(resolved).root.length).split(path.sep).filter(Boolean);
  if (
    parts.length < 2 ||
    SYSTEM_DIRS.has(parts[0].toLowerCase()) ||
    inside(config.backupsDir) ||
    resolved === config.dataDir ||
    resolved === config.serversDir ||
    inside(config.rootDir)
  ) {
    fail(400, 'Pick the folder of one game server, not a system or panel folder');
  }
  return resolved;
}

module.exports = {
  async importExisting(input, actor) {
    const source = checkFolder(String(input.path || '').trim());
    const inPlace = input.mode !== 'copy';
    if (inPlace && this.servers.some((s) => path.resolve(s.dir) === source)) fail(409, 'Another server already uses that folder');

    // An export from another GamePanel says which game it is and how it was set up.
    const manifest = this.readManifest(source);
    if (manifest && !this.templates.get(manifest.templateId)) fail(400, `This export needs the ${manifest.templateId} template, which this panel does not have`);
    const ports = { ...detectPorts(source), ...(input.ports || {}) };
    const server = this.create(
      {
        ...input,
        ...(manifest || {}),
        name: input.name || manifest?.name,
        ports,
        startCommand: input.startCommand?.trim() || manifest?.startCommand || null,
        autoStart: false,
      },
      actor,
      inPlace ? { dir: source } : {}
    );
    server.imported = { from: source, inPlace, at: Date.now() };
    if (manifest) {
      for (const key of ['schedules', 'javaOverride', 'gameVersion', 'idleStopMinutes', 'alerts', 'backupRetention', 'notes']) if (manifest[key] !== undefined) server[key] = manifest[key];
      server.imported.fromExport = true;
    }
    this.store.save();

    if (inPlace) this.finishImport(server, source);
    // Copying a big world can take a while: the console shows it, the request does not wait.
    else this.copyIn(server, source).then((ok) => ok && this.finishImport(server, source));
    return server;
  },

  async copyIn(server, source) {
    this.setStatus(server, STATUS.INSTALLING);
    this.setTask(server, 'Copying files');
    this.pushConsole(server, `Copying ${source} into ${server.dir}…`, 'system');
    try {
      await fs.promises.cp(source, server.dir, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: false });
      this.setTask(server, null);
      return true;
    } catch (err) {
      this.setTask(server, null);
      this.setStatus(server, STATUS.INSTALL_FAILED);
      this.pushConsole(server, `Copy failed: ${err.message}`, 'system');
      logger.error(`Import copy failed for ${server.name}: ${err.message}`);
      return false;
    }
  },

  finishImport(server, source) {
    const inPlace = server.imported.inPlace;
    const template = this.template(server);
    server.installedAt = Date.now();
    if (server.imported.fromExport) fs.rmSync(path.join(server.dir, 'gamepanel-server.json'), { force: true });
    // Only fills in config files the server does not have yet.
    if (template) this.writeConfigFiles(server, template, { overwrite: false });
    this.store.save();
    this.setStatus(server, STATUS.OFFLINE);
    this.pushConsole(
      server,
      `Imported from ${source}${inPlace ? ' (files stay where they are)' : ''}. ${
        server.startCommand ? 'Using your start command.' : `Starting it the ${template?.name || 'template'} way; set a start command in Settings if it launches differently.`
      }`,
      'system'
    );
    this.store.addEvent('server.imported', `${server.name} imported from ${source}`, { serverId: server.id });
  },
};
