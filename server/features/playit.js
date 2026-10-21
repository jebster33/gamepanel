'use strict';

/**
 * playit.gg tunnels: servers that work without port forwarding.
 *
 * playit.gg gives each tunnel a public address and a small program (the
 * agent) running on this machine carries the traffic. The panel downloads the
 * agent from the official GitHub releases, runs it as a child process, shows
 * the claim link the first time (you approve this machine on playit.gg), keeps
 * the agent's secret sealed in its settings and lists the public address of
 * each server port. Tunnels themselves are created on playit.gg.
 *
 * Written against the agent's documented command line and API; it has not
 * been exercised against the live service in tests.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { config } = require('../core/config');
const { fail, logger, redactSecrets } = require('../core/util');
const { isWindows, killTree } = require('../core/platform');
const secrets = require('../core/secrets');
const network = require('./network');

const RELEASES_API = 'https://api.github.com/repos/playit-cloud/playit-agent/releases/latest';
const DOWNLOAD_PREFIX = 'https://github.com/playit-cloud/playit-agent/releases/download/';
const API = 'https://api.playit.gg/agents/rundata';
const TOOLS = path.join(config.toolsDir, 'playit');
const SECRET_FILE = path.join(config.runDir, 'playit-secret.toml');
const MIN_BYTES = 1024 * 1024;
const MAX_BYTES = 120 * 1024 * 1024;
const UA = { 'User-Agent': 'GamePanel (https://github.com/jebster33/gamepanel)' };

// Arguments to try in order: the agent's command line changed between releases.
const VARIANTS = [
  (file) => ['--stdout', '--secret_path', file, 'start'],
  (file) => ['--stdout', '--secret_path', file],
  (file) => ['--secret_path', file],
];

const rt = { child: null, status: 'stopped', claim: null, logs: [], seen: new Set(), error: null, startedAt: null, stopping: false, poll: null, tunnels: { at: 0, list: [], error: null } };

/* --------------------------------------------------------- pure helpers -- */

const ASSETS = {
  'linux:x64': ['playit-linux-amd64'],
  'linux:arm64': ['playit-linux-aarch64'],
  'linux:arm': ['playit-linux-armv7'],
  'win32:x64': ['playit-windows-x86_64-signed.exe', 'playit-windows-x86_64.exe'],
  'win32:ia32': ['playit-windows-x86-signed.exe', 'playit-windows-x86.exe'],
  'win32:arm64': ['playit-windows-x86_64-signed.exe'],
  'darwin:x64': ['playit-darwin-intel'],
  'darwin:arm64': ['playit-darwin-aarch64'],
};

/** The release asset for an OS and CPU, or null. Exact names first, then a close match. */
function pickAsset(release, platform = process.platform, arch = process.arch) {
  const assets = (release?.assets || []).filter((a) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string');
  const wanted = ASSETS[`${platform}:${arch}`] || [];
  for (const name of wanted) {
    const hit = assets.find((a) => a.name === name);
    if (hit) return hit;
  }
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = { x64: ['amd64', 'x86_64'], arm64: ['aarch64', 'arm64'], arm: ['armv7'], ia32: ['x86'] }[arch] || [arch];
  return (
    assets.find((a) => {
      const n = a.name.toLowerCase();
      return n.startsWith('playit') && n.includes(os) && cpu.some((c) => n.includes(c)) && !/\.(msi|deb|rpm|sha256|sig|txt|zip|tar|gz)$/.test(n);
    }) || null
  );
}

/** Magic bytes of an executable for this OS: ELF, PE or Mach-O. */
function looksExecutable(buf) {
  if (buf.length < 4) return false;
  const head = buf.subarray(0, 4).toString('hex');
  return head === '7f454c46' || buf.subarray(0, 2).toString('latin1') === 'MZ' || ['cffaedfe', 'cafebabe', 'feedfacf', 'feedface'].includes(head);
}

/** Check a download against what GitHub says about it. Throws a plain message when it does not fit. */
function verifyDownload(buf, asset) {
  if (buf.length < MIN_BYTES || buf.length > MAX_BYTES) throw new Error(`The download is ${buf.length} bytes, which is not the size of the agent`);
  if (Number(asset.size) > 0 && buf.length !== Number(asset.size)) throw new Error(`The download is ${buf.length} bytes but GitHub lists ${asset.size}`);
  if (!looksExecutable(buf)) throw new Error('The download is not a program for this system');
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
  if (m) {
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== m[1].toLowerCase()) throw new Error('The download does not match the checksum GitHub lists. It was not installed.');
    return { checksum: 'verified' };
  }
  return { checksum: 'GitHub listed no checksum: checked size and file type only' };
}

