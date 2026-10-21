'use strict';

/**
 * Connection flood blocking for game ports.
 *
 * Opt-in per server (server.floodGuard), administrators only. Every few
 * seconds the panel counts, for each protected server's ports, how many
 * connections each remote address has open (and, where the kernel counts
 * them, how many packets per second it sends). An address over the limit is
 * blocked for a while with a firewall rule, and unblocked automatically.
 *
 *   Linux:   counts from conntrack (TCP and UDP), or `ss` (TCP) when conntrack
 *            is not available. Blocks live in nftables table "gamepanel",
 *            chain "gamepanel-flood" (sets with native timeouts), or in an
 *            iptables chain called "gamepanel-flood" when nftables is missing.
 *   Windows: counts TCP connections with Get-NetTCPConnection; blocks with
 *            Windows Firewall rules named "GamePanel flood <ip> <port>/<proto>".
 *
 * Commands are only ever built from addresses that passed the CIDR parser and
 * port numbers from the server's own settings, and are run with execFile and
 * an argument list, never through a shell.
 *
 * Never blocked: loopback and private addresses (unless an administrator
 * turns that on), the allowlist, and addresses staff have signed in from or
 * that the bridge has seen.
 *
 * settings.flood = { allow: [cidr], maxConnections, maxPackets, blockMinutes, blockPrivate }
 * state.floodBlocks = [{ id, ip, serverId, serverName, ports: [{port, protocol}], reason, at, until, manual }]
 */

const fs = require('fs');
const crypto = require('crypto');
const platform = require('../core/platform');
const cidr = require('../core/cidr');
const { fail, logger } = require('../core/util');

const DEFAULTS = { allow: [], maxConnections: 100, maxPackets: 4000, blockMinutes: 15, blockPrivate: false };
const SAMPLE_MS = 10_000;
const MAX_BLOCKS = 500;
const GRACE_MS = 2 * 60_000; // after an unblock, give the address a moment before it can be judged again
const TABLE = 'gamepanel';
const CHAIN = 'gamepanel-flood';

/* ------------------------------------------------------------ settings -- */

const settingsOf = (store) => ({ ...DEFAULTS, ...(store.state.settings.flood || {}) });

function updateSettings(store, body) {
  const s = settingsOf(store);
  if (body.allow !== undefined) {
    const { ranges, bad } = cidr.parseList(body.allow);
    if (bad.length) fail(400, `Not a valid address or range: ${bad.slice(0, 3).join(', ')}`);
    if (ranges.length > 200) fail(400, 'At most 200 entries');
    s.allow = ranges;
  }
  const int = (v, min, max, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) fail(400, `${what} must be a whole number from ${min} to ${max}`);
    return n;
  };
  if (body.maxConnections !== undefined) s.maxConnections = int(body.maxConnections, 5, 100000, 'Connections per address');
  if (body.maxPackets !== undefined) s.maxPackets = int(body.maxPackets, 100, 10_000_000, 'Packets per second');
  if (body.blockMinutes !== undefined) s.blockMinutes = int(body.blockMinutes, 1, 10080, 'Block time');
  if (body.blockPrivate !== undefined) s.blockPrivate = Boolean(body.blockPrivate);
  store.state.settings.flood = s;
  store.save();
  return s;
}

/* ----------------------------------------------------------- detection -- */

/**
 * Connections per remote address from a conntrack listing (one entry per
 * line, either /proc/net/nf_conntrack or `conntrack -L`).
 * ports: Set of "proto/port". Returns Map "ip|proto|port" -> { connections, packets }.
 * Only the original direction (the first src/dst/sport/dport/packets) counts.
 */
function parseConntrack(text, ports) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/\b(tcp|udp)\b/);
    if (!m) continue;
    const proto = m[1];
    const src = line.match(/\bsrc=(\S+)/);
    const dport = line.match(/\bdport=(\d+)/);
    if (!src || !dport || !ports.has(`${proto}/${dport[1]}`)) continue;
    // A half-open TCP entry that never completed still counts: that is the flood.
    if (proto === 'tcp' && /\b(TIME_WAIT|CLOSE)\b/.test(line)) continue;
    const ip = cidr.normalizeIp(src[1]);
    if (!ip) continue;
    const packets = line.match(/\bpackets=(\d+)/);
    const key = `${ip}|${proto}|${dport[1]}`;
    const entry = out.get(key) || { connections: 0, packets: 0 };
    entry.connections += 1;
    entry.packets += packets ? Number(packets[1]) : 0;
    out.set(key, entry);
  }
  return out;
}

