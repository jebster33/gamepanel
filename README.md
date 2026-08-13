# 🎮 GamePanel

A self-hosted game server control panel for Ubuntu — the power of Pterodactyl without Docker, databases, PHP, queues or a two-hour setup guide.

**One command to install. One web UI to run every game server on your box.**

```bash
curl -fsSL https://raw.githubusercontent.com/jebster33/gamepanel/main/install.sh | sudo bash
```

Then open `http://your-server-ip:8080` and create your admin account. That's the whole setup.

---

## Why this exists

Pterodactyl is excellent, but it needs Docker, MySQL, Redis, PHP-FPM, nginx, a queue worker, a separate Wings daemon and a domain with SSL before you can boot a single Minecraft server. GamePanel is one Node.js process with **zero npm dependencies** — no build step, no database server, no containers. It reads its metrics straight from `/proc` and speaks the game protocols itself.

If you have a VPS and want game servers running in the next five minutes, this is for you.

## Features

**Dashboard**
- Live CPU, memory, disk and network usage for the host, with sparkline history
- Per-server CPU, RAM, uptime, disk footprint, player count, query ping and active connections
- Everything streams over WebSockets in real time (with an automatic polling fallback for restrictive proxies)

**Server management**
- Start / stop / restart / force-kill, with a live console you can type commands into
- Crash detection with counters, an activity log and exponential-backoff auto-restart
- Auto-start on boot, per-server memory limits and port allocation
- Full file manager: browse, edit, upload, download, rename, delete — sandboxed to the server directory
- One-click `.tar.gz` backups with restore and download

**Players & networking**
- Real player counts and ping via native protocol implementations:
  Minecraft Java (Server List Ping), Minecraft Bedrock (RakNet), Valve A2S (Source/GoldSrc/Unity), plus TCP/UDP probes
- Source RCON client built in, so games without an interactive stdin still take commands
- Log-pattern player tracking for games with no query protocol at all

**Templates**
- 26 built-in game templates — deploy a server by filling in a short form
- Templates are plain JSON: drop your own into `/var/lib/gamepanel/templates` and they show up instantly
- Two universal templates cover *any* game: **Any Steam game (SteamCMD)** by App ID, and **Custom server** for an arbitrary install script + start command

**Users**
- Multi-user with admin and restricted roles; regular users only see the servers assigned to them
- scrypt password hashing, HMAC-signed session cookies, login rate limiting

## Included templates

| Category | Games |
|---|---|
| **Minecraft** | Paper · Vanilla · Fabric · Bedrock |
| **Survival** | Rust · Valheim · Palworld · ARK: Survival Evolved · 7 Days to Die · Project Zomboid · Enshrouded · V Rising · Unturned · Core Keeper |
| **Shooter** | Counter-Strike 2 · Team Fortress 2 · Left 4 Dead 2 · Squad · Insurgency: Sandstorm |
| **Sandbox** | Garry's Mod · Terraria · Factorio · Satisfactory · Necesse |
| **Universal** | Any Steam game (by App ID) · Custom server (any install script + start command) |

Missing a game? The two universal templates handle it today, and a proper template is ~30 lines of JSON (see below).

## Requirements

