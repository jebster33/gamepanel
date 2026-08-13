# 🎮 GamePanel

A self-hosted game server control panel for Ubuntu — Pterodactyl-style isolation and features, without Docker Compose files, MySQL, PHP, Redis, a separate daemon or a two-hour setup guide.

**One command to install. One web UI to run every game server on your box.**

```bash
curl -fsSL https://raw.githubusercontent.com/jebster33/gamepanel/main/install.sh | sudo bash
```

Then open `http://your-server-ip:8080` and create your admin account. That's the whole setup — Docker, Node.js, the service and the firewall rules are handled for you.

---

## Why this exists

Pterodactyl is excellent, but it needs Docker, MySQL, Redis, PHP-FPM, nginx, a queue worker, a separate Wings daemon and a domain with SSL before you can boot a single Minecraft server. GamePanel is **one Node.js process with zero npm dependencies** that talks to the Docker Engine API directly. No build step, no database server, no compose files.

You still get the thing that actually matters: **every game server runs in its own container**, with its own filesystem view, process table, network namespace and hard memory/CPU limits. One server crashing, leaking memory or eating CPU cannot touch the others.

## Features

**Isolation (containers)**
- Each server runs in its own Docker container with a hard memory cap, optional CPU quota and its own private network
- Companion containers on demand — a FiveM server can get its own private MariaDB with one click
- Accurate **per-server network usage**, which is only possible with a network namespace
- Containers keep running when the panel restarts or updates; the panel re-attaches to them, consoles and all
- No Docker on the box? Everything still works as supervised child processes, minus the isolation

**Dashboard**
- Live CPU, memory, disk and network for the host, and CPU/RAM/players/ping/network/connections per server
- Streams over WebSockets, with an automatic polling fallback for proxies that block them
- Crash detection with counters, an activity log and exponential-backoff auto-restart

**Server management**
- Start / stop / restart / force-kill, and a live console you can type into (stdin or RCON)
- One-click `.tar.gz` backups with restore and download
- Auto-start on boot, per-server memory limits, port allocation and template variables

**File explorer**
- Browse, edit, rename, move, delete, multi-select
- **Drag and drop upload** straight into any folder
- **Unpack** `.zip` / `.tar.gz` / `.tar.xz` archives in place, or compress a selection into an archive
- Everything is sandboxed to the server's own directory

**Mod manager**
- Browse and install mods without leaving the panel:
  | Source | Games | Key needed |
  |---|---|---|
  | **Modrinth** | Minecraft mods, plugins, datapacks | no |
  | **CurseForge** | Minecraft | free key |
  | **uMod / Oxide** | Rust (and other Oxide games) | no |
  | **Steam Workshop** | Garry's Mod, ARK, Unturned… | only for searching |
  | **Factorio Mod Portal** | Factorio | only for downloading |
- Searches are filtered automatically by the server's loader and game version
- Installed mods can be disabled (renamed to `.disabled`) or deleted from the same screen

**Updates**
- Settings → Panel updates shows exactly which commits you are missing and updates in place
- Containerised game servers **stay online** through a panel update
- Or from the shell: `sudo /opt/gamepanel/update.sh`

**Users & permissions**
- Assign specific servers to a user, then tick exactly what they may do on them:
  power, console, send commands, edit settings, browse files, write files,
  manage mods, create backups, restore backups — plus panel-level access to the
  activity log and template catalogue
- Anything not granted is hidden in the UI *and* refused by the API
- Activity log records sign-ins with IP and (optionally) their location
- scrypt password hashing, HMAC-signed session cookies, login rate limiting

## Included templates

| Category | Games |
|---|---|
| **Minecraft** | Paper · Vanilla · Fabric · Bedrock |
| **Roleplay** | **FiveM** (guided setup with txAdmin) |
| **Survival** | Rust (with uMod) · Valheim · Palworld · ARK · 7 Days to Die · Project Zomboid · Enshrouded · V Rising · Unturned · Core Keeper |
| **Shooter** | Counter-Strike 2 · Team Fortress 2 · Left 4 Dead 2 · Squad · Insurgency: Sandstorm |
| **Sandbox** | Garry's Mod · Terraria · Factorio · Satisfactory · Necesse |
| **Universal** | Any Steam game (by App ID) · Custom server (any install script + start command) |

Missing a game? The two universal templates cover it today, and a real template is ~30 lines of JSON (see below).

### FiveM

The FiveM template runs a step-by-step wizard instead of one big form:

1. **Server basics** — name, slots, tags
2. **License key** — with instructions for generating one at keymaster.fivem.net
3. **Framework** — txAdmin (recommended: deploy ESX/QBox from its web UI) or plain cfx-server-data
4. **Database** — optionally start a private MariaDB container for this server, reachable as host `db`

It downloads the recommended Cfx.re artifacts, clones `cfx-server-data`, writes a `server.cfg` with your key and RCON password, and exposes txAdmin on its own port. Resources go in `server-data/resources` — drag a zip into the file explorer and hit Unpack.

## Requirements

