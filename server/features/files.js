'use strict';

/** Sandboxed file manager for a single server directory. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { safeJoin, fail } = require('../core/util');

const MAX_EDIT_BYTES = 4 * 1024 * 1024;

/**
 * Containment check that survives symlinks.
 *
 * safeJoin only reasons about the path string, so a symlink inside a server
 * directory (which a game, a mod, or an uploaded archive can create) would
 * otherwise let the file manager read and write anywhere the panel user can —
 * including the panel's own state and session key. Resolve the deepest part of
 * the path that exists and verify it is still under the real server root.
 */
function containedPath(root, rel) {
  const target = safeJoin(root, rel);
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return target; // the server directory is gone; callers surface that
  }

  const missing = [];
  let probe = target;
  while (!fs.existsSync(probe)) {
    // existsSync follows links: a link whose target is missing would be
    // followed by the write that comes next, wherever it points.
    let dangling = false;
    try {
      dangling = fs.lstatSync(probe).isSymbolicLink();
    } catch {
      dangling = false;
    }
    if (dangling) fail(400, 'That path goes through a broken symlink');
    missing.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  let realProbe;
  try {
    realProbe = fs.realpathSync(probe);
  } catch {
    return target;
  }
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
    fail(400, 'That path leaves the server directory (symlinked elsewhere)');
  }
  return path.join(realProbe, ...missing);
}

/**
 * Archives can carry absolute paths, "..", and symlinks that point outside the
 * server directory — extracting one blindly is a sandbox escape. Inspect the
 * listing first and refuse anything that tries.
 */
const isWindows = process.platform === 'win32';
// Windows 10+ ships bsdtar, which also reads .zip.
const TAR = isWindows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

