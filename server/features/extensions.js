'use strict';

/**
 * Extensions: small add-ons an administrator installs into data/extensions/<name>/
 * (built-in ones ship in the repo's extensions/ folder). Each has a
 * manifest.json; see docs/extensions.md.
 *
 * Trust, in plain words:
 *  - Themes (CSS variables + optional CSS) and pages/widgets (shown inside a
 *    sandboxed iframe that can only talk to the panel through a small
 *    read-only postMessage API) are the safe kinds.
 *  - Event hooks make the PANEL send an HTTP POST to a URL the extension names.
 *  - Code extensions (manifest "main") run INSIDE the panel process with full
 *    access to it. They load only when an administrator switches on "Allow code
 *    extensions" (off by default), and only after a panel restart.
 * Installing an extension means the administrator trusts its author.
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const { config } = require('../core/config');
const { HttpError, logger } = require('../core/util');
const zip = require('./zip');

const BUILTIN_DIR = path.join(__dirname, '..', '..', 'extensions');
const USER_DIR = path.join(config.dataDir, 'extensions');

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;
const VAR_RE = /^--[a-z0-9-]{1,40}$/;
// A CSS value: no way out of the declaration, no imports, no scripts, no external loads.
const VALUE_RE = /^[^;{}<>\\@]{1,120}$/;
const BAD_VALUE = /url\s*\(|expression\s*\(|import|javascript:/i;
const FILE_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff2', '.txt', '.md', '.ico']);
const API_SCOPES = ['servers', 'host'];
const HOOK_EVENT_RE = /^(\*|[a-z_]+\.(\*|[a-z_0-9]+))$/;

const bad = (msg) => new HttpError(400, msg);

/** A relative file path inside an extension, or null. */
function cleanRel(p, exts) {
  const clean = zip.safeEntryPath(String(p ?? ''));
  if (!clean) return null;
  const ext = path.extname(clean).toLowerCase();
  if (!FILE_EXT.has(ext) || (exts && !exts.includes(ext))) return null;
  return clean;
}

/**
 * Check and normalise a manifest. Never throws: returns { errors, manifest }.
 * Unknown fields are dropped, so a manifest cannot smuggle settings in.
 */
