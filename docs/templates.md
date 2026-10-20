# Writing a template

A template is one JSON file that tells the panel how to install, start, stop
and watch a game. Drop it into the panel's `templates` folder inside its data
directory (`/var/lib/gamepanel/templates` on Linux, `C:\ProgramData\GamePanel\templates`
on Windows) and press **Reload templates** in Settings.

The 61 built-in templates in [`templates/`](../templates) are the best examples.

## The template builder

No need to write the JSON by hand: **Games → Build a game** (administrators) is a form for all of the
common parts: name, ports, the settings asked when a server is created, install steps (SteamCMD, download,
unpack, run a command, write a file, make executable, Java, Linux packages, copy, delete, script), the start
command, how it stops, the line it prints when ready and the status check. Start from nothing, a Steam
game, a zip download, or a copy of any game already in the panel. **Check** lists mistakes (unknown step
types, missing fields, bad ports, regexes that do not compile, `{{PLACEHOLDERS}}` nothing fills in) and
shows the install script it would run. **Edit as JSON** covers everything else on this page. Saved games
go to the data directory's `templates` folder and get an **Edit** button on the Games page.

## Import a Pterodactyl egg

**Games → Import egg** (administrators) turns a Pterodactyl or Pelican egg into a game. Choose the egg's `.json` file, paste a link
to it (an `https://` address; GitHub page links work) or paste the JSON. The panel converts it, lists what it changed and what it
could not carry over, and opens the result in the template builder so you can review and **Add game**. Imported games are marked
*Imported*, sit in the **Imported** category and are administrator-only: the egg's install script and start command run as code,
so only import eggs you trust.

| Egg | Becomes |
|---|---|
| Startup command | `startCommand`. `{{SERVER_MEMORY}}` / `${SERVER_MEMORY}` become `{{MEMORY_MB}}`, `SERVER_PORT` becomes `{{PORT}}`, `SERVER_IP` becomes `{{IP}}` |
| Variables | Settings. `in:a,b` rules become a dropdown, `numeric`/`integer` a number box. A name the panel uses itself gets an `EGG_` prefix |
| Docker image | `image` (the first one if the egg lists several) |
| Install script | A `script` install step, with `/mnt/server` replaced by the server folder. It runs in the game's image with bash |
| `config.startup.done` | The "ready" console line |
| `config.stop` | `^C` becomes SIGINT, other text becomes the stop command |
| `config.files` (properties, ini, json) | `patchProperties`, re-applied on every start |

Not carried over, and shown in the import report: egg features (such as `eula`), the file denylist, yaml/xml/line-replace config
parsers, `STARTUP`-style variables, Alpine (`apk`) install scripts, a second install image, and extra ports (an egg only has one
allocation, so the game gets one `game` port, default 25565; add others in the builder).

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

## Game settings (rules)

Give a variable a `"group"` (for example `"Rules"`, `"Rates"`, `"World"`) and the panel treats it as an everyday
game setting: it sits in a collapsed *More game settings* section when deploying, and in a *Game settings* card
on the server's Settings tab, with its label, description and dropdown. `options` makes a dropdown and
`"type": "number"` a number box. A server made before a variable existed uses its `default`.

Wire the variable in wherever the game reads it: a start-command argument, `patchProperties` (re-applied on every
start, so changes take effect on restart) or a `configFiles` entry with `"mode": "overwrite"`. For Source games,
`presets` (`[{ "id", "label", "description", "vars": { NAME: value } }]`) add a Preset dropdown that fills in several settings at once, and `readyCommands` are console commands sent a few seconds after the server is up (Rust's gather rate). For Source games, write the cvars to a cfg and `+exec` it; a blank value leaves the game default alone (see `tf2.json`).

## Install steps

| Step | Linux | Windows | What it does |
|---|:-:|:-:|---|
| `steamcmd` | ✓ | ✓ | Install or update a Steam app (`appid`, optional `branch`, `login`, and `platform: "windows"` to fetch the Windows build for Wine) |
| `workshop` | ✓ | ✓ | Download Workshop items with SteamCMD (optional `login`) |
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
| `bohemia` | Arma 3, DayZ | Downloads into an `@id` folder, copies its `.bikey` files into `keys` (lowercases names on Linux with `lowercase: true`), and fills `{{WORKSHOP_MODS}}` for `-mod=` |
| `modlist` | Conan Exiles | Copies the item's `.pak` files into `dir` and lists them in `file` (modlist.txt) |
| `tmodloader` | tModLoader | Copies the newest `.tmod` into `dir` and switches it on in `file` (enabled.json) |
| `spaceengineers` | Space Engineers | Adds the item to `<Mods>` in `file` and in every world matching `worlds`; the game downloads it |
| `dst` | Don't Starve Together | Adds `ServerModSetup` to `file` and enables it in each `overrides` modoverrides.lua |
| `kf2` | Killing Floor 2 | Adds a `ServerSubscribedWorkshopItems=` line to every ini matching `file` (KFEngine.ini) and puts the Steam Workshop download manager first; the game downloads it |
| `avorion` | Avorion | Adds `{workshopid = "id"}` to `mods` in `file` (the galaxy's modconfig.lua); the game downloads it |

Games that only hand Workshop files to an account that owns them set `mods.workshop.login`, e.g.
`"{{STEAM_USER}} {{STEAM_PASSWORD}}"`. Mark a variable `"secret": true` and the panel encrypts it at rest (AES-256-GCM, keyed from `secret.key`), never sends it back to the browser, and hands Steam logins to SteamCMD through the environment instead of the install script.

## Other keys

- `configFiles` writes files on install (`mode: "create"` keeps user edits, `"overwrite"` replaces).
- `patchProperties` re-applies listed keys before every start (`properties`, `ini`, `json`, and `tuple` for a single
  `Key=(A=1,B=2)` line named by `key`, like Palworld's `OptionSettings`). A missing file is
  skipped unless `createIfMissing` is set or `seedFrom` names a default to start from (Eco's `Network.eco.template`).
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

## Administrator-only templates

`"adminOnly": true` keeps a template away from people who create their own servers within a quota. Use it
when a variable is a command or a script (like the custom-command and generic SteamCMD templates), since
whatever it holds runs on the host.

## Ready-made setups

A setup is a template plus what makes it a particular kind of server, deployed in one click from the Games
page. The built-in ones are in [`setups/`](../setups); put your own in the panel's data folder under `setups/`.

```json
{
  "id": "my-smp",
  "name": "Our SMP",
  "templateId": "minecraft-paper",
  "description": "Shown on the card.",
  "tags": ["Minecraft"],
  "memory": 4096,
  "vars": { "MC_VERSION": "26.1.2" },
  "mods": [{ "provider": "modrinth", "projectId": "luckperms" }],
  "gameSettings": { "difficulty": "hard" },
  "schedules": [{ "name": "Backup", "action": "backup", "cron": "0 */6 * * *" }]
}
```

The game installs first; the mods, game settings and schedules are added when it finishes, and the console
says how each one went. Pin `vars` to a game version every mod supports, since mods are only installed in
builds made for the server's version.