- Ubuntu 22.04 / 24.04 (Debian 12 works too)
- Root access for the installer
- Docker — installed automatically, and optional (see isolation notes below)
- Node.js 18+ — installed automatically if missing
- Enough RAM and disk for the games you plan to run (Rust and ARK want 8–16 GB and tens of gigabytes of disk)

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/jebster33/gamepanel/main/install.sh | sudo bash
```

The installer:
1. installs base packages, Node.js 20 and Docker Engine if they are missing,
2. creates the `gamepanel` system user and adds it to the `docker` group,
3. clones the panel to `/opt/gamepanel` and creates `/var/lib/gamepanel`,
4. grants that user a narrow passwordless sudo rule (`apt-get`, `dpkg`, and restarting its own service),
5. installs and starts the `gamepanel` systemd service,
6. opens the panel and default game ports in `ufw` if it is active.

Re-running the same command updates an existing installation.

**Options**

```bash
# custom port
curl -fsSL .../install.sh | sudo GP_PORT=9000 bash

# skip Docker entirely (plain processes, no isolation)
curl -fsSL .../install.sh | sudo GP_SKIP_DOCKER=1 bash
```

### Manual install

```bash
git clone https://github.com/jebster33/gamepanel.git
cd gamepanel
node server/index.js
```

No `npm install` — there are no dependencies. The panel listens on `:8080` and stores state in `./data` when it cannot write to `/var/lib/gamepanel`.

## Updating

| How | What happens |
|---|---|
| **Settings → Panel updates** | Shows the pending commits, updates and restarts the panel |
| `sudo /opt/gamepanel/update.sh` | Same thing from the shell |
| Re-run `install.sh` | Also refreshes Docker/Node/systemd bits |

With containers, an update is invisible to your players: the panel stops, pulls the new code, restarts and re-attaches to the still-running game containers. Servers running as plain processes are children of the panel, so those *are* restarted.

## How isolation works

Each server gets:

- a container from the template's image (`eclipse-temurin` for Java games, `cm2network/steamcmd` for Steam games, and so on), with the server directory bind-mounted at `/home/container`
- `Memory` and `MemorySwap` set to the server's limit — a leaking server gets OOM-killed instead of taking the host down
- `NanoCpus` from the optional CPU limit
- its own bridge network `gp-net-<id>`; companion containers join it with a DNS alias (`db`), so one server's database is unreachable from another
- `no-new-privileges`, a non-root uid matching the panel user, and dropped capabilities

Templates that need extra runtime packages declare them in `packages`, and the panel builds a small cached layer on top of the base image (installing packages during a game *install* would not survive, since the install container is thrown away).

**Not using Docker?** The panel falls back to supervised child processes in their own process groups. Everything works, but servers share the host's filesystem, RAM and network, and per-server bandwidth is not available. The toggle lives in Settings → Runtime.

## Everyday use

| What | Command |
|---|---|
| Service status | `systemctl status gamepanel` |
| Restart the panel | `sudo systemctl restart gamepanel` |
| Follow panel logs | `journalctl -u gamepanel -f` |
| See the containers | `docker ps --filter label=gamepanel.managed=true` |
| Update | `sudo /opt/gamepanel/update.sh` |
| Uninstall (keep game data) | `sudo /opt/gamepanel/uninstall.sh` |
| Uninstall everything | `sudo /opt/gamepanel/uninstall.sh --purge` |

**Layout**

```
/opt/gamepanel            panel source (a git checkout — this is what updates)
/var/lib/gamepanel/
├── panel.json            all panel state (users, servers, settings)
├── secret.key            session signing key
├── servers/<id>/         one directory per game server (mounted into its container)
├── backups/<id>/         .tar.gz backups
├── templates/            your custom templates
└── logs/                 per-server console logs
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GP_PORT` | `8080` | Panel HTTP port |
| `GP_HOST` | `0.0.0.0` | Bind address |
| `GP_DATA_DIR` | `/var/lib/gamepanel` | Where everything is stored |
| `GP_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker Engine socket |
| `GP_BEHIND_PROXY` | `0` | Trust `X-Forwarded-For` / `X-Forwarded-Proto` |
| `GP_METRICS_INTERVAL` | `2000` | Metrics sampling interval (ms) |
| `GP_QUERY_INTERVAL` | `15000` | Player-count query interval (ms) |
| `GP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Putting it behind HTTPS

```
panel.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

That is the whole Caddy config. Then set `GP_BEHIND_PROXY=1` and restart. nginx works too — remember `proxy_set_header Upgrade`/`Connection` so the WebSocket console keeps working.

## Writing your own template

Drop a JSON file into `/var/lib/gamepanel/templates/` and hit *Reload templates* in Settings.

```json
{
  "id": "my-game",
  "name": "My Game",
  "category": "Shooter",
  "icon": "🎯",
  "image": "cm2network/steamcmd:root",
  "packages": ["libsdl2-2.0-0"],
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
  "query": { "type": "a2s", "port": "query" },
  "rcon": { "type": "source", "port": "rcon" },
  "mods": { "providers": ["workshop"], "dir": "addons", "appId": 123456 },
  "logPatterns": { "ready": "Server started", "join": "(\\w+) connected", "leave": "(\\w+) disconnected" }
}
```

