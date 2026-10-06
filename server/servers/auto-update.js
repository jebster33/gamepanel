'use strict';

/**
 * Automatic game updates for SteamCMD games. Every half hour the panel asks
 * Steam for the newest build of each opted-in server's game; when it is newer
 * than the installed one, the server is updated as soon as nobody is playing
 * (straight away if it is stopped), then started again if it was running.
 * Mixed into ServerManager (see manager.js).
 */

const fs = require('fs');
const path = require('path');
const { interpolate, logger } = require('../core/util');
const { updateSteps } = require('./install');
const { STATUS } = require('./constants');

const CHECK_EVERY_MS = 30 * 60_000;
const builds = new Map(); // "appid/branch" -> { buildid, at }

async function latestBuild(appid, branch) {
  const key = `${appid}/${branch}`;
  const cached = builds.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.buildid;
  const res = await fetch(`https://api.steamcmd.net/v1/info/${encodeURIComponent(appid)}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Steam info answered ${res.status}`);
  const data = await res.json();
  const buildid = data?.data?.[appid]?.depots?.branches?.[branch]?.buildid;
  if (!buildid) throw new Error(`no build listed for branch "${branch}"`);
  builds.set(key, { buildid: String(buildid), at: Date.now() });
  return String(buildid);
}

function installedBuild(dir, appid) {
  try {
    const text = fs.readFileSync(path.join(dir, 'steamapps', `appmanifest_${appid}.acf`), 'utf8');
    return text.match(/"buildid"\s+"(\d+)"/)?.[1] || null;
  } catch {
    return null;
  }
}

module.exports = {
  /** The Steam app behind a server, or null for games that are not updated through SteamCMD. */
  steamApp(server) {
    const template = this.template(server);
    if (!template) return null;
    const step = updateSteps(template).find((s) => s.type === 'steamcmd' && s.appid);
    if (!step) return null;
    const vars = this.vars(server);
    return { appid: String(interpolate(String(step.appid), vars)), branch: String(interpolate(String(step.branch || ''), vars)).trim() || 'public' };
  },

  /** Runs every minute; talks to Steam at most every half hour per server. */
  async checkAutoUpdates() {
    for (const server of this.servers) {
      // A server's own choice wins; otherwise the panel-wide setting decides.
      const on = server.autoUpdate ?? Boolean(this.store.state.settings.autoUpdateGames);
      if (!on || !server.installedAt) continue;
      const rt = this.rt(server.id);
      const info = (rt.autoUpdate ||= {});
      try {
        if (!info.pending && (!info.checkedAt || Date.now() - info.checkedAt > CHECK_EVERY_MS)) {
          const app = this.steamApp(server);
          if (!app) continue;
          info.checkedAt = Date.now();
          info.latest = await latestBuild(app.appid, app.branch);
          info.installed = installedBuild(server.dir, app.appid);
          info.error = null;
          info.pending = Boolean(info.installed && info.latest !== info.installed);
          if (info.pending) this.pushConsole(server, `Auto update: a new build (${info.latest}) is out. Updating as soon as nobody is playing.`, 'system');
        }
        if (info.pending) await this.applyAutoUpdate(server, rt, info);
      } catch (err) {
        info.error = err.message;
        logger.warn(`Auto update check for ${server.name} failed: ${err.message}`);
      }
    }
  },

  async applyAutoUpdate(server, rt, info) {
    if (rt.task || rt.status === STATUS.INSTALLING || rt.status === STATUS.STARTING || rt.status === STATUS.STOPPING) return;
    const running = this.isActive(server.id);
    const players = rt.players ?? rt.playerList?.length ?? 0;
    if (running && players > 0) return;
    info.pending = false;
    if (running) {
      this.pushConsole(server, 'Auto update: the server is empty, stopping it to update.', 'system');
      await this.stop(server.id);
    }
    const result = await this.updateGame(server.id, { quiet: true }).catch((err) => ({ ok: false, error: err.message }));
    const app = this.steamApp(server);
    info.installed = app ? installedBuild(server.dir, app.appid) : info.installed;
    if (result.ok) {
      info.updatedAt = Date.now();
      this.store.addEvent('server.auto_updated', `${server.name} was updated to build ${info.latest}`, { serverId: server.id });
    } else {
      info.error = result.error;
    }
    if (running) await this.start(server.id).catch((err) => this.pushConsole(server, `Auto update: could not start again: ${err.message}`, 'system'));
  },
};
