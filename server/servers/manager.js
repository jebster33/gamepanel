'use strict';

/**
 * ServerManager — the list of game servers and everything you can do to them.
 *
 * The class is split across files by topic so each one stays readable:
 *
 *   manager.js         this file: the server list, create/update/delete, ports
 *   console.js         console scrollback, log files, player tracking
 *   config-files.js    writing and patching game config files
 *   install.js         installing, reinstalling and updating games
 *   power.js           start / stop / restart / kill, crashes and auto-restart
 *   stats.js           CPU, memory, players, ping, disk
 *   history.js         player history and the activity log
 *   versions.js        switching game version / Minecraft server type
 *   doctor.js          crash doctor and log sharing
 *   worlds.js          Minecraft worlds: switch, import, download, reset
 *   alerts.js          CPU, memory and disk alerts
 *   clone.js           duplicating a server
 *   crossplay.js       Bedrock players on Java servers (Geyser + Floodgate)
 *   livemap.js         a web map of the world (BlueMap)
 *   pregen.js          world pre-generation (Chunky)
 *   tps.js             ticks per second over RCON (Paper, Purpur)
 *   watchers.js        tailing game log files, port-based readiness
 *   runtimes/container.js   running a server in Docker (Linux isolation)
 *   runtimes/process.js     running a server as a plain process (Linux or Windows)
 *
 * Each of those files exports plain methods that are mixed into this class,
 * so inside any of them `this` is the manager.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { config } = require('../core/config');
const { logger, uid, slugify, fail, sleep } = require('../core/util');
const { HOST_PLATFORM, isWindows } = require('../core/platform');
const { variant } = require('../games/templates');
const { playerCommands, playerDetails } = require('../games/players');
const { listsFor } = require('../games/player-lists');
const { Ring } = require('../features/metrics');
const { docker } = require('./runtimes/docker-api');

const { STATUS, CONTAINER_DIR } = require('./constants');

/** Fields a PATCH may change. Anything else on a server is managed by the panel. */
const EDITABLE = ['name', 'memory', 'cpuLimit', 'maxPlayers', 'autoStart', 'autoRestart', 'updateOnStart', 'startCommand', 'notes', 'ip', 'backupRetention', 'idleStopMinutes', 'alerts'];

class ServerManager extends EventEmitter {
  /**
   * @param {import('../core/store').Store} store
   * @param {import('../games/templates').TemplateRegistry} templates
   * @param {{broadcast:(topic:string, payload:object)=>void}} bus
   */
  constructor(store, templates, bus) {
    super();
    this.store = store;
    this.templates = templates;
    this.bus = bus;
    this.runtime = new Map();
    this.shuttingDown = false;
    this.dockerAvailable = false;
    this.dockerInfo = null;
    fs.mkdirSync(config.runDir, { recursive: true });
  }

  /* ------------------------------------------------------------ lifecycle -- */

