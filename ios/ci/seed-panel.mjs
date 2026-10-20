// Sets up a throwaway panel for the iOS Simulator run: an admin, a running server that
// prints Minecraft-style log lines and echoes commands, a stopped one, and a backup.
//   GP_URL=http://127.0.0.1:8420 node ios/ci/seed-panel.mjs
const base = process.env.GP_URL || 'http://127.0.0.1:8420';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${data?.error || text}`);
  return data;
}

const fakeServer = String.raw`cat > start.sh <<'EOF'
#!/bin/bash
echo "[Server thread/INFO]: Starting minecraft server version 1.21.4"
echo "[Server thread/INFO]: Preparing level \"world\""
echo "[Server thread/WARN]: Can't keep up! Is the server overloaded?"
echo "[Server thread/INFO]: Done (3.214s)! For help, type \"help\""
i=0
while true; do
  if read -t 4 line; then echo "[Server thread/INFO]: [Console] $line"; fi
  i=$((i+1))
  echo "[Server thread/INFO]: Saved the game (autosave $i)"
done
EOF
chmod +x start.sh
printf 'motd=GamePanel CI\nmax-players=40\npvp=true\n' > server.properties
mkdir -p plugins world`;

async function waitInstalled(id) {
  for (let i = 0; i < 120; i++) {
    const { server } = await api('GET', `/api/servers/${id}`);
    if (server.installedAt && server.status === 'offline') return;
    if (server.status === 'install_failed') {
      // Annotations are readable on the run page without signing in.
      const { lines } = await api('GET', `/api/servers/${id}/console`);
      for (const l of lines.slice(-8)) console.log(`::error title=install ${id}::${l.line.replace(/[\r\n]/g, ' ')}`);
      throw new Error(`install of ${id} failed`);
    }
    await sleep(1000);
  }
  throw new Error(`install of ${id} timed out`);
}

for (let i = 0; i < 120; i++) {
  try {
    await api('GET', '/api/status');
    break;
  } catch {
    await sleep(500);
  }
}

await api('POST', '/api/setup', { username: 'demo', password: 'tour-pass-7391-ok' });
await api('POST', '/api/auth/login', { username: 'demo', password: 'tour-pass-7391-ok' });

const create = (name) =>
  api('POST', '/api/servers', {
    templateId: 'custom-command',
    name,
    vars: { INSTALL_SCRIPT: fakeServer, LAUNCH_COMMAND: './start.sh' },
    autoStart: false,
    autoRestart: false,
  }).then((r) => r.server.id);

const live = await create('Survival SMP');
const idle = await create('Creative World');
await waitInstalled(live);
await waitInstalled(idle);

// The panel's backups use GNU tar options macOS's tar lacks; the Backups screen still shows its empty state.
await api('POST', `/api/servers/${idle}/backups`, { label: 'Before the update' }).catch((err) => console.log(`backup skipped: ${err.message}`));
await api('POST', `/api/servers/${live}/power`, { action: 'start' });
await sleep(6000);
await api('POST', `/api/servers/${live}/command`, { command: 'say hello from CI' });

const { servers } = await api('GET', '/api/servers');
console.log(servers.map((s) => `${s.name}: ${s.status}`).join('\n'));