/** TCP connections per remote address from `ss -H -tn` (columns: state recv-q send-q local peer). */
function parseSs(text, ports) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const local = cols[3].match(/:(\d+)$/);
    const peer = cols[4].match(/^(.*):(\d+)$/);
    if (!local || !peer || !ports.has(`tcp/${local[1]}`)) continue;
    const ip = cidr.normalizeIp(peer[1]);
    if (!ip) continue;
    const key = `${ip}|tcp|${local[1]}`;
    const entry = out.get(key) || { connections: 0, packets: 0 };
    entry.connections += 1;
    out.set(key, entry);
  }
  return out;
}

/** Windows: Get-NetTCPConnection JSON ([{ RemoteAddress, LocalPort }]). */
function parseWindowsTcp(text, ports) {
  const out = new Map();
  let rows = [];
  try {
    rows = [].concat(JSON.parse(String(text || '[]').trim() || '[]'));
  } catch {
    return out;
  }
  for (const row of rows) {
    const port = String(Number(row?.LocalPort));
    if (!ports.has(`tcp/${port}`)) continue;
    const ip = cidr.normalizeIp(row.RemoteAddress);
    if (!ip) continue;
    const key = `${ip}|tcp|${port}`;
    const entry = out.get(key) || { connections: 0, packets: 0 };
    entry.connections += 1;
    out.set(key, entry);
  }
  return out;
}

/**
 * Who is over the limit. samples: Map from parseConntrack/parseSs. before: the
 * previous packet totals (key -> packets) for the rate. Returns [{ ip, proto, port, reason }].
 */
function offenders(samples, before, seconds, limits) {
  const found = [];
  for (const [key, v] of samples) {
    const [ip, proto, port] = key.split('|');
    if (v.connections >= limits.maxConnections) {
      found.push({ ip, proto, port: Number(port), reason: `${v.connections} connections at once (limit ${limits.maxConnections})` });
      continue;
    }
    const prev = before.get(key);
    if (prev !== undefined && v.packets > prev && seconds > 0) {
      const rate = Math.round((v.packets - prev) / seconds);
      if (rate >= limits.maxPackets) found.push({ ip, proto, port: Number(port), reason: `${rate} packets per second (limit ${limits.maxPackets})` });
    }
  }
  return found;
}

/* ------------------------------------------------------- firewall args -- */

const family = (ip) => (ip.includes(':') ? 6 : 4);
const setName = (ip, proto) => `flood${family(ip)}_${proto}`;

function check(ip, port, proto) {
  const clean = cidr.normalizeIp(ip);
  if (!clean || clean.includes('/')) throw new Error('Not an IP address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Not a port');
  if (!['tcp', 'udp'].includes(proto)) throw new Error('Not a protocol');
  return clean;
}

/** nft argument lists. All plain tokens: nft reads "{", ";" and "." as words. */
const nft = {
  init: () => [
    ['add', 'table', 'inet', TABLE],
    ['add', 'chain', 'inet', TABLE, CHAIN, '{', 'type', 'filter', 'hook', 'input', 'priority', '-10', ';', 'policy', 'accept', ';', '}'],
    ...[4, 6].flatMap((f) =>
      ['tcp', 'udp'].map((p) => ['add', 'set', 'inet', TABLE, `flood${f}_${p}`, '{', 'type', `ipv${f}_addr`, '.', 'inet_service', ';', 'flags', 'timeout', ';', '}'])
    ),
    ['flush', 'chain', 'inet', TABLE, CHAIN],
    ...[4, 6].flatMap((f) => ['tcp', 'udp'].map((p) => ['add', 'rule', 'inet', TABLE, CHAIN, `ip${f === 6 ? '6' : ''}`, 'saddr', '.', p, 'dport', `@flood${f}_${p}`, 'drop'])),
  ],
  block: (ip, port, proto, seconds) => {
    const clean = check(ip, port, proto);
    return ['add', 'element', 'inet', TABLE, setName(clean, proto), '{', clean, '.', String(port), 'timeout', `${Math.max(1, Math.floor(seconds))}s`, '}'];
  },
  unblock: (ip, port, proto) => {
    const clean = check(ip, port, proto);
    return ['delete', 'element', 'inet', TABLE, setName(clean, proto), '{', clean, '.', String(port), '}'];
  },
};