  async init() {
    await this.detectDocker();
    this.reapStaleProcesses();
    for (const server of this.servers) this.migrate(server);
    if (this.dockerAvailable) await this.reattachContainers();

    this.timers = [
      setInterval(() => this.collectMetrics(), config.metricsIntervalMs),
      setInterval(() => this.runQueries(), config.queryIntervalMs),
      setInterval(() => this.refreshDiskUsage(), 5 * 60_000),
    ];
    for (const t of this.timers) t.unref?.();
    this.refreshDiskUsage();

    const autoStart = this.servers.filter((s) => s.autoStart && s.installedAt && !this.isActive(s.id));
    for (const server of autoStart) {
      logger.info(`Auto-starting ${server.name}`);
      await this.start(server.id).catch((err) => logger.error(`Auto-start failed for ${server.name}:`, err.message));
      await sleep(1500); // stagger, so a dozen servers do not all boot at once
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    for (const t of this.timers || []) clearInterval(t);
    this.saveHistories();
    // Containers keep running across a panel restart or update; only child
    // processes have to stop, since they would be orphaned.
    for (const server of this.servers) {
      const rt = this.rt(server.id);
      rt.docker?.attachment?.close();
      rt.docker?.stopStats?.();
    }
    const running = this.servers.filter((s) => this.isActive(s.id) && this.runtimeFor(s) === 'process');
    if (!running.length) return;
    logger.info(`Stopping ${running.length} server process(es)…`);
    await Promise.all(running.map((s) => this.stop(s.id).catch(() => {})));
    await sleep(500);
  }

  /** Bring servers saved by older panel versions up to the current shape. */
  migrate(server) {
    if (!server.platform) server.platform = 'linux';
    if (server.backupRetention === undefined) server.backupRetention = 10;
    if (!Array.isArray(server.schedules)) server.schedules = [];
    this.rt(server.id).status = STATUS.OFFLINE;
  }

  async detectDocker() {
    this.dockerAvailable = await docker.available();
    this.dockerInfo = null;
    if (this.dockerAvailable) {
      try {
        const info = await docker.info();
        this.dockerInfo = { version: info.ServerVersion, os: info.OSType, root: info.DockerRootDir, containers: info.Containers };
        // Docker Desktop in Windows-container mode cannot run our Linux images.
        if (info.OSType && info.OSType !== 'linux') {
          logger.warn(`Docker is running ${info.OSType} containers — Linux game images need Linux containers`);
          this.dockerAvailable = false;
        } else {
          logger.info(`Docker ${info.ServerVersion} detected`);
        }
      } catch {
        /* reachable but no info — treat as available */
      }
    } else if (!isWindows) {
      logger.warn('Docker not available — servers run as plain processes (no isolation between them)');
    }
    return this.dockerAvailable;
  }

  /* ---------------------------------------------------------------- lookup -- */

  get servers() {
    return this.store.state.servers;
  }

  get settings() {
    return this.store.state.settings;
  }

  find(id) {
    return this.servers.find((s) => s.id === id) || null;
  }

  require(id) {
    const server = this.find(id);
    if (!server) fail(404, 'Server not found');
    return server;
  }

  /** The template as this server runs it (its platform variant). */
  template(server) {
    return variant(this.templates.get(server.templateId), server.platform || 'linux');
  }

  /** Volatile per-server state: process handles, console, live metrics. */
  rt(id) {
    if (!this.runtime.has(id)) {
      this.runtime.set(id, {
        status: STATUS.OFFLINE,
        proc: null,
        pid: null,
        docker: null,
        startedAt: null,
        console: [],
        seq: 0,
        partial: '',
        history: new Ring(config.metricsHistoryPoints),
        prevCpuSample: null,
        cpu: 0,
        memory: 0,
        connections: 0,
        networkRx: 0,
        networkTx: 0,
        players: null,
        maxPlayers: null,
        playerList: [],
        ping: null,
        queryError: null,
        version: null,
        diskBytes: 0,
        stopping: false,
        stopTimer: null,
        restartAfterStop: false,
        recentCrashes: [],
        task: null,
      });
    }
    return this.runtime.get(id);
  }

  isActive(id) {
    const status = this.rt(id).status;
    return status === STATUS.RUNNING || status === STATUS.STARTING || status === STATUS.STOPPING;
  }

  /**
   * How a server runs:
   *  - Windows builds always run as Windows processes.
   *  - Linux builds use a container when Docker is there and allowed
   *    (on a Windows host that is the only way to run them at all).
   */
  runtimeFor(server) {
    if ((server.platform || 'linux') === 'windows') return 'process';
    if (isWindows) return 'docker';
    if (server.runtime === 'process' || !this.dockerAvailable || this.settings.containerize === false) return 'process';
    if (this.template(server)?.container === false) return 'process';
    return 'docker';
  }

  /** Which variant of a template this host should install. */
  pickPlatform(template) {
    const platforms = template.platforms || ['linux'];
    if (platforms.includes(HOST_PLATFORM)) return HOST_PLATFORM;
    if (isWindows && platforms.includes('linux')) {
      if (this.dockerAvailable) return 'linux';
      fail(400, `${template.name} only has a Linux server. Install Docker Desktop (with Linux containers) to run it on Windows.`);
    }
    fail(400, `${template.name} has no ${HOST_PLATFORM === 'windows' ? 'Windows' : 'Linux'} server build.`);
    return null;
  }

  /** Every value a template can reference with {{VAR}}. */
  vars(server) {
    const ports = server.ports || {};
    const out = {
      SERVER_ID: server.id,
      SERVER_NAME: server.name,
      SERVER_DIR: this.workDir(server),
      MEMORY: server.memory,
      MEMORY_MB: server.memory,
      CPU_LIMIT: server.cpuLimit || 0,
      IP: server.ip || '0.0.0.0',
      PORT: ports.game ?? Object.values(ports)[0] ?? 0,
      MAX_PLAYERS: server.maxPlayers || 20,
      ...(server.vars || {}),
    };
    if (!out.JAVA_VERSION) out.JAVA_VERSION = '21';
    for (const [name, value] of Object.entries(ports)) out[`PORT_${name.toUpperCase()}`] = value;
    return out;
  }

  /** The directory the game sees as its home (differs inside a container). */
  workDir(server) {
    return this.runtimeFor(server) === 'docker' ? CONTAINER_DIR : server.dir;
  }

  /** The version actually running: live query first, then what was installed. */
  gameVersion(server) {
    const rt = this.rt(server.id);
    if (rt.version) return rt.version;
    if (server.gameVersion) return server.gameVersion;
    if (server.resolvedVersion) return server.resolvedVersion;
    return null;
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
      memory: rt.memory, // live usage; the configured cap is memoryMb
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
      tps: rt.tps ?? null,
      // The webhook URL lets anyone post to that channel: only say whether one is set.
      discordFeed: server.discordFeed ? { ...server.discordFeed, webhook: undefined, connected: true } : undefined,
      playerDetails: playerDetails(rt),
      playerCommands: Object.keys(playerCommands(tpl)),
      playerLists: Object.keys(listsFor(tpl) || {}),
      ping: rt.ping,
      queryError: rt.queryError,
      diskBytes: rt.diskBytes,
      task: rt.task,
      templateName: tpl?.name || server.templateId,
      templateIcon: tpl?.icon || '🎮',
      templateCategory: tpl?.category || 'Other',
      supportsConsoleInput: tpl?.consoleInput !== false,
      hasRcon: Boolean(tpl?.rcon && server.vars?.RCON_PASSWORD),
      hasMods: Boolean(tpl?.mods?.providers?.length || tpl?.mods?.dir),
      hasModpacks: Boolean(tpl?.modpacks),
      canUpdate: Boolean((tpl?.install || []).some((s) => s.type === 'steamcmd') || tpl?.update),
      modProviders: tpl?.mods?.providers || [],
      gameVersion: this.gameVersion(server),
      joinNote: tpl?.joinNote || null,
      diagnosis: rt.diagnosis || null,
    };
  }

