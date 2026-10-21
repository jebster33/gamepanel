'use strict';

/**
 * Tailscale and ZeroTier as a fallback next to the panel's bridge, plus the
 * connectivity wizard that recommends which way to let people in.
 *
 * Players install the same app (Tailscale or ZeroTier) and join the same
 * private network, then connect to this machine's private address. Every
 * program is run with execFile and arguments that were checked first; nothing
 * typed by a person ever reaches a shell.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { fail } = require('../core/util');
const { run, which, isWindows, isLinux } = require('../core/platform');
const secrets = require('../core/secrets');
const network = require('./network');

const settingsOf = (store) => (store.state.settings.vpn ||= { tailscaleKey: '', zerotierNetwork: '' });

const TS_KEY = /^tskey-[A-Za-z0-9-]{10,200}$/;
const ZT_ID = /^[0-9a-f]{16}$/i;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** What the install buttons run, shown to the person before they confirm. */
const INSTALL = {
  tailscale: { url: 'https://tailscale.com/install.sh', says: 'Downloads https://tailscale.com/install.sh (Tailscale\'s official installer) and runs it with sh as root. It adds Tailscale\'s package repository and installs the tailscale package.', manual: 'curl -fsSL https://tailscale.com/install.sh | sh', download: 'https://tailscale.com/download' },
  zerotier: { url: 'https://install.zerotier.com', says: 'Downloads https://install.zerotier.com (ZeroTier\'s official installer) and runs it with bash as root. It checks the download\'s signature when gpg is available and installs the zerotier-one package.', manual: 'curl -s https://install.zerotier.com | sudo bash', download: 'https://www.zerotier.com/download/' },
};

/* ------------------------------------------------------------- pure bits -- */

const stripMask = (a) => String(a).replace(/\/\d+$/, '');

/** Tailscale's `status --json` reduced to what the panel shows. */
function parseTailscale(json) {
  const self = json?.Self || {};
  const ips = (json?.TailscaleIPs || self.TailscaleIPs || []).filter((x) => typeof x === 'string');
  return {
    state: String(json?.BackendState || 'Unknown'),
    up: json?.BackendState === 'Running',
    ipv4: ips.find((i) => !i.includes(':')) || null,
    ipv6: ips.find((i) => i.includes(':')) || null,
    dnsName: String(self.DNSName || '').replace(/\.$/, '') || null,
    tailnet: String(json?.CurrentTailnet?.Name || '') || null,
    authUrl: typeof json?.AuthURL === 'string' && json.AuthURL.startsWith('https://') ? json.AuthURL : null,
  };
}

/** `zerotier-cli -j listnetworks` reduced to the networks and their addresses. */
function parseZeroTier(list) {
  return (Array.isArray(list) ? list : []).map((n) => ({
    id: String(n.nwid || n.id || ''),
    name: String(n.name || ''),
    status: String(n.status || ''),
    ok: n.status === 'OK',
    ips: (n.assignedAddresses || []).map(stripMask).filter((a) => !a.includes(':')),
  }));
}

/** Connect addresses for each server port over the private network(s). */
function connectAddresses(servers, portsOf, { tailscale, zerotier }) {
  const hosts = [];
  if (tailscale?.up) hosts.push({ via: 'Tailscale', host: tailscale.ipv4 }, ...(tailscale.dnsName ? [{ via: 'Tailscale name', host: tailscale.dnsName }] : []));
  for (const n of zerotier || []) if (n.ok) for (const ip of n.ips) hosts.push({ via: `ZeroTier ${n.id}`, host: ip });
  return servers.map((s) => ({
    id: s.id,
    name: s.name,
    ports: portsOf(s).filter((p) => p.name !== 'rcon').map((p) => ({ name: p.name, port: p.port, protocol: p.protocol, addresses: hosts.filter((h) => h.host).map((h) => ({ via: h.via, address: `${h.host}:${p.port}` })) })),
  }));
}

const isPrivateV4 = (ip) => /^(10\.|192\.168\.|127\.|169\.254\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);

