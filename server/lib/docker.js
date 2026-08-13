'use strict';

/**
 * Minimal Docker Engine API client (HTTP over /var/run/docker.sock).
 *
 * Containers give every game server its own filesystem view, process table,
 * network namespace and hard memory/CPU limits, so one server can never starve
 * or interfere with another. The namespace also gives us accurate per-server
 * network accounting, which is impossible for plain processes.
 */

const http = require('http');
const { EventEmitter } = require('events');
const { logger } = require('./util');

const SOCKET = process.env.GP_DOCKER_SOCKET || '/var/run/docker.sock';
const API = 'v1.41';

function request(method, path, { body, headers = {}, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath: SOCKET,
        path: `/${API}${path}`,
        method,
        timeout,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
          }
          if (res.statusCode >= 400) {
            const message = (data && data.message) || text || `Docker API ${res.statusCode}`;
            const err = new Error(message);
            err.statusCode = res.statusCode;
            reject(err);
          } else {
            resolve(data);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Docker API request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Open a streaming request and hand back the raw socket/response. */
function stream(method, path, { headers = {}, upgrade = false, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: SOCKET,
      path: `/${API}${path}`,
      method,
      headers: upgrade ? { Connection: 'Upgrade', Upgrade: 'tcp', ...headers } : headers,
    });
    if (body) req.write(body);
    if (upgrade) {
      req.on('upgrade', (res, socket) => resolve({ res, socket }));
    } else {
      req.on('response', (res) => {
        if (res.statusCode >= 400) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => reject(new Error(Buffer.concat(chunks).toString('utf8') || `Docker API ${res.statusCode}`)));
          return;
        }
        resolve({ res, socket: res });
      });
    }
    req.on('error', reject);
    req.end();
  });
}

/**
 * Docker multiplexes stdout/stderr over one stream when TTY is disabled:
 * an 8-byte header (type, 0,0,0, big-endian length) precedes each payload.
 */
function createDemuxer(onChunk) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (buffer.length < 8) return;
      const type = buffer[0];
      const size = buffer.readUInt32BE(4);
      if (buffer.length < 8 + size) return;
      const payload = buffer.subarray(8, 8 + size);
      buffer = buffer.subarray(8 + size);
      onChunk(payload, type === 2 ? 'stderr' : 'stdout');
    }
  };
}