function validateManifest(raw) {
  const errors = [];
  const m = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['manifest.json must be a JSON object'], manifest: null };
  if (!NAME_RE.test(String(raw.name || ''))) errors.push('"name" must be 2-40 characters: lowercase letters, digits and dashes, starting with a letter or digit');
  m.name = String(raw.name || '');
  m.title = String(raw.title || raw.name || '').slice(0, 60);
  if (!m.title) errors.push('"title" is required');
  m.version = String(raw.version || '');
  if (!/^[0-9A-Za-z.+-]{1,20}$/.test(m.version)) errors.push('"version" is required (for example 1.0.0)');
  m.description = String(raw.description || '').slice(0, 300);
  m.author = String(raw.author || '').slice(0, 80);

  const list = (key) => (raw[key] === undefined ? [] : Array.isArray(raw[key]) ? raw[key] : (errors.push(`"${key}" must be a list`), []));
  const seen = new Set();
  const unique = (kind, id) => {
    if (seen.has(`${kind}:${id}`)) errors.push(`${kind} id "${id}" is used twice`);
    seen.add(`${kind}:${id}`);
  };

  m.themes = [];
  for (const t of list('themes').slice(0, 20)) {
    if (!t || typeof t !== 'object') {
      errors.push('A theme entry must be an object');
      continue;
    }
    const id = String(t.id || '');
    if (!ID_RE.test(id)) errors.push(`Theme id "${id.slice(0, 30)}" must be lowercase letters, digits and dashes`);
    unique('theme', id);
    const mode = t.mode === 'light' ? 'light' : t.mode === 'dark' ? 'dark' : null;
    if (!mode) errors.push(`Theme "${id}" needs "mode": "dark" or "light" (the base it builds on)`);
    const vars = {};
    for (const [k, v] of Object.entries(t.vars && typeof t.vars === 'object' ? t.vars : {})) {
      if (Object.keys(vars).length >= 80) break;
      if (!VAR_RE.test(k)) errors.push(`Theme "${id}": "${k.slice(0, 40)}" is not a CSS variable name (--like-this)`);
      else if (typeof v !== 'string' || !VALUE_RE.test(v) || BAD_VALUE.test(v)) errors.push(`Theme "${id}": the value of ${k} is not allowed`);
      else vars[k] = v.trim();
    }
    let css = null;
    if (t.css !== undefined) {
      css = cleanRel(t.css, ['.css']);
      if (!css) errors.push(`Theme "${id}": "css" must be a .css file inside the extension`);
    }
    m.themes.push({ id, name: String(t.name || id).slice(0, 40), mode: mode || 'dark', vars, css });
  }

  const embeds = (key, kind) => {
    const out = [];
    for (const p of list(key).slice(0, 20)) {
      if (!p || typeof p !== 'object') {
        errors.push(`A ${kind} entry must be an object`);
        continue;
      }
      const id = String(p.id || '');
      if (!ID_RE.test(id)) errors.push(`${kind} id "${id.slice(0, 30)}" must be lowercase letters, digits and dashes`);
      unique(kind, id);
      const entry = cleanRel(p.entry, ['.html']);
      if (!entry) errors.push(`${kind} "${id}": "entry" must be an .html file inside the extension`);
      const item = { id, title: String(p.title || id).slice(0, 60), entry: entry || '', adminOnly: p.adminOnly !== false };
      if (kind === 'widget') item.height = Math.min(600, Math.max(80, Number(p.height) || 160));
      out.push(item);
    }
    return out;
  };
  m.pages = embeds('pages', 'page');
  m.widgets = embeds('widgets', 'widget');

  m.api = [];
  for (const s of list('api')) {
    if (!API_SCOPES.includes(s)) errors.push(`"api" can only list: ${API_SCOPES.join(', ')}`);
    else m.api.push(s);
  }

  m.hooks = [];
  for (const h of list('hooks').slice(0, 10)) {
    const event = String(h?.event || '');
    if (!HOOK_EVENT_RE.test(event)) errors.push(`Hook event "${event.slice(0, 40)}" must look like server.crashed, backup.* or *`);
    let url = null;
    try {
      url = new URL(String(h?.url || ''));
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('scheme');
    } catch {
      errors.push(`Hook "${event}": "url" must be an http:// or https:// address without a password in it`);
    }
    if (url) m.hooks.push({ event, url: url.toString() });
  }

  m.main = null;
  if (raw.main !== undefined) {
    m.main = cleanRel(raw.main, ['.js']);
    if (!m.main) errors.push('"main" must be a .js file inside the extension');
  }
  if (!m.themes.length && !m.pages.length && !m.widgets.length && !m.hooks.length && !m.main) errors.push('The extension provides nothing: add themes, pages, widgets, hooks or main');
  return { errors, manifest: errors.length ? null : m };
}

/** The CSS a theme applies. Variables go on the root; the base mode stays as the foundation. */
function themeCss(theme, extDir) {
  const id = theme.gid;
  const decl = Object.entries(theme.vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  let css = `:root[data-ext-theme="${id}"][data-theme]{${decl}}`;
  if (theme.css && extDir) {
    try {
      const extra = fs.readFileSync(path.join(extDir, theme.css), 'utf8').slice(0, 100_000);
      // It lands in a <style> element: nothing may close it.
      css += `\n${extra.replace(/<\/style/gi, '')}`;
    } catch {
      /* missing file: variables still apply */
    }
  }
  return css;
}

const privateAddress = (ip) =>
  net.isIPv4(ip)
    ? /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)
    : /^(::1?$|f[cd]|fe[89ab])/i.test(ip) || /^::ffff:/i.test(ip);

