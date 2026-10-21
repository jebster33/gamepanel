'use strict';

/**
 * Log explainer: give it one line from a console or log and it says, in plain
 * words, what that line means and what to do. Known lines are matched by
 * rules (the common ones across Minecraft, Rust, Source and Unreal servers);
 * a line that looks like a crash is handed to the crash doctor's rules.
 *
 * Each answer: { id, level: 'error'|'warn'|'info', title, meaning, fix? }
 */

const { diagnose } = require('../games/diagnose');

const RULES = [
  { id: 'cant-keep-up', re: /Can't keep up!|Running \d+ms (?:or \d+ ticks )?behind/i, level: 'warn', title: 'The server is running slower than it should', meaning: 'A tick took longer than its 50 ms budget, so the game fell behind. A one-off after a save or a world load is normal; a steady stream means too many entities, plugins, chunks being generated, or not enough CPU.', fix: 'Run a lag report on the Metrics tab, pregenerate the world, lower the view distance and simulation distance.' },
  { id: 'overloaded-sleep', re: /Thread sleep|Skipping \d+ ticks/i, level: 'warn', title: 'A server tick was skipped', meaning: 'The server was stuck for a moment (a big save, garbage collection, or the machine was busy).', fix: 'If it repeats, give it more memory or check the host for other heavy programs.' },
  { id: 'oom', re: /OutOfMemoryError|Cannot allocate memory|out of memory/i, level: 'error', title: 'It ran out of memory', meaning: 'The game asked for more memory than it was allowed. It usually crashes right after.', fix: 'Raise the memory limit in Settings (and leave a little for the system), or remove heavy mods and plugins.' },
  { id: 'bind', re: /Address already in use|FAILED TO BIND TO PORT|EADDRINUSE|bind\(\) failed/i, level: 'error', title: 'The port is already taken', meaning: 'Another program (often an old copy of this server) is using the port.', fix: 'Stop the other program or change this server\'s port in Settings.' },
  { id: 'eula', re: /agree to the EULA/i, level: 'error', title: 'The Minecraft EULA is not accepted', meaning: 'Minecraft will not start until eula.txt says eula=true.', fix: 'Accept it from the crash doctor or edit eula.txt.' },
  { id: 'uuid-offline', re: /UUID of player (\S+) is ([0-9a-f-]{36})/i, level: 'info', title: 'A player\'s unique ID was looked up', meaning: 'Normal on login. In offline mode the UUID is made up from the name instead of coming from Mojang, so accounts are not protected.', fix: null },
  { id: 'moved-wrongly', re: /moved wrongly|moved too quickly/i, level: 'warn', title: 'A player moved in a way the server did not expect', meaning: 'Usually lag or a teleport, sometimes a movement cheat. Only worth a look if it happens a lot to one player.', fix: 'If one player triggers it constantly, check their ping or a movement plugin.' },
  { id: 'failed-to-verify', re: /Failed to verify username|Authentication servers are down|Invalid session/i, level: 'warn', title: 'Mojang could not verify a login', meaning: 'Either their authentication servers are down, or the player is on a cracked/offline account while online-mode is on.', fix: 'Wait a few minutes. If it is always the same player, they need to restart their launcher and sign in again.' },
  { id: 'mod-missing-dep', re: /Missing or unsupported mandatory dependencies|requires (?:mod|version).{0,80}but (?:none|only) /i, level: 'error', title: 'A mod needs another mod or a different version', meaning: 'A dependency is missing or the wrong version, so the loader refuses to start.', fix: 'Open the Mods tab and run the mod check; install the dependency it names.' },
  { id: 'mixin', re: /Mixin apply failed|InvalidInjectionException|MixinTransformerError/i, level: 'error', title: 'A mod clashes with the game or another mod', meaning: 'A mod tried to change game code that does not match (wrong game version or two mods editing the same place).', fix: 'Update the mod to the version for this game version, or remove the newer addition.' },
  { id: 'plugin-api', re: /Unsupported API version|Could not load '([^']+)'|Error occurred while enabling (\S+)/i, level: 'error', title: 'A plugin failed to load', meaning: 'The plugin is built for a different server version, is missing a dependency, or its config is broken.', fix: 'Check the plugin\'s page for the supported version and update it.' },
  { id: 'ambiguous-lib', re: /Ambiguous plugin name/i, level: 'warn', title: 'Two copies of the same plugin', meaning: 'The plugins folder holds two jars of one plugin; only one will load.', fix: 'Delete the older jar.' },
  { id: 'rcon-fail', re: /rcon.*(?:refused|auth|failed)|Authentication failed.*rcon/i, level: 'warn', title: 'The panel could not use RCON', meaning: 'The remote console is off, on another port, or the password does not match.', fix: 'Check RCON_PASSWORD and the RCON port in the server settings.' },
  { id: 'steam-ticket', re: /Steam (?:Auth|ticket)|VAC|SteamAPI/i, level: 'info', title: 'Steam sign-in message', meaning: 'Steam is checking a player or the server login. Occasional failures are normal when Steam is slow.', fix: null },
  { id: 'rust-nre', re: /NullReferenceException[\s\S]{0,300}?(Oxide\.Plugins\.\w+|Carbon\.Plugins\.\w+)?/i, level: 'error', title: 'A plugin hit a bug (null reference)', meaning: 'A plugin used something that did not exist. The plugin name is usually in the lines around it.', fix: 'Update or remove that plugin; tell its author with the lines around this one.' },
  { id: 'rust-compile', re: /Error while compiling[:\s]+(\S+)/i, level: 'error', title: 'A Rust plugin did not compile', meaning: 'The plugin\'s code does not fit the current Oxide/Carbon or game version, so it is not loaded.', fix: 'Update the plugin and the mod framework, then reload it.' },
  { id: 'rust-saving', re: /Saving complete|Saved \d+ ents/i, level: 'info', title: 'World saved', meaning: 'The server wrote its world to disk. Normal.', fix: null },
  { id: 'unreal-fatal', re: /Fatal error!|LowLevelFatalError|Unhandled Exception|Assertion failed/i, level: 'error', title: 'The game engine crashed', meaning: 'An Unreal/Unity engine fault. The lines after this one hold the call stack.', fix: 'Verify the game files (Update button) and remove recent mods. Share the lines with the game\'s community if it repeats.' },
  { id: 'disk-full', re: /No space left on device|ENOSPC|Disk write failure/i, level: 'error', title: 'The disk is full', meaning: 'Nothing more can be written. Saves may be damaged.', fix: 'Free space: clear old backups, logs and the trash (Tools tab).' },
  { id: 'perm', re: /Permission denied|Access is denied|EACCES/i, level: 'error', title: 'The game was not allowed to read or write a file', meaning: 'File permissions in the server folder are wrong, often after copying files in by hand.', fix: 'Fix ownership of the server folder, or reinstall.' },
  { id: 'connection-lost', re: /Disconnected|lost connection: (.+)/i, level: 'info', title: 'A player left', meaning: 'The reason is after "lost connection:". "Timed out" means their connection dropped; "Kicked" or "Banned" was done by staff or a plugin.', fix: null },
  { id: 'version-mismatch', re: /Outdated (?:client|server)|incompatible client|Protocol mismatch/i, level: 'warn', title: 'A player\'s game version does not match', meaning: 'They are on a different game version than the server.', fix: 'Tell them which version to use, or add ViaVersion for Minecraft.' },
  { id: 'ssl', re: /PKIX path building failed|SSLHandshakeException|unable to find valid certification path/i, level: 'warn', title: 'A secure connection failed', meaning: 'The server\'s Java does not trust the site\'s certificate (old Java or a proxy in the way).', fix: 'Update Java from the Settings tab.' },
  { id: 'watchdog', re: /Watchdog|A single server tick took \d+/i, level: 'error', title: 'The server froze and was stopped by its watchdog', meaning: 'One tick took far too long. The dump after it shows what the server was doing.', fix: 'Look at the thread dump below this line for a plugin or mod name.' },
];

