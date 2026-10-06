'use strict';

/**
 * Running a server as a plain process on the host — every Windows server,
 * and Linux servers when Docker is not in use.
 * Mixed into ServerManager (see manager.js).
 */

const fs = require('fs');
const path = require('path');

const { config } = require('../../core/config');
const { logger, fail, interpolate } = require('../../core/util');
const { isWindows, spawnShell, signalTree, killTree, exe } = require('../../core/platform');

/** A Java runtime the installer fetched for this server, if it needed one. */
function privateJavaHome(server, vars) {
  // A version number, never a path: "../../somewhere" must not pick the java that runs.
  const version = /^\d{1,3}$/.test(String(vars.JAVA_VERSION)) ? String(vars.JAVA_VERSION) : '21';
  const candidates = [
    server.javaHome,
    path.join(config.toolsDir, `java-${version}`),
    path.join(server.dir, '.java'),
  ].filter(Boolean);
  for (const home of candidates) {
    if (fs.existsSync(path.join(home, 'bin', exe('java')))) return home;
  }
  return null;
}

module.exports = {
  /** Environment for a server's own processes (start command and installers). */
  envFor(server, vars) {
    const env = {
      GP_SERVER_ID: server.id,
      GP_SERVER_DIR: server.dir,
    };
    const basePath = process.env.PATH || process.env.Path || (isWindows ? '' : '/usr/local/bin:/usr/bin:/bin');
    const javaHome = privateJavaHome(server, vars);
    const extraPath = [];
    if (javaHome) {
      env.JAVA_HOME = javaHome;
      extraPath.push(path.join(javaHome, 'bin'));
    }
    if (isWindows) {
      env.Path = [...extraPath, basePath].join(path.delimiter);
      env.PATH = env.Path;
    } else {
      env.HOME = server.dir;
      env.PATH = [...extraPath, basePath].join(path.delimiter);
      // The start command runs in a login shell, whose profile can rebuild PATH
      // and put a system Java back in front; spawnShell re-adds these after it.
      if (extraPath.length) env.GP_PATH_PREFIX = extraPath.join(':');
      // SteamCMD games ship their own shared libraries next to the binary.
      env.LD_LIBRARY_PATH = [path.join(server.dir, 'linux64'), path.join(server.dir, '.steam', 'sdk64'), process.env.LD_LIBRARY_PATH || '']
        .filter(Boolean)
        .join(':');
    }
    for (const [k, v] of Object.entries(vars)) {
      if (/^[A-Z][A-Z0-9_]*$/.test(k) && v !== undefined && v !== null) env[k] = String(v);
    }
    // The template's own variables, e.g. SteamAppId for games that need it.
    for (const [k, v] of Object.entries(this.template(server)?.env || {})) env[k] = interpolate(String(v), vars);
    return env;
  },

  startProcess(server, template, command, vars) {
    const rt = this.rt(server.id);
    if (template.sidecars?.length) {
      this.pushConsole(
        server,
        `Note: this game expects companion services (${template.sidecars.map((s) => s.name).join(', ')}) that only run under Docker. Point it at your own instead.`,
        'system'
      );
    }

    let proc;
    try {
      proc = spawnShell(command, { cwd: server.dir, env: { ...process.env, ...this.envFor(server, vars) } });
    } catch (err) {
      fail(500, `Could not start the process: ${err.message}`);
    }

    rt.proc = proc;
    rt.pid = proc.pid || null;
    rt.prevCpuSample = null;
    if (proc.pid) this.writePid(server.id, proc.pid);

    const onOutput = this.makeOutputHandler(server, template);
    proc.stdout.on('data', (c) => onOutput(c, 'stdout'));
    proc.stderr.on('data', (c) => onOutput(c, 'stderr'));
    proc.stdin?.on('error', () => {}); // a closed stdin must never take the panel down
    proc.on('error', (err) => this.pushConsole(server, `Process error: ${err.message}`, 'system'));
    proc.on('exit', (code, signal) => this.handleExit(server, code, signal));
    this.startWatchers(server, template, onOutput);
  },

  signalProcess(id, sig) {
    const rt = this.rt(id);
    if (!rt.proc?.pid) return;
    signalTree(rt.proc.pid, sig).catch((err) => logger.debug(`signal ${sig} failed for ${id}: ${err.message}`));
  },

  killProcess(id) {
    const rt = this.rt(id);
    if (rt.proc?.pid) killTree(rt.proc.pid, { force: true });
  },
};