- Ubuntu 22.04 / 24.04 (Debian 12 works too)
- Root access for the installer
- Node.js 18+ — installed automatically if missing
- Enough RAM and disk for the games you plan to run (Rust and ARK want 8–16 GB and tens of gigabytes of disk)

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/jebster33/gamepanel/main/install.sh | sudo bash
```

The installer:
1. installs base packages and Node.js 20 if needed,
2. creates the `gamepanel` system user,
3. clones the panel to `/opt/gamepanel` and creates `/var/lib/gamepanel`,
4. grants that user a narrow passwordless sudo rule for `apt-get` (game installers need Java, 32-bit libs, `unzip`…),
5. installs and starts the `gamepanel` systemd service,
6. opens the panel and default game ports in `ufw` if it is active.

Re-running the same command updates an existing installation in place.

**Custom port:**

```bash
curl -fsSL https://raw.githubusercontent.com/jebster33/gamepanel/main/install.sh | sudo GP_PORT=9000 bash
```

### Manual install

```bash
git clone https://github.com/jebster33/gamepanel.git
cd gamepanel
node server/index.js
```

No `npm install` — there are no dependencies. The panel listens on `:8080` and stores everything in `./data` when it cannot write to `/var/lib/gamepanel`.

## Everyday use

| What | Command |
|---|---|
| Service status | `systemctl status gamepanel` |
| Restart the panel | `sudo systemctl restart gamepanel` |
| Follow panel logs | `journalctl -u gamepanel -f` |
| Update to the latest version | re-run the install command |
| Uninstall (keep game data) | `sudo /opt/gamepanel/uninstall.sh` |
| Uninstall everything | `sudo /opt/gamepanel/uninstall.sh --purge` |

**Layout**

```
/opt/gamepanel            panel source
/var/lib/gamepanel/
├── panel.json            all panel state (users, servers, settings)
├── secret.key            session signing key
├── servers/<id>/         one directory per game server
├── backups/<id>/         .tar.gz backups
├── templates/            your custom templates
└── logs/                 per-server console logs
```

## Configuration

Set these in the systemd unit (`/etc/systemd/system/gamepanel.service`) or the environment:

| Variable | Default | Purpose |
|---|---|---|
| `GP_PORT` | `8080` | Panel HTTP port |
| `GP_HOST` | `0.0.0.0` | Bind address |
| `GP_DATA_DIR` | `/var/lib/gamepanel` | Where everything is stored |
| `GP_BEHIND_PROXY` | `0` | Trust `X-Forwarded-For` / `X-Forwarded-Proto` |
| `GP_METRICS_INTERVAL` | `2000` | Metrics sampling interval (ms) |
| `GP_QUERY_INTERVAL` | `15000` | Player-count query interval (ms) |
| `GP_CONSOLE_LINES` | `400` | Console scrollback kept per server |
| `GP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Putting it behind HTTPS

GamePanel speaks plain HTTP so you can front it with whatever you already use. With Caddy it is two lines:

