'use strict';

/** Sandboxed file manager for a single server directory. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { safeJoin, fail } = require('./util');

const MAX_EDIT_BYTES = 4 * 1024 * 1024;
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
  const dir = safeJoin(root, rel);
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

async function read(root, rel) {
  const file = safeJoin(root, rel);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) fail(404, 'File not found');
  if (stat.isDirectory()) fail(400, 'That is a directory');
  if (stat.size > MAX_EDIT_BYTES) fail(413, 'File is too large to open in the editor');
  return { path: rel, size: stat.size, content: await fsp.readFile(file, 'utf8') };
}

async function write(root, rel, content) {
  const file = safeJoin(root, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, String(content ?? ''));
  const stat = await fsp.stat(file);
  return { path: rel, size: stat.size };
}

async function mkdir(root, rel) {
  const dir = safeJoin(root, rel);
  await fsp.mkdir(dir, { recursive: true });
  return { path: rel };
}

async function remove(root, rel) {
  const target = safeJoin(root, rel);
  if (path.resolve(target) === path.resolve(root)) fail(400, 'Refusing to delete the server root');
  await fsp.rm(target, { recursive: true, force: true });
  return { path: rel };
}

async function rename(root, rel, toRel) {
  const from = safeJoin(root, rel);
  const to = safeJoin(root, toRel);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return { path: toRel };
}

/** Resolve a path for streaming a download, ensuring it is a regular file. */
function resolveDownload(root, rel) {
  const file = safeJoin(root, rel);
  const stat = fs.statSync(file);
  if (!stat.isFile()) fail(400, 'Not a file');
  return { file, size: stat.size, name: path.basename(file) };
}

module.exports = { list, read, write, mkdir, remove, rename, resolveDownload, MAX_EDIT_BYTES };
