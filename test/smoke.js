'use strict';

/**
 * Real-world game check: boot a throwaway panel, deploy one template with its
 * defaults, wait for the install, start it, wait until the game says it is
 * ready, then stop it again.
 *
 *   node test/smoke.js --template=minecraft-paper
 *   node test/smoke.js --template=valheim --keep      leave the data dir behind
 *
 * This is what CI runs for every game on Linux and Windows. It downloads the
 * real game, so it needs a network connection and, for the big Steam titles,
 * tens of gigabytes of disk.
 *
 * Templates can tune it with a "ci" block:
 *   { "ci": { "skip": "why", "installOnly": true, "vars": {}, "bootTimeout": 900 } }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const TEMPLATE = arg('template');
const KEEP = flag('keep');
const OUT_DIR = arg('out', path.join(ROOT, 'smoke-output'));
const PLATFORM = process.platform === 'win32' ? 'windows' : 'linux';

if (!TEMPLATE) {
  console.error('usage: node test/smoke.js --template=<id>');
  process.exit(2);
}

const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', `${TEMPLATE}.json`), 'utf8'));
const ci = { ...(tpl.ci || {}), ...(tpl.ci?.[PLATFORM] || {}) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function main() {
  if (ci.skip) {
    log(`SKIP ${TEMPLATE}: ${ci.skip}`);
    return 0;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(process.env.GP_SMOKE_ROOT || os.tmpdir(), `gp-smoke-${TEMPLATE}-`));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  log(`Panel data in ${dataDir}, listening on ${base}`);

  const panelLog = fs.createWriteStream(path.join(OUT_DIR, `${TEMPLATE}-panel.log`));
  const panel = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, GP_DATA_DIR: dataDir, GP_PORT: String(port), GP_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  panel.stdout.pipe(panelLog);
  panel.stderr.pipe(panelLog);

  let cookie = '';
  const api = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error || text}`);
    return data;
  };

  let serverId = null;
  const dumpConsole = async () => {
    if (!serverId) return;
    try {
      const { lines } = await api('GET', `/api/servers/${serverId}/console`);
      const text = lines.map((l) => `[${l.stream}] ${l.line}`).join('\n');
      fs.writeFileSync(path.join(OUT_DIR, `${TEMPLATE}-console.log`), text);
      console.log('──── console (last 60 lines) ────');
      console.log(lines.slice(-60).map((l) => `  ${l.line}`).join('\n'));
      console.log('─────────────────────────────────');
    } catch (err) {
      log(`could not read the console: ${err.message}`);
    }
  };

  const status = async () => (await api('GET', `/api/servers/${serverId}`)).server;

  const waitFor = async (label, done, timeoutSec) => {
    const until = Date.now() + timeoutSec * 1000;
    let last = '';
    while (Date.now() < until) {
      const server = await status();
      if (server.status !== last) {
        log(`${label}: ${server.status}`);
        last = server.status;
      }
      const verdict = done(server);
      if (verdict) return { server, verdict };
      await sleep(3000);
    }
    return { server: await status(), verdict: 'timeout' };
  };

  let code = 1;
  try {
    for (let i = 0; i < 60; i++) {
      try {
        await api('GET', '/api/status');
        break;
      } catch {
        await sleep(500);
      }
    }
    await api('POST', '/api/setup', { username: 'smoke', password: 'smoke-test-password' });
    await api('POST', '/api/auth/login', { username: 'smoke', password: 'smoke-test-password' });

    const created = await api('POST', '/api/servers', {
      templateId: TEMPLATE,
      name: `CI ${tpl.name}`.slice(0, 60),
      vars: ci.vars || {},
      autoStart: false,
      autoRestart: false,
    });
    serverId = created.server.id;
    log(`Created ${serverId} (runtime ${created.server.runtime})`);

    // 1. install
    const install = await waitFor(
      'install',
      (s) => (s.installedAt && s.status === 'offline' ? 'ok' : s.status === 'install_failed' ? 'failed' : null),
      Number(ci.installTimeout || 5400)
    );
    if (install.verdict !== 'ok') {
      log(`FAIL install ${install.verdict}`);
      await dumpConsole();
      return 1;
    }
    log('Install finished');
    if (ci.installOnly) {
      log(`PASS ${TEMPLATE} (install only: ${ci.installOnly === true ? 'needs credentials to boot' : ci.installOnly})`);
      await dumpConsole();
      return 0;
    }

    // 2. boot until the template's ready marker
    await api('POST', `/api/servers/${serverId}/power`, { action: 'start' });
    const started = Date.now();
    const boot = await waitFor(
      'boot',
      (s) => (s.status === 'running' ? 'ok' : ['crashed', 'offline'].includes(s.status) && Date.now() - started > 4000 ? s.status : null),
      Number(ci.bootTimeout || 900)
    );
    if (boot.verdict !== 'ok') {
      log(`FAIL boot ${boot.verdict}`);
      await dumpConsole();
      return 1;
    }
    log(`Ready after ${Math.round((Date.now() - started) / 1000)}s`);

    // 3. stays up
    await sleep(Number(ci.settle || 20) * 1000);
    const settled = await status();
    if (settled.status !== 'running') {
      log(`FAIL did not stay up (${settled.status})`);
      await dumpConsole();
      return 1;
    }
    if (settled.ping != null) log(`Query answered in ${settled.ping} ms (${settled.players ?? 0}/${settled.maxPlayers ?? '?'} players)`);
    else if (tpl.query && tpl.query.type !== 'none') log(`note: query did not answer (${settled.queryError || 'no reply yet'})`);

    // 4. clean stop
    await api('POST', `/api/servers/${serverId}/power`, { action: 'stop' });
    const stop = await waitFor('stop', (s) => (s.status === 'offline' ? 'ok' : null), Number(tpl.stopTimeout || 45) + 60);
    if (stop.verdict !== 'ok') {
      log(`FAIL stop ${stop.verdict}`);
      await dumpConsole();
      return 1;
    }

    await dumpConsole();
    log(`PASS ${TEMPLATE}`);
    code = 0;
  } catch (err) {
    log(`ERROR ${err.message}`);
    await dumpConsole();
    code = 1;
  } finally {
    if (serverId) await api('POST', `/api/servers/${serverId}/power`, { action: 'kill' }).catch(() => {});
    await sleep(1500);
    panel.kill();
    if (!KEEP) {
      // Game installs are huge; free the disk for the next job step.
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* runner is thrown away anyway */
      }
    }
  }
  return code;
}

main().then((code) => process.exit(code));