/** True when the router's own outside address is not a real public one (the provider shares addresses). */
function isCgnat(routerWan, publicIp) {
  if (!routerWan) return false;
  return isPrivateV4(routerWan) || (Boolean(publicIp) && routerWan !== publicIp);
}

/**
 * Pick the way in. Order of preference: port forward, the panel's bridge,
 * playit.gg, then Tailscale or ZeroTier. `facts` is plain data so it can be tested.
 */
function recommend(facts) {
  const f = facts || {};
  const methods = [];
  const pf = { id: 'portforward', title: 'Port forwarding (direct)' };
  if (f.reachable === true) Object.assign(pf, { status: 'working', steps: ['Players on the internet can already reach this server at your public address. Nothing more to do.'] });
  else if (f.cgnat) Object.assign(pf, { status: 'unlikely', steps: ['Your internet provider shares one public address between customers, so a router cannot forward ports to you.', 'Ask the provider for a public (non-CGNAT) address, or use one of the options below.'] });
  else
    Object.assign(pf, {
      status: f.upnp ? 'ready' : 'available',
      steps: [
        'Open the server\'s port on this machine\'s firewall (Server -> Network -> Open ports).',
        f.upnp ? 'Your router speaks UPnP: press "Forward on router" on the same page.' : 'Log in to your router and forward the server\'s port to this machine\'s LAN address (the Network page lists the exact line).',
        'Start the server and press "Check from the internet".',
      ],
    });
  methods.push(pf);

  const br = { id: 'bridge', title: 'GamePanel Bridge' };
  if (f.bridge?.enabled && f.bridge.connections > 0) Object.assign(br, { status: 'ready', steps: ['Bridge is on and has connections. Friends run their personal client and the server appears on their computer.', 'If a friend cannot connect, open Manage connections and check that their client shows as online.'] });
  else
    Object.assign(br, {
      status: 'available',
      steps: ['Needs the panel itself to be reachable from the internet (one port), or a small VPS you control.', 'Turn Bridge on (Manage connections), add a connection per friend and send them their client download.', 'Friends do not need to install anything else; you do not open the game port.'],
    });
  methods.push(br);

  const pl = { id: 'playit', title: 'playit.gg tunnel' };
  if (f.playit?.running && f.playit.claimed) Object.assign(pl, { status: 'ready', steps: ['The playit agent is running. Create a tunnel for the server on playit.gg pointing at this machine and share the address shown on the playit card.'] });
  else
    Object.assign(pl, {
      status: 'available',
      steps: ['Settings -> Hosting -> playit.gg: press Install agent, then Start.', 'Open the claim link shown and approve this machine on playit.gg (free account).', 'Create a tunnel for each server port on playit.gg; the public address then appears next to the server.'],
    });
  methods.push(pl);

  const vpnReady = f.tailscale?.up || f.zerotier?.ok;
  methods.push({
    id: f.zerotier?.ok && !f.tailscale?.up ? 'zerotier' : 'tailscale',
    title: 'Tailscale or ZeroTier (private network)',
    status: vpnReady ? 'ready' : 'available',
    steps: vpnReady
      ? ['This machine is on the private network. Every player installs the same app, joins it, and connects to the private address shown for the server.']
      : ['Install Tailscale or ZeroTier here (Settings -> Hosting), join with an auth key or network id.', 'Every player installs the same app and joins the same network (Tailscale: share the machine or invite them; ZeroTier: they enter the network id and you approve them).', 'They connect to the private address shown for the server. Works through any router, but every player needs the app.'],
  });

  let pick = methods.find((m) => m.status === 'working') || methods.find((m) => m.status === 'ready');
  if (!pick) pick = f.cgnat ? methods.find((m) => m.id === 'playit') : methods.find((m) => m.status === 'available' && m.id === 'portforward');
  const summary =
    pick.status === 'working' ? 'Direct connections already work.' : pick.status === 'ready' ? `${pick.title} is set up and should work.` : f.cgnat ? 'Your provider shares your address, so start with playit.gg (players need nothing installed).' : 'Try port forwarding first; if that does not work, go down the list.';
  return { recommended: pick.id, summary, methods };
}

/* ------------------------------------------------------------- the tools -- */

