# Game tools

Some games get an extra tab on the server page (next to **Game settings**) with tools made for that game. They work
on the files of servers hosted by this panel (not on another node). Every tool that rewrites a file keeps a backup
first (in `gamepanel-backups/` inside the server folder, or next to the file).

| Game | Tab | What it does |
|---|---|---|
| Counter-Strike 2 | CS2 tools | Game-mode presets, map pool with end-of-match vote, Metamod and CounterStrikeSharp installs, optional skin changer |
| Squad | Layers | Edit the layer rotation |
| Garry's Mod | Gamemode | Switch gamemode and map, install Workshop gamemodes |
| Satisfactory | Saves | Sessions and saves through the game's API, plus the save files |
| Palworld | Player data | Reset one player's character, with backup |
| Space Engineers | World cleanup | Find and remove abandoned grids and floating objects |

## Counter-Strike 2

**Presets.** Competitive 5v5, Arms race, Deathmatch and **Lineup / practice**. A preset sets the game type and
mode and writes `game/csgo/cfg/gamepanel-preset.cfg` (the start command runs it). Practice turns cheats on, gives
unlimited ammo and money, long rounds, grenade trajectory preview and impact markers: use it on a private
server only. Pick the number of bots, apply, restart.

**Map pool and map vote.** Build the pool by adding official maps or Workshop maps (`workshop/<id>/<map>`),
drag or use the arrow buttons (or Alt+Up / Alt+Down on a focused row) to order them, and save. The panel writes
`gamemodes_server.txt` with a map group called `mg_gamepanel`, `mapcycle.txt`, and the game's own end-of-match
vote settings (`mp_endmatch_votenextmap`). The start command loads the group with `+mapgroup`. No plugin is
needed. The optional MapChooserSharp community plugin (nominations, revotes) can be installed from the Plugins card;
its author has marked it as no longer maintained and the panel's install of it has not been tested against a live
server.

**Plugins.** One click installs Metamod:Source (from mms.alliedmods.net) and CounterStrikeSharp (GitHub
releases), with the server stopped. Metamod also needs a line in `gameinfo.gi`; the panel adds it. A CS2 update
restores that file, so run **Enable Metamod** again if plugins stop loading. Needs `unzip` (Linux) on the panel machine.

### Skin changer (WeaponPaints), at your own risk

> **Warning: Valve has banned Game Server Login Tokens (GSLT) of servers that use skin changers.** If you turn
> this on, your server and token can be banned. It is **off by default, no preset turns it on**, and it only
> appears for administrators. You use it entirely at your own risk.

What it is: the WeaponPaints plugin lets players pick knife and gun skins in game (`!ws`, `!knife`). It stores
choices in a **MariaDB or MySQL** database. In the panel:

1. Tick the acknowledgement and **Enable the skin changer**.
2. **Run a database.** The easy way is Docker:
   `docker run -d --name wp-db -e MARIADB_ROOT_PASSWORD=change-me -e MARIADB_DATABASE=weaponpaints -e MARIADB_USER=wp -e MARIADB_PASSWORD=change-me-too -p 127.0.0.1:3306:3306 mariadb:11`.
   Enter host, port, user, password and database name. The password is sealed in the panel.
3. Install the four plugins (PlayerSettings, AnyBaseLibCS2, MenuManagerCS2, WeaponPaints), then **Write plugin
   config**. That writes the database login into `WeaponPaints.json` (the plugin needs it there, in plain text, in the
   server folder) and sets `FollowCS2ServerGuidelines` to false in CounterStrikeSharp's `core.json`.
4. Start the server once so the plugin creates its tables.
5. **Pick skins.** The catalog comes from the ByMykel CSGO-API `skins.json` (downloaded by the panel, cached for a
   week; a small built-in list is used if it cannot be fetched). Enter a SteamID64 (yours, for example), search,
   click a skin. Picks are saved in the panel.
6. **Sync to database** sends the picks. **Limitation:** Node.js has no MySQL client without adding a dependency, so
   the panel runs the SQL through the `mariadb` or `mysql` command line client when one is installed on the panel
   machine. If there is none, use **Download SQL** and run it against the database yourself. The table and column
   names follow WeaponPaints 4.x (`wp_player_skins`, `wp_player_knife`); this was written from its documentation and
   has not been tested against a live server.

## Squad: layer rotation

Edits `SquadGame/ServerConfig/LayerRotation.cfg` (or the legacy `MapRotation.cfg`): pick a map and a layer from the
list, or type a layer name that is newer than the panel's list, then reorder by dragging, with the arrows, or with
Alt+Up / Alt+Down. Squad plays the list top to bottom. Comment lines at the top are kept.

## Garry's Mod: gamemode switcher

Lists the gamemodes on the server (the game's own, addons, and those packed inside Workshop `.gma` files) and the
maps found, filtered by the gamemode's map prefix (`ttt_`, `rp_`, `ph_`, `gm_`...). Choosing one sets `+gamemode` and
`+map` for the next start and warns when the gamemode or map is not on the server. A box installs Workshop items.

## Satisfactory: saves

Uses the server's HTTPS API (the game port). Its certificate is self-signed: press **Trust certificate** once while the
server runs; the panel pins it and refuses a different one later. Sign in with the admin password (only the token the
server returns is kept, sealed) or paste an API token made with `server.GenerateAPIToken` in the server console.
Then you can list sessions and saves, load, download, upload, delete, save now and start a new game. The save files
on disk can always be listed, downloaded, uploaded and deleted (server stopped); deleted files go to
`.gamepanel-trash`. The panel looks for the folder under the server directory (`FactoryGame/Saved/SaveGames/server`
and `.config/Epic/...`); a Windows install that keeps saves under `%LOCALAPPDATA%` is only reachable through the API.

## Palworld: player data reset

Lists `Pal/Saved/SaveGames/0/<world>/Players/*.sav`. Names come from RCON `ShowPlayers` (or the REST API) while the
server is running and are remembered afterwards. **Reset** (administrators, server **stopped**, type the id to confirm)
copies the player's file (and optionally the pal box file) to `gamepanel-backups/palworld/` and removes it, so they
start a fresh character. Their pals, guild and bases stay in the world save. **Restore** puts a backup back.

## Space Engineers: world cleanup

Administrators only, server stopped. Reads `Instance/Saves/<world>/SANDBOX_0_0_0_.sbc` and `Sandbox.sbc` and flags
**unowned** grids, **abandoned** grids (every owner away for N days), **debris** (tiny unowned or abandoned grids)
and **floating** objects. Tick what to remove; the panel backs up the file, removes just those entities, checks the
file is still well-formed, and only then replaces it. NPC and pirate grids can look abandoned, so read the list.
Very large worlds (over about 400 MB of XML) are refused.