function assertArchiveIsSafe(file, cwd) {
  const { execFileSync } = require('child_process');
  const lower = file.toLowerCase();
  let entries = [];

  try {
    if (isWindows) {
      const names = execFileSync(TAR, ['-tf', path.basename(file)], { cwd, encoding: 'utf8', maxBuffer: 8e6, windowsHide: true });
      const long = execFileSync(TAR, ['-tvf', path.basename(file)], { cwd, encoding: 'utf8', maxBuffer: 8e6, windowsHide: true });
      const links = long.split(/\r?\n/).filter((l) => l.startsWith('l')).length;
      entries = names.split(/\r?\n/).filter(Boolean).map((name) => ({ name, link: false }));
      if (links) entries.push({ name: 'symlink', link: true });
    } else if (lower.endsWith('.zip')) {
      const out = execFileSync('unzip', ['-Z1', path.basename(file)], { cwd, encoding: 'utf8', maxBuffer: 8e6 });
      entries = out.split('\n').filter(Boolean).map((name) => ({ name, link: false }));
      // -Z1 shows names only; the long listing starts symlinks with "l" (unzip extracts them as links).
      const long = execFileSync('unzip', ['-Z', path.basename(file)], { cwd, encoding: 'utf8', maxBuffer: 8e6 });
      if (long.split('\n').some((l) => /^l[rwxsStT-]{9}\s/.test(l))) entries.push({ name: 'symlink', link: true });
    } else {
      const out = execFileSync('tar', ['-tvf', path.basename(file)], { cwd, encoding: 'utf8', maxBuffer: 8e6 });
      entries = out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, target] = (line.split(/\s+/).slice(5).join(' ') || '').split(/ -> | link to /);
          // A hard link is fine inside the archive; its target gets the same checks as a name.
          return { name, link: line.startsWith('l'), target: line.startsWith('h') ? target : undefined };
        });
    }
  } catch (err) {
    // Unpacking what could not be checked would skip the checks: refuse instead.
    if (err.code === 'ENOENT') fail(400, `${err.path || 'The archive tool'} is not installed on this host`);
    fail(400, `Could not read that archive: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
  }

  for (const entry of entries.flatMap((e) => (e.target ? [e, { name: e.target, link: false }] : [e]))) {
    const name = entry.name.trim();
    if (!name) continue;
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      fail(400, `Refusing to unpack: "${name}" is an absolute path`);
    }
    if (name.split(/[/\\]/).includes('..')) {
      fail(400, `Refusing to unpack: "${name}" escapes the folder`);
    }
    if (entry.link) {
      fail(400, `Refusing to unpack: "${name}" is a symlink, which could point outside the server`);
    }
  }
}
const TEXT_EXTENSIONS = new Set([
  '.txt', '.properties', '.yml', '.yaml', '.json', '.cfg', '.conf', '.ini', '.log', '.sh', '.bat',
  '.md', '.xml', '.toml', '.lua', '.js', '.py', '.env', '.list', '.acf', '.vdf', '.sk', '.mcmeta',
]);

function isProbablyText(name, size) {
  if (size > MAX_EDIT_BYTES) return false;
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  return ext === '' && size < 512 * 1024;
}

async function list(root, rel = '') {
  const dir = containedPath(root, rel);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') fail(404, 'Directory not found');
    throw err;
  }
  const items = [];
  for (const entry of entries) {
    if (entry.name === '.gamepanel-install.sh') continue;
    const full = path.join(dir, entry.name);
    let stat = null;
    try {
      stat = await fsp.lstat(full);
    } catch {
      continue;
    }
    items.push({
      name: entry.name,
      path: path.posix.join(String(rel || '').replace(/\\/g, '/'), entry.name).replace(/^\/+/, ''),
      directory: entry.isDirectory(),
      symlink: stat.isSymbolicLink(),
      size: stat.size,
      modified: stat.mtimeMs,
      mode: (stat.mode & 0o777).toString(8),
      editable: !entry.isDirectory() && isProbablyText(entry.name, stat.size),
    });
  }
  items.sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1));
  return { path: String(rel || '').replace(/\\/g, '/'), items };
}

/**
 * Find files by name, and text inside config files ("where is max-players
 * set?"). Skips worlds' region data, libraries and other bulky folders, and
 * stops after a few hundred hits or a few thousand files.
 */
const SKIP_DIRS = new Set(['region', 'entities', 'poi', 'libraries', 'cache', 'versions', 'node_modules', '.git', 'bluemap', 'crash-reports', 'logs', 'backups']);

async function search(root, q) {
  const needle = String(q || '').trim().toLowerCase().slice(0, 100);
  if (needle.length < 2) fail(400, 'Type at least 2 characters');
  const results = [];
  let visited = 0;
  const walk = async (rel, depth) => {
    if (depth > 8 || results.length >= 300 || visited > 5000) return;
    let entries;
    try {
      entries = await fsp.readdir(containedPath(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= 300 || ++visited > 5000) return;
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(childRel, depth + 1);
        continue;
      }
      if (entry.name.toLowerCase().includes(needle)) results.push({ path: childRel, line: 0, text: '' });
      const full = containedPath(root, childRel);
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      if (!isProbablyText(entry.name, stat.size) || stat.size > 1024 * 1024 || entry.name.endsWith('.log')) continue;
      let text;
      try {
        text = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      if (!text.toLowerCase().includes(needle)) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < 300; i++) {
        if (lines[i].toLowerCase().includes(needle)) results.push({ path: childRel, line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
  };
  await walk('', 0);
  return { results, truncated: results.length >= 300 || visited > 5000 };
}

async function read(root, rel) {
  const file = containedPath(root, rel);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) fail(404, 'File not found');
  if (stat.isDirectory()) fail(400, 'That is a directory');
  if (stat.size > MAX_EDIT_BYTES) fail(413, 'File is too large to open in the editor');
  return { path: rel, size: stat.size, content: await fsp.readFile(file, 'utf8') };
}

async function write(root, rel, content) {
  const file = containedPath(root, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, String(content ?? ''));
  const stat = await fsp.stat(file);
  return { path: rel, size: stat.size };
}

async function mkdir(root, rel) {
  const dir = containedPath(root, rel);
  await fsp.mkdir(dir, { recursive: true });
  return { path: rel };
}

async function remove(root, rel) {
  const target = containedPath(root, rel);
  if (path.resolve(target) === path.resolve(root)) fail(400, 'Refusing to delete the server root');
  await fsp.rm(target, { recursive: true, force: true });
  return { path: rel };
}

async function rename(root, rel, toRel) {
  const from = containedPath(root, rel);
  const to = containedPath(root, toRel);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return { path: toRel };
}

/**
 * Unpack an archive in place — the usual way mods, maps and modpacks arrive.
 * Extraction always stays inside the server directory.
 */
async function extract(root, rel) {
  const file = containedPath(root, rel);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) fail(404, 'Archive not found');
  const dest = path.dirname(file);
  const name = path.basename(file);
  const lower = name.toLowerCase();

  // Run inside the target directory with a bare file name: absolute paths make
  // tar unhappy on some platforms, and this keeps the command trivially safe.
  let cmd;
  if (isWindows) cmd = [TAR, ['-xf', name]];
  else if (lower.endsWith('.zip')) cmd = ['unzip', ['-oq', name]];
  else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) cmd = ['tar', ['-xzf', name]];
  else if (lower.endsWith('.tar.xz')) cmd = ['tar', ['-xJf', name]];
  else if (lower.endsWith('.tar.bz2')) cmd = ['tar', ['-xjf', name]];
  else if (lower.endsWith('.tar')) cmd = ['tar', ['-xf', name]];
  else fail(400, 'Unsupported archive type — use .zip, .tar.gz, .tar.xz or .tar');

  assertArchiveIsSafe(file, dest);
  await run(cmd[0], cmd[1], dest);
  return { ok: true, extractedTo: path.posix.dirname(String(rel).replace(/\\/g, '/')) };
}

/** Pack files or folders into a .tar.gz next to them. */
async function compress(root, relPaths, name) {
  if (!Array.isArray(relPaths) || !relPaths.length) fail(400, 'Nothing selected to compress');
  const first = containedPath(root, relPaths[0]);
  const dir = path.dirname(first);
  const archiveName = (name && String(name).replace(/[^A-Za-z0-9._-]/g, '_')) || `archive-${Date.now()}.tar.gz`;
  const target = path.join(dir, archiveName.endsWith('.tar.gz') ? archiveName : `${archiveName}.tar.gz`);
  // Verify every entry stays inside the sandbox before touching tar.
  const names = relPaths.map((rel) => path.basename(containedPath(root, rel)));
  await run(TAR, ['-czf', path.basename(target), ...names], dir);
  const stat = await fsp.stat(target);
  return { name: path.basename(target), size: stat.size };
}

function run(command, args, cwd) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    proc.on('error', (err) =>
      reject(new Error(`${command} is not installed on this host (${err.message})`))
    );
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited ${code}`))));
  });
}

/** Resolve a path for streaming a download, ensuring it is a regular file. */
function resolveDownload(root, rel) {
  const file = containedPath(root, rel);
  const stat = fs.statSync(file);
  if (!stat.isFile()) fail(400, 'Not a file');
  return { file, size: stat.size, name: path.basename(file) };
}

module.exports = { list, search, read, write, mkdir, remove, rename, extract, compress, resolveDownload, containedPath, assertArchiveIsSafe, MAX_EDIT_BYTES };
