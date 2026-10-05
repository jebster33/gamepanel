# Writing a template

A template is one JSON file that tells the panel how to install, start, stop
and watch a game. Drop it into the panel's `templates` folder inside its data
directory (`/var/lib/gamepanel/templates` on Linux, `C:\ProgramData\GamePanel\templates`
on Windows) and press **Reload templates** in Settings.

The 41 built-in templates in [`templates/`](../templates) are the best examples.

## The shape

```json
{
  "id": "my-game",
  "name": "My Game",
  "category": "Shooter",
  "icon": "🎯",
  "description": "One or two sentences shown on the Games page.",
  "platforms": ["linux", "windows"],
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
    { "type": "chmod", "path": "./mygame_server", "mode": "+x" }
  ],
  "startCommand": "./mygame_server -port {{PORT}} -maxplayers {{MAX_PLAYERS}}",
  "stopCommand": "quit",
  "query": { "type": "a2s", "port": "query" },
  "logPatterns": { "ready": "Server started", "join": "(\\w+) connected", "leave": "(\\w+) disconnected" },

  "windows": {
    "install": [
      { "type": "steamcmd", "appid": "123456" },
      { "type": "vcredist" }
    ],
    "startCommand": "MyGameServer.exe -port {{PORT}} -log logs\\server.log",
    "tailFiles": ["logs/server.log"]
  }
}
```

## Linux and Windows

`platforms` lists where the template runs (default `["linux"]`). Everything at
the top level is the Linux version; a `windows` block overrides only the keys
that differ. These keys can be overridden per platform:

`install`, `update`, `startCommand`, `stopCommand`, `stopSignal`, `stopTimeout`,
`configFiles`, `patchProperties`, `logPatterns`, `resolve`, `image`, `packages`,
`env`, `query`, `rcon`, `sidecars`, `notes`, `consoleInput`, `consoleNewline`,
`stopRconCommand`, `tailFiles`, `readyOnPort`, `joinNote`, `defaultMemory`,
`container`, plus `variables` (merged by name) and `mods` (merged).

On Windows the start command runs through `cmd.exe`, so no `./`, `export` or `$(…)`.
`npm test` flags those.

## Install steps

| Step | Linux | Windows | What it does |
|---|:-:|:-:|---|
| `steamcmd` | ✓ | ✓ | Install or update a Steam app (`appid`, optional `branch`, `login`) |
| `workshop` | ✓ | ✓ | Download Workshop items with SteamCMD |
| `download` | ✓ | ✓ | Fetch a URL to `dest` |
| `fetchlist` | ✓ | ✓ | Fetch a list of `{url, path}` files (resolvers use it for modpacks) |
| `extract` | ✓ | ✓ | Unpack zip, tar.gz, tar.xz or 7z |
| `copy`, `remove`, `mkdir` | ✓ | ✓ | File housekeeping inside the server folder |
| `writefile` | ✓ | ✓ | Write a file with placeholders filled in |
| `run` | ✓ | ✓ | Run a command (bash on Linux, cmd on Windows) |
| `java` | ✓ | ✓ | Make sure a Java runtime of `version` or newer exists |
| `apt` | ✓ | | Install Debian packages |
| `chmod` | ✓ | ✓ | Make a file executable (no-op on Windows) |
| `script` | ✓ | | Raw bash, with helpers: `gp_fetch`, `gp_extract`, `gp_apt`, `gp_ensure_java`, `gp_steam_app`, `gp_log`, `gp_die` |
| `powershell` | | ✓ | Raw PowerShell, with `GP-Log` |
| `vcredist`, `directx` | | ✓ | Install the Visual C++ or DirectX runtime if missing |

## Placeholders

`{{PORT}}`, `{{PORT_<NAME>}}`, `{{MEMORY}}`, `{{SERVER_NAME}}`, `{{SERVER_DIR}}`,
`{{SERVER_ID}}`, `{{MAX_PLAYERS}}`, every variable you declare, and what a
resolver returns (`DOWNLOAD_URL`, `RESOLVED_VERSION`, `GAME_VERSION`, `LOADER`…).

## Knowing when a server is ready

- `logPatterns.ready` marks the server running when a console line matches.
- `tailFiles` follows log files into the console, for games that print nothing
  to stdout (common on Windows). One `*` is allowed in the file name; the newest match wins.
- `readyOnPort` marks the server running once it has bound its game port
  (`true` for the first port, or a port name).

## Mods

```json
"mods": { "providers": ["modrinth", "curseforge"], "dir": "mods", "loader": "fabric", "gameVersionVar": "MC_VERSION" }
```

Providers: `modrinth`, `curseforge`, `umod`, `workshop`, `factorio`. The panel
filters every search and install by the loader and game version, and installs
required dependencies with the mod.

For the Steam Workshop, `mods.workshop` says how the game loads items:

| `strategy` | Used by | How |
|---|---|---|
| `copy` (default) | most games | Downloads into `dir` |
| `gma` | Garry's Mod | Extracts the `.gma` into `addons` |
| `list` | Unturned, ARK | Writes the item ID into the game's own mod list (`file`, `key`) and lets the game download it |
| `zomboid` | Project Zomboid | Adds `WorkshopItems=` and `Mods=` to the server ini |

## Other keys

- `configFiles` writes files on install (`mode: "create"` keeps user edits, `"overwrite"` replaces).
- `patchProperties` re-applies listed keys before every start (`properties`, `ini`, `json`).
- `wizard`: `[{ "title", "description", "fields": ["VAR", …] }]` turns the create form into steps (see `fivem.json`).
- `sidecars` start companion containers, such as a private MariaDB for FiveM.
- `container: false` forces a plain process even when Docker is available.

## CI

Every template is installed, booted and stopped on real Linux and Windows
runners by `.github/workflows/games.yml`. A `ci` block tunes that:

```json
"ci": {
  "vars": { "MC_VERSION": "1.21.1" },
  "installOnly": "needs a license key to boot",
  "bootTimeout": 900,
  "mods": [{ "provider": "modrinth", "projectId": "ledger", "expectAtLeast": 3 }],
  "windows": { "vars": { } }
}
```
