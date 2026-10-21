'use strict';

/**
 * Config sync: the panel's settings and each server's config files (never
 * worlds) kept in a git repository, for an off-site history and a way to
 * restore or copy a setup to another machine.
 *
 * A local repository lives in data/config-sync. Each run rebuilds a snapshot
 * of a fixed whitelist, commits if anything changed and, when a remote and a
 * token are set, pushes. The token is sealed in the panel's settings and given
 * to git for that one command through an environment variable and a throwaway
 * credential helper; it is never written into the remote URL or a git file.
 *
 *   panel/settings.json            panel settings with every secret removed
 *   servers.yaml                   every server (infra-as-code format, no secret variables)
 *   servers/<id>/files/<path>      the config files chosen for that server
 *
 * Never included: accounts, password hashes, keys, tokens, the bridge, node
 * keys, world data, backups, binaries. Config files lose lines that look like
 * passwords or tokens (replaced by <redacted>).
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { fail, logger } = require('../core/util');
const { run, which } = require('../core/platform');
const secrets = require('../core/secrets');
const infra = require('./infra-as-code');
const { containedPath } = require('./files');

const REPO_DIR = path.join(config.dataDir, 'config-sync');
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 400;
const MAX_ENTRIES_PER_SERVER = 40;
const MARKER = '<redacted>';

// Starting points for a server whose files were not chosen: small, common game config files.
const DEFAULT_FILES = ['server.properties', 'bukkit.yml', 'spigot.yml', 'config/paper-global.yml', 'config/paper-world-defaults.yml', 'ServerConfig.ini', 'server.cfg', 'server.json', 'config.json'];

const ALLOWED_EXT = /\.(properties|ya?ml|json5?|toml|cfg|conf|ini|txt|xml|hocon|lang|cnf|env)$/i;
const DENIED_DIR = /^(world|world_nether|world_the_end|region|playerdata|stats|advancements|logs|crash-reports|cache|libraries|versions|backups|saves|\.git|node_modules|datapacks|dimensions)$/i;
const DENIED_NAME = /(secret|token|password|passwd|credential|private|id_rsa|\.pem$|\.key$|\.jks$|\.p12$|usercache|banned|^ops\.json$|whitelist|\.env$)/i;
const SENSITIVE_KEY = /(token|secret|passw|passphrase|webhook|credential|private|cookie|salt|hash|key|auth|session)/i;
const SENSITIVE_LINE = /^(\s*["']?[\w. -]*(?:password|passwd|secret|token|api[-_ ]?key|private[-_ ]?key|webhook|credential)[\w. -]*["']?\s*[:=]\s*)(\S.*)$/i;
const NEVER_SETTINGS = new Set(['nodes', 'configSync', 'oauth']);

/* ---------------------------------------------------------- whitelisting -- */

/** A panel settings tree without anything secret. */
function sanitizeSettings(value, depth = 0, top = true) {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => sanitizeSettings(v, depth + 1, false)).filter((v) => v !== undefined);
  if (typeof value === 'string') {
    if (secrets.isSealed(value) || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value)) return undefined;
    return value.length > 4000 ? undefined : value;
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '__proto__' || SENSITIVE_KEY.test(k) || (top && NEVER_SETTINGS.has(k))) continue;
    const clean = sanitizeSettings(v, depth + 1, false);
    if (clean !== undefined) out[k] = clean;
  }
  return out;
}

/** A relative path inside a server folder from user text, or null when it is not acceptable. */
function cleanRel(raw) {
  let rel = String(raw || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel || rel.length > 200 || rel.startsWith('/') || /[\x00-\x1f:*?"<>|]/.test(rel)) return null; // eslint-disable-line no-control-regex
  const isDir = rel.endsWith('/');
  rel = rel.replace(/\/+$/, '');
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || DENIED_DIR.test(p))) return null;
  return { rel: parts.join('/'), isDir };
}

/** Blank the value of lines that look like passwords and tokens. */
function redactText(text) {
  return text
    .split('\n')
    .map((line) => line.replace(SENSITIVE_LINE, `$1${MARKER}`))
    .join('\n');
}

function fileAllowed(rel) {
  const name = rel.split('/').pop();
  return ALLOWED_EXT.test(name) && !DENIED_NAME.test(name);
}

