'use strict';

/**
 * Turns a Pterodactyl egg (PTDL_v1 / PTDL_v2 JSON) into a panel game template.
 *
 * Mapped: startup command, variables (with dropdowns from `in:` rules),
 * docker image, install script, "server is ready" line, stop command or
 * signal, and properties/ini/json config edits. Everything else is listed in
 * `unsupported` so the admin sees what to fix by hand. Nothing here is
 * saved: the result goes through the template builder's check first.
 */

const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const { fail, HttpError } = require('../core/util');
const { RESERVED } = require('./template-builder');

// Pterodactyl's own startup values, and what the panel calls them.
const BUILT_INS = { SERVER_MEMORY: 'MEMORY_MB', SERVER_PORT: 'PORT', SERVER_IP: 'IP' };
const PANEL_PLACEHOLDERS = {
  'server.build.default.port': 'PORT',
  'server.build.default.ip': 'IP',
  'server.build.memory': 'MEMORY_MB',
  'server.build.env.SERVER_PORT': 'PORT',
  'server.build.env.SERVER_MEMORY': 'MEMORY_MB',
  'server.build.env.SERVER_IP': 'IP',
};
const UNMAPPABLE_ENV = ['STARTUP', 'P_SERVER_LOCATION', 'P_SERVER_UUID', 'TZ'];

const stripComments = (s) => String(s || '').replace(/\r/g, '');

function portNameFor(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'game';
}