const docker = {
  socketPath: SOCKET,

  async available() {
    try {
      await request('GET', '/_ping', { timeout: 4000 });
      return true;
    } catch {
      return false;
    }
  },

  async version() {
    return request('GET', '/version', { timeout: 5000 });
  },

  async info() {
    return request('GET', '/info', { timeout: 8000 });
  },

  /* --------------------------------------------------------------- images */

  async hasImage(image) {
    try {
      await request('GET', `/images/${encodeURIComponent(image)}/json`, { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  },

  /** Pull an image, reporting progress lines to `onLine`. */
  async pullImage(image, onLine = () => {}) {
    const ref = image.includes(':') ? image : `${image}:latest`;
    const { res } = await stream('POST', `/images/create?fromImage=${encodeURIComponent(ref)}`);
    return new Promise((resolve, reject) => {
      let pending = '';
      let lastStatus = '';
      res.on('data', (chunk) => {
        pending += chunk.toString('utf8');
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.error) return reject(new Error(event.error));
            const status = event.status + (event.id ? ` ${event.id}` : '');
            // Layer progress is noisy; only surface status changes.
            if (status !== lastStatus) {
              lastStatus = status;
              onLine(status);
            }
          } catch {
            /* ignore malformed progress lines */
          }
        }
      });
      res.on('end', resolve);
      res.on('error', reject);
    });
  },

  /**
   * Build a derived image from an inline Dockerfile.
   *
   * Packages installed while *installing* a game live in a throwaway container
   * and would vanish before the game runs, so anything the game needs at
   * runtime has to be baked into an image. Templates declare `packages` and we
   * build a small layer on top of their base image, once, and cache it.
   */
  async build(tag, dockerfile, onLine = () => {}) {
    const context = tarSingleFile('Dockerfile', dockerfile);
    const { res } = await stream('POST', `/build?t=${encodeURIComponent(tag)}&rm=1&forcerm=1&dockerfile=Dockerfile`, {
      headers: { 'Content-Type': 'application/x-tar', 'Content-Length': String(context.length) },
      body: context,
    });
    return new Promise((resolve, reject) => {
      let pending = '';
      res.on('data', (chunk) => {
        pending += chunk.toString('utf8');
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.error) return reject(new Error(event.error));
            const text = String(event.stream || '').trim();
            if (text) onLine(text);
          } catch {
            /* ignore */
          }
        }
      });
      res.on('end', resolve);
      res.on('error', reject);
    });
  },

  async ensureImage(image, onLine = () => {}) {
    if (await docker.hasImage(image)) return false;
    onLine(`Pulling container image ${image} …`);
    await docker.pullImage(image, onLine);
    onLine(`Image ${image} ready`);
    return true;
  },

  /* ------------------------------------------------------------- networks */

  async ensureNetwork(name) {
    try {
      await request('GET', `/networks/${encodeURIComponent(name)}`, { timeout: 8000 });
      return name;
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
    await request('POST', '/networks/create', {
      body: { Name: name, Driver: 'bridge', CheckDuplicate: true, Labels: { 'gamepanel.managed': 'true' } },
    });
    return name;
  },

  async removeNetwork(name) {
    try {
      await request('DELETE', `/networks/${encodeURIComponent(name)}`);
    } catch {
      /* already gone or still in use */
    }
  },

  /* ----------------------------------------------------------- containers */

  async create(name, spec) {
    return request('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body: spec });
  },

  async start(id) {
    return request('POST', `/containers/${id}/start`);
  },

  async stop(id, timeoutSeconds = 30) {
    return request('POST', `/containers/${id}/stop?t=${timeoutSeconds}`, { timeout: (timeoutSeconds + 15) * 1000 });
  },

  async kill(id, signal = 'SIGKILL') {
    return request('POST', `/containers/${id}/kill?signal=${signal}`);
  },

  async remove(id, force = true) {
    try {
      await request('DELETE', `/containers/${id}?force=${force ? 'true' : 'false'}&v=true`);
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  },

  async inspect(id) {
    return request('GET', `/containers/${id}/json`);
  },

  async exists(id) {
    try {
      await docker.inspect(id);
      return true;
    } catch {
      return false;
    }
  },

  async list(all = true) {
    const filters = encodeURIComponent(JSON.stringify({ label: ['gamepanel.managed=true'] }));
    return request('GET', `/containers/json?all=${all ? 'true' : 'false'}&filters=${filters}`);
  },

  /** Wait for a container to exit; resolves with its exit code. */
  async wait(id) {
    const result = await request('POST', `/containers/${id}/wait`, { timeout: 0 });
    return result?.StatusCode ?? 0;
  },

  /**
   * Attach to a running container. Returns an emitter with `output`
   * (payload, stream) events, an `end` event, plus write()/close().
   */
  async attach(id, { stdin = true } = {}) {
    const query = `stream=1&stdout=1&stderr=1&${stdin ? 'stdin=1' : 'stdin=0'}`;
    const { socket } = await stream('POST', `/containers/${id}/attach?${query}`, { upgrade: true });
    const emitter = new EventEmitter();
    const demux = createDemuxer((payload, kind) => emitter.emit('output', payload, kind));

    socket.on('data', demux);
    socket.on('end', () => emitter.emit('end'));
    socket.on('close', () => emitter.emit('end'));
    socket.on('error', (err) => {
      logger.debug('docker attach socket error:', err.message);
      emitter.emit('end');
    });

    emitter.write = (text) => {
      try {
        socket.write(text);
        return true;
      } catch {
        return false;
      }
    };
    emitter.close = () => {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    };
    return emitter;
  },

  /** Follow container logs (used for install containers, no stdin needed). */
  async logs(id, onChunk, { follow = true, tail = 'all' } = {}) {
    const { res } = await stream(
      'GET',
      `/containers/${id}/logs?stdout=1&stderr=1&follow=${follow ? 1 : 0}&tail=${tail}`
    );
    const demux = createDemuxer(onChunk);
    res.on('data', demux);
    return () => res.destroy();
  },

  /**
   * Stream resource stats. Docker reports CPU/memory *and* per-container
   * network counters, which is where per-server bandwidth comes from.
   */
  async statsStream(id, onSample) {
    const { res } = await stream('GET', `/containers/${id}/stats?stream=1`);
    let pending = '';
    res.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          onSample(normalizeStats(JSON.parse(line)));
        } catch {
          /* skip malformed sample */
        }
      }
    });
    res.on('error', () => {});
    return () => res.destroy();
  },

  request,
};

/**
 * A one-file tar archive — the smallest valid build context Docker accepts.
 * Writing 512-byte ustar headers by hand keeps the dependency count at zero.
 */
function tarSingleFile(name, content) {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';

  header.write(name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8);
  header.write(octal(0, 8), 108, 8);
  header.write(octal(0, 8), 116, 8);
  header.write(octal(data.length, 12), 124, 12);
  header.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  header.write('        ', 148, 8); // checksum field counts as spaces while summing
  header.write('0', 156, 1);
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);

  const padding = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([header, data, padding, Buffer.alloc(1024, 0)]);
}

/** Turn a raw Docker stats frame into the numbers the dashboard shows. */
function normalizeStats(raw) {
  let cpuPercent = 0;
  try {
    const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - (raw.precpu_stats?.cpu_usage?.total_usage || 0);
    const systemDelta = raw.cpu_stats.system_cpu_usage - (raw.precpu_stats?.system_cpu_usage || 0);
    const cores = raw.cpu_stats.online_cpus || raw.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    if (cpuDelta > 0 && systemDelta > 0) cpuPercent = (cpuDelta / systemDelta) * cores * 100;
  } catch {
    cpuPercent = 0;
  }

  // Docker counts the page cache in memory usage; subtract it so the figure
  // matches what the game actually holds, like `docker stats` does.
  const usage = raw.memory_stats?.usage || 0;
  const cache = raw.memory_stats?.stats?.inactive_file ?? raw.memory_stats?.stats?.cache ?? 0;
  const memory = Math.max(0, usage - cache);

  let rx = 0;
  let tx = 0;
  for (const iface of Object.values(raw.networks || {})) {
    rx += iface.rx_bytes || 0;
    tx += iface.tx_bytes || 0;
  }

  return {
    at: Date.now(),
    cpuPercent,
    memory,
    memoryLimit: raw.memory_stats?.limit || 0,
    networkRx: rx,
    networkTx: tx,
    pids: raw.pids_stats?.current || 0,
  };
}

module.exports = { docker, normalizeStats, tarSingleFile };