function readSmall(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

/** The files chosen for one server, as { rel -> redacted text }, plus what was left out and why. */
function collectServerFiles(server, entries, skipped) {
  const out = new Map();
  const add = (rel) => {
    if (out.size >= 150) return skipped.push({ server: server.id, path: rel, reason: 'too many files for one server' });
    if (!fileAllowed(rel)) return skipped.push({ server: server.id, path: rel, reason: 'not a config file type, or its name looks secret' });
    try {
      const abs = containedPath(server.dir, rel);
      const text = readSmall(abs);
      if (text === null) return skipped.push({ server: server.id, path: rel, reason: 'not a small text file' });
      out.set(rel, redactText(text));
    } catch {
      /* missing files are normal: the list is a wish list */
    }
  };
  const walk = (rel, depth, budget) => {
    if (depth > 4 || budget.n <= 0) return;
    let names;
    try {
      names = fs.readdirSync(containedPath(server.dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (budget.n-- <= 0) return;
      const child = `${rel}/${d.name}`;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (!DENIED_DIR.test(d.name)) walk(child, depth + 1, budget);
      } else if (d.isFile()) add(child);
    }
  };
  for (const raw of entries) {
    const c = cleanRel(raw);
    if (!c) {
      skipped.push({ server: server.id, path: String(raw).slice(0, 80), reason: 'not an allowed path' });
      continue;
    }
    if (c.isDir) walk(c.rel, 0, { n: 600 });
    else add(c.rel);
  }
  return out;
}

/**
 * Everything that would be committed: { files: Map(path -> text), skipped }.
 * `chosen` maps a server id to its list of files and folders.
 */
function collect({ settings, manager, chosen = {} }) {
  const files = new Map();
  const skipped = [];
  files.set('README.md', '# GamePanel config sync\n\nWritten by GamePanel. It holds panel settings without secrets, a servers file you can apply with `gamepanel apply`, and chosen config files per server. Worlds, accounts, passwords and tokens are never stored here.\n');
  files.set('panel/settings.json', JSON.stringify(sanitizeSettings(settings || {}), null, 2) + '\n');
  files.set('servers.yaml', infra.exportYaml(manager));
  for (const server of manager.servers) {
    if (!/^[A-Za-z0-9._-]+$/.test(server.id)) continue;
    const entries = (Array.isArray(chosen[server.id]) ? chosen[server.id] : DEFAULT_FILES).slice(0, MAX_ENTRIES_PER_SERVER);
    for (const [rel, text] of collectServerFiles(server, entries, skipped)) files.set(`servers/${server.id}/files/${rel}`, text);
  }
  let total = 0;
  for (const [p, t] of [...files]) {
    total += Buffer.byteLength(t);
    if (files.size > MAX_FILES || total > MAX_TOTAL_BYTES) {
      files.delete(p);
      skipped.push({ path: p, reason: 'size limit for the repository reached' });
    }
  }
  return { files, skipped };
}

/* ------------------------------------------------------------------- git -- */

const HELPER = '!f() { echo "username=$GP_SYNC_USER"; echo "password=$GP_SYNC_TOKEN"; }; f';

function checkRemote(raw) {
  const url = String(raw || '').trim();
  if (!url) return '';
  const bad = url.length > 300 || /[\s\x00-\x1f]/.test(url) || url.startsWith('-'); // eslint-disable-line no-control-regex
  const https = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~/-]+$/;
  const ssh = /^(?:ssh:\/\/git@[A-Za-z0-9.-]+(?::\d{1,5})?\/|git@[A-Za-z0-9.-]+:)[A-Za-z0-9._~/-]+$/;
  if (bad || !(https.test(url) || ssh.test(url))) fail(400, 'The repository address must look like https://github.com/you/panel-config.git (no password in it) or git@github.com:you/panel-config.git');
  return url;
}

function checkBranch(raw) {
  const b = String(raw || 'main').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(b) || b.includes('..') || b.endsWith('/') || b.endsWith('.lock')) fail(400, 'The branch name can use letters, numbers, dots, dashes and slashes');
  return b;
}

const settingsOf = (store) => (store.state.settings.configSync ||= { enabled: false, remote: '', branch: 'main', username: 'x-access-token', token: '', everyHours: 0, files: {} });

function gitEnv(cs, withToken) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https:ssh',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  if (withToken && cs.token) {
    env.GP_SYNC_USER = cs.username || 'x-access-token';
    env.GP_SYNC_TOKEN = secrets.open(cs.token);
  }
  return env;
}

