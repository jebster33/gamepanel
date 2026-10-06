'use strict';

/**
 * Installing, reinstalling and updating games.
 * Mixed into ServerManager (see manager.js).
 *
 * Three ways an install can run, chosen by the server's runtime:
 *   container        the template's steps as one bash script in a throwaway root container
 *   Linux process    the same bash script, run directly on the host
 *   Windows process  the steps run one by one from Node (install/native.js)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { config } = require('../core/config');
const { logger, fail } = require('../core/util');
const { buildInstallScript } = require('./install/bash');
const { runNativeInstall } = require('./install/native');
const { STATUS, CONTAINER_DIR } = require('./constants');

/** The steps that only refresh game files (used by "update" and update-on-start). */
function updateSteps(template) {
  if (Array.isArray(template.update)) return template.update;
  return (template.install || []).filter((s) => s.type === 'steamcmd');
}

module.exports = {
  async install(id, { reinstall = false } = {}) {
    const server = this.require(id);
    const template = this.template(server);
    if (!template) fail(400, 'The template this server was created from is no longer available');
    const rt = this.rt(id);
    if (this.isActive(id)) fail(409, 'Stop the server before installing');
    if (rt.status === STATUS.INSTALLING) fail(409, 'An install is already running');
    this.checkDiskRoom('install');

    fs.mkdirSync(server.dir, { recursive: true });
    this.setStatus(server, STATUS.INSTALLING);
    this.clearConsole(id);
    this.pushConsole(server, `Installing ${template.name}${reinstall ? ' (reinstall)' : ''} for ${server.platform === 'windows' ? 'Windows' : 'Linux'}…`, 'system');

    const vars = this.vars(server);
    try {
      Object.assign(vars, await this.resolveDownloads(server, template, vars));
    } catch (err) {
      return this.failInstall(server, err.message);
    }

    const result = await this.runSteps(server, template, template.install || [], vars, { label: 'install' });
    return this.finishInstall(server, template, result, reinstall);
  },

  /**
   * Anything that needs reading JSON (which version, which URL) is resolved
   * here by the panel, not by the install script: in a container the script
   * has no Node and no jq, it just gets finished URLs.
   */
  async resolveDownloads(server, template, vars) {
    if (!template.resolve) return {};
    this.pushConsole(server, `Looking up the ${template.name} download…`, 'system');
    const extra = await require('../games/resolvers').resolveDownload(template.resolve, vars, { platform: server.platform, curseforgeKey: this.store.state.settings.integrations?.curseforgeKey });

    if (extra.RESOLVED_VERSION) server.resolvedVersion = String(extra.RESOLVED_VERSION);
    // The plain game version (e.g. "1.21.4") — what mod searches filter on.
    if (extra.GAME_VERSION) server.gameVersion = String(extra.GAME_VERSION);
    if (extra.LOADER) server.loader = String(extra.LOADER);
    if (extra.PACK_SLUG) {
      server.pack = {
        slug: extra.PACK_SLUG,
        name: extra.PACK_NAME,
        version: extra.PACK_VERSION_NUMBER,
        url: extra.PACK_URL,
        versionUrl: extra.PACK_VERSION_URL,
        icon: extra.PACK_ICON || null,
        mcVersion: extra.PACK_MC_VERSION,
        loader: extra.PACK_LOADER,
        clientRequired: extra.PACK_CLIENT_REQUIRED === 'true',
      };
    }
    // Saved so every later start uses the same Java as the install did.
    // The crash doctor can pin a newer Java when mods need more than the game does.
    if (server.javaOverride && Number(server.javaOverride) > Number(extra.JAVA_VERSION || 0)) extra.JAVA_VERSION = String(server.javaOverride);
    if (extra.JAVA_VERSION) server.vars = { ...server.vars, JAVA_VERSION: String(extra.JAVA_VERSION) };
    this.store.save();
    this.pushConsole(server, `Using ${extra.RESOLVED_VERSION || 'the latest build'}`, 'system');
    return extra;
  },

  /** Run a list of install steps with whichever installer this server uses. */
  async runSteps(server, template, steps, vars, { label = 'task', asRoot = true } = {}) {
    const rt = this.rt(server.id);
    const runtime = this.runtimeFor(server);
    const log = (line, stream = 'stdout') => this.pushConsole(server, line, stream);

    if (server.platform === 'windows') {
      const children = new Set();
      rt.installCancel = false;
      rt.installChildren = children;
      const result = await runNativeInstall(steps, {
        dir: server.dir,
        vars,
        env: this.envFor(server, vars),
        log: (line, stream) => log(line, stream === 'system' ? 'system' : 'stdout'),
        track: (child) => {
          children.add(child);
          child.on('exit', () => children.delete(child));
        },
        cancelled: () => rt.installCancel,
      });
      rt.installChildren = null;
      if (result.javaHome) server.javaHome = result.javaHome;
      return result.ok ? { code: 0 } : { code: 1, error: result.error };
    }

    const containerized = runtime === 'docker';
    const workDir = containerized ? CONTAINER_DIR : server.dir;
    const { script, env } = buildInstallScript({ ...template, install: steps }, workDir, vars, {
      // The install container runs as root (so apt works); hand the files
      // back to the uid the game itself runs as.
      postScript: containerized ? `chown -R "\${GP_UID:-0}:\${GP_GID:-0}" ${CONTAINER_DIR} 2>/dev/null || true` : '',
      steamcmdDir: containerized ? `${CONTAINER_DIR}/.steamcmd` : config.steamcmdDir,
    });
    const scriptName = `.gamepanel-${label}.sh`;
    fs.writeFileSync(path.join(server.dir, scriptName), script, { mode: 0o755 });

    try {
      if (containerized) return await this.runScriptInContainer(server, template, scriptName, env, { label, asRoot });
      return await new Promise((resolve) => {
        const proc = spawn('bash', [path.join(server.dir, scriptName)], {
          cwd: server.dir,
          env: { ...process.env, ...this.envFor(server, vars), ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        rt.installProc = proc;
        if (proc.pid) this.writePid(server.id, proc.pid);
        proc.stdout.on('data', (c) => log(c.toString('utf8')));
        proc.stderr.on('data', (c) => log(c.toString('utf8'), 'stderr'));
        proc.on('error', (err) => resolve({ code: -1, error: `The installer could not start: ${err.message}` }));
        proc.on('exit', (code) => resolve({ code: code ?? -1 }));
      });
    } finally {
      rt.installProc = null;
      this.clearPid(server.id);
      fs.rmSync(path.join(server.dir, scriptName), { force: true });
    }
  },

  failInstall(server, message) {
    this.pushConsole(server, message, 'system');
    this.setStatus(server, STATUS.INSTALL_FAILED);
    this.store.addEvent('server.install_failed', `${server.name} install failed: ${message}`, { serverId: server.id });
    return { ok: false, error: message };
  },

  finishInstall(server, template, result, reinstall) {
    if (result.code !== 0) {
      if (result.error) this.pushConsole(server, result.error, 'system');
      return this.failInstall(server, `Installation failed${result.code > 0 ? ` (exit code ${result.code})` : ''}.`);
    }
    server.installedAt = Date.now();
    this.store.save();
    this.writeConfigFiles(server, template, { overwrite: reinstall });

    // Modpack overrides can smuggle in client-only mods, which take a
    // Forge/NeoForge server down at boot. Check what actually landed.
    if (template.modpacks) {
      require('../features/mods')
        .pruneClientOnlyMods(server, template, (line) => this.pushConsole(server, line, 'system'))
        .catch(() => {});
    }

    this.pushConsole(server, 'Installation finished. You can start the server now.', 'system');
    this.setStatus(server, STATUS.OFFLINE);
    this.store.addEvent('server.installed', `${server.name} installed`, { serverId: server.id });
    this.refreshDiskUsage();
    return { ok: true };
  },

  /** Pull the latest game files (SteamCMD titles) without touching configs or saves. */
  async updateGame(id, { quiet = false } = {}) {
    const server = this.require(id);
    const template = this.template(server);
    const steps = updateSteps(template);
    if (!steps.length) fail(400, 'This game is updated by reinstalling it');
    if (this.isActive(id)) fail(409, 'Stop the server before updating it');
    const rt = this.rt(id);
    if (rt.status === STATUS.INSTALLING) fail(409, 'An install is already running');
    this.checkDiskRoom('update');

    this.setTask(server, 'Updating');
    if (!quiet) this.pushConsole(server, `Checking for ${template.name} updates…`, 'system');
    const result = await this.runSteps(server, template, steps, this.vars(server), { label: 'update' });
    this.setTask(server, null);
    if (result.code !== 0) {
      this.pushConsole(server, `Update failed${result.error ? `: ${result.error}` : ''}`, 'system');
      return { ok: false, error: result.error || `exit ${result.code}` };
    }
    server.updatedAt = Date.now();
    this.store.save();
    this.pushConsole(server, 'Game files are up to date.', 'system');
    this.store.addEvent('server.updated', `${server.name} game files updated`, { serverId: server.id });
    return { ok: true };
  },

  /**
   * Run a one-off bash snippet (Workshop downloads, mod bootstraps…) with the
   * same runtime the server itself uses, streaming to its console.
   * Windows servers pass `steps` instead.
   */
  async runTask(server, { script, steps, label = 'Task' }) {
    const template = this.template(server) || {};
    this.pushConsole(server, `${label}…`, 'system');
    this.setTask(server, label);
    try {
      const list = steps || [{ type: 'script', label, run: script }];
      return await this.runSteps(server, template, list, this.vars(server), { label: 'task' });
    } finally {
      this.setTask(server, null);
    }
  },
};

module.exports.updateSteps = updateSteps;