const cliTimeout = 15_000;

async function tryRun(file, args) {
  let r = await run(file, args, { timeout: cliTimeout });
  // ZeroTier's token file is root-only: the installer's sudo rule may allow it.
  if (r.code !== 0 && !isWindows && /authtoken|permission|denied|access/i.test(r.stderr + r.stdout) && which('sudo')) r = await run('sudo', ['-n', file, ...args], { timeout: cliTimeout });
  return r;
}

async function tailscaleStatus() {
  const bin = which('tailscale');
  if (!bin) return { installed: false };
  const r = await tryRun(bin, ['status', '--json']);
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not running */
  }
  if (!json) return { installed: true, up: false, state: 'Not running', error: (r.stderr || r.error || '').trim().split('\n')[0] || null };
  return { installed: true, ...parseTailscale(json) };
}

async function zerotierStatus() {
  const bin = which('zerotier-cli');
  if (!bin) return { installed: false, networks: [] };
  const info = await tryRun(bin, ['-j', 'info']);
  if (info.code !== 0) return { installed: true, running: false, networks: [], error: (info.stderr || info.stdout || info.error || '').trim().split('\n')[0] || 'zerotier-cli did not answer (is the service running, and may this account use it?)' };
  let nets = [];
  try {
    nets = parseZeroTier(JSON.parse((await tryRun(bin, ['-j', 'listnetworks'])).stdout));
  } catch {
    /* none */
  }
  let node = null;
  try {
    node = JSON.parse(info.stdout).address || null;
  } catch {
    /* ignore */
  }
  return { installed: true, running: true, nodeId: node, networks: nets };
}

async function status(store, manager) {
  const [tailscale, zerotier] = await Promise.all([tailscaleStatus(), zerotierStatus()]);
  const cs = settingsOf(store);
  return {
    platform: process.platform,
    canInstall: isLinux,
    install: INSTALL,
    tailscale: { ...tailscale, keySaved: Boolean(cs.tailscaleKey) },
    zerotier: { ...zerotier, savedNetwork: cs.zerotierNetwork || '' },
    servers: connectAddresses(manager.servers, (s) => network.serverPorts(s, manager.template(s)), { tailscale, zerotier: zerotier.networks }),
  };
}

/** Run the vendor's official installer (Linux only). Returns the tail of its output. */
async function installTool(which_) {
  const spec = INSTALL[which_];
  if (!spec) fail(400, 'Choose tailscale or zerotier');
  if (!isLinux) fail(400, `Automatic install is only offered on Linux. Download it from ${spec.download}`);
  const res = await fetch(spec.url, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'GamePanel' } });
  if (!res.ok) fail(502, `${new URL(spec.url).hostname} answered ${res.status}`);
  const script = await res.text();
  if (script.length < 200 || script.length > 512 * 1024 || !script.startsWith('#!')) fail(502, 'The installer download did not look like a script. Nothing was run.');
  fs.mkdirSync(config.runDir, { recursive: true });
  const file = path.join(config.runDir, `install-${which_}.sh`);
  fs.writeFileSync(file, script, { mode: 0o700 });
  try {
    const shell = which_ === 'zerotier' ? 'bash' : 'sh';
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    const r = root ? await run(shell, [file], { timeout: 300_000 }) : await run('sudo', ['-n', shell, file], { timeout: 300_000 });
    const out = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-12).join('\n');
    if (r.code !== 0) {
      fail(400, /sudo/i.test(out) && !root ? `The panel is not allowed to install software. Run this in a terminal on the machine instead:\n${spec.manual}` : `The installer failed:\n${out}`);
    }
    return { installed: true, output: out };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function joinTailscale(store, { authKey, hostname, remember }) {
  const bin = which('tailscale');
  if (!bin) fail(400, 'Tailscale is not installed');
  const cs = settingsOf(store);
  const key = String(authKey || '').trim() || (cs.tailscaleKey ? secrets.open(cs.tailscaleKey) : '');
  if (!TS_KEY.test(key)) fail(400, 'Paste an auth key from the Tailscale admin console (Settings -> Keys). It starts with tskey-');
  const args = ['up'];
  if (hostname) {
    const h = String(hostname).trim().toLowerCase();
    if (!HOSTNAME.test(h)) fail(400, 'The machine name can use lowercase letters, numbers and dashes');
    args.push(`--hostname=${h}`);
  }
  fs.mkdirSync(config.runDir, { recursive: true });
  const keyFile = path.join(config.runDir, 'tailscale-authkey');
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  try {
    // The key goes through a file so it never shows in a process list.
    const r = await tryRun(bin, [...args, `--auth-key=file:${keyFile}`]);
    if (r.code !== 0) fail(400, `tailscale up failed: ${(r.stderr || r.stdout || r.error).trim().split('\n').slice(-2).join(' ')}. If it says it needs sudo, run "sudo tailscale set --operator=$USER" once in a terminal.`);
  } finally {
    fs.rmSync(keyFile, { force: true });
  }
  if (remember) cs.tailscaleKey = secrets.seal(key);
  store.save();
}

