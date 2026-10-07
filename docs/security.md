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

## Bridge

The bridge (Settings → GamePanel Bridge) is off until an administrator turns it
on. While it is on, `/bridge/tunnel` accepts WebSocket connections that run
TLS 1.3 pinned to the panel's own key, and each connection may reach only the
ports it was given. See [bridge.md](bridge.md) for the full model.

## Hardening notes

Things that were tightened after a security review, and what is still on you:

- **Files in a server's folder are not trusted.** A game, a mod or someone with file access can put
  symlinks, FIFOs and edited records (`.gamepanel/*.json`) in there. The panel never follows a link out of
  the server folder when unpacking, backing up, restoring or pushing from a staging copy, reads such
  files without waiting on special files, and only believes plain file names in its own records.
- **API keys are scripts, not people.** They cannot change accounts, 2FA, passkeys or who can reach a
  server (also through a node's proxy), read-only keys cannot send console commands or read stored
  tokens, and a key is only as safe as where you keep it.
- **First-run setup needs a code** (printed in the log) unless it comes from the machine itself.
- **"Require two-factor for administrators"** counts a passkey as the second factor only when the
  administrator signs in *with* the passkey: a password alone is not enough.
- **Non-administrators** cannot pick privileged ports, run wipes without the permissions to do it
  directly, or point a world folder at another server.
- **Containers matter.** On Linux with Docker, a malicious mod or plugin is contained to its server's
  folder. Without it (Windows, or Settings → run as processes) games run as the panel's own account, and
  anyone who may upload files to a server can run code there. Only give file access to people you trust
  that far, or turn containers on.
- **Wake on join** lets anyone who knows a whitelisted name (or anyone, with the whitelist off) start a
  stopped server, at most once a minute. Leave it off for servers you do not want started by strangers.
- **Backup copies on another node** use that node's administrator API key. Use `https://` between
  machines you do not trust, and give each panel its own node key: copies are filed under the key that
  sent them, so one key cannot read, overwrite or delete another's. (Copies stored by an older version
  sit under the sender's own panel id and are not listed any more; move the folders under
  `backups-from-nodes/` into `k<key id>-<panel id>/` if you need them.)
- **Start-command arguments.** A setting that sits unquoted in a game's command line cannot contain
  spaces for a sub-user, so it stays one argument. Settings are still a trusted permission.
- **Sessions.** Signing out ends that session on the server, not only in the browser. A password change
  or "sign out everywhere" also revokes the account's API keys. Sign-in answers do not carry the session
  token (it lives in the cookie), a two-factor ticket works once, and adding or removing a passkey asks
  for the password.
- **Tokens in the settings** (the Discord bot, Cloudflare, node keys, the S3 secret and sign-in provider
  secrets) are sealed with a key derived from `secret.key`, like server passwords. They are converted
  the first time an updated panel starts, and the settings page never gets them back.
- **Public ban appeals** answer the same whether or not a name is banned, and a ban keeps at most three
  open appeals, so a junk appeal does not use up the real one.

