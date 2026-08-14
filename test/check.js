'use strict';

/**
 * GamePanel self-check.
 *
 *   node test/check.js           static checks only (fast, offline)
 *   node test/check.js --live    also contacts every upstream the templates use
 *
 * Validates every template's schema, generates its install script and parses it
 * with bash, checks ports/variables/regexes line up, and (with --live) resolves
 * real download URLs and confirms the container images exist.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LIVE = process.argv.includes('--live');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];

const results = { pass: 0, warn: 0, fail: 0 };
const failures = [];
const warnings = [];

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function pass(what) {
  results.pass++;
  if (process.env.VERBOSE) console.log('   ', c.green('ok'), what);
}
function fail(what, detail) {
  results.fail++;
  failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
  console.log('   ', c.red('FAIL'), what, detail ? c.dim(detail) : '');
}
function warn(what, detail) {
  results.warn++;
  warnings.push(`${what}${detail ? ` — ${detail}` : ''}`);
  console.log('   ', c.yellow('warn'), what, detail ? c.dim(detail) : '');
}

/* ------------------------------------------------------------- utilities -- */

function head(url, timeoutMs = 15000) {
  return fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'GamePanel/1.0 selfcheck', Range: 'bytes=0-0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
    .then((r) => r.status)
    .catch((e) => `error: ${e.message}`);
}

function dockerImageExists(image) {
  const [name, tag = 'latest'] = image.split(':');
  const repo = name.includes('/') ? name : `library/${name}`;
  return fetch(`https://hub.docker.com/v2/repositories/${repo}/tags/${encodeURIComponent(tag)}`, {
    signal: AbortSignal.timeout(15000),
  })
    .then((r) => r.ok)
    .catch(() => false);
}

/** Drop blank values so sensible defaults can take over. */
function stripEmpty(vars) {
  return Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== '' && v !== undefined && v !== null));
}

