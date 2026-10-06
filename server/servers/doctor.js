'use strict';

/**
 * Crash doctor and log sharing. Mixed into ServerManager (see manager.js).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fail, logger } = require('../core/util');
const { containedPath } = require('../features/files');
const { diagnose } = require('../games/diagnose');

const SAFE_JAR = /^[\w.+\- ]+\.jar$/;

module.exports = {
  /** The newest Minecraft crash report, if one was written in the last few minutes. */
  latestCrashReport(server) {
    try {
      const dir = containedPath(server.dir, 'crash-reports');
      const newest = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.txt'))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0];
      if (!newest || Date.now() - newest.t > 5 * 60_000) return '';
      return fs.readFileSync(path.join(dir, newest.f), 'utf8').slice(0, 200_000);
    } catch {
      return '';
    }
  },

  runDiagnosis(server, ctx = {}) {
    const rt = this.rt(server.id);
    const lines = rt.console.filter((e) => e.stream !== 'system' && e.stream !== 'input').slice(-500).map((e) => e.line);
    const report = this.latestCrashReport(server);
    if (report) lines.push(...report.split('\n'));
    const findings = diagnose(lines, { memory: server.memory, ...ctx });
    rt.diagnosis = findings.length ? { at: Date.now(), findings } : null;
    return rt.diagnosis;
  },

  /** Called when a server crashes: explain why in the console and on the server page. */
  diagnoseCrash(server, code, signal) {
    try {
      const result = this.runDiagnosis(server, { code, signal });
      if (!result) return;
      for (const f of result.findings) this.pushConsole(server, `Crash doctor: ${f.title}. ${f.detail.split('\n')[0]}`, 'system');
      this.broadcastServers();
    } catch (err) {
      logger.warn(`Crash doctor failed for ${server.name}: ${err.message}`);
    }
  },

  /** Apply a fix the crash doctor offered. Navigation-only fixes are handled by the page. */
  async applyFix(id, fix = {}, actor) {
    const server = this.require(id);
    const rt = this.rt(id);
    const stopped = !this.isActive(id);
    let message;
    switch (fix.action) {
      case 'java': {
        const java = Number(fix.java);
        if (![8, 11, 16, 17, 21, 25].includes(java)) fail(400, 'Unknown Java version');
        if (!stopped) fail(409, 'Stop the server first');
        server.javaOverride = java;
        server.vars = { ...server.vars, JAVA_VERSION: String(java) };
        this.store.save();
        this.install(id).catch(() => {});
        message = `Installing Java ${java}`;
        break;
      }
      case 'memory': {
        server.memory = Math.min(server.memory + 1024, 64 * 1024);
        this.store.save();
        message = `Memory raised to ${server.memory} MB`;
        break;
      }
      case 'eula': {
        fs.writeFileSync(containedPath(server.dir, 'eula.txt'), '# Accepted through GamePanel (https://aka.ms/MinecraftEULA)\neula=true\n');
        message = 'EULA accepted';
        break;
      }
      case 'reinstall': {
        if (!stopped) fail(409, 'Stop the server first');
        this.install(id).catch(() => {});
        message = 'Reinstalling';
        break;
      }
      case 'disable-mod':
      case 'disable-plugin': {
        const file = String(fix.file || '');
        if (!SAFE_JAR.test(file)) fail(400, 'Not a mod file');
        const dir = fix.action === 'disable-mod' ? this.template(server)?.mods?.dir || 'mods' : 'plugins';
        const from = containedPath(server.dir, `${dir}/${file}`);
        if (!fs.existsSync(from)) fail(404, `${file} is not in ${dir}/`);
        fs.renameSync(from, `${from}.disabled`);
        message = `${file} disabled (renamed to ${file}.disabled)`;
        break;
      }
      default:
        fail(400, 'Unknown fix');
    }
    rt.diagnosis = null;
    this.pushConsole(server, `Crash doctor: ${message}${actor ? ` (by ${actor.username})` : ''}.`, 'system');
    this.store.addEvent('server.fixed', `${message} on ${server.name}`, { serverId: id });
    this.broadcastServers();
    return { ok: true, message };
  },

  /** Upload the console to mclo.gs (which hides IP addresses) and return the link. */
  /**
   * Search the game's own log files (logs/latest.log and the gzipped days
   * before it), newest first: "when did Steve last say anything", "when did
   * the server last crash". Capped so a year of logs can't stall the panel.
   */
  searchLogs(server, q, { file } = {}) {
    const dir = containedPath(server.dir, 'logs');
    let files;
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => /\.log(\.gz)?$/.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, size: st.size, modifiedAt: st.mtimeMs };
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
    } catch {
      return { files: [], matches: [], truncated: false };
    }
    const needle = String(q || '').trim().toLowerCase().slice(0, 200);
    const matches = [];
    let truncated = false;
    let budget = 200 * 1024 * 1024; // uncompressed bytes read per search
    const targets = file ? files.filter((f) => f.name === file) : files;
    if (file && !targets.length) fail(404, 'Log file not found');
    for (const f of targets) {
      if (!needle && !file) break;
      let text;
      try {
        const raw = fs.readFileSync(path.join(dir, f.name));
        text = (f.name.endsWith('.gz') ? zlib.gunzipSync(raw, { maxOutputLength: 64 * 1024 * 1024 }) : raw).toString('utf8');
      } catch {
        continue;
      }
      budget -= text.length;
      const lines = text.split(/\r?\n/);
      // Reading a whole file shows its end, where the latest lines are.
      for (let i = needle ? 0 : Math.max(0, lines.length - 1000); i < lines.length; i++) {
        if (needle && !lines[i].toLowerCase().includes(needle)) continue;
        if (!lines[i]) continue;
        matches.push({ file: f.name, line: i + 1, text: lines[i].slice(0, 1000) });
        if (matches.length >= 1000) break;
      }
      if (matches.length >= 1000 || budget <= 0) {
        truncated = true;
        break;
      }
    }
    return { files, matches, truncated };
  },

  async shareLog(id) {
    const server = this.require(id);
    const rt = this.rt(id);
    let content = rt.console.map((e) => (e.stream === 'input' ? `> ${e.line.replace(/^> /, '')}` : e.line)).join('\n');
    const report = this.latestCrashReport(server);
    if (report) content += `\n\n---- Crash report ----\n${report}`;
    // Never share secrets that were printed (RCON passwords, tokens in start lines).
    for (const [key, value] of Object.entries(server.vars || {})) {
      if (/PASS|SECRET|TOKEN|KEY/i.test(key) && String(value).length >= 4) content = content.split(String(value)).join('********');
    }
    if (!content.trim()) fail(400, 'The console is empty');
    const res = await fetch('https://api.mclo.gs/1/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ content: content.slice(-9_000_000) }),
      signal: AbortSignal.timeout(20_000),
    }).catch((err) => fail(502, `Could not reach mclo.gs: ${err.message}`));
    const data = await res.json().catch(() => ({}));
    if (!data.success) fail(502, data.error || 'mclo.gs did not accept the log');
    this.store.addEvent('server.log_shared', `Console of ${server.name} shared at ${data.url}`, { serverId: id });
    return { url: data.url };
  },
};