```
panel.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then set `GP_BEHIND_PROXY=1` and restart. nginx works too — remember `proxy_set_header Upgrade`/`Connection` so the WebSocket console keeps working.

## Writing your own template

Drop a JSON file into `/var/lib/gamepanel/templates/` and hit *Reload templates* in Settings.

```json
{
  "id": "my-game",
  "name": "My Game",
  "category": "Shooter",
  "icon": "🎯",
  "description": "Shows up on the template card.",
  "defaultMemory": 4096,
  "variables": [
    { "name": "MAX_PLAYERS", "label": "Max players", "type": "number", "default": 16 },
    { "name": "RCON_PASSWORD", "label": "RCON password", "generate": "password", "default": "" }
  ],
  "ports": [
    { "name": "game",  "default": 27015, "protocol": "udp" },
    { "name": "query", "default": 27016, "protocol": "udp", "offset": 1 }
  ],
  "install": [
    { "type": "steamcmd", "appid": "123456", "label": "Install the server" },
    { "type": "chmod", "path": "./srcds_run", "mode": "+x" }
  ],
  "startCommand": "./srcds_run -port {{PORT}} +maxplayers {{MAX_PLAYERS}}",
  "stopCommand": "quit",
  "stopTimeout": 45,
  "query": { "type": "a2s", "port": "query" },
  "rcon": { "type": "source", "port": "rcon" },
  "logPatterns": { "ready": "Server started", "join": "(\\w+) connected", "leave": "(\\w+) disconnected" }
}
```

**Install step types:** `apt`, `java`, `steamcmd`, `download`, `extract`, `writeFile`, `mkdir`, `chmod`, `script` (raw bash).
Inside `script` steps you get helpers: `gp_fetch URL DEST`, `gp_extract FILE`, `gp_apt PKG…`, `gp_ensure_java 21`, `gp_steam_app APPID`, `gp_log`, `gp_die`.

**Placeholders** available everywhere: `{{PORT}}`, `{{PORT_<NAME>}}`, `{{MEMORY}}`, `{{SERVER_NAME}}`, `{{SERVER_DIR}}`, `{{SERVER_ID}}`, `{{MAX_PLAYERS}}`, plus every variable you declare.

**Config handling:** `configFiles` writes files on install (`mode: "create"` keeps existing user edits, `"overwrite"` replaces). `patchProperties` re-applies only the keys you list before every start — that is how port changes reach `server.properties` without clobbering everything else. Supported formats: `properties`, `ini`, `json`.

**Query types:** `minecraft`, `bedrock`, `a2s`, `tcp`, `udp`, `none`.

## Security notes

Please read this before exposing the panel to the internet.

- **Put it behind HTTPS.** Sessions are cookie-based; over plain HTTP on a hostile network they can be sniffed.
- **Game servers run as the `gamepanel` user**, not root and not in containers. They are isolated from the rest of the system but not from each other. This is the deliberate trade-off that makes setup a single command; if you rent servers to untrusted third parties, use something container-based instead.
- The `gamepanel` user has passwordless sudo for `apt-get` and `dpkg` only, so game templates can install runtimes. Remove `/etc/sudoers.d/gamepanel` if you would rather install dependencies yourself.
- Admin users can edit start commands and install scripts, which means admin access is effectively shell access as the `gamepanel` user. Give the admin role only to people you trust; use the restricted role for everyone else.
- Passwords are hashed with scrypt; sessions are HMAC-SHA256 signed and expire after 7 days. Failed logins are rate limited per IP.

## About the metrics

CPU and memory are read per process group from `/proc`, so a launcher script that forks the real game binary is still measured correctly. CPU is reported the way `top` does it: 100% means one full core.

Network throughput is measured **host-wide** (`/proc/net/dev`); per-server bandwidth is not shown, because Linux does not expose per-process byte counters without container network namespaces or eBPF. Each server does report its **established TCP connection count**, which is the useful signal in practice.

## Troubleshooting

**The panel will not start**
```bash
journalctl -u gamepanel -n 50 --no-pager
```

**A game server will not install** — open its console; the installer streams every command it runs. The usual causes are a missing App ID, a game with no anonymous SteamCMD access, or not enough disk space.

**Players cannot connect** — check the port in the server's Settings tab, then confirm it is open in both `ufw` *and* your provider's firewall (Oracle, AWS and Hetzner all have their own). UDP games need UDP rules.

**Player count shows `—`** — the game either has no query protocol, or its query port differs from the default. Both are adjustable in Settings.

**Console is empty for a Unity/Unreal game** — some engines only log to a file. Use the file manager to read the log, or add `-logfile /dev/stdout` to the start command.

## API

Everything the UI does is a documented REST call — automate freely. Authenticate with the session cookie or `Authorization: Bearer <token>` from `POST /api/auth/login`.

```
GET    /api/servers                      list servers
POST   /api/servers                      create + install
GET    /api/servers/:id                  details
PATCH  /api/servers/:id                  update settings
DELETE /api/servers/:id                  delete
POST   /api/servers/:id/power            {"action":"start|stop|restart|kill"}
POST   /api/servers/:id/command          {"command":"say hello"}
GET    /api/servers/:id/console          scrollback
GET    /api/servers/:id/history          metrics history
GET    /api/servers/:id/query            live player count / ping
GET    /api/servers/:id/files?path=      file manager
GET    /api/servers/:id/backups          backups
GET    /api/system                       host metrics
GET    /api/templates                    template catalogue
```

`WS /ws` streams `servers`, `stats`, `system`, `server:status` and `console:<id>` topics.

## License

MIT — see [LICENSE](LICENSE). Do whatever you want with it.
