# Mods and modpacks

## Where mods come from

| Game | Sources |
|---|---|
| Minecraft Paper, Purpur | Modrinth, CurseForge, Hangar and SpigotMC (free plugins) |
| Minecraft Fabric, Quilt, Forge, NeoForge | Modrinth, CurseForge |
| Minecraft modpack servers | Modrinth and CurseForge packs, plus extra mods |
| Rust | uMod / Oxide plugins |
| Garry's Mod, ARK, Project Zomboid, Unturned, Arma 3, DayZ, Conan Exiles, tModLoader, Space Engineers, Don't Starve Together, Killing Floor 2, Avorion | Steam Workshop |
| Factorio | The Factorio mod portal |

CurseForge needs a free API key (from console.curseforge.com) under **Settings → Integrations**. Factorio
needs your Factorio username and token there. The others work with no key.

## Installing mods

<img src="../screenshots/mods.png" alt="The Mods tab" width="800" />

Open the server's **Mods** tab, search on the left and press install.

- **Only compatible mods are listed.** A Fabric 1.21.1 server sees Fabric builds for 1.21.1; a Forge server
  never sees Fabric mods. NeoForge 1.20.1 also gets Forge builds, since that version loads them.
- **You see the plan first:** the mod and every dependency it pulls in, downloaded together.

  <img src="../screenshots/mod-install.png" alt="Install plan with dependencies" width="600" />

- **Client-only mods are refused**, because one of them can stop a Forge server from booting. Mods
  players need too are labelled, so you know what to tell them.
- **Updates stay compatible:** **Updates** only offers newer releases for the same loader and version. A
  schedule can run **Update mods and plugins** for you.
- **Removing cleans up:** dependencies nothing else needs go with the mod. The switch next to a mod disables it and
  keeps the file.

Restart the server to load changes.

**Steam Workshop** works per game: Garry's Mod addons are unpacked, Unturned and ARK get the item added to
their own mod lists, Project Zomboid gets `WorkshopItems` and `Mods` written for you, Killing Floor 2 gets
`ServerSubscribedWorkshopItems` lines in KFEngine.ini (start the server once first), and Avorion gets the item in
the galaxy's modconfig.lua. Paste the
Workshop link or item ID and press **Add item**.

## Datapacks

Every Minecraft Java server (vanilla, Paper, Fabric, Forge and the rest) has a **Datapacks** card on
its Game settings tab, for the loaded world's `datapacks` folder. **Browse** searches Modrinth for packs
with a release for the server's version; **Upload zip** adds your own (the panel tells you when
`pack.mcmeta` sits in an extra folder, or when the zip is a mod). Each pack can be turned off without
deleting it. Packs made for another Minecraft version are marked **Other version**, using the data pack
format from the server jar itself. On a running server changes apply at once through `/datapack` and
`/reload` (`minecraft:reload` on Paper, so plugins are not reloaded); otherwise on the next start.
**Updates** checks the Modrinth ones for newer releases.

## The mod check

On Minecraft servers, the Mods tab looks inside the jars (also ones you uploaded by hand) and says when a mod is made for another loader or Minecraft version, needs a mod that is missing, breaks another mod, is installed twice, or is client-only. It runs whenever you open the tab, on demand with **Check**, and after a modded server crashes.

## Config files as forms

The **Configs** tab lists the config files of your plugins and mods (`plugins/…`, `config/…`, BepInEx, Oxide) and shows them as forms: toggles, numbers, lists, and choices where the file lists the allowed values. Only what you change is rewritten, so comments and layout stay. Every save is kept in config history.

## Minecraft networks

Create a **Minecraft: Velocity proxy** server, then **Servers → Networks → New network**: pick the proxy and the Paper or Purpur servers behind it (the first is where players land). The panel sets up forwarding on both ends, so players join the proxy's address and move between servers with `/server`, and the servers behind it cannot be joined directly.

## Modpacks

<img src="../screenshots/modpacks.png" alt="The Modpack tab" width="800" />

Create a server with the **Minecraft: Modpack** game. Pick **Modrinth** or **CurseForge**, search for the
pack and choose a version. The panel installs the right loader (Fabric, Quilt, Forge or NeoForge), every
mod and the pack's own configs.

Later, the server's **Modpack** tab changes the version or swaps to another pack. Changing the pack
replaces the mods and the pack's configs; **your world is kept**. Stop the server first.

Players need the same pack and version on their own computer to join. The pack's mods are labelled
the same way as above: server only, needed by players too, or client side.

You can still add single mods to a modpack server on its **Mods** tab.