function scrub(text, cs) {
  let out = String(text || '');
  const token = cs?.token ? secrets.open(cs.token) : '';
  if (token && token.length >= 4) out = out.split(token).join('***');
  return out.replace(/(https?:\/\/)[^/\s@]+@/g, '$1***@');
}

async function git(cs, args, { network = false, timeout = 60_000 } = {}) {
  const lead = network ? ['-c', 'credential.helper=', '-c', `credential.helper=${HELPER}`] : [];
  const r = await run('git', [...lead, ...args], { cwd: REPO_DIR, env: gitEnv(cs, network), timeout });
  return { ...r, stdout: scrub(r.stdout, cs), stderr: scrub(r.stderr || r.error, cs) };
}

const gitFailure = (what, r) => fail(502, `${what} failed: ${String(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || 'git gave no details'}`);

async function ensureRepo(cs) {
  if (!which('git')) fail(400, 'Git is not installed on this machine. Install it (Linux: sudo apt install git; Windows: https://git-scm.com/download/win) and try again.');
  fs.mkdirSync(REPO_DIR, { recursive: true });
  if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
    const r = await git(cs, ['init', '-q']);
    if (r.code) gitFailure('Creating the repository', r);
  }
  const branch = checkBranch(cs.branch);
  await git(cs, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  if (cs.remote) {
    const have = await git(cs, ['remote', 'get-url', 'origin']);
    if (have.code) await git(cs, ['remote', 'add', 'origin', checkRemote(cs.remote)]);
    else if (have.stdout.trim() !== cs.remote) await git(cs, ['remote', 'set-url', 'origin', checkRemote(cs.remote)]);
  }
}

