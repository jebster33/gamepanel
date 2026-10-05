'use strict';

/**
 * Running a Linux server inside Docker: one container per game, a private
 * network per server for companion containers, and throwaway root containers
 * for installs and maintenance tasks.
 * Mixed into ServerManager (see manager.js).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { logger, interpolate } = require('../../core/util');
const { STATUS, CONTAINER_DIR } = require('../constants');
const { docker } = require('./docker-api');

const DEFAULT_IMAGE = 'debian:bookworm-slim';

const hostUid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);
const hostGid = () => (typeof process.getgid === 'function' ? process.getgid() : 0);

/** Docker Desktop on Windows wants forward slashes in bind sources. */
const bindSource = (dir) => dir.replace(/\\/g, '/');

module.exports = {
  containerName(id) {
    return `gp-${id}`;
  },

  networkName(id) {
    return `gp-net-${id}`;
  },

  /**
   * The image a server runs in. Java games use
   * `eclipse-temurin:{{JAVA_VERSION}}-jre`, where JAVA_VERSION is whatever the
   * resolver said that Minecraft release needs.
   */
  imageFor(template, server) {
    const raw = template?.image || DEFAULT_IMAGE;
    const vars = { JAVA_VERSION: '21', ...(server?.vars || {}) };
    return interpolate(raw, vars) || DEFAULT_IMAGE;
  },

  /**
   * The image to run, with a thin derived layer when the template needs extra
   * runtime `packages` (apt installs during an install would be thrown away
   * with the install container).
   */
  async resolveImage(template, server, onLine = () => {}) {
    const base = this.imageFor(template, server);
    const packages = template?.packages || [];
    if (!packages.length) {
      await docker.ensureImage(base, onLine);
      return base;
    }
    // The tag includes the base image, so switching Java versions builds a
    // separate layer rather than reusing the wrong one.
    const hash = crypto.createHash('sha1').update(`${base}|${packages.join(' ')}`).digest('hex').slice(0, 10);
    const tag = `gamepanel/${template.id}:${hash}`;
    if (await docker.hasImage(tag)) return tag;

    await docker.ensureImage(base, onLine);
    onLine(`Building the runtime image with ${packages.join(', ')} (once per game).`);
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
  },

  /** uid:gid the game runs as, so files on the bind mount stay ours. */
  containerUser() {
    return `${hostUid()}:${hostGid()}`;
  },

  containerEnv(server, vars, extra = {}) {
    const env = {
      GP_SERVER_ID: server.id,
      GP_SERVER_DIR: CONTAINER_DIR,
      GP_STEAMCMD: `${CONTAINER_DIR}/.steamcmd`,
      HOME: CONTAINER_DIR,
      TERM: 'xterm',
      LD_LIBRARY_PATH: `${CONTAINER_DIR}/linux64:${CONTAINER_DIR}/.steam/sdk64:${CONTAINER_DIR}`,
    };
    for (const [k, v] of Object.entries(vars)) {
      if (/^[A-Z][A-Z0-9_]*$/.test(k) && v !== undefined && v !== null) env[k] = String(v);
    }
    Object.assign(env, extra);
    return Object.entries(env).map(([k, v]) => `${k}=${v}`);
  },

  /** Publish every port; "both" (or no protocol) means TCP and UDP. */
  portBindings(server) {
    const template = this.template(server);
    const exposed = {};
    const bindings = {};
    for (const [name, port] of Object.entries(server.ports || {})) {
      const def = (template?.ports || []).find((p) => p.name === name);
      const protocols = !def?.protocol || def.protocol === 'both' ? ['tcp', 'udp'] : [def.protocol];
      for (const proto of protocols) {
        exposed[`${port}/${proto}`] = {};
        bindings[`${port}/${proto}`] = [{ HostIp: server.ip || '0.0.0.0', HostPort: String(port) }];
      }
    }
    return { exposed, bindings };
  },

  /**
   * Run a script from the server directory in a throwaway container.
   * Installs run as root (so apt works); the script hands the files back.
   */
  async runScriptInContainer(server, template, scriptName, env, { label = 'task', asRoot = true } = {}) {
    const rt = this.rt(server.id);
    const name = `gp-${label}-${server.id}`;
    try {
      const image = await this.resolveImage(template, server, (line) => this.pushConsole(server, line, 'system'));
      await docker.remove(name);
      const created = await docker.create(name, {
        Image: image,
        Cmd: ['bash', `${CONTAINER_DIR}/${scriptName}`],
        WorkingDir: CONTAINER_DIR,
        Env: this.containerEnv(server, this.vars(server), {
          ...env,
          GP_UID: String(hostUid()),
          GP_GID: String(hostGid()),
          DEBIAN_FRONTEND: 'noninteractive',
        }),
        User: asRoot ? '0:0' : this.containerUser(),
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        Labels: { 'gamepanel.managed': 'true', 'gamepanel.server': server.id, 'gamepanel.role': label },
        HostConfig: {
          Binds: [`${bindSource(server.dir)}:${CONTAINER_DIR}:rw`],
          NetworkMode: 'bridge',
          AutoRemove: false,
          LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '1' } },
        },
      });
      rt.docker = { ...(rt.docker || {}), installId: created.Id };
      const stopLogs = await docker.logs(created.Id, (payload, kind) => this.pushConsole(server, payload.toString('utf8'), kind));
      await docker.start(created.Id);
      const code = await docker.wait(created.Id);
      stopLogs();
      await docker.remove(created.Id).catch(() => {});
      return { code };
    } catch (err) {
      await docker.remove(name).catch(() => {});
      return { code: -1, error: `The ${label} container failed: ${err.message}` };
    } finally {
      if (rt.docker) rt.docker.installId = null;
    }
  },

  /** Create and start the game container, then wire up console, stats and exit. */
  async startContainer(server, template, command, vars) {
    const rt = this.rt(server.id);
    const name = this.containerName(server.id);
    const network = await docker.ensureNetwork(this.networkName(server.id));
    const image = await this.resolveImage(template, server, (line) => this.pushConsole(server, line, 'system'));
    await docker.remove(name);
    await this.startSidecars(server, template, network);

    // A JRE the installer fetched goes ahead of the image's own on PATH.
    // Setting Env replaces the image PATH, so read it and keep it.
    const extraEnv = {};
    if (fs.existsSync(path.join(server.dir, '.java', 'bin', 'java'))) {
      let imagePath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
      try {
        const info = await docker.request('GET', `/images/${encodeURIComponent(image)}/json`);
        const found = (info?.Config?.Env || []).find((e) => e.startsWith('PATH='));
        if (found) imagePath = found.slice(5);
      } catch {
        /* the standard path will do */
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
        Binds: [`${bindSource(server.dir)}:${CONTAINER_DIR}:rw`],
        PortBindings: bindings,
        Memory: memoryBytes,
        MemorySwap: memoryBytes, // no swap: a leaking server cannot drag the host down
        NanoCpus: nanoCpus,
        NetworkMode: network,
        RestartPolicy: { Name: 'no' }, // the panel handles restarts and crash counting
        LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '2' } },
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['SYS_ADMIN', 'SYS_MODULE', 'NET_ADMIN'],
        // No PidsLimit: JVM and Unreal servers run hundreds of threads.
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
    this.attachStats(server, created.Id);
    this.watchContainer(server, created.Id);
  },

  watchContainer(server, containerId) {
    docker
      .wait(containerId)
      .then((code) => this.handleExit(server, code, null))
      .catch((err) => {
        logger.debug(`docker wait failed for ${server.id}: ${err.message}`);
        this.handleExit(server, -1, null);
      });
  },

  /** Follow the stats stream; per-server network traffic comes from here. */
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
        else stop();
      })
      .catch((err) => logger.debug(`stats stream failed: ${err.message}`));
  },

  /**
   * Companion containers (a database for FiveM, for example). They join the
   * server's private network, so only that server can reach them.
   */
  async startSidecars(server, template, network) {
    const vars = this.vars(server);
    for (const sidecar of template.sidecars || []) {
      const enabled = sidecar.enabledVar ? String(vars[sidecar.enabledVar]).toLowerCase() : 'true';
      if (['false', '0', 'no', ''].includes(enabled)) continue;
      const name = `gp-${server.id}-${sidecar.name}`;
      try {
        await docker.ensureImage(sidecar.image, (line) => this.pushConsole(server, line, 'system'));
        await docker.remove(name);
        const created = await docker.create(name, {
          Image: sidecar.image,
          Env: Object.entries(sidecar.env || {}).map(([k, v]) => `${k}=${interpolate(String(v), vars)}`),
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
        this.pushConsole(server, `Companion "${sidecar.name}" (${sidecar.image}) is running.`, 'system');
      } catch (err) {
        this.pushConsole(server, `Could not start companion ${sidecar.name}: ${err.message}`, 'system');
      }
    }
  },

  async stopSidecars(server) {
    for (const sidecar of this.template(server)?.sidecars || []) {
      await docker.remove(`gp-${server.id}-${sidecar.name}`).catch(() => {});
    }
  },

  /** Called from handleExit: drop the exited container so the next start is clean. */
  cleanupAfterExit(server) {
    const rt = this.rt(server.id);
    if (!rt.docker) return;
    rt.docker.attachment?.close();
    rt.docker.stopStats?.();
    const containerId = rt.docker.id;
    rt.docker = null;
    // The game's data lives on the bind mount, not in the container layer.
    if (containerId) docker.remove(containerId).catch(() => {});
    this.stopSidecars(server).catch(() => {});
  },

  signalContainer(id, sig) {
    const rt = this.rt(id);
    if (!rt.docker?.id) return;
    docker.kill(rt.docker.id, sig).catch((err) => logger.debug(`docker kill: ${err.message}`));
  },

  killContainer(id) {
    const rt = this.rt(id);
    if (rt.docker?.installId) docker.remove(rt.docker.installId).catch(() => {});
    if (rt.docker?.id) {
      const containerId = rt.docker.id;
      docker.kill(containerId, 'SIGKILL').catch(() => docker.remove(containerId).catch(() => {}));
    }
  },

  /** Remove every Docker object that belongs to a server (on delete). */
  async cleanupContainers(server) {
    await docker.remove(this.containerName(server.id)).catch(() => {});
    for (const role of ['install', 'update', 'task']) await docker.remove(`gp-${role}-${server.id}`).catch(() => {});
    await this.stopSidecars(server);
    for (const sidecar of this.template(server)?.sidecars || []) {
      await docker.request('DELETE', `/volumes/gp-vol-${server.id}-${sidecar.name}?force=true`).catch(() => {});
    }
    await docker.removeNetwork(this.networkName(server.id)).catch(() => {});
  },

  /**
   * After a panel restart or update, adopt containers that are still running
   * instead of kicking everyone off their game.
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
      if (!server) {
        await docker.remove(container.Id).catch(() => {}); // leftovers of a deleted server
        continue;
      }
      if (role !== 'game') continue;
      if (container.State !== 'running') {
        await docker.remove(container.Id).catch(() => {});
        continue;
      }

      const rt = this.rt(server.id);
      const template = this.template(server) || {};
      rt.docker = { id: container.Id, network: this.networkName(server.id) };
      rt.startedAt = (container.Created || Math.floor(Date.now() / 1000)) * 1000;
      rt.status = STATUS.RUNNING;
      try {
        const onOutput = this.makeOutputHandler(server, template);
        const attachment = await docker.attach(container.Id, { stdin: true });
        attachment.on('output', (payload, kind) => onOutput(payload, kind));
        rt.docker.attachment = attachment;
        this.openLogStream(server);
        this.attachStats(server, container.Id);
        this.watchContainer(server, container.Id);
        this.pushConsole(server, 'The panel reconnected to the running server.', 'system');
        logger.info(`Re-attached to the running container for ${server.name}`);
      } catch (err) {
        logger.warn(`Could not re-attach to ${server.name}: ${err.message}`);
      }
    }
    this.broadcastServers();
  },
};