const iptables = {
  tool: (ip) => (family(ip) === 6 ? 'ip6tables' : 'iptables'),
  init: (tool) => ({ create: ['-N', CHAIN], check: ['-C', 'INPUT', '-j', CHAIN], hook: ['-I', 'INPUT', '1', '-j', CHAIN], tool }),
  rule: (action, ip, port, proto) => {
    const clean = check(ip, port, proto);
    return [action, CHAIN, '-s', clean, '-p', proto, '--dport', String(port), '-j', 'DROP'];
  },
};

/** netsh argument list: one rule per address, port and protocol. */
const netsh = {
  name: (ip, port, proto) => `GamePanel flood ${check(ip, port, proto)} ${port}/${proto}`,
  block: (ip, port, proto) => ['advfirewall', 'firewall', 'add', 'rule', `name=${netsh.name(ip, port, proto)}`, 'dir=in', 'action=block', `protocol=${proto.toUpperCase()}`, `localport=${port}`, `remoteip=${check(ip, port, proto)}`],
  unblock: (ip, port, proto) => ['advfirewall', 'firewall', 'delete', 'rule', `name=${netsh.name(ip, port, proto)}`],
};

/* -------------------------------------------------------------- engine -- */

class Flood {
  constructor({ store, manager, run = platform.run, readFile = (f) => fs.readFileSync(f, 'utf8'), now = () => Date.now() }) {
    this.store = store;
    this.manager = manager;
    this.run = run;
    this.readFile = readFile;
    this.now = now;
    this.before = new Map();
    this.lastSample = 0;
    this.grace = new Map(); // ip -> until
    this.backend = null; // 'nft' | 'iptables' | 'windows' | 'none'
    this.error = null;
    this.timer = null;
    this.busy = false;
    this.initialised = false;
  }

