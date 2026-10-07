'use strict';

/**
 * End-to-end check of the bridge: a real panel, a real client binary, real
 * TCP and UDP through the tunnel, and every way access can be taken away.
 *
 *   cd bridge/client && go build -o /tmp/gpb . && cd - && node test/bridge-e2e.js /tmp/gpb
 *
 * Runs on Linux and Windows (pass the .exe there).
 */

const assert = require('assert');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(BASE)) {
  console.error('usage: node test/bridge-e2e.js <linux client binary>');
  process.exit(2);
}
const WINDOWS = process.platform === 'win32';
const PLATFORM = WINDOWS ? 'windows-amd64' : `linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
const ASSET = `gamepanel-bridge-${PLATFORM}${WINDOWS ? '.exe' : ''}`;
const EXE = WINDOWS ? '.exe' : '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-bridge-'));
const children = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`  - ${msg}`);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

let PANEL;
let COOKIE;
async function api(method, url, body) {
  const res = await fetch(PANEL + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
  // The session is in the cookie; keep it for the calls that follow.
  const set = res.headers.getSetCookie?.().find((c) => c.startsWith('gp_session='));
  if (set) COOKIE = set.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : Buffer.from(await res.arrayBuffer());
}

/** Run the client; collects output so tests can wait for lines. */
function client(exe, input = '') {
  const home = path.join(tmp, 'home');
  const proc = spawn(exe, [], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData'), NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(proc);
  proc.out = '';
  proc.stdout.on('data', (d) => (proc.out += d));
  proc.stderr.on('data', (d) => (proc.out += d));
  proc.exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  if (input) proc.stdin.write(input);
  proc.waitFor = (text, ms) => until(() => proc.out.includes(text), `client output "${text}"\n--- output ---\n${proc.out}`, ms);
  return proc;
}

function tcpRoundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const chunks = [];
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => resolve(Buffer.concat(chunks)));
    sock.on('error', reject);
    sock.setTimeout(15000, () => sock.destroy(new Error('tcp timeout')));
    // Write everything, then half-close: the echo server answers after our end.
    sock.end(payload);
  });
}

function udpRoundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setInterval(() => sock.send(payload, port, '127.0.0.1'), 500);
    sock.on('message', (msg) => {
      clearInterval(timer);
      sock.close();
      resolve(msg);
    });
    sock.send(payload, port, '127.0.0.1');
    setTimeout(() => {
      clearInterval(timer);
      try {
        sock.close();
      } catch {
        /* closed */
      }
      reject(new Error('udp timeout'));
    }, 10000);
  });
}

/** Status line the panel answers a WebSocket upgrade on /bridge/tunnel with. */
function upgradeStatus(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () =>
      sock.write(
        'GET /bridge/tunnel HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    );
    sock.once('data', (d) => {
      sock.destroy();
      resolve(Number(String(d).split(' ')[1]));
    });
    sock.on('error', reject);
  });
}

function restamp(file, out, edit) {
  const buf = fs.readFileSync(file);
  const n = buf.readUInt32LE(buf.length - 12);
  const json = JSON.parse(buf.subarray(buf.length - 12 - n, buf.length - 12).toString());
  edit(json);
  const body = Buffer.from(JSON.stringify(json));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  fs.writeFileSync(out, Buffer.concat([buf.subarray(0, buf.length - 12 - n), body, size, Buffer.from('GPBRIDG1')]), { mode: 0o755 });
}

async function main() {
  const port = await freePort();
  PANEL = `http://127.0.0.1:${port}`;
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(BASE, path.join(bin, ASSET));

  // Game-server stand-ins: a TCP echo that answers after the client's
  // half-close, and a UDP echo.
  const tcpEcho = net.createServer({ allowHalfOpen: true }, (s) => {
    const chunks = [];
    s.on('data', (d) => chunks.push(d));
    s.on('end', () => s.end(Buffer.concat([...chunks, Buffer.from('|bye')])));
    s.on('error', () => {});
  });
  await new Promise((r) => tcpEcho.listen(0, '127.0.0.1', r));
  const udpEcho = dgram.createSocket('udp4');
  udpEcho.on('message', (msg, from) => udpEcho.send(Buffer.concat([Buffer.from('echo:'), msg]), from.port, from.address));
  await new Promise((r) => udpEcho.bind(0, '127.0.0.1', r));
  const tcpPort = tcpEcho.address().port;
  const udpPort = udpEcho.address().port;
  const localTcp = await freePort();
  const localUdp = await freePort();

  const startPanel = async () => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: { ...process.env, GP_DATA_DIR: path.join(tmp, 'data'), GP_PORT: String(port), GP_HOST: '127.0.0.1', GP_BRIDGE_CLIENT_DIR: bin, GP_LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    children.push(proc);
    await until(() => fetch(`${PANEL}/api/status`).then((r) => r.ok), 'the panel');
    return proc;
  };
  step('starting the panel');
  let panel = await startPanel();

  await api('POST', '/api/setup', { username: 'admin', password: 'Correct-Horse-42' });
  await api('POST', '/api/auth/login', { username: 'admin', password: 'Correct-Horse-42' });

  step('tunnel is closed while the bridge is off');
  assert.strictEqual(await upgradeStatus(port), 404, 'tunnel must not answer while off');

  await api('PATCH', '/api/bridge/settings', { enabled: true, publicUrl: PANEL });
  assert.strictEqual(await upgradeStatus(port), 101, 'tunnel answers once on');
  const created = await api('POST', '/api/bridge/connections', {
    username: 'alice',
    ports: [
      { name: 'Echo', port: tcpPort, localPort: localTcp, protocol: 'tcp' },
      { name: 'Echo UDP', port: udpPort, localPort: localUdp, protocol: 'udp' },
    ],
  });
  const id = created.connection.id;
  assert.strictEqual(created.connection.passwordSet, false);

  step('downloading the personal client');
  const exe = path.join(tmp, `GamePanel-Bridge-alice${EXE}`);
  fs.writeFileSync(exe, await api('GET', `/api/bridge/connections/${id}/client?platform=${PLATFORM}`), { mode: 0o755 });

  step('first launch sets the password');
  let c = client(exe, 'short\npassword123\npassword123\nhunter2222\nhunter2222\n');
  await c.waitFor('Choose a password');
  await c.waitFor(`127.0.0.1:${localUdp}`);
  assert.ok(c.out.includes('shorter than 8'), 'short passwords are refused');
  assert.ok(c.out.includes('attackers try'), 'common passwords are refused');
  let conn = (await api('GET', '/api/bridge')).connections[0];
  assert.strictEqual(conn.passwordSet, true);
  assert.strictEqual(conn.online, true);
  assert.strictEqual(conn.devices.length, 1);
  const state = await until(() => {
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'panel.json'), 'utf8'));
    return saved.bridge.connections[0].password && saved;
  }, 'the state file');
  assert.ok(!JSON.stringify(state).includes('hunter2222'), 'the password is never stored in clear');
  assert.ok(state.bridge.connections[0].password.startsWith('scrypt$'), 'the password is scrypt-hashed');

  step('TCP through the tunnel, with half-close and 4 MB of data');
  assert.strictEqual((await tcpRoundTrip(localTcp, Buffer.from('hello'))).toString(), 'hello|bye');
  const big = crypto.randomBytes(4 * 1024 * 1024);
  const back = await tcpRoundTrip(localTcp, big);
  assert.ok(back.subarray(0, big.length).equals(big) && back.subarray(big.length).toString() === '|bye', 'large payload intact');
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => tcpRoundTrip(localTcp, Buffer.from(`c${i}`))));
  many.forEach((b, i) => assert.strictEqual(b.toString(), `c${i}|bye`));

  step('UDP through the tunnel');
  assert.strictEqual((await udpRoundTrip(localUdp, Buffer.from('ping'))).toString(), 'echo:ping');

  step('taking a port away closes it on the client');
  await api('PATCH', `/api/bridge/connections/${id}`, { ports: [{ ...conn.ports[1] }] });
  await c.waitFor('changed what is shared');
  await until(() => tcpRoundTrip(localTcp, Buffer.from('x')).then(() => false, () => true), 'tcp port to close');
  assert.strictEqual((await udpRoundTrip(localUdp, Buffer.from('still'))).toString(), 'echo:still');
  await api('PATCH', `/api/bridge/connections/${id}`, { ports: [conn.ports[0], conn.ports[1]] });
  await until(() => tcpRoundTrip(localTcp, Buffer.from('back')).then((b) => b.toString() === 'back|bye'), 'tcp port to come back');

  step('the saved login is reused on the next launch');
  c.kill();
  await c.exited;
  c = client(exe);
  await c.waitFor(`127.0.0.1:${localTcp}`);
  assert.ok(!c.out.includes('Password'), 'no password prompt with a saved login');

  step('the client reconnects by itself when the panel restarts');
  panel.kill();
  await new Promise((r) => panel.once('exit', r));
  await c.waitFor("Can't reach the panel");
  panel = await startPanel();
  await c.waitFor('Reconnected', 40000);
  assert.strictEqual((await tcpRoundTrip(localTcp, Buffer.from('after restart'))).toString(), 'after restart|bye');

  step('password reset signs the client out and asks for a new password next time');
  await api('POST', `/api/bridge/connections/${id}/reset-password`);
  await c.waitFor('Run GamePanel Bridge again');
  assert.strictEqual(await c.exited, 0);
  conn = (await api('GET', '/api/bridge')).connections[0];
  assert.strictEqual(conn.passwordSet, false);
  assert.strictEqual(conn.devices.length, 0);
  c = client(exe, 'new-password-1\nnew-password-1\n');
  await c.waitFor('Choose a password');
  await c.waitFor(`127.0.0.1:${localTcp}`);
  assert.strictEqual((await tcpRoundTrip(localTcp, Buffer.from('again'))).toString(), 'again|bye');

  step('signing in on a second device with the password');
  c.kill();
  await c.exited;
  fs.rmSync(path.join(tmp, 'home'), { recursive: true, force: true });
  c = client(exe, 'wrong-password\nnew-password-1\n');
  await c.waitFor('Incorrect password');
  await c.waitFor(`127.0.0.1:${localTcp}`);
  assert.strictEqual((await api('GET', '/api/bridge')).connections[0].devices.length, 2);

  step('a tampered pin is refused (no talking to an impostor)');
  const evil = path.join(tmp, `evil${EXE}`);
  restamp(exe, evil, (j) => (j.pin = crypto.createHash('sha256').update('not the panel').digest('base64')));
  const e = client(evil);
  await e.waitFor('identity does not match');
  await e.exited;

  step('a forged key is refused');
  const forged = path.join(tmp, `forged${EXE}`);
  restamp(exe, forged, (j) => (j.key = crypto.randomBytes(32).toString('base64url')));
  const f = client(forged);
  await f.waitFor('no longer valid');
  await f.exited;

  step('turning the connection off disconnects it');
  await api('PATCH', `/api/bridge/connections/${id}`, { enabled: false });
  await c.waitFor('turned this connection off');
  await until(() => tcpRoundTrip(localTcp, Buffer.from('x')).then(() => false, () => true), 'tcp port to close');
  await api('PATCH', `/api/bridge/connections/${id}`, { enabled: true });

  step('a new download key revokes old copies');
  c.kill();
  await c.exited;
  await api('POST', `/api/bridge/connections/${id}/new-key`);
  const old = client(exe);
  await old.waitFor('no longer valid');
  await old.exited;

  step('uninstall removes the saved data');
  const fresh = path.join(tmp, `fresh${EXE}`);
  fs.writeFileSync(fresh, await api('GET', `/api/bridge/connections/${id}/client?platform=${PLATFORM}`), { mode: 0o755 });
  c = client(fresh, 'new-password-1\n');
  await c.waitFor(`127.0.0.1:${localTcp}`);
  c.stdin.write('uninstall\n');
  await c.exited;
  const clientData = WINDOWS ? path.join(tmp, 'home', 'AppData', 'GamePanel Bridge') : path.join(tmp, 'home', '.config', 'GamePanel Bridge');
  assert.ok(!fs.existsSync(clientData), 'client data removed');
  // Windows deletes a running .exe a moment after it exits.
  await until(() => !fs.existsSync(fresh), 'the client to remove itself');

  step('turning the bridge off closes the tunnel endpoint');
  await api('PATCH', '/api/bridge/settings', { enabled: false });
  assert.strictEqual(await upgradeStatus(port), 404);

  tcpEcho.close();
  udpEcho.close();
  console.log('\nbridge end-to-end: all good');
}

main()
  .catch((err) => {
    console.error('\nFAILED:', err.stack || err.message);
    for (const child of children) if (child.out) console.error(`\n--- client output (exit ${child.exitCode}) ---\n${child.out}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) child.kill('SIGKILL');
    setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }), 100);
    setTimeout(() => process.exit(), 1500);
  });