function explain(line) {
  const text = String(line || '').slice(0, 4000);
  if (!text.trim()) return null;
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (m) {
      const named = m.slice(1).find(Boolean);
      return { id: rule.id, level: rule.level, title: rule.title, meaning: rule.meaning, fix: rule.fix, detail: named || null };
    }
  }
  try {
    const found = diagnose([text], {});
    if (found?.length) return { id: found[0].id, level: 'error', title: found[0].title, meaning: found[0].detail, fix: found[0].fix?.label || null, detail: null };
  } catch {
    /* fall through */
  }
  const level = /\b(ERROR|SEVERE|FATAL|Exception)\b/.test(text) ? 'error' : /\bWARN(ING)?\b/.test(text) ? 'warn' : 'info';
  return {
    id: 'unknown',
    level,
    title: level === 'info' ? 'Nothing to worry about' : 'Not a message the panel knows yet',
    meaning:
      level === 'info'
        ? 'This looks like an ordinary status line.'
        : 'The panel has no explanation for this one. Search the exact text (without names and numbers) together with the game\'s name; the lines just before it are usually the cause.',
    fix: null,
    detail: null,
  };
}

/** Warnings and errors from recent console lines, repeated ones counted once. */
function interesting(lines, limit = 40) {
  const seen = new Map();
  for (const line of lines) {
    if (!/\b(WARN(ING)?|ERROR|SEVERE|FATAL)\b|Exception|Can't keep up|failed|Failed/.test(line)) continue;
    const key = line.replace(/^\[[^\]]*\]\s*/, '').replace(/\d+/g, '#').slice(0, 120);
    const prev = seen.get(key);
    if (prev) prev.count++;
    else seen.set(key, { line: line.slice(0, 400), count: 1 });
  }
  return [...seen.values()].slice(-limit).reverse();
}

module.exports = { explain, interesting, RULES };
