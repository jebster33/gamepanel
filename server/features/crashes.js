'use strict';

/**
 * Crash reports: when a server dies on its own, the panel keeps a bundle of
 * what it knew at that moment: the guessed cause (the crash doctor's findings),
 * the last console lines, the game's own crash report, memory and players,
 * and the mods that were loaded. Open from the Tools tab, downloadable as one
 * text file to attach to a bug report. The newest 20 per server are kept.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { fail, redactSecrets, SECRET_NAME, logger } = require('../core/util');
const { containedPath } = require('./files');

const KEEP = 20;
const file = (id) => path.join(config.dataDir, 'crashes', `${String(id).replace(/[^\w.-]/g, '_')}.json`);

function load(id) {
  try {
    const list = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(id, list) {
  fs.mkdirSync(path.dirname(file(id)), { recursive: true });
  fs.writeFileSync(file(id), JSON.stringify(list.slice(0, KEEP)));
}

const readSmall = (p, max) => {
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile()) return '';
    const fd = fs.openSync(p, 'r');
    try {
      const len = Math.min(st.size, max);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
};

/** Names of the files in a mods/plugins folder (not their contents). */
function listJars(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.(jar|dll|cs|lua)$/i.test(f)).slice(0, 300);
  } catch {
    return [];
  }
}

function record(manager, server, code, signal, diagnosis) {
  try {
    const rt = manager.rt(server.id);
    const vars = server.vars || {};
    const lines = rt.console.filter((e) => e.stream !== 'input').slice(-300).map((e) => redactSecrets(e.line, vars));
    const reports = [];
    for (const sub of ['crash-reports', '']) {
      try {
        const dir = containedPath(server.dir, sub);
        const names = fs.readdirSync(dir).filter((f) => (sub ? /\.txt$/ : /^hs_err_pid\d+\.log$/).test(f));
        const newest = names.map((f) => ({ f, t: fs.lstatSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
        if (newest && Date.now() - newest.t < 10 * 60_000) reports.push({ name: (sub ? `${sub}/` : '') + newest.f, text: redactSecrets(readSmall(path.join(dir, newest.f), 60_000), vars) });
      } catch {
        /* none */
      }
    }
    const entry = {
      id: Date.now().toString(36),
      at: Date.now(),
      code: code ?? null,
      signal: signal || null,
      uptimeMs: server.lastExit?.uptimeMs || 0,
      findings: (diagnosis?.findings || []).map((f) => ({ id: f.id, title: f.title, detail: f.detail })),
      lines,
      reports,
      info: { game: server.templateId, version: manager.gameVersion?.(server) || null, memoryMb: server.memory, players: rt.players, cpu: rt.cpu, memoryUsed: rt.memory },
      mods: ['mods', 'plugins', 'oxide/plugins', 'carbon/plugins'].flatMap((d) => listJars(path.join(server.dir, d)).map((f) => `${d}/${f}`)),
    };
    save(server.id, [entry, ...load(server.id)]);
    return entry;
  } catch (err) {
    logger.warn(`Could not save the crash report for ${server.name}: ${err.message}`);
    return null;
  }
}

const list = (id) => load(id).map((c) => ({ id: c.id, at: c.at, code: c.code, signal: c.signal, uptimeMs: c.uptimeMs, causes: c.findings.map((f) => f.title), reports: c.reports.map((r) => r.name) }));

function get(id, crashId) {
  const c = load(id).find((x) => x.id === crashId);
  if (!c) fail(404, 'That crash report is gone');
  return c;
}

/** One text file with everything, for a bug report. */
function bundleText(server, crash) {
  const when = new Date(crash.at).toISOString();
  const out = [
    `GamePanel crash report for ${server.name}`,
    `When: ${when}`,
    `Exit: code ${crash.code ?? 'n/a'}${crash.signal ? `, signal ${crash.signal}` : ''}; ran ${Math.round(crash.uptimeMs / 1000)} s`,
    `Game: ${crash.info.game} ${crash.info.version || ''}; memory cap ${crash.info.memoryMb} MB; players ${crash.info.players ?? '?'}`,
    '',
    '== Likely cause ==',
    ...(crash.findings.length ? crash.findings.map((f) => `* ${f.title}\n  ${f.detail}`) : ['No known cause matched. Read the console lines below.']),
    '',
    ...crash.reports.flatMap((r) => [`== ${r.name} ==`, r.text, '']),
    '== Loaded mods and plugins ==',
    ...(crash.mods.length ? crash.mods : ['(none found)']),
    '',
    '== Last console lines ==',
    ...crash.lines,
  ];
  return out.join('\n');
}

function remove(id, crashId) {
  save(id, load(id).filter((c) => c.id !== crashId));
}

function forget(id) {
  fs.rmSync(file(id), { force: true });
}

module.exports = { record, list, get, bundleText, remove, forget, SECRET_NAME };