/** Write the snapshot over the repository's working tree (only paths this module owns). */
function writeSnapshot(files) {
  for (const p of ['panel', 'servers', 'servers.yaml', 'README.md']) fs.rmSync(path.join(REPO_DIR, p), { recursive: true, force: true });
  for (const [rel, text] of files) {
    const target = path.join(REPO_DIR, ...rel.split('/'));
    if (!target.startsWith(REPO_DIR + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

let busy = false;
const exclusive = async (fn) => {
  if (busy) fail(409, 'A sync is already running');
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
};

const gitIdentity = ['-c', 'user.name=GamePanel', '-c', 'user.email=gamepanel@localhost', '-c', 'commit.gpgsign=false'];

/** Snapshot, commit if changed, push if a remote is set. */
async function sync({ store, manager }, { push = true, reason = 'Manual sync' } = {}) {
  return exclusive(async () => {
    const cs = settingsOf(store);
    const result = { committed: false, pushed: false, files: 0, skipped: [] };
    try {
      await ensureRepo(cs);
      const remote = Boolean(cs.remote && push);
      if (remote) {
        // The remote may hold history from elsewhere (a README from "new repository"): build on top of it.
        const f = await git(cs, ['fetch', '-q', 'origin', checkBranch(cs.branch)], { network: true, timeout: 120_000 });
        if (f.code === 0) {
          const anc = await git(cs, ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD']);
          if (anc.code !== 0) await git(cs, ['reset', '-q', '--soft', 'FETCH_HEAD']);
        }
      }
      const { files, skipped } = collect({ settings: store.state.settings, manager, chosen: cs.files || {} });
      writeSnapshot(files);
      result.files = files.size;
      result.skipped = skipped.slice(0, 50);
      await git(cs, ['add', '-A']);
      const dirty = await git(cs, ['status', '--porcelain']);
      if (dirty.stdout.trim()) {
        const c = await git(cs, [...gitIdentity, 'commit', '-q', '-m', `${reason}: ${dirty.stdout.trim().split('\n').length} file(s) changed`]);
        if (c.code) gitFailure('Committing', c);
        result.committed = true;
      }
      const head = await git(cs, ['rev-parse', '--short', 'HEAD']);
      cs.lastCommit = head.code === 0 ? head.stdout.trim() : cs.lastCommit || null;
      if (remote) {
        const p = await git(cs, ['push', '-q', 'origin', `HEAD:refs/heads/${checkBranch(cs.branch)}`], { network: true, timeout: 180_000 });
        if (p.code) gitFailure('Pushing', p);
        result.pushed = true;
        cs.lastPush = Date.now();
      }
      cs.lastError = null;
    } catch (err) {
      cs.lastError = err.message;
      cs.lastRun = Date.now();
      store.save();
      throw err;
    }
    cs.lastRun = Date.now();
    store.save();
    if (result.committed) store.addEvent('config-sync.committed', `Config sync: ${result.pushed ? 'committed and pushed' : 'committed'} (${result.files} files)`);
    return result;
  });
}

/* ----------------------------------------------------------- view / save -- */

function view(store, manager) {
  const cs = settingsOf(store);
  return {
    gitInstalled: Boolean(which('git')),
    enabled: Boolean(cs.enabled),
    remote: cs.remote || '',
    branch: cs.branch || 'main',
    username: cs.username || 'x-access-token',
    tokenSet: Boolean(cs.token),
    everyHours: cs.everyHours || 0,
    lastRun: cs.lastRun || null,
    lastPush: cs.lastPush || null,
    lastCommit: cs.lastCommit || null,
    lastError: cs.lastError || null,
    defaults: DEFAULT_FILES,
    servers: manager.servers.map((s) => ({ id: s.id, name: s.name, files: cs.files?.[s.id] || null })),
    never: 'Accounts, password hashes, keys, tokens, secret variables, node keys, worlds and backups are never included.',
  };
}

function save(store, body) {
  const cs = settingsOf(store);
  if (body.remote !== undefined) cs.remote = checkRemote(body.remote);
  if (body.branch !== undefined) cs.branch = checkBranch(body.branch);
  if (body.username !== undefined) {
    const u = String(body.username).trim() || 'x-access-token';
    if (!/^[A-Za-z0-9._@-]{1,100}$/.test(u)) fail(400, 'The username can only use letters, numbers and . _ @ -');
    cs.username = u;
  }
  if (typeof body.token === 'string' && body.token.trim()) {
    const t = body.token.trim();
    if (t.length > 300 || /\s/.test(t)) fail(400, 'That does not look like an access token');
    cs.token = secrets.seal(t);
  }
  if (body.clearToken === true) cs.token = '';
  if (body.enabled !== undefined) cs.enabled = Boolean(body.enabled);
  if (body.everyHours !== undefined) {
    const n = Number(body.everyHours);
    if (!Number.isFinite(n) || n < 0 || n > 720) fail(400, 'Hours must be between 0 (only when you press Sync) and 720');
    cs.everyHours = Math.round(n);
  }
  if (body.files && typeof body.files === 'object') {
    cs.files = cs.files || {};
    for (const [id, list] of Object.entries(body.files)) {
      if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '__proto__') continue;
      if (list === null) {
        delete cs.files[id];
        continue;
      }
      const lines = (Array.isArray(list) ? list : String(list).split('\n')).map((l) => String(l).trim()).filter(Boolean);
      if (lines.length > MAX_ENTRIES_PER_SERVER) fail(400, `At most ${MAX_ENTRIES_PER_SERVER} files or folders per server`);
      for (const l of lines) if (!cleanRel(l)) fail(400, `"${l.slice(0, 60)}" is not allowed: use paths inside the server folder, like plugins/Essentials/ (not world folders)`);
      cs.files[id] = lines.map((l) => cleanRel(l)).map((c) => (c.isDir ? `${c.rel}/` : c.rel));
    }
  }
  store.save();
}

/* --------------------------------------------------------------- restore -- */

const snapshotFiles = () => {
  const out = new Map();
  const walk = (dir, rel) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === '.git' || d.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(path.join(dir, d.name), r);
      else if (d.isFile() && out.size < 2000) {
        const text = readSmall(path.join(dir, d.name));
        if (text !== null) out.set(r, text);
      }
    }
  };
  if (fs.existsSync(REPO_DIR)) walk(REPO_DIR, '');
  return out;
};

const deepMerge = (target, source, depth = 0) => {
  if (depth > 12) return target;
  for (const [k, v] of Object.entries(source)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype' || SENSITIVE_KEY.test(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepMerge(target[k], v, depth + 1);
    else target[k] = v;
  }
  return target;
};

/** Fetch the remote and compare it with what this panel has now. Nothing is changed except the local repo copy. */
async function restorePreview({ store, manager }) {
  return exclusive(async () => {
    const cs = settingsOf(store);
    if (!cs.remote) fail(400, 'Set a repository address first');
    await ensureRepo(cs);
    const f = await git(cs, ['fetch', '-q', 'origin', checkBranch(cs.branch)], { network: true, timeout: 120_000 });
    if (f.code) gitFailure('Fetching', f);
    const reset = await git(cs, ['reset', '-q', '--hard', 'FETCH_HEAD']);
    if (reset.code) gitFailure('Reading the repository', reset);
    const log = await git(cs, ['log', '-1', '--format=%h %cI %s']);
    const repo = snapshotFiles();
    const preview = { commit: log.stdout.trim(), settings: [], servers: null, files: [] };

    const theirs = repo.get('panel/settings.json');
    if (theirs) {
      let parsed = {};
      try {
        parsed = JSON.parse(theirs);
      } catch {
        /* reported as no changes */
      }
      const mine = sanitizeSettings(store.state.settings);
      for (const k of Object.keys(parsed)) if (JSON.stringify(parsed[k]) !== JSON.stringify(mine[k])) preview.settings.push(k);
    }
    if (repo.has('servers.yaml')) {
      try {
        preview.servers = infra.publicPlan(infra.computePlan(manager, repo.get('servers.yaml'), { prune: false }));
      } catch (err) {
        preview.servers = { error: err.message };
      }
    }
    for (const [p, text] of repo) {
      const m = /^servers\/([A-Za-z0-9._-]+)\/files\/(.+)$/.exec(p);
      if (!m) continue;
      const server = manager.servers.find((s) => s.id === m[1]);
      const c = cleanRel(m[2]);
      if (!server || !c || c.isDir) {
        preview.files.push({ server: m[1], path: m[2], status: 'no such server here' });
        continue;
      }
      let status = 'new';
      try {
        const now = readSmall(containedPath(server.dir, c.rel));
        if (now !== null) status = redactText(now) === text ? 'same' : 'changed';
      } catch {
        /* not there yet */
      }
      if (text.includes(MARKER) && status !== 'new') status = status === 'same' ? 'same' : 'changed (has redacted lines: kept as it is)';
      preview.files.push({ server: m[1], path: c.rel, status });
    }
    return preview;
  });
}

/** Apply the pieces of the last preview that were asked for: { settings, servers, files }. */
async function restoreApply({ store, manager }, sections, actor) {
  return exclusive(async () => {
    const repo = snapshotFiles();
    if (!repo.size) fail(400, 'Preview the restore first');
    const out = { settings: false, servers: null, files: [] };
    if (sections.settings && repo.has('panel/settings.json')) {
      let parsed;
      try {
        parsed = JSON.parse(repo.get('panel/settings.json'));
      } catch {
        fail(400, 'The settings file in the repository is damaged');
      }
      deepMerge(store.state.settings, sanitizeSettings(parsed));
      store.save();
      out.settings = true;
    }
    if (sections.servers && repo.has('servers.yaml')) out.servers = await infra.apply(manager, repo.get('servers.yaml'), actor, { prune: false });
    if (sections.files) {
      for (const [p, text] of repo) {
        const m = /^servers\/([A-Za-z0-9._-]+)\/files\/(.+)$/.exec(p);
        const server = m && manager.servers.find((s) => s.id === m[1]);
        const c = m && cleanRel(m[2]);
        if (!server || !c || c.isDir || !fileAllowed(c.rel)) continue;
        if (text.includes(MARKER)) {
          // Secrets were removed from this copy: writing it would blank the real ones.
          if (fs.existsSync(path.join(server.dir, ...c.rel.split('/')))) {
            out.files.push({ server: server.id, path: c.rel, skipped: 'has redacted lines' });
            continue;
          }
        }
        const target = containedPath(server.dir, c.rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
        out.files.push({ server: server.id, path: c.rel, written: true });
      }
    }
    store.addEvent('config-sync.restored', `${actor?.username || 'panel'} restored from the config repository`);
    return out;
  });
}

/* ------------------------------------------------------------- scheduler -- */

let timer = null;
function start(app) {
  stop();
  timer = setInterval(() => {
    const cs = settingsOf(app.store);
    if (!cs.enabled || !cs.everyHours || busy) return;
    if (Date.now() - (cs.lastRun || 0) < cs.everyHours * 3_600_000) return;
    sync(app, { reason: 'Scheduled sync' }).catch((err) => logger.warn(`Config sync: ${err.message}`));
  }, 5 * 60_000);
  timer.unref?.();
}
function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { collect, sanitizeSettings, redactText, cleanRel, checkRemote, checkBranch, sync, view, save, restorePreview, restoreApply, start, stop, REPO_DIR, DEFAULT_FILES, MARKER };
