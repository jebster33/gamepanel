# Security

Please read this before exposing the panel to the internet.

- **Put it behind HTTPS.** Sessions are cookie-based; over plain HTTP on a hostile network they can be sniffed.
- **The panel user is in the `docker` group, which is equivalent to root on the host.** That is how it manages containers. Anyone who can run code as `gamepanel` (i.e. any panel administrator) can therefore reach root. Give the admin role only to people you trust with the machine; use the restricted role for everyone else.
- Game servers themselves run unprivileged, in containers, as a non-root uid, with `no-new-privileges` — so *players* and game exploits are contained.
- The `gamepanel` user has passwordless sudo for `apt-get`, `dpkg` and restarting its own service only. Remove `/etc/sudoers.d/gamepanel` if you would rather do those by hand.
- Passwords are hashed with scrypt; sessions are HMAC-SHA256 signed and expire after 7 days. Failed logins are rate limited per IP.
- The file manager resolves symlinks before every operation, so a link inside a
  server directory cannot be used to reach the rest of the machine — and archives
  containing symlinks, absolute paths or `..` are refused rather than unpacked.
- `panel.json` is written `0600`; it holds password hashes, RCON passwords and any
  API keys you add.
- Secrets substituted into a start command are masked in the console and log file.
- State-changing requests are refused if they carry a foreign `Origin`, on top of
  the SameSite=Lax session cookie.
- The **settings** capability lets a user change variables that are handed to the
  game process, so treat it as trusted. Only administrators can edit the raw start
  command.
- API keys you add under Integrations are stored in plain text in `panel.json` (mode 0600 directory). They are per-panel, not per-user.

## How isolation works

Each server gets:

- a container from the template's image (`eclipse-temurin` for Java games, `cm2network/steamcmd` for Steam games, and so on), with the server directory bind-mounted at `/home/container`
- `Memory` and `MemorySwap` set to the server's limit — a leaking server gets OOM-killed instead of taking the host down
- `NanoCpus` from the optional CPU limit
- its own bridge network `gp-net-<id>`; companion containers join it with a DNS alias (`db`), so one server's database is unreachable from another
- `no-new-privileges`, a non-root uid matching the panel user, and dropped capabilities

Templates that need extra runtime packages declare them in `packages`, and the panel builds a small cached layer on top of the base image (installing packages during a game *install* would not survive, since the install container is thrown away).

**Not using Docker?** The panel falls back to supervised child processes in their own process groups. Everything works, but servers share the host's filesystem, RAM and network, and per-server bandwidth is not available. The toggle lives in Settings → Runtime.

## Windows

- The panel runs as a Windows service under the LocalSystem account, so it can
  install the Visual C++ and DirectX runtimes games need and add firewall rules
  for their ports. Game servers it starts run with the same rights. Treat panel
  administrators as administrators of the PC, and give everyone else the
  restricted role.
- Windows has no container isolation for game servers yet: they are normal
  processes with their own folders under `C:\ProgramData\GamePanel\servers`.
  Docker Desktop is not used for Windows game builds.
- The panel opens only its own port (8420 by default) in Windows Firewall at
  install. Game ports are opened from each server's Settings tab, never on their own.
