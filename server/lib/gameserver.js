'use strict';

/**
 * The heart of the panel: creating, installing, running and supervising game
 * server processes, plus everything the dashboard shows about them
 * (console, CPU/RAM history, player counts, ping, crashes, connections).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const { config } = require('./config');
const { logger, uid, slugify, interpolate, fail, stripAnsi, sleep } = require('./util');
const { buildInstallScript } = require('./installer');
const { query } = require('./query');
const { rconCommand } = require('./rcon');
const {
  readProcessGroup,
  readProcess,
  cpuPercentFrom,
  countConnections,
  directorySize,
  Ring,
  isLinux,
} = require('./metrics');

const STATUS = {
  OFFLINE: 'offline',
  INSTALLING: 'installing',
  INSTALL_FAILED: 'install_failed',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  CRASHED: 'crashed',
};

const STOP_GRACE_MS = 45_000;
const CRASH_WINDOW_MS = 10 * 60_000;

class ServerManager extends EventEmitter {
  /**
   * @param {import('./store').Store} store
   * @param {import('./templates').TemplateRegistry} templates
   * @param {{broadcast:(topic:string, payload:object)=>void}} bus
   */
  constructor(store, templates, bus) {
    super();
    this.store = store;
    this.templates = templates;
    this.bus = bus;
    this.runtime = new Map();
    this.runDir = path.join(config.dataDir, 'run');
    fs.mkdirSync(this.runDir, { recursive: true });
    this.shuttingDown = false;
  }

  /* --------------------------------------------------------- lifecycle -- */

  async init() {
    this.reapStaleProcesses();
    for (const server of this.servers) {
      const rt = this.rt(server.id);
      rt.status = server.installedAt ? STATUS.OFFLINE : STATUS.INSTALL_FAILED;
      if (!server.installedAt && server.everInstalled !== true) rt.status = STATUS.OFFLINE;
    }
    this.metricsTimer = setInterval(() => this.collectMetrics(), config.metricsIntervalMs);
    this.queryTimer = setInterval(() => this.runQueries(), config.queryIntervalMs);
    this.diskTimer = setInterval(() => this.refreshDiskUsage(), 5 * 60_000);
    for (const t of [this.metricsTimer, this.queryTimer, this.diskTimer]) t.unref?.();

    this.refreshDiskUsage();

    const autoStart = this.servers.filter((s) => s.autoStart && s.installedAt);
    for (const server of autoStart) {
      logger.info(`Auto-starting ${server.name}`);
      try {
        await this.start(server.id);
      } catch (err) {
        logger.error(`Auto-start failed for ${server.name}:`, err.message);
      }
      await sleep(1500); // stagger so a dozen servers do not thrash the box
    }
  }

  /** Kill process groups left behind by a previous (crashed) panel run. */
  reapStaleProcesses() {
    if (!isLinux) return;
    let files = [];
    try {
      files = fs.readdirSync(this.runDir).filter((f) => f.endsWith('.pid'));
    } catch {
      return;
    }
    for (const file of files) {
      const full = path.join(this.runDir, file);
      const pgid = Number(fs.readFileSync(full, 'utf8').trim());
      if (pgid > 1) {
        try {
          process.kill(-pgid, 'SIGKILL');
          logger.warn(`Reaped orphaned process group ${pgid} from a previous run`);
        } catch {
          /* already gone */
        }
      }
      try {
        fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    clearInterval(this.metricsTimer);
    clearInterval(this.queryTimer);
    clearInterval(this.diskTimer);
    const running = this.servers.filter((s) => this.isActive(s.id));
    if (!running.length) return;
    logger.info(`Stopping ${running.length} running server(s)…`);
    await Promise.all(running.map((s) => this.stop(s.id).catch(() => {})));
  }

  /* ------------------------------------------------------------ helpers -- */

  get servers() {
    return this.store.state.servers;
  }

  get settings() {
    return this.store.state.settings;
  }

  rt(id) {
    if (!this.runtime.has(id)) {
      this.runtime.set(id, {
        status: STATUS.OFFLINE,
        proc: null,
        pgid: null,
        startedAt: null,
        console: [],
        seq: 0,
        prevCpuSample: null,
        history: new Ring(config.metricsHistoryPoints),
        cpu: 0,
        memory: 0,
        connections: 0,
        players: null,
        maxPlayers: null,
        playerList: [],
        ping: null,
        queryError: null,
        diskBytes: 0,
        stopping: false,
        stopTimer: null,
        restartAfterStop: false,
        recentCrashes: [],
      });
    }
    return this.runtime.get(id);
  }

  find(id) {
    return this.servers.find((s) => s.id === id) || null;
  }

  require(id) {
    const server = this.find(id);
    if (!server) fail(404, 'Server not found');
    return server;
  }

  isActive(id) {
    const st = this.rt(id).status;
    return st === STATUS.RUNNING || st === STATUS.STARTING || st === STATUS.STOPPING;
  }

  template(server) {
    return this.templates.get(server.templateId);
  }

  /** Every value a template can reference with {{VAR}}. */
  vars(server) {
    const ports = server.ports || {};
    const out = {
      SERVER_ID: server.id,
      SERVER_NAME: server.name,
      SERVER_DIR: server.dir,
      MEMORY: server.memory,
      MEMORY_MB: server.memory,
      CPU_LIMIT: server.cpuLimit || 0,
      IP: server.ip || '0.0.0.0',
      PORT: ports.game ?? Object.values(ports)[0] ?? 0,
      MAX_PLAYERS: server.maxPlayers || 20,
      ...(server.vars || {}),
    };
    for (const [name, value] of Object.entries(ports)) {
      out[`PORT_${name.toUpperCase()}`] = value;
    }
    return out;
  }

  publicServer(server) {
    const rt = this.rt(server.id);
    const tpl = this.template(server);
    return {
      ...server,
      status: rt.status,
      startedAt: rt.startedAt,
      uptime: rt.startedAt ? Date.now() - rt.startedAt : 0,
      cpu: Number(rt.cpu.toFixed(1)),
      // `memory` is live RSS; the configured cap stays available as memoryMb.
      memory: rt.memory,
      memoryMb: server.memory,
      memoryLimit: server.memory * 1024 * 1024,
      connections: rt.connections,
      players: rt.players,
      maxPlayers: rt.maxPlayers ?? server.maxPlayers ?? null,
      playerList: rt.playerList,
      ping: rt.ping,
      queryError: rt.queryError,
      diskBytes: rt.diskBytes,
      templateName: tpl?.name || server.templateId,
      templateIcon: tpl?.icon || '🎮',
      supportsConsoleInput: Boolean(tpl?.stopCommand || tpl?.consoleInput !== false),
      hasRcon: Boolean(tpl?.rcon && server.vars?.RCON_PASSWORD),
    };
  }

  /* ------------------------------------------------------------- create -- */

  usedPorts() {
    const used = new Set();
    for (const server of this.servers) {
      for (const port of Object.values(server.ports || {})) used.add(Number(port));
    }
    return used;
  }

  allocatePort(preferred, used) {
    const { portRangeStart, portRangeEnd } = this.settings;
    if (preferred && !used.has(Number(preferred))) return Number(preferred);
    for (let p = portRangeStart; p <= portRangeEnd; p++) {
      if (!used.has(p)) return p;
    }
    fail(409, 'No free ports left in the configured range');
    return 0;
  }

  assignPorts(template, requested = {}) {
    const used = this.usedPorts();
    const ports = {};
    const primaryDef = template.ports.find((p) => p.name === 'game') || template.ports[0];
    const primary = this.allocatePort(requested.game ?? requested[primaryDef.name] ?? primaryDef.default, used);
    ports[primaryDef.name] = primary;
    used.add(primary);

    for (const def of template.ports) {
      if (def.name === primaryDef.name) continue;
      let candidate = requested[def.name];
      if (!candidate && def.offset !== undefined) candidate = primary + Number(def.offset);
      const port = this.allocatePort(candidate ?? def.default, used);
      ports[def.name] = port;
      used.add(port);
    }
    return ports;
  }

  /** Fill in defaults and validate user-supplied template variables. */
  resolveVars(template, provided = {}) {
    const out = {};
    for (const def of template.variables || []) {
      let value = provided[def.name];
      if (value === undefined || value === '') value = def.default;
      if (value === undefined || value === null) value = '';
      if (def.type === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) fail(400, `${def.label || def.name} must be a number`);
        value = n;
      }
      if (def.options && def.options.length && !def.options.includes(String(value))) {
        fail(400, `${def.label || def.name} must be one of: ${def.options.join(', ')}`);
      }
      if (def.generate === 'password' && !value) {
        value = require('crypto').randomBytes(12).toString('base64url');
      }
      out[def.name] = value;
    }
    // Anything extra the user supplied is passed through untouched.
    for (const [k, v] of Object.entries(provided)) {
      if (!(k in out)) out[k] = v;
    }
    return out;
  }

  create(input, actor) {
    const template = this.templates.require(input.templateId);
    const name = String(input.name || template.name).trim().slice(0, 60);
    if (!name) fail(400, 'Server name is required');

    const id = `${slugify(name)}-${uid(4)}`;
    const dir = path.join(config.serversDir, id);
    const ports = this.assignPorts(template, input.ports || {});
    const vars = this.resolveVars(template, input.vars || {});

    const server = {
      id,
      name,
      templateId: template.id,
      dir,
      ip: input.ip || '0.0.0.0',
      ports,
      vars,
      memory: Number(input.memory) || Number(template.defaultMemory) || 2048,
      cpuLimit: Number(input.cpuLimit) || 0,
      maxPlayers: Number(input.maxPlayers) || Number(vars.MAX_PLAYERS) || 20,
      autoStart: input.autoStart !== false,
      autoRestart: input.autoRestart !== false,
      startCommand: input.startCommand || template.startCommand,
      createdAt: Date.now(),
      createdBy: actor?.username || 'system',
      installedAt: null,
      crashCount: 0,
      lastExit: null,
      notes: '',
    };

    fs.mkdirSync(dir, { recursive: true });
    this.servers.push(server);
    this.store.save();
    this.store.addEvent('server.created', `${name} created from template ${template.name}`, { serverId: id });
    this.broadcastServers();
    return server;
  }

  async remove(id, deleteFiles = true) {
    const server = this.require(id);
    if (this.isActive(id)) await this.stop(id).catch(() => {});
    this.killTree(id);
    const idx = this.servers.findIndex((s) => s.id === id);
    this.servers.splice(idx, 1);
    this.runtime.delete(id);
    this.store.save();
    if (deleteFiles) {
      try {
        fs.rmSync(server.dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(`Could not delete ${server.dir}: ${err.message}`);
      }
    }
    this.store.addEvent('server.deleted', `${server.name} deleted`, { serverId: id });
    this.broadcastServers();
  }

  update(id, patch) {
    const server = this.require(id);
    const allowed = [
      'name',
      'memory',
      'cpuLimit',
      'maxPlayers',
      'autoStart',
      'autoRestart',
      'startCommand',
      'notes',
      'ip',
    ];
    for (const key of allowed) {
      if (patch[key] !== undefined) server[key] = patch[key];
    }
    if (patch.vars) server.vars = { ...server.vars, ...patch.vars };
    if (patch.ports) {
      const used = this.usedPorts();
      for (const [name, value] of Object.entries(patch.ports)) {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) fail(400, `Invalid port for ${name}`);
        if (server.ports[name] !== port && used.has(port)) fail(409, `Port ${port} is already allocated`);
        server.ports[name] = port;
      }
    }
    this.store.save();
    this.broadcastServers();
    return server;
  }

  /* ------------------------------------------------------------ install -- */

  async install(id, { reinstall = false } = {}) {
    const server = this.require(id);
    const template = this.template(server);
    if (!template) fail(400, 'The template this server was created from is no longer available');
    const rt = this.rt(id);
    if (this.isActive(id)) fail(409, 'Stop the server before installing');
    if (rt.status === STATUS.INSTALLING) fail(409, 'An install is already running');

    fs.mkdirSync(server.dir, { recursive: true });
    const vars = this.vars(server);
    const { script, env } = buildInstallScript(template, server.dir, vars);
    const scriptPath = path.join(server.dir, '.gamepanel-install.sh');
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    this.setStatus(server, STATUS.INSTALLING);
    this.clearConsole(id);
    this.pushConsole(server, `Installing ${template.name}${reinstall ? ' (reinstall)' : ''}…`, 'system');

    const proc = spawn('bash', [scriptPath], {
      cwd: server.dir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: isLinux,
    });
    rt.installProc = proc;
    if (isLinux && proc.pid) this.writePid(id, proc.pid);

    proc.stdout.on('data', (chunk) => this.pushConsole(server, chunk.toString('utf8'), 'stdout'));
    proc.stderr.on('data', (chunk) => this.pushConsole(server, chunk.toString('utf8'), 'stderr'));

    return new Promise((resolve) => {
      proc.on('error', (err) => {
        this.pushConsole(server, `Install could not start: ${err.message}`, 'system');
        this.setStatus(server, STATUS.INSTALL_FAILED);
        rt.installProc = null;
        this.clearPid(id);
        resolve({ ok: false, error: err.message });
      });
      proc.on('exit', (code) => {
        rt.installProc = null;
        this.clearPid(id);
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* ignore */
        }
        if (code === 0) {
          server.installedAt = Date.now();
          this.store.save();
          this.writeConfigFiles(server, template, { overwrite: reinstall });
          this.pushConsole(server, 'Installation finished successfully. You can start the server now.', 'system');
          this.setStatus(server, STATUS.OFFLINE);
          this.store.addEvent('server.installed', `${server.name} installed`, { serverId: id });
          this.refreshDiskUsage();
          resolve({ ok: true });
        } else {
          this.pushConsole(server, `Installation failed with exit code ${code}.`, 'system');
          this.setStatus(server, STATUS.INSTALL_FAILED);
          this.store.addEvent('server.install_failed', `${server.name} install failed (exit ${code})`, { serverId: id });
          resolve({ ok: false, error: `Install exited with code ${code}` });
        }
      });
    });
  }

  /** Write template config files (only creating missing ones unless told otherwise). */
  writeConfigFiles(server, template, { overwrite = false } = {}) {
    const vars = this.vars(server);
    for (const file of template.configFiles || []) {
      const target = path.join(server.dir, file.path);
      const mode = file.mode || 'create';
      if (fs.existsSync(target) && mode !== 'overwrite' && !overwrite) continue;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, interpolate(file.content || '', vars));
      } catch (err) {
        logger.warn(`Could not write ${file.path}: ${err.message}`);
      }
    }
  }

  /**
   * Keep game configs in sync with the panel's allocation on every boot,
   * touching only the keys the template names and leaving user edits alone.
   */
  applyPropertyPatches(server, template) {
    const vars = this.vars(server);
    for (const patch of template.patchProperties || []) {
      const target = path.join(server.dir, patch.path);
      const format = patch.format || 'properties';
      let existing = '';
      try {
        existing = fs.readFileSync(target, 'utf8');
      } catch {
        if (!patch.createIfMissing) continue;
      }
      const values = {};
      for (const [k, v] of Object.entries(patch.set || {})) values[k] = interpolate(String(v), vars);

      try {
        if (format === 'json') {
          const obj = existing ? JSON.parse(existing) : {};
          for (const [k, v] of Object.entries(values)) {
            const parts = k.split('.');
            let node = obj;
            while (parts.length > 1) {
              const key = parts.shift();
              node[key] = node[key] || {};
              node = node[key];
            }
            const raw = v;
            node[parts[0]] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
          }
          fs.writeFileSync(target, JSON.stringify(obj, null, 2));
        } else {
          // properties / ini: replace matching keys, append the rest
          const lines = existing ? existing.split(/\r?\n/) : [];
          const remaining = new Map(Object.entries(values));
          const out = lines.map((line) => {
            const m = line.match(/^(\s*)([A-Za-z0-9_.\-]+)(\s*=\s*)(.*)$/);
            if (!m) return line;
            if (!remaining.has(m[2])) return line;
            const value = remaining.get(m[2]);
            remaining.delete(m[2]);
            return `${m[1]}${m[2]}${m[3]}${value}`;
          });
          for (const [k, v] of remaining) out.push(`${k}=${v}`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, out.join('\n').replace(/\n{3,}/g, '\n\n'));
        }
      } catch (err) {
        logger.warn(`Could not patch ${patch.path}: ${err.message}`);
      }
    }
  }

  /* -------------------------------------------------------------- start -- */

  async start(id) {
    const server = this.require(id);
    const template = this.template(server);
    if (!template) fail(400, 'Template missing for this server');
    const rt = this.rt(id);

    if (this.isActive(id)) fail(409, 'Server is already running');
    if (rt.status === STATUS.INSTALLING) fail(409, 'Server is still installing');
    if (!server.installedAt) fail(409, 'Server is not installed yet — run the installer first');
    if (!fs.existsSync(server.dir)) fail(500, 'Server directory is missing — reinstall the server');

    this.writeConfigFiles(server, template);
    this.applyPropertyPatches(server, template);

    const vars = this.vars(server);
    const command = interpolate(server.startCommand || template.startCommand, vars);
    const env = { ...process.env, ...this.envFor(server, vars) };

    this.setStatus(server, STATUS.STARTING);
    this.pushConsole(server, `Starting: ${command}`, 'system');

    let proc;
    try {
      proc = isLinux
        ? spawn('bash', ['-lc', command], {
            cwd: server.dir,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true, // own process group => we can signal the whole tree
          })
        : spawn(command, { cwd: server.dir, env, stdio: ['pipe', 'pipe', 'pipe'], shell: true });
    } catch (err) {
      this.pushConsole(server, `Failed to spawn process: ${err.message}`, 'system');
      this.setStatus(server, STATUS.CRASHED);
      fail(500, `Could not start server: ${err.message}`);
    }

    rt.proc = proc;
    rt.pgid = isLinux ? proc.pid : null;
    rt.startedAt = Date.now();
    rt.prevCpuSample = null;
    rt.stopping = false;
    rt.playerList = [];
    rt.players = null;
    if (proc.pid) this.writePid(id, proc.pid);

    const readyPattern = template.logPatterns?.ready ? new RegExp(template.logPatterns.ready) : null;
    if (!readyPattern) {
      // No readiness marker: treat as running once the process survives startup.
      setTimeout(() => {
        if (this.rt(id).status === STATUS.STARTING) this.setStatus(server, STATUS.RUNNING);
      }, 5000).unref?.();
    }

    const onOutput = (chunk, stream) => {
      const text = chunk.toString('utf8');
      this.pushConsole(server, text, stream);
      if (readyPattern && this.rt(id).status === STATUS.STARTING && readyPattern.test(text)) {
        this.setStatus(server, STATUS.RUNNING);
        this.pushConsole(server, 'Server is ready.', 'system');
      }
      this.trackPlayers(server, template, text);
    };

    proc.stdout.on('data', (c) => onOutput(c, 'stdout'));
    proc.stderr.on('data', (c) => onOutput(c, 'stderr'));
    proc.stdin.on('error', () => {}); // a closed stdin must not take the panel down

    proc.on('error', (err) => {
      this.pushConsole(server, `Process error: ${err.message}`, 'system');
    });

    proc.on('exit', (code, signal) => this.handleExit(server, code, signal));

    this.openLogStream(server);
    this.store.addEvent('server.started', `${server.name} started`, { serverId: id });
    return this.publicServer(server);
  }

  envFor(server, vars) {
    const env = {
      GP_SERVER_ID: server.id,
      GP_SERVER_DIR: server.dir,
      HOME: server.dir,
      LD_LIBRARY_PATH: [
        path.join(server.dir, 'linux64'),
        path.join(server.dir, '.steam', 'sdk64'),
        process.env.LD_LIBRARY_PATH || '',
      ]
        .filter(Boolean)
        .join(':'),
    };
    for (const [k, v] of Object.entries(vars)) {
      if (/^[A-Z][A-Z0-9_]*$/.test(k)) env[k] = String(v);
    }
    return env;
  }

  handleExit(server, code, signal) {
    const rt = this.rt(server.id);
    const wasStopping = rt.stopping || this.shuttingDown;
    const uptime = rt.startedAt ? Date.now() - rt.startedAt : 0;

    rt.proc = null;
    rt.pgid = null;
    rt.startedAt = null;
    rt.cpu = 0;
    rt.memory = 0;
    rt.connections = 0;
    rt.players = null;
    rt.ping = null;
    clearTimeout(rt.stopTimer);
    rt.stopTimer = null;
    this.clearPid(server.id);
    this.closeLogStream(server.id);

    server.lastExit = { code, signal, at: Date.now(), uptimeMs: uptime };

    if (wasStopping) {
      this.pushConsole(server, `Server stopped (code ${code ?? 'n/a'}${signal ? `, signal ${signal}` : ''}).`, 'system');
      this.setStatus(server, STATUS.OFFLINE);
      rt.stopping = false;
      this.store.save();
      if (rt.restartAfterStop) {
        rt.restartAfterStop = false;
        setTimeout(() => this.start(server.id).catch((e) => logger.error('Restart failed:', e.message)), 1500);
      }
      return;
    }

    // Unexpected exit => crash.
    server.crashCount = (server.crashCount || 0) + 1;
    rt.recentCrashes.push(Date.now());
    rt.recentCrashes = rt.recentCrashes.filter((t) => Date.now() - t < CRASH_WINDOW_MS);
    this.store.save();

    this.pushConsole(server, `Server crashed (exit code ${code ?? 'n/a'}${signal ? `, signal ${signal}` : ''}).`, 'system');
    this.setStatus(server, STATUS.CRASHED);
    this.store.addEvent('server.crashed', `${server.name} crashed (exit ${code ?? signal})`, {
      serverId: server.id,
      code,
      signal,
      uptimeMs: uptime,
    });

    const limit = this.settings.maxCrashRestarts ?? 5;
    if (server.autoRestart && this.settings.autoRestart !== false && !this.shuttingDown) {
      if (rt.recentCrashes.length > limit) {
        this.pushConsole(
          server,
          `Auto-restart disabled: ${rt.recentCrashes.length} crashes in the last 10 minutes. Fix the problem and start it manually.`,
          'system'
        );
        return;
      }
      const delay = Math.min(60_000, 3000 * rt.recentCrashes.length);
      this.pushConsole(server, `Auto-restarting in ${Math.round(delay / 1000)}s…`, 'system');
      setTimeout(() => {
        if (this.rt(server.id).status === STATUS.CRASHED && !this.shuttingDown) {
          this.start(server.id).catch((e) => this.pushConsole(server, `Auto-restart failed: ${e.message}`, 'system'));
        }
      }, delay).unref?.();
    }
  }

  /* --------------------------------------------------------------- stop -- */

  async stop(id, { restart = false } = {}) {
    const server = this.require(id);
    const template = this.template(server);
    const rt = this.rt(id);
    if (!rt.proc) {
      if (restart) return this.start(id);
      fail(409, 'Server is not running');
    }
    if (rt.stopping) return { ok: true, alreadyStopping: true };

    rt.stopping = true;
    rt.restartAfterStop = restart;
    this.setStatus(server, STATUS.STOPPING);

    const stopCommand = template?.stopCommand || server.vars?.STOP_COMMAND || null;
    const stopSignal = template?.stopSignal || 'SIGTERM';
    if (stopCommand && rt.proc.stdin && rt.proc.stdin.writable) {
      this.pushConsole(server, `Sending stop command: ${stopCommand}`, 'system');
      try {
        rt.proc.stdin.write(stopCommand + '\n');
      } catch {
        this.signal(id, stopSignal);
      }
    } else if (template?.rcon && server.vars?.RCON_PASSWORD && template.stopRconCommand) {
      try {
        await rconCommand({
          host: '127.0.0.1',
          port: server.ports[template.rcon.port || 'rcon'],
          password: server.vars.RCON_PASSWORD,
          command: template.stopRconCommand,
        });
      } catch {
        this.signal(id, stopSignal);
      }
    } else {
      this.pushConsole(server, `Sending ${stopSignal}…`, 'system');
      this.signal(id, stopSignal);
    }

    const grace = Number(template?.stopTimeout || 0) * 1000 || STOP_GRACE_MS;
    rt.stopTimer = setTimeout(() => {
      if (this.rt(id).proc) {
        this.pushConsole(server, 'Server did not stop in time — killing it.', 'system');
        this.killTree(id);
      }
    }, grace);
    rt.stopTimer.unref?.();

    return { ok: true };
  }

  async restart(id) {
    const rt = this.rt(id);
    if (!rt.proc) return this.start(id);
    return this.stop(id, { restart: true });
  }

  signal(id, sig) {
    const rt = this.rt(id);
    if (!rt.proc) return;
    try {
      if (isLinux && rt.pgid) process.kill(-rt.pgid, sig);
      else rt.proc.kill(sig);
    } catch (err) {
      logger.debug(`signal ${sig} failed for ${id}: ${err.message}`);
    }
  }

  killTree(id) {
    const rt = this.rt(id);
    rt.stopping = true;
    if (rt.installProc) {
      try {
        if (isLinux && rt.installProc.pid) process.kill(-rt.installProc.pid, 'SIGKILL');
        else rt.installProc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    if (!rt.proc) return;
    try {
      if (isLinux && rt.pgid) process.kill(-rt.pgid, 'SIGKILL');
      else if (process.platform === 'win32') spawn('taskkill', ['/pid', String(rt.proc.pid), '/f', '/t']);
      else rt.proc.kill('SIGKILL');
    } catch (err) {
      logger.debug(`kill failed for ${id}: ${err.message}`);
    }
  }

  /* ------------------------------------------------------------ console -- */

  openLogStream(server) {
    const rt = this.rt(server.id);
    if (rt.logStream) return;
    try {
      fs.mkdirSync(config.logsDir, { recursive: true });
      rt.logStream = fs.createWriteStream(path.join(config.logsDir, `${server.id}.log`), { flags: 'a' });
      rt.logStream.on('error', () => {
        rt.logStream = null;
      });
    } catch {
      rt.logStream = null;
    }
  }

  closeLogStream(id) {
    const rt = this.rt(id);
    if (rt.logStream) {
      rt.logStream.end();
      rt.logStream = null;
    }
  }

  clearConsole(id) {
    const rt = this.rt(id);
    rt.console = [];
    this.bus.broadcast(`console:${id}`, { type: 'clear' });
  }

  pushConsole(server, text, stream = 'stdout') {
    const rt = this.rt(server.id);
    const clean = stripAnsi(text);

    // Panel-generated notices are whole lines already, and must not be mixed
    // into the partial-line buffer that carries process output between chunks.
    if (stream === 'system' || stream === 'input') {
      if (rt.partial) {
        const held = rt.partial;
        rt.partial = '';
        this.emitConsoleLines(server, [held], 'stdout');
      }
      return this.emitConsoleLines(server, clean.replace(/\n+$/, '').split('\n'), stream);
    }

    const lines = clean.split('\n');
    // A chunk rarely ends on a line boundary; hold the tail for the next chunk.
    if (rt.partial) {
      lines[0] = rt.partial + lines[0];
      rt.partial = '';
    }
    if (!clean.endsWith('\n')) rt.partial = lines.pop() ?? '';
    else lines.pop();

    return this.emitConsoleLines(server, lines, stream);
  }

  emitConsoleLines(server, lines, stream) {
    const rt = this.rt(server.id);
    const batch = [];
    for (const line of lines) {
      const entry = { seq: ++rt.seq, at: Date.now(), stream, line };
      rt.console.push(entry);
      batch.push(entry);
    }
    if (rt.console.length > config.consoleBufferLines) {
      rt.console.splice(0, rt.console.length - config.consoleBufferLines);
    }
    if (!batch.length) return;

    if (rt.logStream) {
      try {
        rt.logStream.write(batch.map((b) => b.line).join('\n') + '\n');
      } catch {
        /* logging is best-effort */
      }
    }
    this.bus.broadcast(`console:${server.id}`, { type: 'lines', serverId: server.id, lines: batch });
  }

  getConsole(id) {
    return this.rt(id).console;
  }

  async sendCommand(id, command) {
    const server = this.require(id);
    const template = this.template(server);
    const rt = this.rt(id);
    if (!rt.proc) fail(409, 'Server is not running');
    command = String(command);

    if (rt.proc.stdin && rt.proc.stdin.writable && template?.consoleInput !== false) {
      this.pushConsole(server, `> ${command}`, 'input');
      rt.proc.stdin.write(command + '\n');
      return { ok: true, via: 'stdin' };
    }
    if (template?.rcon && server.vars?.RCON_PASSWORD) {
      this.pushConsole(server, `> ${command}`, 'input');
      const out = await rconCommand({
        host: '127.0.0.1',
        port: server.ports[template.rcon.port || 'rcon'],
        password: server.vars.RCON_PASSWORD,
        command,
      });
      if (out) this.pushConsole(server, out, 'stdout');
      return { ok: true, via: 'rcon', response: out };
    }
    fail(400, 'This server does not accept console commands');
    return null;
  }

  /** Track joins/leaves from log output when the game has no query protocol. */
  trackPlayers(server, template, text) {
    const patterns = template.logPatterns || {};
    if (!patterns.join && !patterns.leave) return;
    const rt = this.rt(server.id);
    for (const line of text.split('\n')) {
      if (patterns.join) {
        const m = line.match(new RegExp(patterns.join));
        if (m) {
          const name = m[1] || 'player';
          if (!rt.playerList.includes(name)) rt.playerList.push(name);
        }
      }
      if (patterns.leave) {
        const m = line.match(new RegExp(patterns.leave));
        if (m) {
          const name = m[1] || 'player';
          rt.playerList = rt.playerList.filter((p) => p !== name);
        }
      }
    }
    if (!template.query || template.query.type === 'none') rt.players = rt.playerList.length;
  }

  /* ------------------------------------------------------------ metrics -- */

  collectMetrics() {
    const summary = [];
    for (const server of this.servers) {
      const rt = this.rt(server.id);
      if (rt.proc && rt.pgid) {
        const sample = readProcessGroup(rt.pgid) || readProcess(rt.proc.pid);
        if (sample) {
          rt.cpu = cpuPercentFrom(rt.prevCpuSample, sample);
          rt.memory = sample.rss;
          rt.processes = sample.procs;
          rt.prevCpuSample = sample;
        }
        rt.connections = countConnections(Object.values(server.ports || {}));
      } else {
        rt.cpu = 0;
        rt.memory = 0;
        rt.connections = 0;
      }
      rt.history.push({
        t: Date.now(),
        cpu: Number(rt.cpu.toFixed(1)),
        mem: rt.memory,
        players: rt.players ?? 0,
        ping: rt.ping ?? 0,
        conns: rt.connections,
      });
      summary.push({
        id: server.id,
        status: rt.status,
        cpu: Number(rt.cpu.toFixed(1)),
        memory: rt.memory,
        memoryLimit: server.memory * 1024 * 1024,
        players: rt.players,
        maxPlayers: rt.maxPlayers ?? server.maxPlayers,
        ping: rt.ping,
        connections: rt.connections,
        uptime: rt.startedAt ? Date.now() - rt.startedAt : 0,
      });
    }
    if (summary.length) this.bus.broadcast('stats', { servers: summary });
  }

  getHistory(id) {
    return this.rt(id).history.toArray();
  }

  async refreshDiskUsage() {
    for (const server of this.servers) {
      try {
        this.rt(server.id).diskBytes = await directorySize(server.dir);
      } catch {
        /* ignore */
      }
    }
  }

  /* -------------------------------------------------------------- query -- */

  async runQueries() {
    const jobs = this.servers
      .filter((s) => this.rt(s.id).status === STATUS.RUNNING)
      .map(async (server) => {
        const template = this.template(server);
        const q = template?.query;
        const rt = this.rt(server.id);
        // Universal templates let the user pick the protocol per server.
        const type = server.vars?.QUERY_TYPE || q?.type;
        if (!type || type === 'none') return;

        const portName = q?.port || 'query';
        let port = server.ports[portName] ?? server.ports.game;
        if (q?.portOffset) port = Number(server.ports.game) + Number(q.portOffset);

        const result = await query({ type, host: server.ip && server.ip !== '0.0.0.0' ? server.ip : '127.0.0.1', port });
        if (result.online) {
          rt.ping = result.latency;
          rt.queryError = null;
          if (typeof result.players === 'number') rt.players = result.players;
          if (typeof result.maxPlayers === 'number' && result.maxPlayers > 0) rt.maxPlayers = result.maxPlayers;
          if (result.playerList?.length) rt.playerList = result.playerList;
          if (result.motd) rt.motd = result.motd;
          if (result.map) rt.map = result.map;
        } else {
          rt.ping = null;
          rt.queryError = result.reason || 'No response';
        }
      });
    await Promise.allSettled(jobs);
  }

  /* --------------------------------------------------------------- misc -- */

  writePid(id, pid) {
    try {
      fs.writeFileSync(path.join(this.runDir, `${id}.pid`), String(pid));
    } catch {
      /* best effort */
    }
  }

  clearPid(id) {
    try {
      fs.unlinkSync(path.join(this.runDir, `${id}.pid`));
    } catch {
      /* already gone */
    }
  }

  setStatus(server, status) {
    const rt = this.rt(server.id);
    if (rt.status === status) return;
    rt.status = status;
    this.bus.broadcast('server:status', { serverId: server.id, status, server: this.publicServer(server) });
    this.broadcastServers();
  }

  broadcastServers() {
    this.bus.broadcast('servers', { servers: this.servers.map((s) => this.publicServer(s)) });
  }

  /** Snapshot used by the dashboard header. */
  overview() {
    let running = 0;
    let players = 0;
    let cpu = 0;
    let memory = 0;
    for (const server of this.servers) {
      const rt = this.rt(server.id);
      if (rt.status === STATUS.RUNNING) running++;
      players += rt.players || 0;
      cpu += rt.cpu;
      memory += rt.memory;
    }
    return {
      total: this.servers.length,
      running,
      players,
      cpu: Number(cpu.toFixed(1)),
      memory,
      crashes: this.servers.reduce((n, s) => n + (s.crashCount || 0), 0),
      cores: os.cpus().length,
    };
  }
}

module.exports = { ServerManager, STATUS };