const CLAIM = /https:\/\/playit\.gg\/claim\/([A-Za-z0-9_-]{4,64})/;
function parseClaim(line) {
  const m = CLAIM.exec(String(line));
  return m ? { url: m[0], code: m[1] } : null;
}

const ADDRESS = /\b((?:[a-z0-9-]+\.)+(?:joinmc\.link|ply\.gg|playit\.plus|gl\.joinmc\.link)(?::\d{2,5})?)/gi;
function parseAddresses(line) {
  return [...String(line).matchAll(ADDRESS)].map((m) => m[1].toLowerCase());
}

/** The secret out of the agent's file: `secret_key = "..."` or the bare secret. */
function readSecretText(text) {
  const t = String(text || '').trim();
  const m = /^\s*secret(?:_key)?\s*=\s*["']([^"'\s]+)["']/m.exec(t);
  const v = m ? m[1] : /^[A-Za-z0-9_-]{16,200}$/.test(t) ? t : '';
  return v;
}

/** Tunnels out of the agent API's answer: { name, address, localPort, protocol, pending }. */
function parseRundata(body) {
  const list = body?.data?.tunnels || body?.tunnels || [];
  if (!Array.isArray(list)) return [];
  return list.slice(0, 200).map((t) => {
    const alloc = t?.alloc?.data || t?.alloc || {};
    const origin = t?.origin?.data || t?.origin || {};
    let host = String(alloc.assigned_domain || alloc.assigned_srv || alloc.ip_hostname || alloc.tunnel_ip || '');
    if (!/^[A-Za-z0-9.:-]{1,253}$/.test(host)) host = '';
    const port = Number(alloc.port_start ?? alloc.port ?? 0) || null;
    return {
      name: String(t?.name || t?.id || '').slice(0, 80),
      protocol: String(t?.port_type || t?.protocol || '').toLowerCase().slice(0, 8),
      address: host ? (port && !/:\d+$/.test(host) ? `${host}:${port}` : host) : '',
      localPort: Number(origin.local_port ?? t?.local_port ?? 0) || null,
      pending: Boolean(t?.alloc?.status && t.alloc.status !== 'allocated') || !host,
    };
  });
}

/** Which tunnel address belongs to each port of each server. */
function mapToServers(servers, tunnels, portsOf) {
  return servers.map((s) => ({
    id: s.id,
    name: s.name,
    ports: portsOf(s).map((p) => {
      const t = tunnels.filter((x) => x.localPort === p.port && (!x.protocol || x.protocol === 'both' || x.protocol === p.protocol));
      return { name: p.name, port: p.port, protocol: p.protocol, addresses: [...new Set(t.map((x) => x.address).filter(Boolean))] };
    }),
  }));
}

/* ----------------------------------------------------------- the binary -- */

const settingsOf = (store) => (store.state.settings.playit ||= { secret: '', autoStart: false, version: '', binary: '' });

function binaryPath(store) {
  const name = settingsOf(store).binary;
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const file = path.join(TOOLS, name);
  return fs.existsSync(file) ? file : null;
}