/** @returns {{ template: object, notes: string[], unsupported: string[] }} */
function convert(egg) {
  if (!egg || typeof egg !== 'object' || Array.isArray(egg)) fail(400, 'That is not an egg file (expected a JSON object)');
  if (!egg.startup || !egg.name) fail(400, 'That does not look like a Pterodactyl egg: it needs a name and a startup command');
  const notes = [];
  const unsupported = [];

  // Variables. Pterodactyl names that clash with the panel's own values get a prefix.
  const rename = new Map();
  const variables = [];
  const envNames = new Set();
  for (const raw of Array.isArray(egg.variables) ? egg.variables : []) {
    let name = String(raw.env_variable || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      unsupported.push(`Variable "${raw.name || name}" has no usable environment name, skipped`);
      continue;
    }
    if (BUILT_INS[name] || UNMAPPABLE_ENV.includes(name)) continue;
    envNames.add(name);
    if (RESERVED.includes(name) || /^PORT_/.test(name)) {
      rename.set(name, `EGG_${name}`);
      name = `EGG_${name}`;
      notes.push(`Variable ${raw.env_variable} clashes with a value the panel fills in, so it is called ${name} here`);
    }
    const rules = String(raw.rules || '');
    const v = { name, label: String(raw.name || name).slice(0, 80), default: raw.default_value ?? '' };
    if (raw.description) v.description = String(raw.description).slice(0, 300);
    const options = /(?:^|\|)in:([^|]+)/.exec(rules);
    if (options) v.options = options[1].split(',').map((o) => o.trim()).filter(Boolean);
    else if (/(?:^|\|)(numeric|integer)\b/.test(rules)) v.type = 'number';
    if (/(?:^|\|)(password|token|secret)/i.test(name)) v.secret = true;
    if (raw.user_editable === false) notes.push(`${name} is not editable by players in Pterodactyl; here anyone who may change settings can edit it`);
    variables.push(v);
  }
  const mapName = (n) => rename.get(n) || BUILT_INS[n] || n;

  /** {{VAR}} and ${VAR} in startup/install/config text to the panel's {{VAR}}. */
  const placeholders = (text) =>
    String(text)
      .replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, key) => {
        if (PANEL_PLACEHOLDERS[key]) return `{{${PANEL_PLACEHOLDERS[key]}}}`;
        const env = /^(?:server\.build\.env|env)\.([A-Z0-9_]+)$/.exec(key);
        if (env) return `{{${mapName(env[1])}}}`;
        if (/^[A-Z][A-Z0-9_]*$/.test(key)) return `{{${mapName(key)}}}`;
        unsupported.push(`Placeholder {{${key}}} has no equivalent and stays empty`);
        return m;
      });
  const shellVars = (text) =>
    placeholders(text).replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (m, key) => (BUILT_INS[key] || envNames.has(key) ? `{{${mapName(key)}}}` : m));

  // Start command. Ports: an egg only knows one allocation, so the template has one "game" port.
  let startCommand = shellVars(stripComments(egg.startup)).trim();
  if (/\{\{\s*STARTUP\s*\}\}|\$STARTUP\b/.test(startCommand)) unsupported.push('The startup command refers to STARTUP, which Pterodactyl images expand themselves');

  // Docker image: the panel runs one image, so take the first.
  const images = egg.docker_images && typeof egg.docker_images === 'object' ? Object.entries(egg.docker_images) : egg.image ? [['default', egg.image]] : [];
  const image = images[0]?.[1] || undefined;
  if (images.length > 1) notes.push(`The egg offers ${images.length} Docker images (${images.map(([label]) => label).join(', ')}); the first one is used: ${image}`);
  if (!images.length) notes.push('The egg names no Docker image, so the panel default is used');

  // Install script.
  const install = [];
  const script = egg.scripts?.installation;
  if (script?.script) {
    let text = stripComments(script.script).replace(/\/mnt\/server\b/g, '"$GP_SERVER_DIR"').replace(/"\$GP_SERVER_DIR""/g, '"$GP_SERVER_DIR/"');
    text = text.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (m, key) => (BUILT_INS[key] ? `\${${mapName(key)}}` : m));
    // The mapped names must exist as environment variables in the install script.
    const aliases = Object.entries(BUILT_INS).filter(([k]) => new RegExp(`\\$\\{?${k}\\b`).test(text));
    for (const [k, to] of aliases) text = `export ${k}="$${to}"\n${text}`;
    for (const [from, to] of rename) text = text.replace(new RegExp(`\\$\\{${from}\\}|\\$${from}\\b`, 'g'), `\${${to}}`);
    install.push({ type: 'script', label: `Run the egg's install script (${script.container || 'its own image'})`, run: `cd "$GP_SERVER_DIR"\n${text}` });
    if (script.container && !/debian|ubuntu|bookworm|bullseye/i.test(script.container)) notes.push(`The install script was written for ${script.container}; the panel runs it in the game's image with bash. Commands such as apk may need changing`);
    if (/\bapk\b/.test(script.script)) unsupported.push('The install script uses apk (Alpine); change it to apt-get');
    if (script.entrypoint && !/^(ba)?sh$|^ash$/.test(script.entrypoint)) notes.push(`The install entrypoint is ${script.entrypoint}; the script runs with bash`);
  }

  // Config edits: properties, ini and json become patches that are re-applied on each start.
  const patchProperties = [];
  let parsedFiles = {};
  try {
    parsedFiles = typeof egg.config?.files === 'string' ? JSON.parse(egg.config.files || '{}') : egg.config?.files || {};
  } catch {
    unsupported.push('config.files is not valid JSON, so no config edits were imported');
  }
  for (const [file, def] of Object.entries(parsedFiles)) {
    const parser = String(def?.parser || '').toLowerCase();
    if (!['properties', 'ini', 'json'].includes(parser)) {
      unsupported.push(`Config edits for ${file} use the "${parser || 'unknown'}" parser, which the panel cannot apply (set it in the Config tab instead)`);
      continue;
    }
    const set = {};
    for (const [key, value] of Object.entries(def.find || {})) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        unsupported.push(`${file}: "${key}" is matched with a rule list, skipped`);
        continue;
      }
      set[key] = placeholders(String(value));
    }
    if (Object.keys(set).length) patchProperties.push({ path: file, format: parser === 'json' ? 'json' : 'properties', createIfMissing: true, set });
  }

  // Ready line, stop.
  const logPatterns = {};
  let done = egg.config?.startup;
  try {
    if (typeof done === 'string') done = JSON.parse(done || '{}');
  } catch {
    done = null;
  }
  const doneLine = Array.isArray(done?.done) ? done.done[0] : done?.done;
  if (doneLine) {
    const m = /^\/(.*)\/[a-z]*$/.exec(String(doneLine));
    logPatterns.ready = m ? m[1] : String(doneLine).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  let stop = egg.config?.stop;
  const template = {};
  if (typeof stop === 'string' && stop) {
    const signal = { '^C': 'SIGINT', '^X': 'SIGTERM', SIGINT: 'SIGINT', SIGTERM: 'SIGTERM', SIGKILL: 'SIGKILL', SIGHUP: 'SIGHUP', SIGQUIT: 'SIGQUIT' }[stop.trim().replace(/^\^?c$/i, '^C')];
    if (signal) template.stopSignal = signal;
    else template.stopCommand = stop.trim();
  }

  // What cannot come across.
  if (Array.isArray(egg.features) && egg.features.length) unsupported.push(`Egg features (${egg.features.join(', ')}) are Pterodactyl panel behaviours with no equivalent here`);
  if (Array.isArray(egg.file_denylist) && egg.file_denylist.length) unsupported.push('The egg\'s file denylist is not enforced');
  if (egg.config?.logs && egg.config.logs !== '{}' && egg.config.logs !== '') notes.push('Custom log files from the egg are ignored; the console shows the process output');
  if (!egg.startup) unsupported.push('No startup command');
  notes.push('Ports: eggs get one allocated port; this template has a "game" port (default 25565, TCP and UDP). Add other ports in the builder if the game needs them');

  const id = `egg-${String(egg.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}`;
  Object.assign(template, {
    id,
    name: String(egg.name).slice(0, 80),
    category: 'Imported',
    icon: '🥚',
    description: String(egg.description || `Imported Pterodactyl egg${egg.author ? ` by ${egg.author}` : ''}.`).slice(0, 500),
    imported: true,
    adminOnly: true,
    importedFrom: { type: 'pterodactyl-egg', author: egg.author || null, at: Date.now() },
    platforms: ['linux'],
    defaultMemory: 2048,
    variables,
    ports: [{ name: 'game', default: 25565, protocol: 'both' }],
    install,
    startCommand,
    logPatterns,
    stopTimeout: 30,
  });
  if (image) template.image = image;
  if (patchProperties.length) template.patchProperties = patchProperties;
  if (!logPatterns.ready) delete template.logPatterns;
  if (!template.stopSignal && !template.stopCommand) template.stopSignal = 'SIGTERM';
  return { template, notes: [...new Set(notes)], unsupported: [...new Set(unsupported)] };
}

