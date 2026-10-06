# Install on Windows

Works on **Windows 10, Windows 11 and Windows Server 2016 or newer**, 64-bit.

## Install

Pick one:

- **Setup.exe:** download `GamePanel-Setup.exe` from
  [Releases](https://github.com/jebster33/gamepanel/releases) and run it. SmartScreen may warn that the
  installer isn't signed yet: choose **More info**, then **Run anyway**.
- **PowerShell:** open PowerShell **as Administrator** and paste

  ```powershell
  irm https://raw.githubusercontent.com/jebster33/gamepanel/main/windows/install.ps1 | iex
  ```

Both install the same thing: a private copy of Node.js, a **GamePanel** Windows service that starts with
the computer, and a firewall rule for the panel port. Then open **http://localhost:8420** and carry on
with [First setup](first-setup.md).

## Options (PowerShell install)

Set them before the install line:

```powershell
$env:GP_PORT = 9000
$env:GP_INSTALL_DIR = 'D:\GamePanel'
irm https://raw.githubusercontent.com/jebster33/gamepanel/main/windows/install.ps1 | iex
```

| Option | Default |
|---|---|
| `GP_PORT` | `8420` |
| `GP_INSTALL_DIR` | `C:\Program Files\GamePanel` |

## Where things live

| | |
|---|---|
| Program | `C:\Program Files\GamePanel` |
| Servers, backups, settings, accounts | `C:\ProgramData\GamePanel` |
| Service | `Get-Service GamePanel`, `Restart-Service GamePanel` |
| Logs | `C:\ProgramData\GamePanel\logs` |

## How servers run on Windows

There is no Docker on Windows, so game servers run as normal processes under the service. A server's
memory limit isn't a hard cap there (it still counts toward alerts and the panel-wide limit), and
per-server bandwidth isn't measured.
Everything else (console, mods, backups, schedules, players, Bridge) works the same as on Linux.

## Portable, no service

Download `GamePanel-<version>-windows-x64.zip` from Releases, unzip it anywhere and run `start.cmd`.
It stops when you close the window.
