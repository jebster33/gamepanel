'use strict';

/**
 * The crash doctor: reads the end of a server's console after it dies and
 * explains, in plain words, the usual reasons game servers fall over, with a
 * one-click fix where there is a safe one.
 *
 * Each finding: { id, title, detail, fix?: { action, label, ...args } }.
 */

// Java class file version → the Java release that reads it.
const CLASS_VERSIONS = { 52: 8, 55: 11, 60: 16, 61: 17, 65: 21, 69: 25 };

const RULES = [
  {
    id: 'java-version',
    test: (text) => text.match(/class file version (\d+)(?:\.\d+)?.*?(?:only recognizes class file versions up to (\d+))?/) || text.match(/UnsupportedClassVersionError/),
    explain(m, text) {
      const need = Number(m[1]) ? CLASS_VERSIONS[Number(m[1])] : null;
      const req = text.match(/requires (?:running the server with )?Java (\d+)/i);
      const java = need || (req && Number(req[1])) || null;
      return {
        title: `It needs ${java ? `Java ${java}` : 'a newer Java'}`,
        detail: `The server (or one of its mods) was built for ${java ? `Java ${java}` : 'a newer Java than the one installed'}. Newer Minecraft versions need newer Java.`,
        fix: java ? { action: 'java', java, label: `Switch to Java ${java} and reinstall` } : { action: 'reinstall', label: 'Reinstall to fetch the right Java' },
      };
    },
  },
  {
    id: 'port',
    test: (text) => text.match(/(?:FAILED TO BIND TO PORT|Address already in use|Failed to bind|bind\(\) failed|EADDRINUSE)[^\n]*?(\d{2,5})?/i),
    explain: (m) => ({
      title: 'The port is already taken',
      detail: `Something else is already using ${m[1] ? `port ${m[1]}` : 'the server\'s port'}: often another copy of this server that never closed, or another game. Stop the other program or move this server to a free port on the Settings tab.`,
      fix: { action: 'settings', label: 'Change the port' },
    }),
  },
  {
    id: 'memory',
    test: (text, ctx) =>
      text.match(/java\.lang\.OutOfMemoryError[^\n]*|Cannot allocate memory|There is insufficient memory|out of memory/i) || (ctx.signal === 'SIGKILL' || ctx.code === 137 ? ['killed'] : null),
    explain: (m, text, ctx) => ({
      title: 'It ran out of memory',
      detail:
        m[0] === 'killed'
          ? 'The server was killed by the system, which almost always means it used more memory than it was allowed.'
          : `The game asked for more memory than it has (${ctx.memory ? `${ctx.memory} MB` : 'its limit'}). Big modpacks and large view distances need more.`,
      fix: { action: 'memory', label: `Give it ${Math.round(((ctx.memory || 2048) + 1024) / 1024)} GB` },
    }),
  },
  {
    id: 'eula',
    test: (text) => text.match(/You need to agree to the EULA|agree to the EULA in order to run/i),
    explain: () => ({
      title: 'The Minecraft EULA is not accepted',
      detail: "Minecraft will not start until eula.txt says eula=true. Accepting it means you agree to Mojang's EULA (aka.ms/MinecraftEULA).",
      fix: { action: 'eula', label: 'Accept the EULA' },
    }),
  },
  {
    id: 'jar-missing',
    test: (text) => text.match(/Unable to access jarfile|Could not find or load main class|No such file or directory[^\n]*\.(?:jar|x86_64|exe)/i),
    explain: () => ({
      title: 'The server files are missing',
      detail: 'The program that runs the server is not where it should be. An install may have failed or something deleted it.',
      fix: { action: 'reinstall', label: 'Reinstall the game files' },
    }),
  },
  {
    id: 'client-mod',
    test: (text) =>
      text.match(/Attempted to load class net\/minecraft\/client[^\n]*?for invalid dist DEDICATED_SERVER|Environment type CLIENT is not allowed/),
    explain(m, text) {
      const mod = text.match(/(?:mod file|Mod File|from mod|mods\/)([\w.+-]+\.jar)/);
      return {
        title: 'A client-only mod is installed',
        detail: `${mod ? `${mod[1]} looks like` : 'One of the mods is'} a mod made only for players' game (graphics, minimaps, menus). It cannot run on a server. Remove it from the mods folder.`,
        fix: mod ? { action: 'disable-mod', file: mod[1], label: `Disable ${mod[1]}` } : { action: 'files', label: 'Open the mods folder' },
      };
    },
  },
  {
    id: 'mod-deps',
    test: (text) => text.match(/Incompatible mods? found!?|Missing or unsupported mandatory dependencies|requires (?:version [^\n]+ )?of ([\w-]+), which is missing|Mod ([\w-]+) requires/i),
    explain(m, text) {
      const lines = text
        .split('\n')
        .filter((l) => /requires|missing|incompatible/i.test(l) && !/^\s*at /.test(l))
        .slice(0, 6)
        .map((l) => l.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]:?\s*)?/, '').trim());
      return {
        title: 'Some mods are missing what they need',
        detail: `A mod depends on another mod (or another version) that is not installed.${lines.length ? `\n\n${lines.join('\n')}` : ''}`,
        fix: { action: 'mods', label: 'Open the Mods tab' },
      };
    },
  },
  {
    id: 'plugin',
    test: (text) => text.match(/Could not load '?plugins[\/\\]([^'\n]+\.jar)'?/),
    explain: (m) => ({
      title: `The plugin ${m[1]} failed to load`,
      detail: 'It is probably built for another Minecraft version or needs another plugin first. The server can usually run without it.',
      fix: { action: 'disable-plugin', file: m[1], label: `Disable ${m[1]}` },
    }),
  },
  {
    id: 'world',
    test: (text) => text.match(/Exception reading [^\n]*level\.dat|Failed to load level|Failed to read level data|Corrupt(?:ed)? (?:chunk|world|region)/i),
    explain: () => ({
      title: 'The world looks damaged',
      detail: 'The world files could not be read. This can happen after a power cut or a crash while saving. Restoring the latest backup is the safest fix.',
      fix: { action: 'backups', label: 'Open backups' },
    }),
  },
  {
    id: 'disk',
    test: (text) => text.match(/No space left on device|Disk write failure|ENOSPC|There is not enough space on the disk/i),
    explain: () => ({
      title: 'The disk is full',
      detail: 'The server could not write its files. Delete old backups or logs, or move the panel to a bigger disk.',
      fix: { action: 'backups', label: 'Clean up backups' },
    }),
  },
  {
    id: 'permission',
    test: (text) => text.match(/Permission denied|EACCES|Access is denied/i),
    explain: () => ({
      title: 'A file could not be opened (permission denied)',
      detail: 'The server is not allowed to read or write one of its files. This usually happens after copying files in as another user. Reinstalling fixes ownership.',
      fix: { action: 'reinstall', label: 'Reinstall (keeps worlds and configs)' },
    }),
  },
  {
    id: 'tick-loop',
    test: (text) => text.match(/Exception in server tick loop|Encountered an unexpected exception|The server has stopped responding|Considering it to be crashed/i),
    explain(m, text) {
      // The first frame that is not Minecraft or Java itself usually names the culprit.
      const frame = text.match(/^\s*at ((?!net\.minecraft|java\.|jdk\.|sun\.|com\.mojang|org\.bukkit|io\.papermc|org\.spigotmc|net\.fabricmc|cpw\.|net\.minecraftforge)[\w$]+\.[\w$.]+)/m);
      return {
        title: 'The game hit an error while running',
        detail: `The server crashed while running the world.${frame ? ` The error came from ${frame[1].split('.').slice(0, 3).join('.')}, which is likely a mod or plugin.` : ''} Check the full crash report in the crash-reports folder, or share the log to get help.`,
        fix: { action: 'share', label: 'Share the log' },
      };
    },
  },
];

/**
 * @param {string[]} lines the end of the console
 * @param {{code?:number, signal?:string, memory?:number}} ctx
 */
function diagnose(lines, ctx = {}) {
  const text = lines.join('\n');
  const found = [];
  for (const rule of RULES) {
    const m = rule.test(text, ctx);
    if (!m) continue;
    found.push({ id: rule.id, ...rule.explain(m, text, ctx) });
    if (found.length >= 3) break;
  }
  return found;
}

module.exports = { diagnose, CLASS_VERSIONS };