async function downloadBuffer(url) {
  if (!url.startsWith(DOWNLOAD_PREFIX)) throw new Error('GitHub gave an unexpected download address');
  const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error('The download is larger than the agent should be');
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new Error('The download is larger than the agent should be');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Download the agent for this OS and CPU from the official releases. */
async function install(store) {
  if (rt.child) fail(409, 'Stop the agent before updating it');
  let release;
  try {
    const res = await fetch(RELEASES_API, { headers: { ...UA, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    release = await res.json();
  } catch (err) {
    fail(502, `Could not look up the latest playit agent: ${err.message}`);
  }
  const asset = pickAsset(release);
  if (!asset) fail(400, `There is no playit agent build for ${process.platform} on ${process.arch} in the latest release (${release?.tag_name || 'unknown'}). Install it by hand from https://playit.gg/download.`);
  let buf;
  let verdict;
  try {
    buf = await downloadBuffer(asset.browser_download_url);
    verdict = verifyDownload(buf, asset);
  } catch (err) {
    fail(502, err.message);
  }
  fs.mkdirSync(TOOLS, { recursive: true });
  const name = path.basename(asset.name).replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(TOOLS, name);
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, buf, { mode: 0o755 });
  fs.renameSync(tmp, file);
  if (!isWindows) fs.chmodSync(file, 0o755);
  const cs = settingsOf(store);
  cs.binary = name;
  cs.version = String(release.tag_name || '').slice(0, 40);
  store.save();
  store.addEvent('playit.installed', `playit agent ${cs.version} installed`);
  return { version: cs.version, binary: name, ...verdict };
}

/* ----------------------------------------------------------- the process -- */

function log(line, secret) {
  const text = redactSecrets(String(line).replace(/\x1b\[[0-9;]*m/g, '').trim(), { TOKEN: secret || '' }).slice(0, 500); // eslint-disable-line no-control-regex
  if (!text) return;
  rt.logs.push(text);
  if (rt.logs.length > 200) rt.logs.shift();
  const claim = parseClaim(text);
  if (claim) {
    rt.claim = claim;
    rt.status = 'claiming';
  }
  for (const a of parseAddresses(text)) rt.seen.add(a);
}

function cleanup() {
  clearInterval(rt.poll);
  rt.poll = null;
  try {
    fs.rmSync(SECRET_FILE, { force: true });
  } catch {
    /* gone already */
  }
}

function spawnVariant(store, index) {
  const cs = settingsOf(store);
  const bin = binaryPath(store);
  const secret = cs.secret ? secrets.open(cs.secret) : '';
  fs.mkdirSync(config.runDir, { recursive: true });
  fs.mkdirSync(TOOLS, { recursive: true });
  cleanup();
  if (secret) fs.writeFileSync(SECRET_FILE, `secret_key = "${secret}"\n`, { mode: 0o600 });
  const child = spawn(bin, VARIANTS[index](SECRET_FILE), { cwd: TOOLS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME || TOOLS, USERPROFILE: process.env.USERPROFILE, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, RUST_LOG: 'info' } });
  rt.child = child;
  rt.startedAt = Date.now();
  rt.status = 'running';
  let output = '';
  const onData = (buf) => {
    const text = buf.toString('utf8');
    output += text;
    for (const line of text.split(/\r?\n/)) log(line, secret);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  // The secret appears in the file once the claim is approved: seal it for next time.
  rt.poll = setInterval(() => {
    try {
      const found = readSecretText(fs.readFileSync(SECRET_FILE, 'utf8'));
      if (found && !settingsOf(store).secret) {
        settingsOf(store).secret = secrets.seal(found);
        store.save();
        rt.claim = null;
        rt.status = 'running';
        store.addEvent('playit.claimed', 'playit agent was approved on playit.gg');
      } else if (found && rt.claim) {
        rt.claim = null;
        rt.status = 'running';
      }
    } catch {
      /* not written yet */
    }
  }, 2000);
  rt.poll.unref?.();
  child.on('error', (err) => {
    rt.error = err.message;
  });
  child.on('exit', (code) => {
    const early = Date.now() - rt.startedAt < 8000;
    rt.child = null;
    cleanup();
    if (!rt.stopping && early && code !== 0 && index < VARIANTS.length - 1 && /unexpected argument|unrecognized|invalid (option|value)|usage:/i.test(output)) {
      log(`The agent did not accept those options (${code}); trying another form`);
      spawnVariant(store, index + 1);
      return;
    }
    rt.status = rt.stopping || code === 0 ? 'stopped' : 'error';
    rt.error = rt.stopping || code === 0 ? null : `The agent stopped (exit ${code}). ${rt.logs.slice(-2).join(' ')}`.trim();
    rt.claim = null;
    rt.stopping = false;
  });
}

function start(store) {
  if (rt.child) return;
  if (!binaryPath(store)) fail(400, 'Install the playit agent first');
  rt.error = null;
  rt.claim = null;
  rt.stopping = false;
  rt.logs = [];
  rt.seen = new Set();
  rt.tunnels = { at: 0, list: [], error: null };
  spawnVariant(store, 0);
}

function stop() {
  const child = rt.child;
  if (!child) {
    cleanup();
    rt.status = 'stopped';
    return;
  }
  rt.stopping = true;
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (rt.child === child) {
      try {
        killTree?.(child.pid);
      } catch {
        child.kill('SIGKILL');
      }
    }
  }, 5000).unref?.();
}

/** Forget this machine's playit account link (the tunnels stay on playit.gg). */
function reset(store) {
  stop();
  settingsOf(store).secret = '';
  store.save();
  rt.claim = null;
  rt.tunnels = { at: 0, list: [], error: null };
}

/* ------------------------------------------------------------- tunnels -- */

async function refreshTunnels(store) {
  const cs = settingsOf(store);
  if (!cs.secret || !rt.child) return;
  if (Date.now() - rt.tunnels.at < 20_000) return;
  rt.tunnels.at = Date.now();
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { ...UA, 'Content-Type': 'application/json', Authorization: `Agent-Key ${secrets.open(cs.secret)}` },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`playit.gg answered ${res.status}`);
    rt.tunnels.list = parseRundata(await res.json());
    rt.tunnels.error = null;
  } catch (err) {
    rt.tunnels.error = err.message;
  }
}

