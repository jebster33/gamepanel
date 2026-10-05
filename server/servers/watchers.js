'use strict';

/**
 * Two helpers for games that say little on stdout — mostly Windows builds:
 *
 *   tailFiles    follow the game's own log files into the console, so the
 *                ready line, player joins and errors still show up.
 *   readyOnPort  call the server "running" once it has bound its game port.
 *
 * Mixed into ServerManager (see manager.js).
 */

const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const path = require('path');

const { interpolate, safeJoin } = require('../core/util');
const { STATUS } = require('./constants');

const TAIL_EVERY_MS = 1000;
const PORT_EVERY_MS = 3000;
const MAX_READ = 256 * 1024;

/** "Saved/Logs/*.log" → the newest matching file (one `*` in the file name only). */
function newestMatch(dir, pattern) {
  const full = safeJoin(dir, pattern);
  const base = path.basename(full);
  if (!base.includes('*')) return fs.existsSync(full) ? full : null;
  const folder = path.dirname(full);
  const re = new RegExp(`^${base.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  let best = null;
  let bestTime = 0;
  for (const name of fs.readdirSync(folder, { withFileTypes: true }).filter((e) => e.isFile() && re.test(e.name)).map((e) => e.name)) {
    const time = fs.statSync(path.join(folder, name)).mtimeMs;
    if (time > bestTime) [best, bestTime] = [path.join(folder, name), time];
  }
  return best;
}

/** True when something already listens on the port (we cannot bind it ourselves). */
function portBound(port, protocol) {
  return new Promise((resolve) => {
    const done = (bound) => {
      try {
        sock.close();
      } catch {
        /* never opened */
      }
      resolve(bound);
    };
    let sock;
    if (protocol === 'udp') {
      sock = dgram.createSocket('udp4');
      sock.once('error', (err) => done(err.code === 'EADDRINUSE' || err.code === 'EACCES'));
      sock.bind(port, () => done(false));
    } else {
      sock = net.createServer();
      sock.once('error', (err) => done(err.code === 'EADDRINUSE' || err.code === 'EACCES'));
      sock.listen(port, () => done(false));
    }
  });
}

module.exports = {
  /** Start whatever watchers the template asks for. `onOutput` is the runtime's output handler. */
  startWatchers(server, template, onOutput) {
    this.stopWatchers(server.id);
    const rt = this.rt(server.id);
    rt.watchers = [];
    if (template.tailFiles?.length) rt.watchers.push(this.tailLogs(server, template, onOutput));
    if (template.readyOnPort) rt.watchers.push(this.watchPort(server, template));
  },

  stopWatchers(id) {
    const rt = this.rt(id);
    for (const stop of rt.watchers || []) stop();
    rt.watchers = [];
  },

  /**
   * Follow each file from where it ends now. A file that appears, or is
   * replaced by a newer one (games often start a fresh log each boot), is
   * read from the beginning.
   */
  tailLogs(server, template, onOutput) {
    const vars = this.vars(server);
    const started = Date.now();
    const files = template.tailFiles.map((pattern) => ({ pattern: interpolate(pattern, vars), file: null, offset: 0 }));

    const poll = () => {
      for (const f of files) {
        let file;
        try {
          file = newestMatch(server.dir, f.pattern);
        } catch {
          file = null;
        }
        if (!file) continue;
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (file !== f.file) {
          // A log that existed before the start is old news; skip what it already holds.
          f.offset = stat.mtimeMs < started - 2000 ? stat.size : 0;
          f.file = file;
        }
        if (stat.size < f.offset) f.offset = 0; // truncated
        if (stat.size === f.offset) continue;
        const length = Math.min(stat.size - f.offset, MAX_READ);
        const buffer = Buffer.alloc(length);
        let fd;
        try {
          fd = fs.openSync(file, 'r');
          fs.readSync(fd, buffer, 0, length, f.offset);
        } catch {
          continue;
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
        f.offset += length;
        onOutput(buffer, 'stdout');
      }
    };

    const timer = setInterval(poll, TAIL_EVERY_MS);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      poll(); // the last lines often explain why it stopped
    };
  },

  /** Mark the server running once its game port is bound. Not for Docker: its proxy holds the port from the start. */
  watchPort(server, template) {
    const name = typeof template.readyOnPort === 'string' ? template.readyOnPort : template.ports?.[0]?.name;
    const spec = template.ports?.find((p) => p.name === name) || template.ports?.[0];
    const port = server.ports?.[name];
    if (!port || this.runtimeFor(server) === 'docker') return () => {};
    let stopped = false;
    const check = async () => {
      if (stopped || this.rt(server.id).status !== STATUS.STARTING) return;
      if (await portBound(port, spec?.protocol === 'udp' ? 'udp' : 'tcp')) {
        if (stopped || this.rt(server.id).status !== STATUS.STARTING) return;
        this.setStatus(server, STATUS.RUNNING);
        this.pushConsole(server, `Port ${port} is open — players can join.`, 'system');
        this.store.addEvent('server.ready', `${server.name} is ready`, { serverId: server.id });
      }
    };
    const timer = setInterval(check, PORT_EVERY_MS);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  },
};

// For tests; non-enumerable so it is not mixed into the manager.
Object.defineProperty(module.exports, '_internal', { value: { newestMatch, portBound } });
