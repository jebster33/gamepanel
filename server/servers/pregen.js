'use strict';

/**
 * World pre-generation with Chunky on Paper and Purpur: generate the land
 * out to a radius ahead of time, so players exploring new chunks do not lag
 * the server. Installs Chunky from Modrinth and drives it through the
 * console; progress is read back from Chunky's own console lines.
 * Mixed into ServerManager (see manager.js), so `this` is the manager.
 */

const fs = require('fs');
const path = require('path');
const { fail } = require('../core/util');
const { containedPath } = require('../features/files');

const SUPPORTED = ['minecraft-paper', 'minecraft-purpur'];
const ACTIONS = ['install', 'start', 'pause', 'continue', 'cancel'];

// "[Chunky] Task running for world. Processed: 1600 chunks (1.02%), ETA: 0:12:34, Rate: 125.3 cps, Current: 10, -3"
const RUNNING = /\[Chunky\] Task running for (\S+)\. Processed: (\d+) chunks \(([\d.]+)%\), ETA: ([\d:]+), Rate: ([\d.]+) cps/;
const FINISHED = /\[Chunky\] Task finished for (\S+)\. Processed: (\d+) chunks \(([\d.]+)%\), Total time: ([\d:]+)/;
const STOPPED = /\[Chunky\] Task (?:stopped|cancelled|paused) for (\S+)/;

function jarOf(server) {
  try {
    const dir = containedPath(server.dir, 'plugins');
    const name = fs.readdirSync(dir).find((f) => /^chunky.*\.jar$/i.test(f) && !/border/i.test(f));
    return name ? { name, mtime: fs.statSync(path.join(dir, name)).mtimeMs } : null;
  } catch {
    return null;
  }
}

/** The latest thing Chunky said, newest console line first. */
function readProgress(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].line || '';
    let m = text.match(RUNNING);
    if (m) return { state: 'running', world: m[1], chunks: Number(m[2]), percent: Number(m[3]), eta: m[4], rate: Number(m[5]) };
    m = text.match(FINISHED);
    if (m) return { state: 'finished', world: m[1], chunks: Number(m[2]), percent: 100, took: m[4] };
    m = text.match(STOPPED);
    if (m) return { state: 'stopped', world: m[1] };
  }
  return null;
}

module.exports = {
  pregenInfo(server) {
    if (!SUPPORTED.includes(server.templateId)) return { supported: false };
    const jar = jarOf(server);
    const rt = this.rt(server.id);
    const running = rt.status === 'running';
    return {
      supported: true,
      installed: Boolean(jar),
      running,
      // Plugins load at start: a jar newer than this run needs a restart first.
      needsRestart: Boolean(jar && running && rt.startedAt && jar.mtime > rt.startedAt),
      progress: running ? readProgress(rt.console || []) : null,
    };
  },

  async pregen(id, { action, radius }, actor) {
    const server = this.require(id);
    if (!SUPPORTED.includes(server.templateId)) fail(400, 'Pre-generation works on Paper and Purpur servers');
    if (!ACTIONS.includes(action)) fail(400, `Action must be one of: ${ACTIONS.join(', ')}`);
    if (action === 'install') {
      if (!jarOf(server)) {
        await require('../features/mods').install(server, this.template(server), { provider: 'modrinth', projectId: 'chunky', liveVersion: this.rt(id).version }, this.store.state.settings.integrations || {});
      }
      return { ...this.pregenInfo(server), restartNeeded: this.isActive(id) };
    }
    const info = this.pregenInfo(server);
    if (!info.installed) fail(400, 'Install Chunky first');
    if (!info.running) fail(409, 'Start the server first');
    if (info.needsRestart) fail(409, 'Restart the server first so Chunky loads');
    const say = (command) => this.sendCommand(id, command);
    if (action === 'start') {
      const r = Math.round(Number(radius));
      if (!(r >= 100 && r <= 50_000)) fail(400, 'Pick a radius between 100 and 50,000 blocks');
      const world = readLevelName(server) || 'world';
      if (/\s/.test(world)) fail(400, 'Chunky cannot pick a world with spaces in its name. Rename the world first.');
      await say(`chunky world ${world}`);
      await say('chunky center 0 0');
      await say(`chunky radius ${r}`);
      await say('chunky start');
      // Chunky asks to confirm when a task for this world already exists.
      setTimeout(() => say('chunky confirm').catch(() => {}), 1500);
      this.store.addEvent('server.pregen', `${actor?.username || 'Someone'} started pre-generating ${server.name} out to ${r} blocks`, { serverId: id });
    } else if (action === 'cancel') {
      await say('chunky cancel');
      setTimeout(() => say('chunky confirm').catch(() => {}), 1000);
    } else {
      await say(`chunky ${action}`);
    }
    return this.pregenInfo(server);
  },
};

function readLevelName(server) {
  try {
    const props = fs.readFileSync(containedPath(server.dir, 'server.properties'), 'utf8');
    return props.match(/^level-name\s*=\s*(.+)$/m)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

module.exports.readProgress = readProgress;