async function joinZeroTier(store, networkId) {
  const bin = which('zerotier-cli');
  if (!bin) fail(400, 'ZeroTier is not installed');
  const id = String(networkId || '').trim().toLowerCase();
  if (!ZT_ID.test(id)) fail(400, 'A ZeroTier network id is 16 letters and numbers (from my.zerotier.com)');
  const r = await tryRun(bin, ['join', id]);
  if (r.code !== 0) fail(400, `zerotier-cli join failed: ${(r.stderr || r.stdout || r.error).trim().split('\n')[0]}`);
  settingsOf(store).zerotierNetwork = id;
  store.save();
}

async function leave(store, which_, networkId) {
  if (which_ === 'tailscale') {
    const bin = which('tailscale');
    if (!bin) fail(400, 'Tailscale is not installed');
    const r = await tryRun(bin, ['down']);
    if (r.code !== 0) fail(400, `tailscale down failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
    settingsOf(store).tailscaleKey = '';
  } else if (which_ === 'zerotier') {
    const bin = which('zerotier-cli');
    const id = String(networkId || '').trim().toLowerCase();
    if (!bin) fail(400, 'ZeroTier is not installed');
    if (!ZT_ID.test(id)) fail(400, 'Bad network id');
    const r = await tryRun(bin, ['leave', id]);
    if (r.code !== 0) fail(400, `zerotier-cli leave failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
    if (settingsOf(store).zerotierNetwork === id) settingsOf(store).zerotierNetwork = '';
  } else fail(400, 'Choose tailscale or zerotier');
  store.save();
}

/** Gather what the wizard needs and recommend. `check` runs the outside test for one running server. */
async function wizard({ store, manager, bridge, playit }, server, { check = false } = {}) {
  const facts = { reachable: null, cgnat: false, upnp: false };
  const notes = [];
  const [upnp, ts, zt] = await Promise.all([network.upnpStatus().catch(() => ({ available: false })), tailscaleStatus(), zerotierStatus()]);
  facts.upnp = Boolean(upnp.available);
  let pubIp = null;
  if (check && server) {
    try {
      const result = await require('./reachability').check(manager, server, {});
      if (result.error) notes.push(result.error);
      else {
        facts.reachable = result.reachable;
        pubIp = result.publicIp;
      }
    } catch (err) {
      notes.push(err.message);
    }
  }
  facts.cgnat = isCgnat(upnp.externalIp, pubIp);
  facts.bridge = { enabled: Boolean(bridge?.enabled), connections: bridge?.connections?.length || 0 };
  const p = await playit.status(store, manager).catch(() => ({}));
  facts.playit = { running: Boolean(p.running), claimed: Boolean(p.claimed) };
  facts.tailscale = { up: Boolean(ts.up) };
  facts.zerotier = { ok: (zt.networks || []).some((n) => n.ok) };
  return { facts, notes, ...recommend(facts) };
}

module.exports = { parseTailscale, parseZeroTier, connectAddresses, isCgnat, recommend, status, installTool, joinTailscale, joinZeroTier, leave, wizard, INSTALL, TS_KEY, ZT_ID };