function bashParses(script) {
  const tmp = path.join(require('os').tmpdir(), `gp-check-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(tmp, script);
  try {
    execFileSync('bash', ['-n', tmp], { stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message).trim().split('\n')[0] };
  } finally {
    fs.unlinkSync(tmp);
  }
}

/* --------------------------------------------------------------- checks -- */

const { buildInstallScript } = require(path.join(ROOT, 'server/lib/installer'));
const { RESOLVERS } = require(path.join(ROOT, 'server/lib/resolvers'));
const { SOURCES } = require(path.join(ROOT, 'server/lib/options'));
const { QUERY_TYPES } = require(path.join(ROOT, 'server/lib/query'));
const { PROVIDERS: MOD_PROVIDERS } = require(path.join(ROOT, 'server/lib/mods'));

const VALID_STEP_TYPES = ['apt', 'java', 'steamcmd', 'download', 'extract', 'writefile', 'mkdir', 'chmod', 'script'];

/** Every {{VAR}} a template references. */
function placeholdersIn(value) {
  const found = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      for (const m of node.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) found.add(m[1]);
    } else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(value);
  return found;
}

/** Variables the panel provides without the template declaring them. */
const BUILTIN_VARS = new Set([
  'SERVER_ID',
  'SERVER_NAME',
  'SERVER_DIR',
  'MEMORY',
  'MEMORY_MB',
  'CPU_LIMIT',
  'IP',
  'PORT',
  'MAX_PLAYERS',
  'JAVA_VERSION',
  // Supplied by resolvers
  'DOWNLOAD_URL',
  'RESOLVED_VERSION',
  'RESOLVED_BUILD',
  'MRPACK_FILE',
  'PACK_NAME',
  'PACK_SLUG',
  'PACK_URL',
  'PACK_VERSION_URL',
  'PACK_VERSION_NUMBER',
  'PACK_CLIENT_REQUIRED',
  'PACK_ICON',
  'PACK_MC_VERSION',
  'PACK_LOADER',
  'PACK_FILE_COUNT',
  'PACK_SKIPPED',
  'PACK_DOWNLOADS',
  'LOADER_INSTALL',
  'START_SCRIPT',
]);

async function checkTemplate(file) {
  const id = file.replace(/\.json$/, '');
  let tpl;
  try {
    tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', file), 'utf8'));
  } catch (err) {
    fail(`${id}: JSON`, err.message);
    return;
  }

  console.log(c.bold(`\n▸ ${tpl.name || id}`));

  /* --- required fields --- */
  for (const key of ['id', 'name', 'startCommand']) {
    if (!tpl[key]) fail(`${id}: missing "${key}"`);
  }
  if (tpl.id !== id) fail(`${id}: id "${tpl.id}" does not match the filename`);
  if (!tpl.description) warn(`${id}: no description`);
  if (!tpl.category) warn(`${id}: no category`);
  else pass(`${id}: schema`);

  /* --- ports --- */
  const portNames = new Set();
  for (const port of tpl.ports || []) {
    if (!port.name) fail(`${id}: a port has no name`);
    if (portNames.has(port.name)) fail(`${id}: duplicate port name "${port.name}"`);
    portNames.add(port.name);
    if (!Number.isInteger(port.default) || port.default < 1 || port.default > 65535) {
      fail(`${id}: port ${port.name} has an invalid default (${port.default})`);
    }
    if (port.protocol && !['tcp', 'udp', 'both'].includes(port.protocol)) {
      fail(`${id}: port ${port.name} has protocol "${port.protocol}"`);
    }
  }
  if (portNames.size) pass(`${id}: ports`);

  /* --- variables --- */
  const varNames = new Set((tpl.variables || []).map((v) => v.name));
  for (const v of tpl.variables || []) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(v.name)) fail(`${id}: variable "${v.name}" is not UPPER_SNAKE_CASE`);
    if (!v.label) warn(`${id}: variable ${v.name} has no label`);
    if (v.source && !SOURCES.includes(v.source)) fail(`${id}: variable ${v.name} uses unknown source "${v.source}"`);
    if (v.dependsOn && !varNames.has(v.dependsOn)) fail(`${id}: ${v.name} depends on unknown variable ${v.dependsOn}`);
    if (v.options) {
      const values = v.options.map((o) => String(typeof o === 'object' ? o.value : o));
      if (v.default !== undefined && v.default !== '' && !values.includes(String(v.default)) && !v.allowCustom) {
        fail(`${id}: ${v.name} default "${v.default}" is not one of its options`);
      }
    }
    if (v.default === undefined && !v.generate) warn(`${id}: variable ${v.name} has no default`);
  }

  /* --- placeholders resolve --- */
  const used = placeholdersIn({
    start: tpl.startCommand,
    install: tpl.install,
    config: tpl.configFiles,
    patch: tpl.patchProperties,
    image: tpl.image,
    sidecars: tpl.sidecars,
  });
  for (const name of used) {
    const isPort = name.startsWith('PORT_') && portNames.has(name.slice(5).toLowerCase());
    if (!varNames.has(name) && !BUILTIN_VARS.has(name) && !isPort) {
      fail(`${id}: uses {{${name}}} but nothing defines it`);
    }
  }
  pass(`${id}: placeholders`);

  /* --- install steps --- */
  for (const step of tpl.install || []) {
    if (!VALID_STEP_TYPES.includes(String(step.type).toLowerCase())) {
      fail(`${id}: unknown install step type "${step.type}"`);
    }
    if (step.type === 'steamcmd' && !step.appid) fail(`${id}: a steamcmd step has no appid`);
  }

  /* --- query and rcon point at real ports --- */
  if (tpl.query && tpl.query.type !== 'none') {
    if (!QUERY_TYPES.includes(tpl.query.type)) fail(`${id}: unknown query type "${tpl.query.type}"`);
    if (tpl.query.port && !portNames.has(tpl.query.port)) {
      fail(`${id}: query uses port "${tpl.query.port}" which is not declared`);
    }
  }
  if (tpl.rcon?.port && !portNames.has(tpl.rcon.port)) {
    fail(`${id}: rcon uses port "${tpl.rcon.port}" which is not declared`);
  }

  /* --- log patterns compile --- */
  for (const [key, pattern] of Object.entries(tpl.logPatterns || {})) {
    try {
      new RegExp(pattern);
    } catch (err) {
      fail(`${id}: logPatterns.${key} is not a valid regex`, err.message);
    }
  }

  /* --- mods config --- */
  if (tpl.mods) {
    for (const provider of tpl.mods.providers || []) {
      if (!MOD_PROVIDERS[provider]) fail(`${id}: unknown mod provider "${provider}"`);
    }
    if (!tpl.mods.dir) fail(`${id}: mods block has no dir`);
    if (tpl.mods.providers?.includes('workshop') && !tpl.mods.appId) {
      fail(`${id}: workshop mods need an appId`);
    }
  }

  /* --- resolver --- */
  if (tpl.resolve && !RESOLVERS[tpl.resolve]) fail(`${id}: unknown resolver "${tpl.resolve}"`);

  /* --- the generated install script must be valid bash --- */
  const vars = {};
  for (const v of tpl.variables || []) vars[v.name] = v.default ?? 'x';
  for (const name of BUILTIN_VARS) vars[name] = name === 'PACK_DOWNLOADS' ? 'gp_log "files"' : 'x';
  vars.START_SCRIPT = '#!/usr/bin/env bash\nexec true\n';
  vars.LOADER_INSTALL = 'gp_log "loader"';
  for (const port of tpl.ports || []) vars[`PORT_${port.name.toUpperCase()}`] = String(port.default);
  vars.PORT = String((tpl.ports || [])[0]?.default || 25565);

  const { script } = buildInstallScript(tpl, '/srv/test', vars);
  const parsed = bashParses(script);
  if (parsed.ok) pass(`${id}: install script parses`);
  else fail(`${id}: install script is not valid bash`, parsed.error);

  // The start command is run through bash -lc, so it must parse too.
  const startParsed = bashParses(require(path.join(ROOT, 'server/lib/util')).interpolate(tpl.startCommand, vars));
  if (startParsed.ok) pass(`${id}: start command parses`);
  else fail(`${id}: start command is not valid bash`, startParsed.error);

  /* --- live checks --- */
  if (!LIVE) return;

  if (tpl.image && !tpl.image.includes('{{')) {
    const exists = await dockerImageExists(tpl.image);
    if (exists) pass(`${id}: image ${tpl.image} exists`);
    else fail(`${id}: container image ${tpl.image} not found on Docker Hub`);
  } else if (tpl.image) {
    // Parameterised image: check the versions we might substitute.
    for (const version of ['17', '21', '25']) {
      const image = tpl.image.replace('{{JAVA_VERSION}}', version);
      const exists = await dockerImageExists(image);
      if (exists) pass(`${id}: image ${image} exists`);
      else fail(`${id}: container image ${image} not found`);
    }
  }

  for (const sidecar of tpl.sidecars || []) {
    const exists = await dockerImageExists(sidecar.image);
    if (exists) pass(`${id}: sidecar image ${sidecar.image} exists`);
    else fail(`${id}: sidecar image ${sidecar.image} not found`);
  }

  if (tpl.resolve) {
    try {
      // Some resolvers need a choice the template deliberately leaves blank.
      const sample = { MODPACK: 'fabulously-optimized' };
      const extra = await RESOLVERS[tpl.resolve]({ ...sample, ...stripEmpty(vars) });
      const status = await head(extra.DOWNLOAD_URL);
      if (typeof status === 'number' && status < 400) {
        pass(`${id}: resolves ${extra.RESOLVED_VERSION} → HTTP ${status}`);
      } else {
        fail(`${id}: resolved download is not reachable`, `${status} ${extra.DOWNLOAD_URL}`);
      }
    } catch (err) {
      fail(`${id}: resolver failed`, err.message);
    }
  }

  // Any hard-coded URL in an install step should still exist.
  for (const url of new Set([...JSON.stringify(tpl.install || []).matchAll(/https?:\/\/[^"'\\\s)]+/g)].map((m) => m[0]))) {
    if (url.includes('{{')) continue;
    const status = await head(url);
    if (typeof status === 'number' && status < 400) pass(`${id}: ${url.slice(0, 60)} → ${status}`);
    else warn(`${id}: ${url.slice(0, 70)}`, String(status));
  }
}

/* ------------------------------------------------------- option sources -- */

async function checkOptionSources() {
  if (!LIVE) return;
  console.log(c.bold('\n▸ Option sources (dropdown data)'));
  const { getOptions } = require(path.join(ROOT, 'server/lib/options'));
  for (const source of SOURCES) {
    const query = source === 'modrinth-modpack-version' ? 'fabulously-optimized' : '';
    const data = await getOptions(source, query);
    if (data.error) fail(`${source}`, data.error);
    else if (!data.options.length) fail(`${source}: returned no options`);
    else pass(`${source}: ${data.options.length} options, recommended "${data.recommended}"`);
  }
}

/* -------------------------------------------------------- panel modules -- */

function checkModules() {
  console.log(c.bold('\n▸ Panel modules'));
  const dir = path.join(ROOT, 'server/lib');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    try {
      require(path.join(dir, file));
      pass(`server/lib/${file} loads`);
    } catch (err) {
      fail(`server/lib/${file} failed to load`, err.message);
    }
  }
  // index.js starts listening on import, so only check that it parses.
  for (const file of ['server/index.js', 'public/js/app.js']) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
      pass(`${file} parses`);
    } catch (err) {
      fail(`${file} has a syntax error`, String(err.stderr || err.message).split('\n')[0]);
    }
  }
  for (const script of ['install.sh', 'update.sh', 'uninstall.sh']) {
    const parsed = bashParses(fs.readFileSync(path.join(ROOT, script), 'utf8'));
    if (parsed.ok) pass(`${script} parses`);
    else fail(`${script} is not valid bash`, parsed.error);
  }
}

/* ------------------------------------------------------------------ run -- */

(async () => {
  console.log(c.bold(`GamePanel self-check${LIVE ? ' (live)' : ' (offline — pass --live for network checks)'}`));
  checkModules();

  const files = fs
    .readdirSync(path.join(ROOT, 'templates'))
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !ONLY || f.includes(ONLY));

  for (const file of files) await checkTemplate(file);
  await checkOptionSources();

  console.log(c.bold('\n─────────────────────────────────────'));
  console.log(`${c.green(results.pass + ' passed')}   ${c.yellow(results.warn + ' warnings')}   ${c.red(results.fail + ' failed')}`);
  if (failures.length) {
    console.log(c.red('\nFailures:'));
    failures.forEach((f) => console.log('  •', f));
  }
  process.exit(results.fail ? 1 : 0);
})();
