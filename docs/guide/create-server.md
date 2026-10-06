# Create a server

## From a game

Press **New server** (top right), or open **Games** and press **Deploy** on a game.

<img src="../screenshots/games.png" alt="Picking a game" width="800" />

| Field | |
|---|---|
| **Server name** | Anything; it shows in the sidebar and on the status page. |
| **Game settings** | What that game asks for: version, world name, server password, max players. Blank fields get a sensible default, and passwords are generated for you. Some games walk you through this in steps. |
| **Memory limit** | On Linux with Docker this is a hard cap: a server that goes over it restarts instead of taking the machine down. |
| **Ports** | Picked for you from the free ports in your port range (Settings → General). Change them if you need a specific one. |
| **Node** | Only shows when you've added [other machines](nodes.md): where the server should run. |

Press **Create & install**. The panel downloads the game and the console opens so you can watch it install. Small
games are ready in a minute; big Steam games can take a while. When it says it's running, the
address at the top of the page (click to copy) is what players connect to.

Players outside your network also need the ports open: see
[Making a server reachable](../troubleshooting.md#making-a-server-reachable), or skip that with
[GamePanel Bridge](../bridge.md).

### Games that aren't in the list

- **Any Steam game (SteamCMD):** give it the App ID of the dedicated server (search
  [SteamDB](https://steamdb.info) for "Dedicated Server"), and the start command.
- **Custom server (any game):** your own start command, for a jar or launch script you upload.
- Or write a [template](../templates.md) so it gets a proper form, ports and mod support.

## Import a server you already have

**Servers → Import existing.** Pick the game, give it a name and point it at the folder on this
machine. Nothing is downloaded or reinstalled.

- **Use the folder where it is:** deleting the server in the panel later never deletes those files.
- **Copy it into the panel's own folder:** the original stays untouched.
- **Start command:** leave empty to start it the way the game's template does, or give your own
  (`java -Xmx4G -jar server.jar nogui`).

The panel's service account must be able to read and write the folder. Ports are read from the server's
own config when the panel can find them.

**Moving from another GamePanel:** on the old panel use **Settings tab → Danger zone → Export**, unpack
the file into a folder on the new machine and import that folder. The game and settings come with it.

## Copying a server

**Settings tab → Danger zone → Duplicate** makes a copy on new ports, with or without the files.
Handy for a test server next to the real one.

Next: [Running a server](running-a-server.md).
