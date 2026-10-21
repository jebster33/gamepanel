'use strict';

/**
 * Restart or shut down the whole machine without hurting the game servers (administrators only).
 *
 *   1. countdown, with warnings in game chat ("Server host restarting in 60 seconds")
 *   2. note which servers are running, then stop each cleanly, one after another (proxies last),
 *      waiting for the game to save and exit
 *   3. run the operating system command (Linux: sudo -n systemctl reboot / poweroff, Windows: shutdown)
 *   4. after the machine is back, the panel starts exactly the servers that were running
 *      (manager.init asks startList() instead of using the "start with panel" flags)
 *
 * It can be previewed (plan), watched (status) and cancelled until the command is sent.
 * Linux needs the panel's user to be allowed those two commands: install.sh adds the sudoers line,
 * docs/guide/host-health.md shows it for existing installs.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { run, isWindows } = require('../core/platform');
const { fail, logger } = require('../core/util');

const STATE = path.join(config.dataDir, 'host-power.json');
const RESUME_WINDOW = 7 * 86_400_000;
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The operating system command for an action: [file, args]. Fixed, nothing from a request goes in. */
function commandFor(action, { windows = isWindows, root = typeof process.getuid === 'function' && process.getuid() === 0 } = {}) {
  const verb = action === 'shutdown' ? 'poweroff' : 'reboot';
  if (windows) return ['shutdown.exe', [action === 'shutdown' ? '/s' : '/r', '/t', '5', '/c', 'GamePanel host power action']];
  return root ? ['systemctl', [verb]] : ['sudo', ['-n', 'systemctl', verb]];
}

/** Is the panel allowed to run it? (Windows: the service account normally can.) */
async function allowed(action, exec = run) {
  if (isWindows) return { ok: true };
  if (typeof process.getuid === 'function' && process.getuid() === 0) return { ok: true };
  const r = await exec('sudo', ['-n', '-l', 'systemctl', action === 'shutdown' ? 'poweroff' : 'reboot'], { timeout: 8000 });
  return r.code === 0
    ? { ok: true }
    : { ok: false, hint: 'The panel user may not run systemctl reboot/poweroff. Add to sudoers (visudo -f /etc/sudoers.d/gamepanel): gamepanel ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /bin/systemctl reboot, /bin/systemctl poweroff' };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  if (!state) return fs.rmSync(STATE, { force: true });
  fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(state));
  fs.renameSync(`${STATE}.tmp`, STATE);
}

/**
 * Servers the panel should start now (called once from manager.init). After a host reboot or
 * shutdown that is exactly the ones that were running; otherwise the usual "start with panel" ones.
 */
function startList(manager, store) {
  const state = readState();
  const usual = () => manager.servers.filter((s) => s.autoStart && s.installedAt && !manager.isActive(s.id));
  if (!state?.running || Date.now() - state.at > RESUME_WINDOW) {
    if (state) writeState(null);
    return usual();
  }
  writeState(null);
  const list = manager.servers.filter((s) => state.running.includes(s.id) && s.installedAt && !manager.isActive(s.id));
  try {
    store?.addEvent('panel.host_resumed', `After the host ${state.action === 'shutdown' ? 'shutdown' : 'restart'}, starting the ${list.length} server${list.length === 1 ? '' : 's'} that were running`);
  } catch {
    /* the event log is not essential */
  }
  return list;
}

class HostPower {
  constructor({ manager, store, exec = run, sleep = sleepMs, state = { read: readState, write: writeState } }) {
    this.manager = manager;
    this.store = store;
    this.exec = exec;
    this.sleep = sleep;
    this.state = state;
    this.job = null;
  }

  /** Servers to stop, in the order they will be stopped: games first, proxies (Velocity) last. */
  order() {
    const m = this.manager;
    const active = m.servers.filter((s) => m.isActive(s.id));
    const proxy = (s) => /velocity|bungee|waterfall/i.test(s.templateId || '');
    return [...active.filter((s) => !proxy(s)), ...active.filter(proxy)];
  }

  /** Dry run: what would happen, nothing is done. */
  async plan(action = 'reboot', seconds = 60) {
    const [file, args] = commandFor(action);
    return {
      action,
      seconds,
      servers: this.order().map((s) => ({ id: s.id, name: s.name })),
      command: `${file} ${args.join(' ')}`,
      permission: await allowed(action, this.exec),
      resumes: 'After the machine is back the panel starts exactly the servers listed above.',
    };
  }

  status() {
    const j = this.job;
    if (!j) return { phase: 'idle', pending: this.state.read() };
    return { phase: j.phase, action: j.action, by: j.by, runAt: j.runAt, remaining: Math.max(0, Math.round((j.runAt - Date.now()) / 1000)), servers: j.servers.map((s) => ({ ...s })), cancellable: j.phase === 'countdown' || j.phase === 'stopping', error: j.error || null };
  }

