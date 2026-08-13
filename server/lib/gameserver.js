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
const { docker } = require('./docker');
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

/** Everything inside a container lives here, whatever the host path is. */
const CONTAINER_DIR = '/home/container';
const DEFAULT_IMAGE = 'debian:bookworm-slim';

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
    this.dockerAvailable = false;
    this.dockerInfo = null;
  }

  /* ------------------------------------------------------------- runtime -- */

  /**
   * Containers are used whenever Docker is present and neither the panel
   * settings nor the template opt out. Plain child processes remain the
   * fallback so the panel still works on a box without Docker.
   */
  runtimeFor(server) {
    if (server.runtime === 'process') return 'process';
    if (!this.dockerAvailable) return 'process';
    if (this.settings.containerize === false) return 'process';
    const template = this.template(server);
    if (template && template.container === false) return 'process';
    return 'docker';
  }

  /**
   * The image a server runs in. Templates may parameterise it — Java games use
   * `eclipse-temurin:{{JAVA_VERSION}}-jre`, and JAVA_VERSION is whatever the
   * resolver said that Minecraft release needs.
   */
  imageFor(template, server) {
    const raw = (template && (template.image || template.container?.image)) || DEFAULT_IMAGE;
    const vars = { ...(server?.vars || {}) };
    if (!vars.JAVA_VERSION) vars.JAVA_VERSION = '21';
    return interpolate(raw, vars) || DEFAULT_IMAGE;
  }

  /**
   * Resolve the image a template runs in, building a thin derived layer when
   * the template declares runtime `packages` (apt installs performed during a
   * game install would be thrown away with the install container).
   */
  async resolveImage(template, server, onLine = () => {}) {
    const base = this.imageFor(template, server);
    const packages = template?.packages || [];
    if (!packages.length) {
      await docker.ensureImage(base, onLine);
      return base;
    }
    const hash = require('crypto')
      .createHash('sha1')
      .update(`${base}|${packages.join(' ')}`)
      .digest('hex')
      .slice(0, 10);
    // The tag includes the base image hash, so switching Java version builds
    // (and caches) a separate layer rather than reusing the wrong one.
    const tag = `gamepanel/${template.id}:${hash}`;
    if (await docker.hasImage(tag)) return tag;

    await docker.ensureImage(base, onLine);
    onLine(`Building runtime image with ${packages.join(', ')} — this happens once per template.`);
    const dockerfile = [
      `FROM ${base}`,
      'USER root',
      'RUN set -eux; \\',
      '    if command -v apt-get >/dev/null; then \\',
      '      apt-get update -qq; \\',
      `      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages.join(' ')}; \\`,
      '      rm -rf /var/lib/apt/lists/*; \\',
      '    fi',
      '',
    ].join('\n');
    await docker.build(tag, dockerfile, (line) => onLine(line));
    return tag;
  }

  containerName(id) {
    return `gp-${id}`;
  }

  networkName(id) {
    return `gp-net-${id}`;
  }

  async detectDocker() {
    this.dockerAvailable = await docker.available();
    if (this.dockerAvailable) {
      try {
        const info = await docker.info();
        this.dockerInfo = { version: info.ServerVersion, root: info.DockerRootDir, containers: info.Containers };
        logger.info(`Docker ${info.ServerVersion} detected — servers will run in containers`);
      } catch {
        this.dockerInfo = null;
      }
    } else {
      logger.warn('Docker not available — falling back to plain processes (no isolation between servers)');
    }
    return this.dockerAvailable;
  }

  /* --------------------------------------------------------- lifecycle -- */

  async init() {
    await this.detectDocker();
    this.reapStaleProcesses();
    for (const server of this.servers) {
      const rt = this.rt(server.id);
      rt.status = STATUS.OFFLINE;
    }

    // Containers outlive the panel: after a restart or an update we simply
    // re-attach to whatever is still running instead of rebooting games.
    if (this.dockerAvailable) await this.reattachContainers();
    this.metricsTimer = setInterval(() => this.collectMetrics(), config.metricsIntervalMs);
    this.queryTimer = setInterval(() => this.runQueries(), config.queryIntervalMs);
    this.diskTimer = setInterval(() => this.refreshDiskUsage(), 5 * 60_000);
    for (const t of [this.metricsTimer, this.queryTimer, this.diskTimer]) t.unref?.();

    this.refreshDiskUsage();

    const autoStart = this.servers.filter((s) => s.autoStart && s.installedAt && !this.isActive(s.id));
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
    // Containerised servers keep running across a panel restart or update —
    // only child processes have to be stopped, since they would be orphaned.
    const running = this.servers.filter((s) => this.isActive(s.id) && this.runtimeFor(s) === 'process');
    for (const server of this.servers) {
      const rt = this.rt(server.id);
      if (rt.docker?.attachment) rt.docker.attachment.close();
      if (rt.docker?.stopStats) rt.docker.stopStats();
    }
    if (!running.length) return;
    logger.info(`Stopping ${running.length} non-containerised server(s)…`);
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
        networkRx: 0,
        networkTx: 0,
        docker: null,
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

  /**
   * What version the server is actually running: whatever the live query
   * reported, else the version variable the template was deployed with.
   */
  gameVersion(server, template) {
    const rt = this.rt(server.id);
    if (rt.version) return rt.version;
    if (server.resolvedVersion) return server.resolvedVersion;
    const vars = server.vars || {};
    const key = template?.versionVar || Object.keys(vars).find((k) => /(_VERSION|_BUILD)$/.test(k));
    const value = key ? vars[key] : null;
    if (!value) return null;
    const text = String(value);
    return text && text.toLowerCase() !== 'latest' ? text : null;
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
      networkRx: rt.networkRx || 0,
      networkTx: rt.networkTx || 0,
      runtime: this.runtimeFor(server),
      containerId: rt.docker?.id ? String(rt.docker.id).slice(0, 12) : null,
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
      hasMods: Boolean(tpl?.mods),
      modProviders: tpl?.mods?.providers || [],
      gameVersion: this.gameVersion(server, tpl),
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
      if (def.options && def.options.length) {
        // Options may be plain values or {value,label} pairs.
        const allowed = def.options.map((o) => String(typeof o === 'object' ? o.value : o));
        if (!allowed.includes(String(value))) {
          fail(400, `${def.label || def.name} must be one of: ${allowed.join(', ')}`);
        }
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
    if (this.dockerAvailable) await this.cleanupContainers(server).catch(() => {});
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

    // Anything that needs JSON parsing is resolved here, not in the install
    // script: that script runs inside the game's container, which has no Node
    // and no jq. The script only ever sees a finished URL.
    if (template.resolve) {
      this.setStatus(server, STATUS.INSTALLING);
      this.pushConsole(server, `Looking up the ${template.name} download…`, 'system');
      try {
        const extra = await require('./resolvers').resolveDownload(template.resolve, vars);
        Object.assign(vars, extra);
        // Remember what was actually installed, so the UI can show a version
        // even for a server deployed with "latest" that has never started.
        if (extra.RESOLVED_VERSION) server.resolvedVersion = String(extra.RESOLVED_VERSION);
        // Persisted so later starts pick the same JRE image as the install did.
        if (extra.JAVA_VERSION) server.vars = { ...server.vars, JAVA_VERSION: String(extra.JAVA_VERSION) };
        if (extra.RESOLVED_VERSION || extra.JAVA_VERSION) this.store.save();
        this.pushConsole(server, `Using ${extra.RESOLVED_VERSION || 'the latest build'}`, 'system');
      } catch (err) {
        this.pushConsole(server, err.message, 'system');
        this.setStatus(server, STATUS.INSTALL_FAILED);
        this.store.addEvent('server.install_failed', `${server.name} install failed: ${err.message}`, {
          serverId: server.id,
        });
        return { ok: false, error: err.message };
      }
    }

    const containerized = this.runtimeFor(server) === 'docker';
    const workDir = containerized ? CONTAINER_DIR : server.dir;
    const { script, env } = buildInstallScript(template, workDir, vars, {
      // The install container runs as root so apt works; hand the files back
      // to the unprivileged uid the game container will run as.
      postScript: containerized ? `chown -R "\${GP_UID:-0}:\${GP_GID:-0}" ${CONTAINER_DIR} 2>/dev/null || true` : '',
      steamcmdDir: containerized ? `${CONTAINER_DIR}/.steamcmd` : config.steamcmdDir,
    });
    const scriptPath = path.join(server.dir, '.gamepanel-install.sh');
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    this.setStatus(server, STATUS.INSTALLING);
    this.clearConsole(id);
    this.pushConsole(server, `Installing ${template.name}${reinstall ? ' (reinstall)' : ''}…`, 'system');

    if (containerized) return this.runInstallContainer(server, template, { reinstall, env });

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
        resolve(this.finishInstall(server, template, code, reinstall));
      });
    });
  }

  /** Shared post-install bookkeeping for both the process and container paths. */
  finishInstall(server, template, code, reinstall) {
    try {
      fs.unlinkSync(path.join(server.dir, '.gamepanel-install.sh'));
    } catch {
      /* already removed */
    }
    if (code === 0) {
      server.installedAt = Date.now();
      this.store.save();
      this.writeConfigFiles(server, template, { overwrite: reinstall });
      this.pushConsole(server, 'Installation finished successfully. You can start the server now.', 'system');
      this.setStatus(server, STATUS.OFFLINE);
      this.store.addEvent('server.installed', `${server.name} installed`, { serverId: server.id });
      this.refreshDiskUsage();
      return { ok: true };
    }
    this.pushConsole(server, `Installation failed with exit code ${code}.`, 'system');
    this.setStatus(server, STATUS.INSTALL_FAILED);
    this.store.addEvent('server.install_failed', `${server.name} install failed (exit ${code})`, { serverId: server.id });
    return { ok: false, error: `Install exited with code ${code}` };
  }

  /**
   * Run a one-off maintenance script (Workshop downloads, mod bootstraps…)
   * with the same runtime the server itself uses, streaming to its console.
   */
  async runTask(server, { script, label = 'Task' }) {
    const template = this.template(server) || {};
    const containerized = this.runtimeFor(server) === 'docker';
    const workDir = containerized ? CONTAINER_DIR : server.dir;
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 0;

    const body = [
      'set -uo pipefail',
      `GP_SERVER_DIR=${JSON.stringify(workDir)}`,
      `GP_STEAMCMD=${JSON.stringify(containerized ? `${CONTAINER_DIR}/.steamcmd` : config.steamcmdDir)}`,
      'export GP_SERVER_DIR GP_STEAMCMD',
      `cd "$GP_SERVER_DIR" || exit 1`,
      script,
      'rc=$?',
      containerized ? `chown -R ${uid}:${gid} "$GP_SERVER_DIR" 2>/dev/null || true` : '',
      'exit $rc',
    ]
      .filter(Boolean)
      .join('\n');

    // Reuse the installer preamble so gp_fetch / gp_steam_app / gp_apt exist.
    const { script: full } = buildInstallScript(
      { install: [{ type: 'script', label, run: body }] },
      workDir,
      this.vars(server),
      { steamcmdDir: containerized ? `${CONTAINER_DIR}/.steamcmd` : config.steamcmdDir }
    );

    const scriptPath = path.join(server.dir, '.gamepanel-task.sh');
    fs.writeFileSync(scriptPath, full, { mode: 0o755 });
    this.pushConsole(server, `${label}…`, 'system');

    try {
      if (containerized) {
        const name = `gp-task-${server.id}`;
        const image = await this.resolveImage(template, server, (line) => this.pushConsole(server, line, 'system'));
        await docker.remove(name);
        const created = await docker.create(name, {
          Image: image,
          Cmd: ['bash', `${CONTAINER_DIR}/.gamepanel-task.sh`],
          WorkingDir: CONTAINER_DIR,
          Env: this.containerEnv(server, this.vars(server)),
          User: '0:0',
          Tty: false,
          Labels: { 'gamepanel.managed': 'true', 'gamepanel.server': server.id, 'gamepanel.role': 'task' },
          HostConfig: {
            Binds: [`${server.dir}:${CONTAINER_DIR}:rw`],
            NetworkMode: 'bridge',
            LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '1' } },
          },
        });
        const stopLogs = await docker.logs(created.Id, (payload, kind) =>
          this.pushConsole(server, payload.toString('utf8'), kind)
        );
        await docker.start(created.Id);
        const code = await docker.wait(created.Id);
        stopLogs();
        await docker.remove(created.Id);
        return { code };
      }

      const code = await new Promise((resolve) => {
        const proc = spawn('bash', [scriptPath], {
          cwd: server.dir,
          env: { ...process.env, ...this.envFor(server, this.vars(server)) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', (c) => this.pushConsole(server, c.toString('utf8'), 'stdout'));
        proc.stderr.on('data', (c) => this.pushConsole(server, c.toString('utf8'), 'stderr'));
        proc.on('error', () => resolve(-1));
        proc.on('exit', (exitCode) => resolve(exitCode ?? -1));
      });
      return { code };
    } finally {
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* already gone */
      }
    }
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

    if (this.runtimeFor(server) !== 'docker' && template.sidecars?.length) {
      this.pushConsole(
        server,
        `Note: this template expects companion containers (${template.sidecars
          .map((s) => s.name)
          .join(', ')}) but Docker is not in use. Install Docker, or point the server at your own database.`,
        'system'
      );
    }

    if (this.runtimeFor(server) === 'docker') {
      return this.startContainer(server, template, command, vars).catch((err) => {
        this.pushConsole(server, `Container start failed: ${err.message}`, 'system');
        this.setStatus(server, STATUS.CRASHED);
        throw err;
      });
    }

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

    const onOutput = this.makeOutputHandler(server, template);
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

  /**
   * Console output handling shared by both runtimes: stream to the UI, detect
   * the template's "ready" marker and track player joins/leaves.
   */
  makeOutputHandler(server, template) {
    const readyPattern = template.logPatterns?.ready ? new RegExp(template.logPatterns.ready) : null;
    if (!readyPattern) {
      // No readiness marker: treat as running once startup survives a moment.
      setTimeout(() => {
        if (this.rt(server.id).status === STATUS.STARTING) this.setStatus(server, STATUS.RUNNING);
      }, 5000).unref?.();
    }
    return (chunk, stream) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.pushConsole(server, text, stream);
      if (readyPattern && this.rt(server.id).status === STATUS.STARTING && readyPattern.test(text)) {
        this.setStatus(server, STATUS.RUNNING);
        this.pushConsole(server, 'Server is ready.', 'system');
      }
      this.trackPlayers(server, template, text);
    };
  }

  /** A JRE the installer fetched for this server, if it had to. */
  privateJavaBin(dir) {
    const bin = path.join(dir, '.java', 'bin');
    return fs.existsSync(path.join(bin, 'java')) ? bin : null;
  }

  envFor(server, vars) {
    const javaBin = this.privateJavaBin(server.dir);
    const env = {
      GP_SERVER_ID: server.id,
      GP_SERVER_DIR: server.dir,
      HOME: server.dir,
      ...(javaBin
        ? {
            PATH: `${javaBin}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
            JAVA_HOME: path.dirname(javaBin),
          }
        : {}),
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
    rt.networkRx = 0;
    rt.networkTx = 0;
    clearTimeout(rt.stopTimer);
    rt.stopTimer = null;
    this.clearPid(server.id);
    this.closeLogStream(server.id);

    if (rt.docker) {
      if (rt.docker.attachment) rt.docker.attachment.close();
      if (rt.docker.stopStats) rt.docker.stopStats();
      const containerId = rt.docker.id;
      rt.docker = null;
      // Remove the exited container so the next start gets a clean one; the
      // game's data lives on the bind mount, not in the container layer.
      if (containerId) docker.remove(containerId).catch(() => {});
      this.stopSidecars(server).catch(() => {});
    }

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
    if (!rt.proc && !rt.docker?.id) {
      if (restart) return this.start(id);
      fail(409, 'Server is not running');
    }
    if (rt.stopping) return { ok: true, alreadyStopping: true };

    rt.stopping = true;
    rt.restartAfterStop = restart;
    this.setStatus(server, STATUS.STOPPING);

    const stopCommand = template?.stopCommand || server.vars?.STOP_COMMAND || null;
    const stopSignal = template?.stopSignal || 'SIGTERM';
    const stdinWritable = rt.docker?.attachment || (rt.proc?.stdin && rt.proc.stdin.writable);

    if (stopCommand && stdinWritable) {
      this.pushConsole(server, `Sending stop command: ${stopCommand}`, 'system');
      try {
        if (rt.docker?.attachment) rt.docker.attachment.write(stopCommand + '\n');
        else rt.proc.stdin.write(stopCommand + '\n');
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
      const current = this.rt(id);
      if (current.proc || current.docker?.id) {
        this.pushConsole(server, 'Server did not stop in time — killing it.', 'system');
        this.killTree(id);
      }
    }, grace);
    rt.stopTimer.unref?.();

    return { ok: true };
  }

  async restart(id) {
    const rt = this.rt(id);
    if (!rt.proc && !rt.docker?.id) return this.start(id);
    return this.stop(id, { restart: true });
  }

  signal(id, sig) {
    const rt = this.rt(id);
    if (rt.docker?.id) {
      docker.kill(rt.docker.id, sig).catch((err) => logger.debug(`docker kill: ${err.message}`));
      return;
    }
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
    if (rt.docker?.installId) docker.remove(rt.docker.installId).catch(() => {});
    if (rt.docker?.id) {
      docker.kill(rt.docker.id, 'SIGKILL').catch(() => docker.remove(rt.docker.id).catch(() => {}));
      return;
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
    if (!rt.proc && !rt.docker?.id) fail(409, 'Server is not running');
    command = String(command);

    if (rt.docker?.attachment && template?.consoleInput !== false) {
      this.pushConsole(server, `> ${command}`, 'input');
      rt.docker.attachment.write(command + '\n');
      return { ok: true, via: 'stdin' };
    }
    if (rt.proc?.stdin && rt.proc.stdin.writable && template?.consoleInput !== false) {
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
      if (rt.docker?.id) {
        // CPU, memory and network already arrive from the Docker stats stream.
        rt.connections = countConnections(Object.values(server.ports || {}));
      } else if (rt.proc && rt.pgid) {
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
        rx: rt.networkRx || 0,
        tx: rt.networkTx || 0,
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
        networkRx: rt.networkRx || 0,
        networkTx: rt.networkTx || 0,
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
          if (result.version) rt.version = result.version;
          if (result.motd) rt.motd = result.motd;
          if (result.map) rt.map = result.map;
        } else {
          rt.ping = null;
          rt.queryError = result.reason || 'No response';
        }
      });
    await Promise.allSettled(jobs);
  }

  /* ---------------------------------------------------------- containers -- */

  /** uid/gid the game container runs as, so bind-mounted files stay ours. */
  containerUser() {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
    return `${uid}:${gid}`;
  }

  containerEnv(server, vars, extra = {}) {
    const env = {
      GP_SERVER_ID: server.id,
      GP_SERVER_DIR: CONTAINER_DIR,
      GP_STEAMCMD: `${CONTAINER_DIR}/.steamcmd`,
      HOME: CONTAINER_DIR,
      TERM: 'xterm',
      LD_LIBRARY_PATH: `${CONTAINER_DIR}/linux64:${CONTAINER_DIR}/.steam/sdk64:${CONTAINER_DIR}`,
      ...extra,
    };
    for (const [k, v] of Object.entries(vars)) {
      if (/^[A-Z][A-Z0-9_]*$/.test(k)) env[k] = String(v);
    }
    return Object.entries(env).map(([k, v]) => `${k}=${v}`);
  }

  portBindings(server) {
    const template = this.template(server);
    const exposed = {};
    const bindings = {};
    for (const [name, port] of Object.entries(server.ports || {})) {
      const def = (template?.ports || []).find((p) => p.name === name);
      // "both" (or an unspecified protocol) publishes TCP and UDP on the same
      // number — FiveM and several others need exactly that.
      const protocols = !def?.protocol || def.protocol === 'both' ? ['tcp', 'udp'] : [def.protocol];
      for (const proto of protocols) {
        exposed[`${port}/${proto}`] = {};
        bindings[`${port}/${proto}`] = [{ HostIp: server.ip || '0.0.0.0', HostPort: String(port) }];
      }
    }
    return { exposed, bindings };
  }

  /** Run the template's install script inside a throwaway root container. */
  async runInstallContainer(server, template, { reinstall, env }) {
    const rt = this.rt(server.id);
    const name = `gp-install-${server.id}`;

    try {
      const image = await this.resolveImage(template, server, (line) => this.pushConsole(server, line, 'system'));
      await docker.remove(name);

      const created = await docker.create(name, {
        Image: image,
        Cmd: ['bash', `${CONTAINER_DIR}/.gamepanel-install.sh`],
        WorkingDir: CONTAINER_DIR,
        Env: this.containerEnv(server, this.vars(server), {
          ...env,
          GP_SERVER_DIR: CONTAINER_DIR,
          GP_UID: String(typeof process.getuid === 'function' ? process.getuid() : 0),
          GP_GID: String(typeof process.getgid === 'function' ? process.getgid() : 0),
          DEBIAN_FRONTEND: 'noninteractive',
        }),
        // Installers need root to apt-get inside the container; the script
        // hands ownership back to the runtime uid before it exits.
        User: '0:0',
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        Labels: { 'gamepanel.managed': 'true', 'gamepanel.server': server.id, 'gamepanel.role': 'install' },
        HostConfig: {
          Binds: [`${server.dir}:${CONTAINER_DIR}:rw`],
          NetworkMode: 'bridge',
          AutoRemove: false,
          LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '1' } },
        },
      });

      rt.docker = { ...(rt.docker || {}), installId: created.Id };
      const stopLogs = await docker.logs(created.Id, (payload, kind) =>
        this.pushConsole(server, payload.toString('utf8'), kind)
      );
      await docker.start(created.Id);
      const code = await docker.wait(created.Id);
      stopLogs();
      await docker.remove(created.Id);
      if (rt.docker) rt.docker.installId = null;
      return this.finishInstall(server, template, code, reinstall);
    } catch (err) {
      this.pushConsole(server, `Install container failed: ${err.message}`, 'system');
      this.setStatus(server, STATUS.INSTALL_FAILED);
      await docker.remove(name).catch(() => {});
      return { ok: false, error: err.message };
    }
  }

  /** Create and start the game container, then wire console, stats and exit. */
  async startContainer(server, template, command, vars) {
    const rt = this.rt(server.id);
    const name = this.containerName(server.id);
    const network = await docker.ensureNetwork(this.networkName(server.id));

    const image = await this.resolveImage(template, server, (line) => this.pushConsole(server, line, 'system'));
    await docker.remove(name);
    await this.startSidecars(server, template, network);

    // If the installer had to fetch its own JRE, put it on PATH ahead of the
    // image's own — while preserving that PATH, since setting Env replaces it.
    const extraEnv = {};
    if (this.privateJavaBin(server.dir)) {
      let imagePath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
      try {
        const info = await docker.request('GET', `/images/${encodeURIComponent(image)}/json`);
        const found = (info?.Config?.Env || []).find((e) => e.startsWith('PATH='));
        if (found) imagePath = found.slice(5);
      } catch {
        /* fall back to the standard path */
      }
      extraEnv.PATH = `${CONTAINER_DIR}/.java/bin:${imagePath}`;
      extraEnv.JAVA_HOME = `${CONTAINER_DIR}/.java`;
    }

    const { exposed, bindings } = this.portBindings(server);
    const memoryBytes = Math.max(64, Number(server.memory) || 1024) * 1024 * 1024;
    const nanoCpus = server.cpuLimit ? Math.round((Number(server.cpuLimit) / 100) * 1e9) : 0;

    const created = await docker.create(name, {
      Image: image,
      Cmd: ['bash', '-lc', command],
      WorkingDir: CONTAINER_DIR,
      Env: this.containerEnv(server, vars, extraEnv),
      User: this.containerUser(),
      Hostname: server.id.slice(0, 63),
      Tty: false,
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      ExposedPorts: exposed,
      Labels: { 'gamepanel.managed': 'true', 'gamepanel.server': server.id, 'gamepanel.role': 'game' },
      HostConfig: {
        Binds: [`${server.dir}:${CONTAINER_DIR}:rw`],
        PortBindings: bindings,
        Memory: memoryBytes,
        MemorySwap: memoryBytes, // no swap: a leaking server cannot drag the host down
        NanoCpus: nanoCpus,
        NetworkMode: network,
        RestartPolicy: { Name: 'no' }, // the panel handles restarts and crash counting
        LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '2' } },
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['SYS_ADMIN', 'SYS_MODULE', 'NET_ADMIN'],
        // No PidsLimit: the JVM and Unreal servers spawn hundreds of threads,
        // which count towards it, and hitting the cap fails in confusing ways.
      },
    });

    rt.docker = { ...(rt.docker || {}), id: created.Id, network };
    this.writePid(server.id, created.Id);

    // Attach before starting so no early output is missed.
    const onOutput = this.makeOutputHandler(server, template);
    const attachment = await docker.attach(created.Id, { stdin: true });
    attachment.on('output', (payload, kind) => onOutput(payload, kind));
    rt.docker.attachment = attachment;

    await docker.start(created.Id);

    rt.startedAt = Date.now();
    rt.stopping = false;
    rt.playerList = [];
    rt.players = null;
    this.openLogStream(server);

    this.attachStats(server, created.Id);

    docker
      .wait(created.Id)
      .then((code) => this.handleExit(server, code, null))
      .catch((err) => {
        logger.debug(`docker wait failed for ${server.id}: ${err.message}`);
        this.handleExit(server, -1, null);
      });

    this.store.addEvent('server.started', `${server.name} started (container)`, { serverId: server.id });
    return this.publicServer(server);
  }

  /** Follow the container stats stream; this is where per-server network comes from. */
  attachStats(server, containerId) {
    const rt = this.rt(server.id);
    let previous = null;
    docker
      .statsStream(containerId, (sample) => {
        rt.cpu = sample.cpuPercent;
        rt.memory = sample.memory;
        if (previous) {
          const seconds = (sample.at - previous.at) / 1000;
          if (seconds > 0) {
            rt.networkRx = Math.max(0, Math.round((sample.networkRx - previous.networkRx) / seconds));
            rt.networkTx = Math.max(0, Math.round((sample.networkTx - previous.networkTx) / seconds));
          }
        }
        previous = sample;
      })
      .then((stop) => {
        if (rt.docker) rt.docker.stopStats = stop;
      })
      .catch((err) => logger.debug(`stats stream failed: ${err.message}`));
  }

  /**
   * Optional companion containers (a database for FiveM, for example). They
   * join the server's private network, so only that server can reach them.
   */
  async startSidecars(server, template, network) {
    const sidecars = template.sidecars || [];
    if (!sidecars.length) return;
    const vars = this.vars(server);

    for (const sidecar of sidecars) {
      const enabled = sidecar.enabledVar ? String(vars[sidecar.enabledVar]).toLowerCase() : 'true';
      if (['false', '0', 'no', ''].includes(enabled)) continue;

      const name = `gp-${server.id}-${sidecar.name}`;
      try {
        await docker.ensureImage(sidecar.image, (line) => this.pushConsole(server, line, 'system'));
        await docker.remove(name);
        const env = Object.entries(sidecar.env || {}).map(([k, v]) => `${k}=${interpolate(String(v), vars)}`);
        const created = await docker.create(name, {
          Image: sidecar.image,
          Env: env,
          Labels: { 'gamepanel.managed': 'true', 'gamepanel.server': server.id, 'gamepanel.role': 'sidecar' },
          HostConfig: {
            Binds: sidecar.volume ? [`gp-vol-${server.id}-${sidecar.name}:${sidecar.volume}`] : [],
            NetworkMode: network,
            RestartPolicy: { Name: 'unless-stopped' },
            Memory: (sidecar.memory || 1024) * 1024 * 1024,
          },
          NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [sidecar.name] } } },
        });
        await docker.start(created.Id);
        this.pushConsole(server, `Companion container "${sidecar.name}" (${sidecar.image}) is running.`, 'system');
      } catch (err) {
        this.pushConsole(server, `Could not start companion container ${sidecar.name}: ${err.message}`, 'system');
      }
    }
  }

  async stopSidecars(server) {
    const template = this.template(server);
    for (const sidecar of template?.sidecars || []) {
      await docker.remove(`gp-${server.id}-${sidecar.name}`).catch(() => {});
    }
  }

  /** Remove every Docker object belonging to a server (used on delete). */
  async cleanupContainers(server) {
    await docker.remove(this.containerName(server.id)).catch(() => {});
    await docker.remove(`gp-install-${server.id}`).catch(() => {});
    await this.stopSidecars(server);
    const template = this.template(server);
    for (const sidecar of template?.sidecars || []) {
      await docker
        .request('DELETE', `/volumes/gp-vol-${server.id}-${sidecar.name}?force=true`)
        .catch(() => {});
    }
    await docker.removeNetwork(this.networkName(server.id));
  }

  /**
   * After a panel restart, adopt containers that are still running instead of
   * bouncing everyone's game server.
   */
  async reattachContainers() {
    let containers = [];
    try {
      containers = await docker.list(true);
    } catch (err) {
      logger.warn(`Could not list containers: ${err.message}`);
      return;
    }

    for (const container of containers) {
      const serverId = container.Labels?.['gamepanel.server'];
      const role = container.Labels?.['gamepanel.role'];
      const server = serverId ? this.find(serverId) : null;

      // Containers whose server no longer exists are leftovers.
      if (!server) {
        await docker.remove(container.Id).catch(() => {});
        continue;
      }
      if (role !== 'game') continue;

      if (container.State !== 'running') {
        await docker.remove(container.Id).catch(() => {});
        continue;
      }

      const rt = this.rt(server.id);
      const template = this.template(server);
      rt.docker = { id: container.Id, network: this.networkName(server.id) };
      rt.startedAt = (container.Created || Math.floor(Date.now() / 1000)) * 1000;
      rt.status = STATUS.RUNNING;

      try {
        const onOutput = this.makeOutputHandler(server, template || {});
        const attachment = await docker.attach(container.Id, { stdin: true });
        attachment.on('output', (payload, kind) => onOutput(payload, kind));
        rt.docker.attachment = attachment;
        this.openLogStream(server);
        this.attachStats(server, container.Id);
        docker
          .wait(container.Id)
          .then((code) => this.handleExit(server, code, null))
          .catch(() => {});
        this.pushConsole(server, 'Panel reconnected to the running container.', 'system');
        logger.info(`Re-attached to running container for ${server.name}`);
      } catch (err) {
        logger.warn(`Could not re-attach to ${server.name}: ${err.message}`);
        rt.status = STATUS.RUNNING; // it is still running even if the console is not wired
      }
    }
    this.broadcastServers();
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
