# Updating and uninstalling

## Updating

- **From the panel:** **Settings → Panel updates → Check for updates**.
- **Linux terminal:** `sudo /opt/gamepanel/update.sh`, or run the install command again.
- **Windows:** run `GamePanel-Setup.exe` or the PowerShell install line again.

Servers, backups, accounts and settings stay through every update. Container servers keep running while
the panel restarts.

## Uninstalling on Linux

```bash
sudo /opt/gamepanel/uninstall.sh
```

It lists what it will remove and asks you to type `YES`. By default that's **everything**: every game server
and world, all backups, panel users, Bridge connections and settings, the containers and images GamePanel
built, the program in `/opt/gamepanel` and the `gamepanel` account.

| | |
|---|---|
| `--keep-data` | Remove the program and service, keep servers and settings in `/var/lib/gamepanel` for a reinstall |
| `--yes` | Don't ask (for scripts) |

Docker itself and Node.js stay installed; remove them with `apt` if nothing else uses them.

## Uninstalling on Windows

**Settings → Apps → GamePanel → Uninstall** removes everything, after asking. To keep your servers and
settings, use PowerShell as Administrator instead:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Program Files\GamePanel\windows\uninstall.ps1" -KeepData
```

Leave out `-KeepData` to remove everything; add `-Yes` to skip the question.

Everything means the same as on Linux: servers, backups, accounts and settings in
`C:\ProgramData\GamePanel`, the service, the firewall rule and the program.

## Copies of the Bridge client

Friends who used [GamePanel Bridge](../bridge.md) type `uninstall` in the client window. It signs the
device out, removes what it saved and deletes itself. Once the panel is gone their client can't connect
anyway.
