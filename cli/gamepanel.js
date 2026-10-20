#!/usr/bin/env node
'use strict';

/**
 * gamepanel: command-line client for a GamePanel install (this machine or a remote one).
 * Zero dependencies; talks to the HTTP API with an API key (Account page -> API keys).
 *
 *   gamepanel login [--url http://host:8420]   save the panel address and key
 *   gamepanel help
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');
const { spawnSync } = require('child_process');

const DEFAULT_URL = 'http://127.0.0.1:8420';

const configPath = () => {
  if (process.env.GP_CLI_CONFIG) return process.env.GP_CLI_CONFIG;
  const base = process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'gamepanel', 'cli.json');
};

const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
};

/** The saved key is a credential: the file is created readable by this account only. */
const writeConfig = (cfg) => {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {
    /* Windows has no chmod: ACLs below. */
  }
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    if (user) spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
  }
};

/* ------------------------------------------------------------ arguments -- */

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') {
    positional.push(...argv.slice(i + 1));
    break;
  }
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (v !== undefined) flags[k] = v;
    else if (['url', 'n', 'lines'].includes(k)) flags[k] = argv[++i];
    else flags[k] = true;
  } else if (a === '-f') flags.follow = true;
  else if (a === '-y') flags.yes = true;
  else if (a === '-n') flags.n = argv[++i];
  else if (a === '-h') flags.help = true;
  else positional.push(a);
}

/* ------------------------------------------------------------------ http -- */

const die = (msg, code = 1) => {
  process.stderr.write(`gamepanel: ${msg}\n`);
  process.exit(code);
};

const settings = () => {
  const cfg = readConfig();
  const url = String(flags.url || process.env.GP_URL || cfg.url || DEFAULT_URL).replace(/\/+$/, '');
  const key = process.env.GP_API_KEY || cfg.key || '';
  return { url, key };
};

const request = (method, apiPath, body, opts = {}) =>
  new Promise((resolve, reject) => {
    const { url, key } = opts.anon ? { url: settings().url, key: '' } : settings();
    if (!key && !opts.anon) return reject(new Error('No API key saved. Run "gamepanel login" (create a key on the panel\'s Account page).'));
    const target = new URL(url + apiPath);
    const lib = target.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = lib.request(
      target,
      {
        method,
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          'User-Agent': 'gamepanel-cli',
        },
        timeout: opts.timeout || 60000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = { raw: text };
          }
          if (res.statusCode >= 400) {
            const err = new Error(data?.error || data?.message || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.data = data;
            return reject(err);
          }
          resolve(data);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('The panel did not answer in time')));
    req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? `Cannot reach the panel at ${url}` : e.message)));
    if (payload) req.write(payload);
    req.end();
  });

/* --------------------------------------------------------------- prompts -- */

const ask = (question, { hidden = false } = {}) =>
  new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Piped input: read one line.
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', (l) => {
        resolve(l.trim());
        rl.close();
      });
      rl.once('close', () => resolve(''));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) process.stderr.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stderr.write('\n');
      resolve(answer.trim());
    });
  });

const confirm = async (what) => {
  if (flags.yes) return true;
  if (!process.stdin.isTTY) die(`${what} needs confirmation: run it in a terminal or pass --yes`);
  return /^y(es)?$/i.test(await ask(`${what} [y/N] `));
};

/* --------------------------------------------------------------- helpers -- */

const table = (rows, cols) => {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (r) => cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(Object.fromEntries(cols.map((c) => [c, c.toUpperCase()]))));
  for (const r of rows) console.log(line(r));
};

const listServers = async () => (await request('GET', '/api/servers')).servers || [];

