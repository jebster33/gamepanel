# Troubleshooting

**The panel will not start**
```bash
journalctl -u gamepanel -n 50 --no-pager
```

**"Docker not found" in Settings → Runtime** — check `systemctl status docker`, and that the panel user is in the `docker` group (`id gamepanel`). Group changes need a service restart.

**A game server will not install** — open its console; the installer streams every command. Usual causes: wrong App ID, a game with no anonymous SteamCMD access, or no disk space.

**A container exits immediately** — `docker logs gp-<server-id>` shows what the game printed. A missing runtime library is the usual cause; add it to the template's `packages`.

**Players cannot connect** — check the port in Settings, then confirm it is open in both `ufw` *and* your provider's firewall (Oracle, AWS and Hetzner all have their own). UDP games need UDP rules.

**Console empty for a Unity/Unreal game** — some engines only log to a file. Read it in the file explorer, or add `-logfile /dev/stdout` to the start command.

**Windows: the panel does not open** — check the service with `Get-Service GamePanel`, and read
`C:\ProgramData\GamePanel\logs\GamePanel-Service.out.log`. Restart it with `Restart-Service GamePanel`.

**Windows: SmartScreen warns about Setup.exe** — the installer is not code-signed yet. Choose
"More info", then "Run anyway", or use the PowerShell one-liner instead.

## About the metrics

In container mode, CPU, memory and **network** come from the Docker stats stream, so per-server bandwidth is real. CPU is normalised the way `docker stats` does it, and memory excludes page cache.

Without Docker, CPU and memory are read per process group from `/proc` (so a launcher script that forks the real binary is still measured correctly, `top`-style where 100% = one core), but **per-server bandwidth is not available** — Linux has no per-process byte counters without a network namespace. The host-wide graph and per-server connection counts still work.

## Making a server reachable

Two things usually sit between a player and your server, and each server's
**Settings → Reachability** card handles both:

- **The host firewall** — one click opens exactly that server's ports in `ufw`
  (the installer grants the panel a narrow sudo rule for it). The card shows
  each port as open, closed, or unfiltered.
- **Your router** — if it speaks UPnP, one click forwards the same ports to this
  machine and shows your public IP. If it does not, the card prints the exact
  rules to enter by hand, including the LAN address to forward to.

Nothing is opened unless you ask, and the same buttons close it all again.

## Locked out by two-factor sign-in

Lost the phone? Sign in with one of the recovery codes you saved (the "Recovery code" side of the sign-in
step), then make new ones under **Account**. Another administrator can also press **Reset 2FA** for you on
the Users page.

If nobody can sign in, turn it off from the machine itself. Stop the panel first, or it writes its own copy
back over the change:

```bash
sudo systemctl stop gamepanel
sudo node /opt/gamepanel/server/reset-2fa.js <username>
sudo systemctl start gamepanel
```

On Windows, in PowerShell opened as Administrator:

```powershell
Stop-Service GamePanel; $env:GP_SERVICE = 1
& "$env:ProgramFiles\GamePanel\node\node.exe" "$env:ProgramFiles\GamePanel\server\reset-2fa.js" <username>
Start-Service GamePanel
```

## Cloud backups

**Settings → Cloud backups → Test connection** writes, lists and deletes a small file, so the error you get
there is the bucket's own. The usual ones: `SignatureDoesNotMatch` (wrong secret key, or the region does not
match the endpoint), `NoSuchBucket` (bucket name typo), `AccessDenied` (the key is not allowed to write or
list that bucket). Uploads that fail are retried with the **Copy** button on the server's Backups tab and are
posted to Discord when that alert is ticked.
