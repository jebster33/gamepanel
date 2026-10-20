# Command line (`gamepanel`)

A small command for scripting the panel: start and stop servers, send console commands, make backups, run updates. It is installed with the panel (Linux: `/usr/local/bin/gamepanel`; Windows: the install folder is added to PATH, open a new terminal). It has no dependencies and talks to the [HTTP API](../api.md), so it works against a remote panel too.

## Sign in

1. In the panel, open **Account → API keys** and create a key (read-only keys can list and read, nothing else).
2. Run `gamepanel login`. It asks for the panel address (default `http://127.0.0.1:8420`) and the key, and checks them.

The key is saved to `~/.config/gamepanel/cli.json` (Windows: `%APPDATA%\gamepanel\cli.json`), readable by your account only. `gamepanel logout` deletes it. For scripts and CI, skip the file: set `GP_URL` and `GP_API_KEY`, or pass `--url`.

## Commands

```
gamepanel list [--json]
gamepanel status
gamepanel start|stop|restart <server>
gamepanel kill <server> [-y]
gamepanel command <server> say hello everyone
gamepanel console <server> [-n 50] [-f]
gamepanel backup <server> [label]
gamepanel backups <server>
gamepanel update game <server>      # SteamCMD game files
gamepanel update mods <server>      # every mod with a newer compatible release
gamepanel update panel [-y]
```

`<server>` is its id, its name, or the start of a name that is unique. `console -f` keeps following the output until you press Ctrl+C.

Example, a nightly restart with a backup (cron or Task Scheduler):

```
gamepanel stop survival && gamepanel backup survival nightly && gamepanel start survival
```

## What it leaves out

Restores, deletes and wipes are not in the CLI; do them from the panel, where the confirmation steps live. `kill` and `update panel` ask for a yes first (`-y` skips it in scripts). An API key acts as your account, so it can do what you can, minus account changes.
