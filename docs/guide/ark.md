# ARK tools

ARK servers (Survival Evolved and Survival Ascended) get an **ARK** tab with four tools, plus a transfer log for clusters. Everything here edits the server's own config files, so **restart the server afterwards**. These tools were written against ARK's documented file formats and have not been run against a live server, so check the result in game.

## Mod order

ARK loads mods from the top of the list down, and a mod lower in the list can override one above it. Drag a row to move it, or use the up and down buttons (they work with the keyboard too). Add a mod by its number.

- **Survival Evolved**: saved as `ActiveMods` in `GameUserSettings.ini`. ARK rewrites that file when it shuts down, so stop the server before saving.
- **Survival Ascended**: saved in the **Mod IDs (load order)** setting and passed to the game as `-mods=`. Use CurseForge mod IDs.

## Levels and engrams

Raise the player or dino level cap, choose how much XP each level takes and how many engram points each level gives. Enter a max level and the XP for the last level, press **Generate XP list**, and the panel builds a rising curve you can still edit by hand. Steps: turn on the player cap, set the max level, generate, save, restart. You can also change an engram's cost or required level, hide it, or unlock it automatically at a level. Written to `Game.ini` (`LevelExperienceRampOverrides`, `OverrideMaxExperiencePointsPlayer/Dino`, `OverridePlayerLevelEngramPoints`, `OverrideEngramEntries`, `EngramEntryAutoUnlocks`). Dino levels need the player ramp as well, because ARK reads the first ramp line as players and the second as dinos.

## Supply crates

Change what supply drops, ocean crates and cave crates contain. A crate picks some item sets; each set picks some entries; each entry gives one of its items in a quantity and quality range. Higher weights are picked more often. Crates already in `Game.ini` show up in the editor; a crate that uses settings the editor does not know is kept exactly as written.

## Give item

Search about 2000 items (data from Project Purlovia, for Survival Evolved; Ascended shares most paths, and anything else can use the custom blueprint path box). Pick an online player, a quantity, and a quality tier (Primitive up to Ascendant, which many players call Ascended) or type an exact number such as 700. ARK's `GiveItemToPlayer` wants the player's in-game ID (a number), which the panel remembers per player after you enter it. `giveitem` is offered as text to copy, because it only works from an admin's own game console.

## Cluster transfers

On **ARK clusters**, press **Transfers** on a cluster. It lists what is stored in the shared cluster folder (with the upload time from each file) and the upload and download lines the member servers printed in their logs. ARK keeps no full history, so older transfers may be gone.