const privateAddress = (ip) =>
  net.isIPv4(ip)
    ? /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)
    : /^(::1?$|f[cd]|fe[89ab])/i.test(ip) || /^::ffff:/i.test(ip);

/** Fetch an egg from an https URL (GitHub page links are turned into raw links). Admin-only, no private addresses. */
async function fetchEgg(input, hops = 0) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    fail(400, 'That is not a web address');
  }
  if (url.protocol !== 'https:') fail(400, 'Only https:// addresses are accepted');
  if (url.hostname === 'github.com') {
    const m = /^\/([^/]+\/[^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (m) url = new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}`);
  }
  const lookups = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!lookups.length) fail(400, `Could not find ${url.hostname}`);
  if (lookups.some((l) => privateAddress(l.address))) fail(400, 'That address points inside your network');
  const target = lookups[0].address;
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: target, servername: url.hostname, path: url.pathname + url.search, headers: { host: url.hostname, 'user-agent': 'GamePanel', accept: 'application/json' }, timeout: 15000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops >= 3) return reject(new HttpError(400, 'Too many redirects'));
          return fetchEgg(new URL(res.headers.location, url).toString(), hops + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new HttpError(400, `The address answered ${res.statusCode}`));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 1024 * 1024) {
            req.destroy();
            reject(new HttpError(400, 'That file is bigger than 1 MB, so it is not an egg'));
          } else chunks.push(c);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new HttpError(400, 'That address did not return JSON'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('The address took too long to answer')));
    req.on('error', (err) => reject(err.code === 400 ? err : new HttpError(400, err.message)));
  });
}

module.exports = { convert, fetchEgg };