  get blocks() {
    if (!Array.isArray(this.store.state.floodBlocks)) this.store.state.floodBlocks = [];
    return this.store.state.floodBlocks;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((err) => logger.debug(`Flood check failed: ${err.message}`)), SAMPLE_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  protectedServers() {
    return this.manager.servers.filter((s) => s.floodGuard);
  }

  /** The ports to watch: every game port of protected servers except RCON-style admin ports. */
  portsOf(server) {
    return require('./network')
      .serverPorts(server, this.manager.template(server))
      .filter((p) => p.name !== 'rcon' && Number.isInteger(p.port) && p.port > 0);
  }

  /** Addresses that must never be blocked. */
  neverBlock(ip) {
    const s = settingsOf(this.store);
    if (!s.blockPrivate && cidr.isPrivate(ip)) return true;
    if (cidr.matchesAny(s.allow, ip)) return true;
    for (const u of this.store.state.users) if ((u.knownIps || []).includes(ip)) return true;
    for (const c of this.store.state.bridge?.connections || []) for (const d of c.devices || []) if (d.lastIp && cidr.normalizeIp(d.lastIp) === ip) return true;
    return false;
  }

  async elevated(file, args) {
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    const res = root ? await this.run(file, args, { timeout: 15000 }) : await this.run('sudo', ['-n', file, ...args], { timeout: 15000 });
    return res;
  }

  async detectBackend() {
    if (platform.isWindows) return 'windows';
    if (await this.hasTool('nft')) return 'nft';
    if (await this.hasTool('iptables')) return 'iptables';
    return 'none';
  }

  async hasTool(name) {
    const res = await this.run('which', [name], { timeout: 4000 });
    return res.code === 0 && Boolean(res.stdout.trim());
  }

  async setup() {
    if (this.initialised) return;
    this.backend = await this.detectBackend();
    this.error = null;
    if (this.backend === 'none') {
      this.error = platform.isWindows ? null : 'Neither nftables (nft) nor iptables is installed, so addresses cannot be blocked';
      return;
    }
    if (this.backend === 'nft') {
      for (const args of nft.init()) {
        const res = await this.elevated('nft', args);
        if (res.code !== 0) {
          this.error = /sudo|password|permission|operation not permitted/i.test(res.stderr) ? 'The panel is not allowed to change the firewall (nftables). Re-run install.sh to grant it, or run the panel as root.' : res.stderr.trim().split('\n')[0] || 'nftables refused the setup';
          return;
        }
      }
    } else if (this.backend === 'iptables') {
      for (const tool of ['iptables', 'ip6tables']) {
        const i = iptables.init(tool);
        await this.elevated(tool, i.create);
        if ((await this.elevated(tool, i.check)).code !== 0) {
          const res = await this.elevated(tool, i.hook);
          if (res.code !== 0 && tool === 'iptables') {
            this.error = 'The panel is not allowed to change the firewall (iptables). Re-run install.sh to grant it, or run the panel as root.';
            return;
          }
        }
      }
    }
    this.initialised = true;
    // After a restart the sets are empty (and the iptables chain may be): put back what has not expired.
    for (const b of this.blocks) await this.apply(b, true).catch(() => {});
  }

  /** Put a block's rules in place (or take them out). */
  async apply(block, add) {
    if (!this.initialised && this.backend !== 'windows') return false;
    let ok = true;
    for (const { port, protocol } of block.ports) {
      let res;
      if (this.backend === 'nft') {
        const seconds = Math.max(1, Math.ceil((block.until - this.now()) / 1000));
        res = await this.elevated('nft', add ? nft.block(block.ip, port, protocol, seconds) : nft.unblock(block.ip, port, protocol));
        // Removing something already gone (it timed out) is fine.
        if (!add && res.code !== 0) res = { code: 0 };
      } else if (this.backend === 'iptables') {
        const tool = iptables.tool(block.ip);
        if (add) {
          // -C first so a restart never stacks the same rule twice.
          const has = await this.elevated(tool, iptables.rule('-C', block.ip, port, protocol));
          res = has.code === 0 ? has : await this.elevated(tool, iptables.rule('-A', block.ip, port, protocol));
        } else {
          res = await this.elevated(tool, iptables.rule('-D', block.ip, port, protocol));
          if (res.code !== 0) res = { code: 0 };
        }
      } else if (this.backend === 'windows') {
        if (add) await this.run('netsh', netsh.unblock(block.ip, port, protocol));
        res = await this.run('netsh', add ? netsh.block(block.ip, port, protocol) : netsh.unblock(block.ip, port, protocol));
        if (!add) res = { code: 0 };
      } else {
        return false;
      }
      if (res.code !== 0) ok = false;
    }
    return ok;
  }

  /** Block one address on one server's ports. Returns the record. */
  async block({ ip, server, ports, reason, minutes, manual = false }) {
    const clean = cidr.normalizeIp(ip);
    if (!clean) fail(400, 'That is not an IP address');
    const s = settingsOf(this.store);
    if (this.neverBlock(clean) && !manual) return null;
    if (manual && (cidr.isLoopback(clean) || cidr.matchesAny(s.allow, clean))) fail(400, 'That address is allowlisted or this machine itself, so it is never blocked');
    await this.setup();
    if (this.backend === 'none' || this.error) fail(501, this.error || 'No firewall tool found to block with');
    const existing = this.blocks.find((b) => b.ip === clean && b.serverId === server.id);
    const until = this.now() + (minutes || s.blockMinutes) * 60_000;
    if (existing) {
      existing.until = until;
      existing.reason = reason;
      await this.apply(existing, true);
      this.store.save();
      return existing;
    }
    const record = { id: crypto.randomBytes(6).toString('hex'), ip: clean, serverId: server.id, serverName: server.name, ports: ports.map(({ port, protocol }) => ({ port, protocol })), reason, at: this.now(), until, manual };
    this.blocks.push(record);
    while (this.blocks.length > MAX_BLOCKS) await this.unblock(this.blocks[0].id, false);
    const ok = await this.apply(record, true);
    this.store.save();
    if (!ok) logger.warn(`Flood guard: the firewall refused the block for ${clean}`);
    this.store.addEvent('security.flood_blocked', `${clean} blocked on ${server.name} for ${Math.round((until - this.now()) / 60000)} min: ${reason}`, { serverId: server.id, ip: clean });
    return record;
  }

  async unblock(id, remember = true) {
    const i = this.blocks.findIndex((b) => b.id === id);
    if (i === -1) fail(404, 'That block no longer exists');
    const [record] = this.blocks.splice(i, 1);
    await this.apply(record, false).catch(() => {});
    if (remember) this.grace.set(record.ip, this.now() + GRACE_MS);
    this.store.save();
    return record;
  }

  /** Take down blocks whose time is up. */
  async expire() {
    const now = this.now();
    for (const b of [...this.blocks]) if (b.until <= now) await this.unblock(b.id, false);
    for (const [ip, until] of this.grace) if (until < now) this.grace.delete(ip);
  }

  async sample(ports) {
    if (platform.isWindows) {
      const res = await platform.powershell("Get-NetTCPConnection -State Established,SynReceived -ErrorAction SilentlyContinue | Select-Object RemoteAddress,LocalPort | ConvertTo-Json -Compress", { timeout: 20000 });
      return { samples: parseWindowsTcp(res.stdout, ports), method: 'windows' };
    }
    let text = null;
    try {
      text = this.readFile('/proc/net/nf_conntrack');
    } catch {
      const res = await this.elevated('conntrack', ['-L']);
      if (res.code === 0 && res.stdout) text = res.stdout;
    }
    if (text) return { samples: parseConntrack(text, ports), method: 'conntrack' };
    const res = await this.run('ss', ['-H', '-tn'], { timeout: 8000 });
    if (res.code === 0) return { samples: parseSs(res.stdout, ports), method: 'ss' };
    return { samples: new Map(), method: 'none' };
  }

  /** One round: expire old blocks, sample, block offenders. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.expire();
      const servers = this.protectedServers();
      if (!servers.length) return;
      const byPort = new Map(); // "proto/port" -> server
      for (const server of servers) for (const p of this.portsOf(server)) byPort.set(`${p.protocol}/${p.port}`, { server, p });
      const { samples, method } = await this.sample(new Set(byPort.keys()));
      this.method = method;
      const now = this.now();
      const seconds = this.lastSample ? (now - this.lastSample) / 1000 : 0;
      this.lastSample = now;
      const limits = settingsOf(this.store);
      for (const o of offenders(samples, this.before, seconds, limits)) {
        const hit = byPort.get(`${o.proto}/${o.port}`);
        if ((this.grace.get(o.ip) || 0) > now || !hit) continue;
        // Block on all of the server's game ports, not only the one flooded.
        await this.block({ ip: o.ip, server: hit.server, ports: this.portsOf(hit.server), reason: o.reason });
      }
      this.before = new Map([...samples].map(([k, v]) => [k, v.packets]));
    } finally {
      this.busy = false;
    }
  }

  async view() {
    if (!this.backend) await this.setup().catch(() => {});
    return {
      platform: platform.isWindows ? 'windows' : 'linux',
      backend: this.backend,
      method: this.method || null,
      error: this.error,
      settings: settingsOf(this.store),
      servers: this.manager.servers.map((s) => ({ id: s.id, name: s.name, enabled: Boolean(s.floodGuard), ports: this.portsOf(s).map((p) => `${p.port}/${p.protocol}`) })),
      blocks: this.blocks.map((b) => ({ ...b })),
    };
  }
}

let instance = null;
function start(app) {
  instance = new Flood(app);
  instance.start();
  return instance;
}
const get = (app) => instance || (instance = new Flood(app));

module.exports = { Flood, start, get, settingsOf, updateSettings, parseConntrack, parseSs, parseWindowsTcp, offenders, nft, iptables, netsh, DEFAULTS };
