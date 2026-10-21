'use strict';

/**
 * Search the text inside every file of a server (configs, scripts, logs and
 * all), like "find in files": plain text or a regular expression, optional
 * case matching, a file-name filter ("*.yml, *.json"), a few lines of context.
 *
 * Bounded on every side: files and bytes read, matches returned, time spent.
 * Links are never followed and binary files are skipped.
 */

const fsp = require('fs/promises');
const path = require('path');
const { fail } = require('../core/util');
const { containedPath } = require('./files');

const SKIP_DIRS = new Set(['region', 'entities', 'poi', 'DIM-1', 'DIM1', 'libraries', 'cache', 'versions', 'node_modules', '.git', '.steamcmd', 'steamapps', 'backups', '.gamepanel']);
const MAX_FILE = 4 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_BYTES = 400 * 1024 * 1024;
const MAX_MATCHES = 400;
const MAX_MS = 15_000;
const BINARY = /\.(jar|zip|gz|bz2|xz|7z|rar|png|jpe?g|gif|webp|ico|dll|exe|so|dylib|bin|dat|mca|nbt|db|sqlite|ogg|mp3|wav|mp4|ttf|otf|pak|bsp|vpk|sav|map|ytd|ydr|dds|fbx|obj|blend|class|iso|img)$/i;

/** "*.yml, config*" → one regular expression on the file name. */
function globToRegex(text) {
  const parts = String(text || '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .slice(0, 20);
  if (!parts.length) return null;
  const source = parts.map((p) => p.slice(0, 80).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'));
  return new RegExp(`^(?:${source.join('|')})$`, 'i');
}

function matcher({ q, regex, caseSensitive }) {
  const text = String(q || '').slice(0, 200);
  if (text.length < 2) fail(400, 'Type at least 2 characters');
  if (!regex) {
    const needle = caseSensitive ? text : text.toLowerCase();
    return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
  }
  // A pattern with nested quantifiers can freeze the panel on a long line; lines are also cut short below.
  if (/(\([^)]*[+*][^)]*\))[+*{]/.test(text)) fail(400, 'That pattern could take too long to run. Simplify it.');
  let re;
  try {
    re = new RegExp(text, caseSensitive ? '' : 'i');
  } catch (err) {
    fail(400, `Not a valid pattern: ${err.message}`);
  }
  return (line) => re.test(line);
}

async function search(root, opts = {}) {
  const test = matcher(opts);
  const nameFilter = globToRegex(opts.files);
  const context = Math.max(0, Math.min(3, Number(opts.context) || 0));
  const start = opts.path ? containedPath(root, String(opts.path)) : containedPath(root, '');
  const startedAt = Date.now();
  const results = [];
  const stats = { files: 0, bytes: 0, truncated: false };

  const walk = async (dir, rel, depth) => {
    if (depth > 12 || stats.truncated) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stats.truncated) return;
      if (Date.now() - startedAt > MAX_MS || stats.files > MAX_FILES || stats.bytes > MAX_BYTES || results.length >= MAX_MATCHES) {
        stats.truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, childRel, depth + 1);
        continue;
      }
      if (!entry.isFile() || BINARY.test(entry.name) || (nameFilter && !nameFilter.test(entry.name))) continue;
      if (!opts.logs && /\.log(\.\d+)?$/i.test(entry.name)) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (!st || st.size > MAX_FILE) continue;
      stats.files++;
      stats.bytes += st.size;
      let text;
      try {
        text = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue;
      const lines = text.split(/\r?\n/);
      const hits = [];
      for (let i = 0; i < lines.length && results.length + hits.length < MAX_MATCHES; i++) {
        if (test(lines[i].slice(0, 2000))) {
          hits.push({
            line: i + 1,
            text: lines[i].trim().slice(0, 300),
            before: lines.slice(Math.max(0, i - context), i).map((l) => l.slice(0, 200)),
            after: lines.slice(i + 1, i + 1 + context).map((l) => l.slice(0, 200)),
          });
        }
      }
      if (hits.length) results.push(...hits.map((h) => ({ path: childRel, ...h })));
    }
  };
  await walk(start, opts.path ? String(opts.path).replace(/^\/+|\/+$/g, '') : '', 0);
  return { results, scanned: stats.files, truncated: stats.truncated };
}

module.exports = { search, globToRegex };