  async start({ action = 'reboot', seconds = 60, by = 'admin' } = {}) {
    if (!['reboot', 'shutdown'].includes(action)) fail(400, 'Choose reboot or shutdown');
    if (this.job && !['failed', 'cancelled'].includes(this.job.phase)) fail(409, 'A host restart or shutdown is already in progress');
    const secs = Math.max(0, Math.min(3600, Math.round(Number(seconds)) || 0));
    const perm = await allowed(action, this.exec);
    if (!perm.ok) fail(400, perm.hint);
    const servers = this.order().map((s) => ({ id: s.id, name: s.name, state: 'running' }));
    this.job = { action, by, phase: 'countdown', runAt: Date.now() + secs * 1000, servers, cancelled: false };
    this.store?.addEvent('panel.host_power', `${by} scheduled a host ${action === 'shutdown' ? 'shutdown' : 'restart'} in ${secs} seconds (${servers.length} running server${servers.length === 1 ? '' : 's'})`);
    const job = this.job;
    this.drive(job, secs).catch((err) => {
      job.phase = 'failed';
      job.error = err.message;
      logger.error(`Host ${action} failed: ${err.message}`);
    });
    return this.status();
  }

  async say(job, text) {
    const players = require('../games/players');
    for (const s of job.servers) {
      const server = this.manager.servers.find((x) => x.id === s.id);
      if (!server || !this.manager.isActive(s.id)) continue;
      const command = players.broadcastCommand(this.manager.template(server));
      if (command) await this.manager.sendCommand(s.id, players.fillBroadcast(command, text)).catch(() => {});
    }
  }

  async drive(job, secs) {
    const word = job.action === 'shutdown' ? 'shutting down' : 'restarting';
    const marks = [1800, 900, 300, 60, 30, 10, 5].filter((m) => m <= secs && m !== secs);
    if (secs > 0) marks.unshift(secs);
    let left = secs;
    for (const mark of marks.sort((a, b) => b - a)) {
      await this.sleep((left - mark) * 1000);
      left = mark;
      if (job.cancelled) return;
      await this.say(job, `Server host ${word} in ${mark >= 60 ? `${Math.round(mark / 60)} minute${mark < 120 ? '' : 's'}` : `${mark} seconds`}`);
    }
    await this.sleep(left * 1000);
    if (job.cancelled) return;

    job.phase = 'stopping';
    // Written before anything stops, so a crash half way still brings the right servers back.
    this.state.write({ action: job.action, at: Date.now(), running: job.servers.map((s) => s.id) });
    for (const s of job.servers) {
      if (job.cancelled) return this.rollback(job);
      s.state = 'stopping';
      try {
        if (this.manager.isActive(s.id)) await this.manager.stop(s.id);
        await this.waitStopped(s.id, job);
        s.state = 'stopped';
      } catch (err) {
        s.state = `failed: ${err.message}`;
      }
    }
    if (job.cancelled) return this.rollback(job);
    job.phase = 'rebooting';
    this.manager.saveHistories?.();
    this.store?.save?.();
    const [file, args] = commandFor(job.action);
    this.store?.addEvent('panel.host_power', `Host ${job.action === 'shutdown' ? 'shutting down' : 'restarting'} now`);
    const r = await this.exec(file, args, { timeout: 30_000 });
    if (r.code !== 0) {
      this.state.write(null);
      job.phase = 'failed';
      job.error = (r.stderr || r.error || `exit code ${r.code}`).trim().slice(0, 300);
      // The servers were stopped for nothing: bring them back.
      await this.rollback(job, true);
    }
  }

  async waitStopped(id, job, limitMs = 5 * 60_000) {
    const end = Date.now() + limitMs;
    while (this.manager.isActive(id) && Date.now() < end) {
      await this.sleep(1000);
    }
    if (this.manager.isActive(id)) throw new Error('did not stop in time');
  }

  /** Cancelled or failed after some servers stopped: start those again. */
  async rollback(job, keepPhase = false) {
    this.state.write(null);
    for (const s of job.servers) {
      if (s.state === 'stopped' || s.state === 'stopping') {
        await this.manager.start(s.id).catch(() => {});
        s.state = 'restarted';
      }
    }
    if (!keepPhase) job.phase = 'cancelled';
  }

  async cancel(by = 'admin') {
    const j = this.job;
    if (!j || !['countdown', 'stopping'].includes(j.phase)) fail(409, 'Nothing to cancel: no restart is counting down');
    j.cancelled = true;
    if (j.phase === 'countdown') j.phase = 'cancelled';
    await this.say(j, 'The host restart was cancelled');
    this.store?.addEvent('panel.host_power', `${by} cancelled the host ${j.action}`);
    return { ok: true };
  }
}

module.exports = { HostPower, startList, commandFor, allowed, STATE };
