# Config sync and servers as a file

Two ways to keep your setup written down. Both are under **Settings** and administrator-only.

## Servers as a file

What it is: all your servers described in one text file ("infrastructure as code"). You can export it, change it, then apply it in one go, on this panel or a fresh one.

1. Settings, **Servers as a file**, **Export current servers**. You get YAML like this:

   ```yaml
   version: 1
   prune: false
   servers:
     - name: Survival
       id: survival-ab12
       template: minecraft-paper
       memory: 4096
       ports:
         game: 25565
       vars:
         MOTD: Welcome
   ```

2. Edit it. Add a server by adding an entry with a `name` and a `template`. Change a setting by changing it. Fields you leave out are not touched. JSON works too.
3. **Preview plan** lists every server as created (`+`), updated (`~`), unchanged (`=`) or a problem (`!`), with each field's old and new value. Nothing happens yet.
4. **Apply** does it. Creates install like a normal new server. Running servers need a restart for changed ports, settings or memory; the result tells you which.

Rules: servers match by `id` first, then by name. Nothing is ever deleted unless the file says `prune: true`, and then you must confirm and the server folders stay on disk. A template cannot change (create a new server). Variables and ports are checked against the game template. **Secret variables** (passwords, tokens) are left out of exports and refused on apply: set them in the panel.

From a terminal: `gamepanel export > servers.yaml`, then `gamepanel apply servers.yaml` (`--plan` to only look). See the [command line guide](cli.md).

## Config sync (git)

What it is: the panel's settings and each server's config files (never worlds) saved into a git repository, for example a private repository on GitHub. You get an off-site history and a way to restore, or copy a setup to another machine.

Setup:

1. Install git on the machine (`sudo apt install git`).
2. Create an empty private repository (GitHub: New repository).
3. Create an access token that can write to it (GitHub: Settings, Developer settings, Fine-grained tokens, repository access to that repo, Contents: read and write).
4. Settings, **Config sync (git)**: paste the repository address (`https://github.com/you/panel-config.git`) and the token, set **Sync every** hours (or 0 to sync by hand), **Save**, then **Sync now**.

What goes in: panel settings with every token, key, password and webhook removed; `servers.yaml` (the file above); and per server the config files you list (default: `server.properties` and similar; a folder ends with `/`, for example `plugins/Essentials/`). Small text config files only. **Never** included: accounts, password hashes, keys, node keys, secret variables, world folders, backups, jars. Lines in config files that look like passwords or tokens are replaced by `<redacted>`.

The token is stored encrypted in the panel's settings. It is given to git for one command at a time and is never written into the repository address or a git file.

**Restore preview** fetches the repository and shows what would change in settings, servers (as a plan, nothing is deleted) and files. You tick what to restore. Files with redacted lines are kept as they are on this machine so your real passwords are not blanked. To copy a setup to a new machine, point the new panel at the same repository and restore.

If the remote already has commits from elsewhere, the panel builds on top of them; the remote keeps the history.
