'use strict';

/**
 * ARK cluster transfer log: what players uploaded to or downloaded from the
 * cluster, pieced together from two places.
 *
 *  - The shared cluster folder. Every upload leaves a file there; its modified
 *    time says when, its name says whose (and roughly what).
 *  - Each member server's ShooterGame.log, for lines that mention an upload or
 *    download of a survivor, item or creature.
 *
 * ARK does not write a structured transfer log, so this is a best-effort view:
 * the file list is exact, the log lines depend on what the game prints.
 * Not checked against a live cluster.
 */

const fs = require('fs');
const path = require('path');
const { fail } = require('../core/util');
const { containedPath } = require('./files');
const clusters = require('./ark-clusters');

const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 200;
const ACTION = /\b(upload|uploaded|uploading|download|downloaded|downloading)\b/i;
const THING = /(survivor|character|dino|creature|tribute|obelisk|terminal|transfer|\bitem)/i;

/** A rough label for a cluster file from its name. */
function kindOf(name) {
  const n = name.toLowerCase();
  if (/dino|creature/.test(n)) return 'Creature';
  if (/\.arkprofile$/.test(n)) return 'Survivor';
  if (/tribe/.test(n)) return 'Tribe';
  if (/^\d{5,}$/.test(n)) return 'Survivor or items';
  return 'Other';
}

/** The files in the cluster folder (two levels deep), newest first. */
function files(dir) {
  const out = [];
  const walk = (d, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 2) walk(full, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          out.push({ file: path.relative(dir, full).split(path.sep).join('/'), kind: kindOf(e.name), size: st.size, at: Math.round(st.mtimeMs) });
        } catch {
          /* gone meanwhile */
        }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
}

function tail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** "[2025.01.31-18.04.05:123]" at the start of an ARK log line, as epoch ms (the log is UTC). */
function stamp(line) {
  const m = line.match(/^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})(?::\d+)?\]/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/** Transfer-looking lines from a log text. */
function transferLines(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!ACTION.test(raw) || !THING.test(raw)) continue;
    // eslint-disable-next-line no-control-regex
    const clean = raw.replace(/[\x00-\x08\x0b-\x1f]/g, '').slice(0, 300);
    rows.push({ at: stamp(clean), text: clean.replace(/^\[[^\]]*\]\[[^\]]*\]/, '').trim() });
  }
  return rows;
}

function logsOf(server) {
  let dir;
  try {
    dir = containedPath(server.dir, 'ShooterGame/Saved/Logs');
  } catch {
    return [];
  }
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^ShooterGame(-backup-[\d.-]+)?\.log$/.test(n));
  } catch {
    return [];
  }
  // The live log and the two before it; older ones are rarely worth the read.
  const sorted = names
    .map((n) => ({ n, t: (() => { try { return fs.statSync(path.join(dir, n)).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.t - a.t)
    .slice(0, 3);
  return sorted.map(({ n, t }) => ({ rows: transferLines(tail(path.join(dir, n))), fileTime: t }));
}

function view(manager, store, id) {
  const cluster = clusters.listOf(store).find((c) => c.id === id);
  if (!cluster) fail(404, 'Cluster not found');
  const dir = clusters.dirOf(cluster);
  const lines = [];
  for (const sid of cluster.servers) {
    const server = manager.servers.find((s) => s.id === sid);
    if (!server) continue;
    for (const { rows, fileTime } of logsOf(server)) {
      for (const r of rows) lines.push({ server: { id: server.id, name: server.name }, at: r.at ?? Math.round(fileTime), approximate: r.at == null, text: r.text });
    }
  }
  lines.sort((a, b) => b.at - a.at);
  return {
    cluster: { id: cluster.id, name: cluster.name, game: clusters.TEMPLATES[cluster.templateId] },
    folder: dir,
    files: files(dir),
    lines: lines.slice(0, MAX_ROWS),
    note: 'The file list shows what is stored in the cluster right now (when each upload happened and whose it is). The log lines are what the game itself printed about transfers; ARK does not keep a full history.',
  };
}

module.exports = { view, files, transferLines, kindOf, stamp };
