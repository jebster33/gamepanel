# Install on Linux

Works on **Ubuntu** and **Debian** (anything with `apt-get`), on a home PC, a spare laptop or a VPS.
You need `sudo` and about 2 GB of free disk for the panel and Docker, plus whatever your games need.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/jebster33/gamepanel/main/install.sh | sudo bash
```

The script installs Node.js, Docker and the 32-bit libraries SteamCMD needs, creates a `gamepanel`
service account and a `gamepanel` systemd service. If `ufw` is active it opens the panel port and the
default game ranges (27000-27999 and 25565-25575).
When it finishes it prints the address to open, usually **http://&lt;server-ip&gt;:8420**.

Then carry on with [First setup](first-setup.md).

## Options

Put them between `sudo` and `bash`:

| Option | What it does |
|---|---|
| `GP_PORT=9000` | Run the panel on another port (default `8420`) |
| `GP_SKIP_DOCKER=1` | Don't install Docker. Servers run as normal processes, without memory caps or per-server network stats. |
| `GP_DATA_DIR=/srv/gamepanel` | Keep servers, backups and settings somewhere else (default `/var/lib/gamepanel`) |
| `GP_BRANCH=…` | Install another branch (for testing) |

```bash
curl -fsSL https://raw.githubusercontent.com/jebster33/gamepanel/main/install.sh | sudo GP_PORT=9000 bash
```

## Where things live

| | |
|---|---|
| Program | `/opt/gamepanel` |
| Servers, backups, settings, accounts | `/var/lib/gamepanel` |
| Service | `systemctl status gamepanel` |
| Logs | `journalctl -u gamepanel -f` |

## Docker or not

With Docker (the default) every game server runs in its own container with a hard memory limit, a CPU
cap if you set one, and its own network counters. Without Docker the panel runs servers as normal
processes owned by the `gamepanel` user. You can switch under **Settings → Runtime**; it applies the
next time each server starts.

> Anyone who controls the `gamepanel` account can control Docker, which is the same as root on that
> machine. Read [Security](../security.md) before giving anyone else a shell on it.

## HTTPS

The panel speaks plain HTTP. For a domain with HTTPS, put Caddy in front of it:

```
panel.example.com {
  reverse_proxy 127.0.0.1:8420
}
```

and add `GP_BEHIND_PROXY=1` to the service (`sudo systemctl edit gamepanel`, then
`[Service]` / `Environment=GP_BEHIND_PROXY=1`) so sign-in throttling sees real visitor addresses.
HTTPS is also what makes the [phone app](first-setup.md#phone-app) work away from home.

## Running from a checkout

For development, or a machine where you don't want a service:

```bash
git clone https://github.com/jebster33/gamepanel && cd gamepanel
node server/index.js
```

Node 20 or newer, no `npm install` needed.