async function status(store, manager) {
  const cs = settingsOf(store);
  await refreshTunnels(store);
  const servers = mapToServers(manager.servers, rt.tunnels.list, (s) => network.serverPorts(s, manager.template(s)));
  return {
    installed: Boolean(binaryPath(store)),
    version: cs.version || null,
    platformSupported: Boolean(ASSETS[`${process.platform}:${process.arch}`]),
    running: Boolean(rt.child),
    status: rt.status,
    claim: rt.claim,
    claimed: Boolean(cs.secret),
    autoStart: Boolean(cs.autoStart),
    error: rt.error,
    startedAt: rt.startedAt,
    tunnels: rt.tunnels.list,
    tunnelError: rt.tunnels.error,
    seenAddresses: [...rt.seen].slice(0, 20),
    servers,
    logs: rt.logs.slice(-60),
    dashboard: 'https://playit.gg/account/tunnels',
  };
}

function setAutoStart(store, on) {
  settingsOf(store).autoStart = Boolean(on);
  store.save();
}

/** Boot hook: start the agent with the panel when it was set to. */
function boot(store) {
  const cs = settingsOf(store);
  if (cs.autoStart && cs.secret && binaryPath(store)) {
    try {
      start(store);
    } catch (err) {
      logger.warn(`playit agent did not start: ${err.message}`);
    }
  }
}

module.exports = { pickAsset, verifyDownload, looksExecutable, parseClaim, parseAddresses, parseRundata, readSecretText, mapToServers, install, start, stop, reset, status, setAutoStart, boot, ASSETS };
