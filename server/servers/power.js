'use strict';

/**
 * Start, stop, restart and kill — plus what happens when a server exits on
 * its own (a crash) and the auto-restart that follows.
 * Mixed into ServerManager (see manager.js).
 */

const { logger, interpolate, fail, redactSecrets } = require('../core/util');
const { rconCommand } = require('../games/rcon');
const { STATUS, STOP_GRACE_MS, CRASH_WINDOW_MS } = require('./constants');
const { updateSteps } = require('./install');

module.exports = {
  async start(id) {
    const server = this.require(id);
    const template = this.template(server);
    if (!template) fail(400, 'The template for this server is missing');
    const rt = this.rt(id);

    if (this.isActive(id)) fail(409, 'The server is already running');
    if (rt.status === STATUS.INSTALLING) fail(409, 'The server is still installing');
    if (!server.installedAt) fail(409, 'The server is not installed yet');
    if (!require('fs').existsSync(server.dir)) fail(500, 'The server directory is missing — reinstall the server');

    // Optional: pull the newest game build first, like LinuxGSM/AMP do.
    if (server.updateOnStart && updateSteps(template).length && !rt.task) {
      const result = await this.updateGame(id, { quiet: true }).catch((err) => ({ ok: false, error: err.message }));
      if (!result.ok) this.pushConsole(server, `Starting anyway — the update did not finish (${result.error}).`, 'system');
    }

    this.writeConfigFiles(server, template);
    this.applyPropertyPatches(server, template);
    this.patchCrossplay(server);

    const vars = this.vars(server);
    const command = interpolate(server.startCommand || template.startCommand, vars);
    this.setStatus(server, STATUS.STARTING);
    // The console reaches anyone with console access and the log file, so
    // never echo secrets that were substituted into the command.
    this.pushConsole(server, `Starting: ${redactSecrets(command, vars)}`, 'system');

    rt.stopping = false;
    rt.diagnosis = null;
    rt.playerList = [];
    rt.playerInfo = new Map();
    rt.players = null;
    rt.version = null;

    try {
      if (this.runtimeFor(server) === 'docker') await this.startContainer(server, template, command, vars);
      else this.startProcess(server, template, command, vars);
    } catch (err) {
      this.pushConsole(server, `Could not start: ${err.message}`, 'system');
      this.setStatus(server, STATUS.CRASHED);
      throw err;
    }

    rt.startedAt = Date.now();
    this.openLogStream(server);
    this.store.addEvent('server.started', `${server.name} started`, { serverId: id });
    return this.publicServer(server);
  },

  /**
   * Output handling shared by every runtime: stream to the console, spot the
   * template's "ready" line and keep the player list.
   */
  makeOutputHandler(server, template) {
    const ready = template.logPatterns?.ready ? new RegExp(template.logPatterns.ready) : null;
    if (!ready && !template.readyOnPort) {
      // No marker: call it running once it has survived a few seconds.
      setTimeout(() => {
        if (this.rt(server.id).status === STATUS.STARTING) this.setStatus(server, STATUS.RUNNING);
      }, 5000).unref?.();
    }
    return (chunk, stream) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.pushConsole(server, text, stream);
      if (ready && this.rt(server.id).status === STATUS.STARTING && ready.test(text)) {
        this.setStatus(server, STATUS.RUNNING);
        this.pushConsole(server, 'Server is ready — players can join.', 'system');
        this.store.addEvent('server.ready', `${server.name} is ready`, { serverId: server.id });
      }
      this.trackPlayers(server, template, text);
    };
  },

  /** Shared bookkeeping when a server process or container exits. */
  handleExit(server, code, signal) {
    const rt = this.rt(server.id);
    const wasStopping = rt.stopping || this.shuttingDown;
    const uptime = rt.startedAt ? Date.now() - rt.startedAt : 0;

    Object.assign(rt, {
      proc: null,
      pid: null,
      startedAt: null,
      cpu: 0,
      memory: 0,
      connections: 0,
      players: null,
      playerList: [],
      playerInfo: new Map(),
      ping: null,
      networkRx: 0,
      networkTx: 0,
      prevCpuSample: null,
    });
    clearTimeout(rt.stopTimer);
    rt.stopTimer = null;
    this.clearPid(server.id);
    this.stopWatchers(server.id);
    this.closeLogStream(server.id);
    this.cleanupAfterExit?.(server);

    server.lastExit = { code, signal, at: Date.now(), uptimeMs: uptime };
    const how = `code ${code ?? 'n/a'}${signal ? `, signal ${signal}` : ''}`;

    if (wasStopping) {
      this.pushConsole(server, `Server stopped (${how}).`, 'system');
      this.setStatus(server, STATUS.OFFLINE);
      rt.stopping = false;
      this.store.save();
      this.store.addEvent('server.stopped', `${server.name} stopped`, { serverId: server.id });
      if (rt.restartAfterStop) {
        rt.restartAfterStop = false;
        setTimeout(() => this.start(server.id).catch((e) => logger.error('Restart failed:', e.message)), 1500);
      }
      return;
    }

    // It exited without being asked to: a crash.
    server.crashCount = (server.crashCount || 0) + 1;
    rt.recentCrashes = [...rt.recentCrashes, Date.now()].filter((t) => Date.now() - t < CRASH_WINDOW_MS);
    this.store.save();
    this.pushConsole(server, `Server crashed (${how}).`, 'system');
    this.diagnoseCrash(server, code, signal);
    this.setStatus(server, STATUS.CRASHED);
    this.store.addEvent('server.crashed', `${server.name} crashed (exit ${code ?? signal})`, {
      serverId: server.id,
      code,
      signal,
      uptimeMs: uptime,
    });

    if (!server.autoRestart || this.settings.autoRestart === false || this.shuttingDown) return;
    const limit = this.settings.maxCrashRestarts ?? 5;
    if (rt.recentCrashes.length > limit) {
      this.pushConsole(
        server,
        `Auto-restart paused: ${rt.recentCrashes.length} crashes in 10 minutes. Fix the cause, then start it by hand.`,
        'system'
      );
      return;
    }
    const delay = Math.min(60_000, 3000 * rt.recentCrashes.length);
    this.pushConsole(server, `Restarting in ${Math.round(delay / 1000)}s…`, 'system');
    setTimeout(() => {
      if (this.rt(server.id).status === STATUS.CRASHED && !this.shuttingDown) {
        this.start(server.id).catch((e) => this.pushConsole(server, `Auto-restart failed: ${e.message}`, 'system'));
      }
    }, delay).unref?.();
  },

  /**
   * Ask the game to stop: its stop command on stdin, an RCON command, or a
   * signal — then kill it if it has not exited when the grace period ends.
   */
  async stop(id, { restart = false } = {}) {
    const server = this.require(id);
    const template = this.template(server);
    const rt = this.rt(id);
    if (!rt.proc && !rt.docker?.id) {
      if (restart) return this.start(id);
      return fail(409, 'The server is not running');
    }
    if (rt.stopping) return { ok: true, alreadyStopping: true };

    rt.stopping = true;
    rt.restartAfterStop = restart;
    this.setStatus(server, STATUS.STOPPING);

    const stopCommand = template?.stopCommand || server.vars?.STOP_COMMAND || null;
    const stopSignal = template?.stopSignal || 'SIGTERM';

    if (stopCommand && this.writeStdin(server, `${stopCommand}${template?.consoleNewline || '\n'}`)) {
      this.pushConsole(server, `Sending stop command: ${stopCommand}`, 'system');
    } else if (template?.stopRconCommand && template.rcon && server.vars?.RCON_PASSWORD) {
      this.pushConsole(server, `Sending "${template.stopRconCommand}" over RCON`, 'system');
      await rconCommand({
        host: '127.0.0.1',
        port: server.ports[template.rcon.port || 'rcon'],
        password: server.vars.RCON_PASSWORD,
        command: template.stopRconCommand,
      }).catch(() => this.signal(id, stopSignal));
    } else {
      this.pushConsole(server, `Asking the server to stop (${stopSignal})…`, 'system');
      this.signal(id, stopSignal);
    }

    const grace = Number(template?.stopTimeout || 0) * 1000 || STOP_GRACE_MS;
    rt.stopTimer = setTimeout(() => {
      const current = this.rt(id);
      if (current.proc || current.docker?.id) {
        this.pushConsole(server, 'The server did not stop in time — forcing it.', 'system');
        this.killTree(id);
      }
    }, grace);
    rt.stopTimer.unref?.();
    return { ok: true };
  },

  async restart(id) {
    const rt = this.rt(id);
    if (!rt.proc && !rt.docker?.id) return this.start(id);
    return this.stop(id, { restart: true });
  },

  signal(id, sig) {
    const rt = this.rt(id);
    if (rt.docker?.id) return this.signalContainer(id, sig);
    return this.signalProcess(id, sig);
  },

  /** Force-stop everything belonging to a server, installs included. */
  killTree(id) {
    const rt = this.rt(id);
    rt.stopping = true;
    rt.installCancel = true;
    for (const child of rt.installChildren || []) require('../core/platform').killTree(child.pid);
    if (rt.installProc?.pid) require('../core/platform').killTree(rt.installProc.pid);
    if (rt.docker?.installId || rt.docker?.id) return this.killContainer(id);
    return this.killProcess(id);
  },
};
