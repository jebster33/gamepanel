'use strict';

/**
 * A live web map of the world (BlueMap) for Paper and Purpur: installs the
 * plugin from Modrinth, gives its web server a port of its own and keeps it
 * there, and accepts BlueMap's texture download once the admin agrees.
 * Mixed into ServerManager (see manager.js), so `this` is the manager.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { fail } = require('../core/util');
const { containedPath } = require('../features/files');

const SUPPORTED = ['minecraft-paper', 'minecraft-purpur'];
const DIR = 'plugins/BlueMap';

function jarOf(server) {
  try {
    return fs.readdirSync(containedPath(server.dir, 'plugins')).find((f) => /^bluemap.*\.jar$/i.test(f)) || null;
  } catch {
    return null;
  }
}

/** Replace `key: value` (HOCON) in a BlueMap config file, or add it. */
function setConfValue(text, key, value) {
  const re = new RegExp(`^(\\s*${key}\\s*[:=]\\s*).*$`, 'm');
  return re.test(text) ? text.replace(re, `$1${value}`) : `${text.trim() ? text.replace(/\s*$/, '\n') : ''}${key}: ${value}\n`;
}

function writeConf(server, file, values) {
  const full = containedPath(server.dir, `${DIR}/${file}`);
  let text = '';
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    fs.mkdirSync(path.dirname(full), { recursive: true });
  }
  let next = text;
  for (const [key, value] of Object.entries(values)) next = setConfValue(next, key, value);
  if (next !== text) fs.writeFileSync(full, next);
}

module.exports = {
  mapInfo(server) {
    if (!SUPPORTED.includes(server.templateId)) return { supported: false };
    return { supported: true, installed: Boolean(jarOf(server)), port: server.ports?.map || null };
  },

  async enableMap(id, actor) {
    const server = this.require(id);
    if (!SUPPORTED.includes(server.templateId)) fail(400, 'The live map works on Paper and Purpur servers. Switch the server type first.');
    if (!jarOf(server)) {
      const mods = require('../features/mods');
      await mods.install(server, this.template(server), { provider: 'modrinth', projectId: 'bluemap', liveVersion: this.rt(id).version }, this.store.state.settings.integrations || {});
    }
    if (!server.ports.map) server.ports.map = this.allocatePort(8100, this.usedPorts());
    this.patchMap(server);
    this.store.save();
    this.broadcastServers();
    this.store.addEvent('server.settings', `${actor?.username || 'Someone'} turned on the live map for ${server.name} (port ${server.ports.map})`, { serverId: id });
    return { ...this.mapInfo(server), restartNeeded: this.isActive(id) };
  },

  async disableMap(id, actor) {
    const server = this.require(id);
    const jar = jarOf(server);
    if (jar) await fsp.rm(containedPath(server.dir, `plugins/${jar}`), { force: true });
    delete server.ports.map;
    this.store.save();
    this.broadcastServers();
    this.store.addEvent('server.settings', `${actor?.username || 'Someone'} turned off the live map for ${server.name}`, { serverId: id });
    return { ...this.mapInfo(server), restartNeeded: this.isActive(id) };
  },

  /**
   * Before each start: BlueMap on the panel's port, with its download of
   * Minecraft's textures accepted (the admin agreed when turning it on).
   */
  patchMap(server) {
    if (!server.ports?.map || !jarOf(server)) return;
    try {
      writeConf(server, 'core.conf', { 'accept-download': 'true' });
      writeConf(server, 'webserver.conf', { port: server.ports.map });
    } catch {
      /* the plugin folder is not writable; BlueMap will say so in the console */
    }
  },
};

module.exports.setConfValue = setConfValue;