/** Download an https URL (no private addresses, bounded size and redirects). */
async function download(input, hops = 0, max = zip.LIMITS.totalBytes) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw bad('That is not a web address');
  }
  if (url.protocol !== 'https:') throw bad('Only https:// addresses are accepted');
  if (url.hostname === 'github.com') {
    // A repository page link becomes its main-branch zip.
    const m = /^\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.pathname);
    if (m) url = new URL(`https://codeload.github.com/${m[1]}/zip/refs/heads/main`);
  }
  const lookups = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!lookups.length) throw bad(`Could not find ${url.hostname}`);
  if (lookups.some((l) => privateAddress(l.address))) throw bad('That address points inside your network');
  return new Promise((resolve, reject) => {
    const req = https.get({ host: lookups[0].address, servername: url.hostname, path: url.pathname + url.search, headers: { host: url.hostname, 'user-agent': 'GamePanel' }, timeout: 20_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= 3) return reject(bad('Too many redirects'));
        return download(new URL(res.headers.location, url).toString(), hops + 1, max).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(bad(`The address answered ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > max) {
          req.destroy();
          reject(bad('That download is too large'));
        } else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => reject(err instanceof HttpError ? err : bad(`Could not download it: ${err.message}`)));
  });
}

class Extensions {
  constructor(store, { builtinDir = BUILTIN_DIR, userDir = USER_DIR } = {}) {
    this.store = store;
    this.builtinDir = builtinDir;
    this.userDir = userDir;
    this.cache = null;
    this.hookHits = new Map();
    this.codeLoaded = [];
    store.on('event', (event) => this.onEvent(event));
  }

  get settings() {
    const s = (this.store.state.settings.extensions ||= { allowCode: false, disabled: [] });
    if (!Array.isArray(s.disabled)) s.disabled = [];
    return s;
  }

  /** Every extension on disk, valid or not. */
  scan(force = false) {
    if (this.cache && !force) return this.cache;
    const out = [];
    for (const [dir, builtin] of [
      [this.builtinDir, true],
      [this.userDir, false],
    ]) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        /* no folder yet */
      }
      for (const name of names.sort()) {
        const root = path.join(dir, name);
        try {
          if (!fs.statSync(root).isDirectory()) continue;
          const { errors, manifest } = validateManifest(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')));
          if (manifest && manifest.name !== name) errors.push(`The folder is called "${name}" but the manifest says "${manifest.name}"`);
          if (out.some((e) => e.name === name)) continue; // a built-in name wins over an installed copy
          out.push({ name, root, builtin, errors, manifest: errors.length ? null : manifest });
        } catch (err) {
          out.push({ name, root, builtin, errors: [`manifest.json could not be read: ${err.message.slice(0, 100)}`], manifest: null });
        }
      }
    }
    this.cache = out;
    return out;
  }

  isEnabled(ext) {
    return !this.settings.disabled.includes(ext.name);
  }

  active() {
    return this.scan().filter((e) => e.manifest && this.isEnabled(e));
  }

  /** The administrator's view. */
  list() {
    return this.scan().map((e) => ({
      name: e.name,
      title: e.manifest?.title || e.name,
      version: e.manifest?.version || '',
      author: e.manifest?.author || '',
      description: e.manifest?.description || '',
      builtin: e.builtin,
      enabled: this.isEnabled(e),
      valid: !e.errors.length,
      errors: e.errors,
      themes: e.manifest?.themes.map((t) => t.name) || [],
      pages: e.manifest?.pages.map((p) => p.title) || [],
      widgets: e.manifest?.widgets.map((w) => w.title) || [],
      hooks: e.manifest?.hooks.map((h) => `${h.event} → ${new URL(h.url).host}`) || [],
      code: Boolean(e.manifest?.main),
      codeRunning: this.codeLoaded.includes(e.name),
    }));
  }

  /** Everything an account may use from the enabled extensions. */
  publicView(user) {
    const admin = user?.role === 'admin';
    const themes = [];
    const pages = [];
    const widgets = [];
    for (const e of this.active()) {
      for (const t of e.manifest.themes) themes.push({ id: `${e.name}/${t.id}`, name: t.name, mode: t.mode, extension: e.manifest.title, swatch: swatchOf(t) });
      for (const p of e.manifest.pages) if (admin || !p.adminOnly) pages.push({ ext: e.name, id: p.id, title: p.title, src: `/ext/${e.name}/${p.entry}`, api: e.manifest.api });
      for (const w of e.manifest.widgets) if (admin || !w.adminOnly) widgets.push({ ext: e.name, id: w.id, title: w.title, height: w.height, src: `/ext/${e.name}/${w.entry}`, api: e.manifest.api });
    }
    return { themes, pages, widgets };
  }

  /** {id, mode, css} for an enabled theme, or null. */
  theme(gid) {
    const [name, id] = String(gid || '').split('/');
    const e = this.active().find((x) => x.name === name);
    const t = e?.manifest.themes.find((x) => x.id === id);
    if (!t) return null;
    return { id: gid, mode: t.mode, css: themeCss({ ...t, gid }, e.root) };
  }

  setEnabled(name, enabled) {
    if (!this.scan().some((e) => e.name === name)) throw new HttpError(404, 'No such extension');
    const set = new Set(this.settings.disabled);
    if (enabled) set.delete(name);
    else set.add(name);
    this.settings.disabled = [...set];
    this.store.save();
  }

  setAllowCode(on) {
    this.settings.allowCode = Boolean(on);
    this.store.save();
  }

  remove(name) {
    const e = this.scan().find((x) => x.name === name);
    if (!e) throw new HttpError(404, 'No such extension');
    if (e.builtin) throw bad('Built-in extensions cannot be removed, only turned off');
    fs.rmSync(e.root, { recursive: true, force: true });
    this.settings.disabled = this.settings.disabled.filter((n) => n !== name);
    this.store.save();
    this.scan(true);
  }

  /** Install from zip bytes. Returns the manifest. Nothing is written unless everything checks out. */
  installZip(buffer) {
    const files = zip.readZip(buffer);
    // The manifest may sit at the root or inside one top-level folder (GitHub zips do this).
    const mf = files.find((f) => f.path === 'manifest.json') || files.find((f) => /^[^/]+\/manifest\.json$/.test(f.path));
    if (!mf) throw bad('The zip has no manifest.json');
    const prefix = mf.path.slice(0, -'manifest.json'.length);
    let parsed;
    try {
      parsed = JSON.parse(mf.data.toString('utf8'));
    } catch {
      throw bad('manifest.json is not valid JSON');
    }
    const { errors, manifest } = validateManifest(parsed);
    if (!manifest) throw bad(errors.slice(0, 4).join('. '));
    if (this.scan().some((e) => e.builtin && e.name === manifest.name)) throw bad('A built-in extension already has that name');
    const rooted = files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), data: f.data }));
    for (const f of rooted) {
      if (!FILE_EXT.has(path.extname(f.path).toLowerCase())) throw bad(`File type not allowed in an extension: ${f.path.slice(0, 60)}`);
    }
    // Every file the manifest points at must be in the package.
    const have = new Set(rooted.map((f) => f.path));
    const needs = [...manifest.themes.map((t) => t.css), ...manifest.pages.map((p) => p.entry), ...manifest.widgets.map((w) => w.entry), manifest.main].filter(Boolean);
    for (const n of needs) if (!have.has(n)) throw bad(`The manifest names ${n}, which is not in the zip`);

    fs.mkdirSync(this.userDir, { recursive: true });
    const staging = fs.mkdtempSync(path.join(this.userDir, '.incoming-'));
    try {
      for (const f of rooted) {
        const target = path.join(staging, ...f.path.split('/'));
        if (!target.startsWith(staging + path.sep)) throw bad('Unsafe path in the zip');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.data);
      }
      const finalDir = path.join(this.userDir, manifest.name);
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(staging, finalDir);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    this.scan(true);
    return manifest;
  }

  async installUrl(url) {
    return this.installZip(await download(url));
  }

  /** Absolute path of a file an enabled extension may serve, or null. */
  fileFor(name, rel) {
    const e = this.active().find((x) => x.name === name);
    if (!e) return null;
    const clean = cleanRel(rel);
    if (!clean) return null;
    const file = path.join(e.root, ...clean.split('/'));
    try {
      const real = fs.realpathSync(file);
      if (!real.startsWith(fs.realpathSync(e.root) + path.sep) || !fs.statSync(real).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------- event hooks -- */

  onEvent(event) {
    for (const e of this.active()) {
      for (const hook of e.manifest.hooks) {
        if (!hookMatches(hook.event, event.type)) continue;
        const key = `${e.name}|${hook.url}`;
        const now = Date.now();
        const hits = (this.hookHits.get(key) || []).filter((t) => now - t < 60_000);
        if (hits.length >= 30) continue;
        hits.push(now);
        this.hookHits.set(key, hits);
        fetch(hook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'GamePanel-Extension', 'X-GamePanel-Event': event.type },
          body: JSON.stringify({ event: event.type, message: event.message, serverId: event.serverId || null, at: event.at, extension: e.name }),
          signal: AbortSignal.timeout(8000),
          redirect: 'error',
        }).catch((err) => logger.debug(`Extension ${e.name} hook failed: ${err.message}`));
      }
    }
  }

  /** Code extensions: only with "allow code extensions" on, once, at start. */
  startCode(app) {
    if (!this.settings.allowCode) return;
    for (const e of this.active()) {
      if (!e.manifest.main) continue;
      try {
        const file = this.fileFor(e.name, e.manifest.main);
        if (!file) throw new Error('main file is missing');
        const mod = require(file);
        const handlers = [];
        mod.activate?.({
          name: e.name,
          log: (msg) => logger.info(`[ext ${e.name}] ${String(msg).slice(0, 300)}`),
          on: (type, fn) => handlers.push([String(type), fn]),
          servers: () => app.manager.servers.map((s) => ({ id: s.id, name: s.name, game: s.templateId })),
        });
        this.store.on('event', (event) => {
          for (const [type, fn] of handlers) {
            if (!hookMatches(type, event.type)) continue;
            try {
              Promise.resolve(fn({ type: event.type, message: event.message, serverId: event.serverId || null, at: event.at })).catch((err) => logger.warn(`[ext ${e.name}] ${err.message}`));
            } catch (err) {
              logger.warn(`[ext ${e.name}] ${err.message}`);
            }
          }
        });
        this.codeLoaded.push(e.name);
        logger.warn(`Code extension "${e.name}" is running inside the panel.`);
      } catch (err) {
        logger.error(`Code extension "${e.name}" failed to start: ${err.message}`);
      }
    }
  }
}

function hookMatches(pattern, type) {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

/** Three colours to preview a theme: background, surface, accent. */
function swatchOf(t) {
  const v = t.vars;
  const dark = { '--bg': '#111210', '--surface': '#191a17', '--lime': '#c6f432' };
  const light = { '--bg': '#f3f2ed', '--surface': '#ffffff', '--lime': '#c6f432' };
  const base = t.mode === 'light' ? light : dark;
  return [v['--bg'] || base['--bg'], v['--surface'] || base['--surface'], v['--lime'] || base['--lime']];
}

let instance = null;
function init(app) {
  if (!instance) instance = new Extensions(app.store);
  return instance;
}

module.exports = { Extensions, init, validateManifest, hookMatches, cleanRel, themeCss, USER_DIR, BUILTIN_DIR };
