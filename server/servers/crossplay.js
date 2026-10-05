'use strict';

/**
 * Bedrock crossplay for Paper and Purpur: installs Geyser (lets Bedrock
 * phones, consoles and Windows players join) and Floodgate (so they do not
 * need a Java account), on its own UDP port. ViaVersion comes along when
 * missing, since Geyser always speaks the newest Java version.
 * Mixed into ServerManager (see manager.js), so `this` is the manager.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { fail } = require('../core/util');
const { containedPath } = require('../features/files');
const { downloadTo } = require('../features/mods/http');

const SUPPORTED = ['minecraft-paper', 'minecraft-purpur'];
const DOWNLOADS = {
  geyser: { file: 'Geyser-Spigot.jar', url: 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot' },
  floodgate: { file: 'floodgate-spigot.jar', url: 'https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot' },
};
const CONFIG = 'plugins/Geyser-Spigot/config.yml';

/** Set `port:` inside the top-level `bedrock:` block, keeping everything else. */
function patchGeyserPort(text, port) {
  const lines = text.split(/\r?\n/);
  let inBedrock = false;
  let done = false;
  const out = lines.map((line) => {
    if (/^\S/.test(line)) inBedrock = /^bedrock:\s*$/.test(line);
    if (inBedrock && !done && /^\s+port:\s*\d+/.test(line)) {
      done = true;
      return line.replace(/port:\s*\d+/, `port: ${port}`);
    }
    return line;
  });
  return out.join('\n');
}

module.exports = {
  crossplayInfo(server) {
    if (!SUPPORTED.includes(server.templateId)) return { supported: false };
    const has = (name) => fs.existsSync(containedPath(server.dir, `plugins/${DOWNLOADS[name].file}`));
    return { supported: true, geyser: has('geyser'), floodgate: has('floodgate'), port: server.ports?.bedrock || null };
  },

  async enableCrossplay(id, actor) {
    const server = this.require(id);
    if (!SUPPORTED.includes(server.templateId)) fail(400, 'Crossplay works on Paper and Purpur servers. Switch the server type first.');
    const plugins = containedPath(server.dir, 'plugins');
    await fsp.mkdir(plugins, { recursive: true });
    for (const { file, url } of Object.values(DOWNLOADS)) {
      const temp = path.join(plugins, `.${file}.download`);
      await downloadTo(url, temp);
      await fsp.rename(temp, path.join(plugins, file));
    }
    // Geyser speaks the newest Java protocol; ViaVersion bridges older servers to it.
    const hasVia = (await fsp.readdir(plugins)).some((f) => /^ViaVersion.*\.jar$/i.test(f));
    if (!hasVia) {
      const via = await require('../features/mods/providers/hangar')
        .best({ projectId: '31', ctx: { gameVersion: this.gameVersion?.(server) || null } })
        .catch(() => null);
      if (via?.file) {
        const temp = path.join(plugins, `.${via.file.filename}.download`);
        await downloadTo(via.file.url, temp);
        await fsp.rename(temp, path.join(plugins, via.file.filename));
      }
    }
    if (!server.ports.bedrock) server.ports.bedrock = this.allocatePort(19132, this.usedPorts());
    const config = containedPath(server.dir, CONFIG);
    if (!fs.existsSync(config)) {
      // Geyser fills in every other setting on first start.
      await fsp.mkdir(path.dirname(config), { recursive: true });
      await fsp.writeFile(config, `bedrock:\n  port: ${server.ports.bedrock}\nremote:\n  auth-type: floodgate\n`);
    }
    this.store.save();
    this.broadcastServers();
    this.logActivity?.(id, { type: 'crossplay', text: 'Bedrock crossplay turned on', by: actor?.username });
    this.store.addEvent('server.settings', `${actor?.username || 'Someone'} turned on Bedrock crossplay for ${server.name} (UDP ${server.ports.bedrock})`, { serverId: id });
    return { ...this.crossplayInfo(server), restartNeeded: this.isActive(id) };
  },

  async disableCrossplay(id, actor) {
    const server = this.require(id);
    for (const { file } of Object.values(DOWNLOADS)) await fsp.rm(containedPath(server.dir, `plugins/${file}`), { force: true });
    delete server.ports.bedrock;
    this.store.save();
    this.broadcastServers();
    this.logActivity?.(id, { type: 'crossplay', text: 'Bedrock crossplay turned off', by: actor?.username });
    return { ...this.crossplayInfo(server), restartNeeded: this.isActive(id) };
  },

  /** Before each start: keep Geyser on the port the panel gave it. */
  patchCrossplay(server) {
    if (!server.ports?.bedrock) return;
    try {
      const file = containedPath(server.dir, CONFIG);
      const text = fs.readFileSync(file, 'utf8');
      const next = patchGeyserPort(text, server.ports.bedrock);
      if (next !== text) fs.writeFileSync(file, next);
    } catch {
      /* Geyser writes its config on first start */
    }
  },
};

module.exports.patchGeyserPort = patchGeyserPort;