/** A server by id, exact name, or unique name prefix. */
const resolveServer = async (ref) => {
  if (!ref) die('Name a server (see "gamepanel list").');
  const servers = await listServers();
  const q = ref.toLowerCase();
  const exact = servers.find((s) => s.id === ref || String(s.name).toLowerCase() === q);
  if (exact) return exact;
  const partial = servers.filter((s) => s.id.startsWith(ref) || String(s.name).toLowerCase().startsWith(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) die(`"${ref}" matches more than one server: ${partial.map((s) => s.name).join(', ')}`);
  return die(`No server called "${ref}".`);
};

const printLines = (lines) => {
  for (const l of lines) process.stdout.write(`${l.line}\n`);
};

/* -------------------------------------------------------------- commands -- */

const commands = {
  async login() {
    const url = String(flags.url || (await ask(`Panel address [${settings().url}]: `)) || settings().url).replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) die('The address must start with http:// or https://');
    const key = process.env.GP_API_KEY || (await ask('API key (Account page -> API keys): ', { hidden: true }));
    if (!key) die('No key given.');
    writeConfig({ url, key });
    try {
      const servers = await listServers();
      console.log(`Saved to ${configPath()}. Signed in; ${servers.length} server${servers.length === 1 ? '' : 's'} visible.`);
    } catch (err) {
      console.log(`Saved to ${configPath()}, but the test call failed: ${err.message}`);
      process.exitCode = 1;
    }
  },

  logout() {
    try {
      fs.unlinkSync(configPath());
      console.log('Saved key removed.');
    } catch {
      console.log('Nothing saved.');
    }
  },

  async status() {
    const s = await request('GET', '/api/status', undefined, { anon: true });
    const servers = await listServers();
    const running = servers.filter((x) => x.status === 'running').length;
    console.log(`${s.panelName || 'GamePanel'} ${s.version} at ${settings().url}`);
    console.log(`${running} of ${servers.length} servers running`);
  },

  async list() {
    const servers = await listServers();
    if (flags.json) return console.log(JSON.stringify(servers, null, 2));
    if (!servers.length) return console.log('No servers.');
    table(
      servers.map((s) => ({ id: s.id, name: s.name, game: s.templateName || s.templateId || '', status: s.status })),
      ['id', 'name', 'game', 'status']
    );
  },

  async power(action, ref) {
    const server = await resolveServer(ref);
    if (action === 'kill' && !(await confirm(`Force-kill ${server.name}? Unsaved progress is lost.`))) return;
    await request('POST', `/api/servers/${server.id}/power`, { action });
    console.log(`${server.name}: ${action} sent`);
  },

  async command(ref, ...words) {
    const server = await resolveServer(ref);
    const command = words.join(' ');
    if (!command) die('Usage: gamepanel command <server> <console command...>');
    const r = await request('POST', `/api/servers/${server.id}/command`, { command });
    if (r?.response) console.log(r.response);
  },

  async console(ref) {
    const server = await resolveServer(ref);
    const fetchLines = async () => (await request('GET', `/api/servers/${server.id}/console`)).lines || [];
    const all = await fetchLines();
    const n = Number(flags.n ?? flags.lines ?? 50);
    printLines(n > 0 ? all.slice(-n) : []);
    if (!flags.follow) return;
    let seq = all.length ? all[all.length - 1].seq : 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      let lines;
      try {
        lines = await fetchLines();
      } catch {
        continue;
      }
      const fresh = lines.filter((l) => l.seq > seq);
      if (fresh.length) {
        printLines(fresh);
        seq = fresh[fresh.length - 1].seq;
      }
    }
  },

  async backup(ref, ...label) {
    const server = await resolveServer(ref);
    const r = await request('POST', `/api/servers/${server.id}/backups`, { label: label.join(' ') }, { timeout: 30 * 60 * 1000 });
    console.log(`Backup created for ${server.name}: ${r.backup?.name || 'ok'}`);
  },

  async backups(ref) {
    const server = await resolveServer(ref);
    const { backups } = await request('GET', `/api/servers/${server.id}/backups`);
    if (!backups.length) return console.log('No backups.');
    table(
      backups.map((b) => ({ name: b.name, size: b.size != null ? `${(b.size / 1048576).toFixed(1)} MB` : '', created: b.createdAt ? new Date(b.createdAt).toLocaleString() : '' })),
      ['name', 'size', 'created']
    );
  },

  /** Game files (SteamCMD games), mods, or the panel itself. */
  async update(what, ref) {
    if (what === 'panel') {
      const check = await request('GET', '/api/system/update');
      if (!check.updateAvailable) return console.log(`Panel is up to date${check.version ? ` (${check.version})` : ''}.`);
      if (!(await confirm('Update the panel now? It restarts; game servers in containers keep running.'))) return;
      const r = await request('POST', '/api/system/update', {}, { timeout: 10 * 60 * 1000 });
      return console.log(`Panel updated ${r.from} -> ${r.to}; restarting.`);
    }
    const server = await resolveServer(ref);
    if (what === 'game') {
      await request('POST', `/api/servers/${server.id}/update`, {});
      return console.log(`${server.name}: game update started (watch it with "gamepanel console ${server.name} -f")`);
    }
    if (what === 'mods') {
      const r = await request('POST', `/api/servers/${server.id}/mods/update`, { all: true }, { timeout: 10 * 60 * 1000 });
      return console.log(`${server.name}: mods updated${r.restartNeeded ? ' (restart needed)' : ''}`);
    }
    return die('Usage: gamepanel update <game|mods> <server>   or   gamepanel update panel');
  },
};

const HELP = `gamepanel: control a GamePanel install from the command line

  login [--url URL]            save the panel address and an API key
  logout                       forget the saved key
  status                       panel version and how many servers are running
  list [--json]                servers and their state
  start|stop|restart <server>  power actions
  kill <server> [-y]           force-kill (asks first)
  command <server> <cmd...>    send a console command
  console <server> [-n 50] [-f]  recent console output; -f keeps following
  backup <server> [label]      make a backup now
  backups <server>             list backups
  update game|mods <server>    update game files / all mods
  update panel [-y]            update the panel itself (asks first)

<server> is an id, a name, or a unique start of a name.
Use --url or GP_URL to point at a remote panel, GP_API_KEY to pass a key without saving it.
Restores, deletes and wipes are not in the CLI; do those from the panel.
Key file: ${configPath()}`;

const main = async () => {
  const [cmd, ...rest] = positional;
  if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);
  switch (cmd) {
    case 'login':
    case 'logout':
    case 'status':
    case 'list':
    case 'ls':
    case 'command':
    case 'console':
    case 'backup':
    case 'backups':
    case 'update':
      return commands[cmd === 'ls' ? 'list' : cmd](...rest);
    case 'start':
    case 'stop':
    case 'restart':
    case 'kill':
      return commands.power(cmd, rest[0]);
    default:
      return die(`Unknown command "${cmd}". Try "gamepanel help".`);
  }
};

main().catch((err) => {
  if (err.status === 401) die('The panel rejected the API key. Run "gamepanel login" again.');
  if (err.status === 403) die(`Not allowed: ${err.message}`);
  die(err.message);
});