  /* ---------------------------------------------------------------- create -- */

  usedPorts(exceptId = null) {
    const used = new Set();
    for (const server of this.servers) {
      if (server.id === exceptId) continue;
      for (const port of Object.values(server.ports || {})) used.add(Number(port));
    }
    return used;
  }

  allocatePort(preferred, used) {
    const { portRangeStart, portRangeEnd } = this.settings;
    if (preferred && !used.has(Number(preferred))) return Number(preferred);
    for (let p = portRangeStart; p <= portRangeEnd; p++) if (!used.has(p)) return p;
    return fail(409, 'No free ports left in the configured range');
  }

  /**
   * Give every port a free number. Ports declared with an `offset` follow the
   * game port, so moving the game port moves its query/RCON ports with it.
   */
  assignPorts(template, requested = {}) {
    const used = this.usedPorts();
    const ports = {};
    const primaryDef = template.ports.find((p) => p.name === 'game') || template.ports[0];
    const primary = this.allocatePort(requested[primaryDef.name] ?? requested.game ?? primaryDef.default, used);
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
      if (def.options?.length && !def.allowCustom) {
        const allowed = def.options.map((o) => String(typeof o === 'object' ? o.value : o));
        if (!allowed.includes(String(value))) fail(400, `${def.label || def.name} must be one of: ${allowed.join(', ')}`);
      }
      if (def.required && String(value).trim() === '') fail(400, `${def.label || def.name} is required`);
      if (def.generate === 'password' && !value) value = require('crypto').randomBytes(12).toString('base64url');
      out[def.name] = value;
    }
    // Anything extra the user supplied is passed through untouched.
    for (const [k, v] of Object.entries(provided)) if (!(k in out)) out[k] = v;
    return out;
  }

  /** `dir` is set when importing a server whose files stay where they are. */
  create(input, actor, { dir = null } = {}) {
    const base = this.templates.require(input.templateId);
    const platform = this.pickPlatform(base);
    const template = variant(base, platform);
    const name = String(input.name || template.name).trim().slice(0, 60);
    if (!name) fail(400, 'Server name is required');

    const id = `${slugify(name)}-${uid(4)}`;
    const vars = this.resolveVars(template, input.vars || {});
    const server = {
      id,
      name,
      templateId: template.id,
      platform,
      dir: dir || path.join(config.serversDir, id),
      ip: input.ip || '0.0.0.0',
      ports: this.assignPorts(template, input.ports || {}),
      vars,
      memory: Number(input.memory) || Number(template.defaultMemory) || 2048,
      cpuLimit: Number(input.cpuLimit) || 0,
      maxPlayers: Number(input.maxPlayers) || Number(vars.MAX_PLAYERS) || 20,
      autoStart: input.autoStart !== false,
      autoRestart: input.autoRestart !== false,
      updateOnStart: Boolean(input.updateOnStart),
      startCommand: input.startCommand || null, // null = follow the template
      backupRetention: 10,
      schedules: [],
      createdAt: Date.now(),
      createdBy: actor?.username || 'system',
      installedAt: null,
      crashCount: 0,
      lastExit: null,
      notes: '',
    };

    fs.mkdirSync(server.dir, { recursive: true });
    this.servers.push(server);
    this.store.save();
    this.store.addEvent('server.created', `${name} created from ${template.name}`, { serverId: id });
    this.broadcastServers();
    return server;
  }

  update(id, patch) {
    const server = this.require(id);
    for (const key of EDITABLE) if (patch[key] !== undefined) server[key] = patch[key];
    if (patch.startCommand === '') server.startCommand = null;
    if (patch.memory !== undefined) server.memory = Math.max(256, Number(patch.memory) || server.memory);
    if (patch.idleStopMinutes !== undefined) server.idleStopMinutes = Math.max(0, Math.min(1440, Math.round(Number(patch.idleStopMinutes) || 0)));
    if (patch.alerts !== undefined) server.alerts = this.cleanAlerts(patch.alerts);
    if (patch.vars) server.vars = { ...server.vars, ...patch.vars };
    if (patch.ports) {
      const used = this.usedPorts(server.id);
      for (const [name, value] of Object.entries(patch.ports)) {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) fail(400, `Invalid port for ${name}`);
        if (used.has(port)) fail(409, `Port ${port} is already used by another server`);
        server.ports[name] = port;
      }
    }
    this.store.save();
    this.broadcastServers();
    return server;
  }

  async remove(id, deleteFiles = true) {
    const server = this.require(id);
    if (this.isActive(id)) await this.stop(id).catch(() => {});
    this.killTree(id);
    if (this.dockerAvailable) await this.cleanupContainers(server).catch(() => {});
    this.servers.splice(this.servers.indexOf(server), 1);
    this.runtime.delete(id);
    this.deleteHistory(id);
    // Free play.example.com so the name can be reused.
    if (server.subdomain) require('../features/dns').release(this.store, server).catch(() => {});
    this.store.save();
    // A server imported in place keeps its folder: those files were never the panel's.
    if (deleteFiles && server.imported?.inPlace) {
      fs.rmSync(path.join(config.backupsDir, id), { recursive: true, force: true });
    } else if (deleteFiles) {
      // Windows can hold file locks for a moment after a process exits.
      await sleep(isWindows ? 1500 : 0);
      try {
        fs.rmSync(server.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        fs.rmSync(path.join(config.backupsDir, id), { recursive: true, force: true });
      } catch (err) {
        logger.warn(`Could not delete ${server.dir}: ${err.message}`);
      }
    }
    this.store.addEvent('server.deleted', `${server.name} deleted`, { serverId: id });
    this.broadcastServers();
  }

  /* ------------------------------------------------------------- broadcast -- */

  setStatus(server, status) {
    const rt = this.rt(server.id);
    if (rt.status === status) return;
    rt.status = status;
    this.bus.broadcast('server:status', { serverId: server.id, status, server: this.publicServer(server) });
    this.broadcastServers();
  }

  /** Long-running background job (update, Workshop download…) shown on the server. */
  setTask(server, label) {
    this.rt(server.id).task = label || null;
    this.broadcastServers();
  }

  broadcastServers() {
    this.bus.broadcast('servers', { servers: this.servers.map((s) => this.publicServer(s)) });
  }

  /** Snapshot for the dashboard header. */
  overview() {
    let running = 0;
    let players = 0;
    let cpu = 0;
    let memory = 0;
    for (const server of this.servers) {
      const rt = this.rt(server.id);
      if (rt.status === STATUS.RUNNING) running++;
      players += rt.players ?? rt.playerList?.length ?? 0;
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

  /* ------------------------------------------------------------- pid files -- */

  writePid(id, pid) {
    try {
      fs.writeFileSync(path.join(config.runDir, `${id}.pid`), String(pid));
    } catch {
      /* best effort */
    }
  }

  clearPid(id) {
    try {
      fs.unlinkSync(path.join(config.runDir, `${id}.pid`));
    } catch {
      /* already gone */
    }
  }

  /** Kill process trees left behind by a panel that crashed. */
  reapStaleProcesses() {
    let files = [];
    try {
      files = fs.readdirSync(config.runDir).filter((f) => f.endsWith('.pid'));
    } catch {
      return;
    }
    const { killTree } = require('../core/platform');
    for (const file of files) {
      const full = path.join(config.runDir, file);
      const value = fs.readFileSync(full, 'utf8').trim();
      // Container ids are hex strings; those are re-attached, not killed.
      if (/^\d+$/.test(value) && Number(value) > 1) {
        killTree(Number(value));
        logger.warn(`Stopped an orphaned server process (${value}) from a previous run`);
      }
      if (/^\d+$/.test(value)) fs.rmSync(full, { force: true });
    }
  }
}

Object.assign(
  ServerManager.prototype,
  require('./console'),
  require('./config-files'),
  require('./install'),
  require('./import'),
  require('./power'),
  require('./stats'),
  require('./history'),
  require('./versions'),
  require('./doctor'),
  require('./worlds'),
  require('./alerts'),
  require('./clone'),
  require('./crossplay'),
  require('./livemap'),
  require('./pregen'),
  require('./tps'),
  require('./watchers'),
  require('./runtimes/container'),
  require('./runtimes/process')
);

module.exports = { ServerManager, STATUS, CONTAINER_DIR };
