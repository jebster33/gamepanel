'use strict';

/**
 * Console scrollback, per-server log files and player tracking from log lines.
 * Mixed into ServerManager (see manager.js), so `this` is the manager.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { stripAnsi, fail } = require('../core/util');
const { rconCommand } = require('../games/rcon');
const { setPlayers } = require('../games/players');

module.exports = {
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
  },

  closeLogStream(id) {
    const rt = this.rt(id);
    rt.logStream?.end();
    rt.logStream = null;
  },

  clearConsole(id) {
    this.rt(id).console = [];
    this.bus.broadcast(`console:${id}`, { type: 'clear' });
  },

  /**
   * Add output to a server's console. Process output arrives in arbitrary
   * chunks, so a trailing partial line is held until the rest arrives.
   * Panel notices ('system') and echoed input are always whole lines.
   */
  pushConsole(server, text, stream = 'stdout') {
    const rt = this.rt(server.id);
    const clean = stripAnsi(text);

    if (stream === 'system' || stream === 'input') {
      if (rt.partial) {
        const held = rt.partial;
        rt.partial = '';
        this.emitConsoleLines(server, [held], 'stdout');
      }
      return this.emitConsoleLines(server, clean.replace(/\n+$/, '').split('\n'), stream);
    }

    const lines = clean.split('\n');
    if (rt.partial) {
      lines[0] = rt.partial + lines[0];
      rt.partial = '';
    }
    if (!clean.endsWith('\n')) rt.partial = lines.pop() ?? '';
    else lines.pop();
    return this.emitConsoleLines(server, lines, stream);
  },

  emitConsoleLines(server, lines, stream) {
    const rt = this.rt(server.id);
    const batch = [];
    for (const line of lines) {
      const entry = { seq: ++rt.seq, at: Date.now(), stream, line: line.replace(/\r$/, '') };
      rt.console.push(entry);
      batch.push(entry);
    }
    if (rt.console.length > config.consoleBufferLines) rt.console.splice(0, rt.console.length - config.consoleBufferLines);
    if (!batch.length) return;
    try {
      rt.logStream?.write(batch.map((b) => b.line).join('\n') + '\n');
    } catch {
      /* logging is best-effort */
    }
    this.bus.broadcast(`console:${server.id}`, { type: 'lines', serverId: server.id, lines: batch });
  },

  getConsole(id) {
    return this.rt(id).console;
  },

  /** Send a console command: stdin when the game reads it, RCON otherwise. */
  async sendCommand(id, command) {
    const server = this.require(id);
    const template = this.template(server);
    const rt = this.rt(id);
    if (!rt.proc && !rt.docker?.id) fail(409, 'The server is not running');
    command = String(command);

    if (template?.consoleInput !== false && this.writeStdin(server, command + (template?.consoleNewline || '\n'))) {
      this.pushConsole(server, `> ${command}`, 'input');
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
    return fail(400, 'This server does not accept console commands');
  },

  /** Write to the game's stdin, whichever runtime it is in. */
  writeStdin(server, text) {
    const rt = this.rt(server.id);
    if (rt.docker?.attachment) return rt.docker.attachment.write(text);
    if (rt.proc?.stdin?.writable) {
      rt.proc.stdin.write(text);
      return true;
    }
    return false;
  },

  /** Track joins/leaves from log output, for games without a query protocol. */
  trackPlayers(server, template, text) {
    this.trackChat(server, template, text);
    const patterns = template.logPatterns || {};
    if (!patterns.join && !patterns.leave) return;
    const rt = this.rt(server.id);
    let list = rt.playerList;
    for (const line of text.split('\n')) {
      const joined = patterns.join && line.match(new RegExp(patterns.join));
      if (joined) {
        const name = joined[1] || 'player';
        if (!list.includes(name)) list = [...list, name];
      }
      const left = patterns.leave && line.match(new RegExp(patterns.leave));
      if (left) list = list.filter((p) => p !== (left[1] || 'player'));
    }
    if (list !== rt.playerList) setPlayers(rt, list);
    if (!template.query || template.query.type === 'none') rt.players = rt.playerList.length;
  },
};