**Install steps:** `apt`, `java`, `steamcmd`, `download`, `extract`, `writeFile`, `mkdir`, `chmod`, `script` (raw bash).
Helpers available in `script` steps: `gp_fetch URL DEST`, `gp_extract FILE`, `gp_apt PKG…`, `gp_ensure_java 21`, `gp_steam_app APPID`, `gp_log`, `gp_die`.

**Placeholders:** `{{PORT}}`, `{{PORT_<NAME>}}`, `{{MEMORY}}`, `{{SERVER_NAME}}`, `{{SERVER_DIR}}`, `{{SERVER_ID}}`, `{{MAX_PLAYERS}}`, plus every variable you declare.

**Container fields:** `image` (base image), `packages` (runtime apt packages baked into a cached layer), `container: false` (force plain process), `sidecars` (companion containers), `protocol: "both"` (publish TCP *and* UDP on one port).

**Config handling:** `configFiles` writes files on install (`mode: "create"` keeps user edits, `"overwrite"` replaces). `patchProperties` re-applies only the listed keys before every start — that is how port changes reach `server.properties` without clobbering the rest. Formats: `properties`, `ini`, `json`.

**Wizards:** add a `wizard` array of `{ title, description, fields: ["VAR_NAME", …] }` to walk users through setup in steps instead of one long form (see `templates/fivem.json`).

**Mods:** `mods: { providers, dir, loader, gameVersionVar, appId, projectType }`. Providers: `modrinth`, `curseforge`, `umod`, `workshop`, `factorio`.

## Security notes

Please read this before exposing the panel to the internet.

- **Put it behind HTTPS.** Sessions are cookie-based; over plain HTTP on a hostile network they can be sniffed.
- **The panel user is in the `docker` group, which is equivalent to root on the host.** That is how it manages containers. Anyone who can run code as `gamepanel` (i.e. any panel administrator) can therefore reach root. Give the admin role only to people you trust with the machine; use the restricted role for everyone else.
- Game servers themselves run unprivileged, in containers, as a non-root uid, with `no-new-privileges` — so *players* and game exploits are contained.
- The `gamepanel` user has passwordless sudo for `apt-get`, `dpkg` and restarting its own service only. Remove `/etc/sudoers.d/gamepanel` if you would rather do those by hand.
- Passwords are hashed with scrypt; sessions are HMAC-SHA256 signed and expire after 7 days. Failed logins are rate limited per IP.
- API keys you add under Integrations are stored in plain text in `panel.json` (mode 0600 directory). They are per-panel, not per-user.

## About the metrics

In container mode, CPU, memory and **network** come from the Docker stats stream, so per-server bandwidth is real. CPU is normalised the way `docker stats` does it, and memory excludes page cache.

Without Docker, CPU and memory are read per process group from `/proc` (so a launcher script that forks the real binary is still measured correctly, `top`-style where 100% = one core), but **per-server bandwidth is not available** — Linux has no per-process byte counters without a network namespace. The host-wide graph and per-server connection counts still work.

## Troubleshooting

**The panel will not start**
```bash
journalctl -u gamepanel -n 50 --no-pager
```

**"Docker not found" in Settings → Runtime** — check `systemctl status docker`, and that the panel user is in the `docker` group (`id gamepanel`). Group changes need a service restart.

**A game server will not install** — open its console; the installer streams every command. Usual causes: wrong App ID, a game with no anonymous SteamCMD access, or no disk space.

**A container exits immediately** — `docker logs gp-<server-id>` shows what the game printed. A missing runtime library is the usual cause; add it to the template's `packages`.

**Players cannot connect** — check the port in Settings, then confirm it is open in both `ufw` *and* your provider's firewall (Oracle, AWS and Hetzner all have their own). UDP games need UDP rules.

**Console empty for a Unity/Unreal game** — some engines only log to a file. Read it in the file explorer, or add `-logfile /dev/stdout` to the start command.

## API

Everything the UI does is a REST call. Authenticate with the session cookie or `Authorization: Bearer <token>` from `POST /api/auth/login`.

```
GET    /api/servers                      list servers
POST   /api/servers                      create + install
POST   /api/servers/:id/power            {"action":"start|stop|restart|kill"}
POST   /api/servers/:id/command          {"command":"say hello"}
GET    /api/servers/:id/console          scrollback
GET    /api/servers/:id/history          metrics history
GET    /api/servers/:id/files?path=      file explorer
POST   /api/servers/:id/files/extract    unpack an archive
POST   /api/servers/:id/files/compress   pack a selection
GET    /api/servers/:id/mods             providers + installed mods
GET    /api/servers/:id/mods/search      search a provider
POST   /api/servers/:id/mods/install     install a mod
GET    /api/servers/:id/backups          backups
GET    /api/system                       host metrics
GET    /api/system/runtime               Docker status
GET    /api/system/update                pending panel updates
POST   /api/system/update                update and restart
```

`WS /ws` streams `servers`, `stats`, `system`, `server:status` and `console:<id>`.

## License

MIT — see [LICENSE](LICENSE). Do whatever you want with it.
