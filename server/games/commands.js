'use strict';

/**
 * Console quick commands, autocomplete and macros.
 *
 * Each game has `quick` buttons (a command template with {name} fields the
 * panel fills in and sanitizes) and `suggest` lines for autocomplete:
 *   "kick <player> [reason]"  ->  <player> completes to online players,
 *   "weather clear|rain"      ->  a|b is a choice, other <x> / [x] are hints.
 *
 * A command of "@say" sends its {text} through the game's chat command
 * (players.fillBroadcast), the same path restart countdowns use.
 *
 * Macros are saved per server: server.macros = [{ id, name, commands: [] }].
 * A macro line is a plain console command, or "@say message".
 */

const crypto = require('crypto');
const { fail } = require('../core/util');
const players = require('./players');

const P = { name: 'player', label: 'Player', type: 'player' };
const T = (name = 'text', label = 'Message') => ({ name, label, type: 'text' });
const N = (name, label) => ({ name, label, type: 'number' });
const C = (name, label, options) => ({ name, label, type: 'choice', options });

const q = (id, label, command, args = [], extra = {}) => ({ id, label, command, args, ...extra });

const MINECRAFT = {
  quick: [
    q('say', 'Say', '@say', [T()]),
    q('save', 'Save world', 'save-all'),
    q('list', 'Players', 'list'),
    q('time', 'Time', 'time set {when}', [C('when', 'Time', ['day', 'noon', 'night', 'midnight'])]),
    q('weather', 'Weather', 'weather {kind}', [C('kind', 'Weather', ['clear', 'rain', 'thunder'])]),
    q('difficulty', 'Difficulty', 'difficulty {level}', [C('level', 'Difficulty', ['peaceful', 'easy', 'normal', 'hard'])]),
    q('kick', 'Kick', 'kick {player} {reason}', [P, T('reason', 'Reason (optional)')], { optional: ['reason'] }),
    q('op', 'Op', 'op {player}', [P]),
    q('deop', 'Deop', 'deop {player}', [P]),
    q('gamemode', 'Game mode', 'gamemode {mode} {player}', [C('mode', 'Mode', ['survival', 'creative', 'adventure', 'spectator']), P]),
    q('whitelist', 'Whitelist add', 'whitelist add {player}', [P]),
  ],
  suggest: [
    'say <message>', 'list', 'save-all', 'save-on', 'save-off', 'stop',
    'kick <player> [reason]', 'ban <player> [reason]', 'ban-ip <ip|player> [reason]', 'pardon <player>', 'pardon-ip <ip>', 'banlist players|ips',
    'op <player>', 'deop <player>',
    'whitelist on|off|list|reload', 'whitelist add <player>', 'whitelist remove <player>',
    'gamemode survival|creative|adventure|spectator <player>',
    'difficulty peaceful|easy|normal|hard',
    'time set day|noon|night|midnight|<ticks>', 'time add <ticks>', 'time query daytime|gametime|day',
    'weather clear|rain|thunder [seconds]',
    'tp <player> <player|x> [y] [z]', 'give <player> <item> [count]', 'clear <player> [item]',
    'effect give <player> <effect> [seconds] [level]', 'effect clear <player>',
    'xp add <player> <amount> points|levels', 'kill <player>', 'seed', 'reload', 'help',
    'gamerule keepInventory|doDaylightCycle|doMobSpawning|mobGriefing|doFireTick|doWeatherCycle true|false',
    'setworldspawn [x] [y] [z]', 'spawnpoint <player> [x] [y] [z]', 'worldborder set|add <size> [seconds]', 'worldborder get|center|damage|warning',
    'tellraw <player> <json>', 'title <player> title|subtitle|actionbar|clear|reset <json>',
    'scoreboard objectives|players list', 'datapack list|enable|disable', 'function <name>', 'forceload add|remove|query <x> <z>',
    'spark profiler start|stop|info', 'spark tps', 'spark healthreport',
  ],
};

const SOURCE = {
  quick: [
    q('say', 'Say', '@say', [T()]),
    q('status', 'Status', 'status'),
    q('changelevel', 'Change map', 'changelevel {map}', [T('map', 'Map name')]),
    q('kick', 'Kick', 'kick "{player}"', [P]),
    q('restart', 'Restart round', 'mp_restartgame 1'),
  ],
  suggest: [
    'say <message>', 'status', 'users', 'kick <player> [reason]', 'banid <minutes> <steamid>', 'removeid <steamid>', 'writeid', 'listid',
    'changelevel <map>', 'map <map>', 'maps *', 'mp_restartgame <seconds>', 'mp_timelimit <minutes>', 'mp_maxrounds <rounds>',
    'sv_cheats 0|1', 'sv_password <password>', 'hostname <name>', 'exec <file>', 'cvarlist', 'sm_admin', 'meta list',
    'bot_add', 'bot_kick', 'bot_quota <number>', 'bot_difficulty 0|1|2|3', 'mp_autoteambalance 0|1', 'mp_friendlyfire 0|1', 'quit',
  ],
};

const RUST = {
  quick: [
    q('say', 'Say', '@say', [T()]),
    q('save', 'Save', 'server.save'),
    q('players', 'Players', 'playerlist'),
    q('kick', 'Kick', 'kick "{player}" "{reason}"', [P, T('reason', 'Reason')]),
    q('time', 'Time', 'env.time {hour}', [N('hour', 'Hour (0-24)')]),
    q('writecfg', 'Write config', 'server.writecfg'),
    q('oxide', 'Oxide plugins', 'oxide.plugins'),
    q('reload', 'Reload plugin', 'oxide.reload {plugin}', [T('plugin', 'Plugin name')]),
  ],
  suggest: [
    'say <message>', 'status', 'playerlist', 'users', 'players', 'server.save', 'server.writecfg', 'server.readcfg', 'server.seed <seed>', 'server.worldsize <size>',
    'server.hostname <name>', 'server.maxplayers <number>', 'server.description <text>', 'server.pve true|false',
    'kick <player> [reason]', 'ban <player> [reason]', 'banid <steamid> <name> [reason]', 'unban <steamid>', 'banlist',
    'moderatorid <steamid> <name>', 'ownerid <steamid> <name>', 'removemoderator <steamid>', 'removeowner <steamid>',
    'env.time <hour>', 'env.progresstime true|false', 'airdrop', 'airdrop.min_players <number>', 'spawn <prefab>', 'teleport <player> <player>',
    'inventory.giveto <player> <item> [amount]', 'global.kill <player>', 'weather.clouds <0-1>', 'weather.rain <0-1>', 'weather.fog <0-1>',
    'oxide.plugins', 'oxide.reload <plugin>', 'oxide.load <plugin>', 'oxide.unload <plugin>', 'oxide.grant user|group <name> <permission>', 'oxide.revoke user|group <name> <permission>',
    'oxide.show perms|groups|user|group <name>', 'oxide.version', 'o.reload <plugin>', 'c.reload <plugin>',
  ],
};

const ARK = {
  quick: [
    q('chat', 'Say', '@say', [T()]),
    q('save', 'Save world', 'saveworld'),
    q('list', 'Players', 'listplayers'),
    q('dinos', 'Wipe wild dinos', 'DestroyWildDinos', [], { danger: true }),
    q('kick', 'Kick', 'KickPlayer {steamid}', [T('steamid', 'Steam ID')]),
    q('time', 'Time', 'settimeofday {time}', [T('time', 'Time (HH:MM:SS)')]),
  ],
  suggest: [
    'serverchat <message>', 'broadcast <message>', 'saveworld', 'listplayers', 'DoExit', 'DestroyWildDinos', 'DestroyAll<Class>',
    'KickPlayer <steamid>', 'BanPlayer <steamid>', 'UnbanPlayer <steamid>', 'AllowPlayerToJoinNoCheck <steamid>', 'DisallowPlayerToJoinNoCheck <steamid>',
    'SetMessageOfTheDay <message>', 'ShowMessageOfTheDay', 'settimeofday <HH:MM:SS>', 'Slomo <speed>', 'ForceTame', 'GiveItemToPlayer <steamid> <blueprint> <qty> <quality> <blueprint:0|1>',
    'ServerChatTo <steamid> <message>', 'ServerChatToPlayer <player> <message>', 'GetChat', 'cheat SetTutorialHints false',
  ],
};

const PALWORLD = {
  quick: [
    q('broadcast', 'Broadcast', '@say', [T()]),
    q('save', 'Save', 'Save'),
    q('players', 'Players', 'ShowPlayers'),
    q('info', 'Info', 'Info'),
    q('kick', 'Kick', 'KickPlayer {steamid}', [T('steamid', 'Steam ID')]),
  ],
  suggest: ['Broadcast <message>', 'Save', 'ShowPlayers', 'Info', 'Shutdown <seconds> <message>', 'DoExit', 'KickPlayer <steamid>', 'BanPlayer <steamid>', 'UnBanPlayer <steamid>', 'TeleportToPlayer <steamid>', 'TeleportToMe <steamid>'],
};

const SEVEN_DAYS = {
  quick: [
    q('say', 'Say', '@say', [T()]),
    q('save', 'Save world', 'saveworld'),
    q('list', 'Players', 'listplayers'),
    q('time', 'Time', 'settime {time}', [C('time', 'Time', ['day', 'night', 'morning', 'noon', 'evening'])]),
    q('horde', 'Spawn horde', 'spawnscouts {player}', [P]),
    q('kick', 'Kick', 'kick "{player}"', [P]),
  ],
  suggest: [
    'say <message>', 'listplayers', 'lp', 'saveworld', 'shutdown', 'kick <player> [reason]', 'ban add <player> <duration> <unit> [reason]', 'ban remove <player>', 'ban list',
    'admin add <player> <level>', 'admin remove <player>', 'admin list', 'settime day|night|morning|noon|evening|<ticks>', 'gettime', 'weather <name>',
    'teleport <player> <x> <y> <z>', 'teleportplayer <player> <player>', 'giveselfxp <amount>', 'give <player> <item> [count] [quality]', 'spawnentity <player> <entity-id>',
    'listents', 'killall', 'removequest <player> <quest>', 'bloodmoon', 'aiddrop', 'help',
  ],
};

const TERRARIA = {
  quick: [
    q('say', 'Say', '@say', [T()]),
    q('save', 'Save', 'save'),
    q('playing', 'Players', 'playing'),
    q('time', 'Time', 'dawn'),
    q('kick', 'Kick', 'kick {player}', [P]),
  ],
  suggest: ['say <message>', 'playing', 'save', 'exit', 'exit-nosave', 'kick <player>', 'ban <player>', 'password [new-password]', 'motd [message]', 'dawn', 'dusk', 'noon', 'midnight', 'settle', 'time', 'maxplayers', 'port', 'version', 'help'],
};

const FACTORIO = {
  quick: [
    q('say', 'Say', '@say', [T()]),
    q('players', 'Players', '/players online'),
    q('save', 'Save', '/save'),
    q('time', 'Evolution', '/evolution'),
    q('kick', 'Kick', '/kick {player}', [P]),
  ],
  suggest: [
    '/players online|count', '/save [name]', '/evolution [surface]', '/time', '/seed', '/version', '/kick <player> [reason]', '/ban <player> [reason]', '/unban <player>', '/banlist get|add|remove|clear',
    '/promote <player>', '/demote <player>', '/admins', '/whitelist get|add|remove|clear|enable|disable', '/mute <player>', '/unmute <player>', '/permissions',
    '/config get|set <setting> [value]', '/clear', '/help',
  ],
};

const ZOMBOID = {
  quick: [
    q('say', 'Say', '@say', [T()]),
    q('save', 'Save', 'save'),
    q('players', 'Players', 'players'),
    q('rain', 'Start rain', 'startrain'),
    q('kick', 'Kick', 'kickuser "{player}"', [P]),
    q('chopper', 'Helicopter', 'chopper'),
  ],
  suggest: [
    'servermsg <message>', 'players', 'save', 'quit', 'kickuser <player> [-r reason]', 'banuser <player> [-ip] [-r reason]', 'unbanuser <player>', 'banid <steamid>', 'unbanid <steamid>',
    'adduser <player> <password>', 'addusertowhitelist <player>', 'removeuserfromwhitelist <player>', 'grantadmin <player>', 'removeadmin <player>', 'setaccesslevel <player> admin|moderator|overseer|gm|observer|none',
    'startrain', 'stoprain', 'chopper', 'gunshot', 'thunder', 'additem <player> <item> [count]', 'teleport <player> <player>', 'reloadoptions', 'showoptions', 'checkModsNeedUpdate',
  ],
};

const UNTURNED = {
  quick: [
    q('say', 'Say', '@say', [T()]),
    q('save', 'Save', 'save'),
    q('players', 'Players', 'players'),
    q('kick', 'Kick', 'kick {player}', [P]),
  ],
  suggest: ['say <message>', 'players', 'save', 'shutdown [seconds]', 'kick <player> [reason]', 'ban <player> [reason] [duration]', 'unban <steamid>', 'permit <steamid> <name>', 'unpermit <steamid>', 'admin <player>', 'unadmin <player>', 'time <seconds>', 'give <player> <id> [amount]', 'help'],
};

const SQUAD = {
  quick: [
    q('say', 'Broadcast', '@say', [T()]),
    q('list', 'Players', 'ListPlayers'),
    q('map', 'Next map', 'AdminChangeMap {map}', [T('map', 'Map name')]),
    q('end', 'End match', 'AdminEndMatch', [], { danger: true }),
  ],
  suggest: ['AdminBroadcast <message>', 'ListPlayers', 'ListSquads', 'AdminKick <player> [reason]', 'AdminKickById <id> [reason]', 'AdminBan <player> <duration> [reason]', 'AdminChangeMap <map>', 'AdminSetNextMap <map>', 'AdminEndMatch', 'AdminRestartMatch', 'AdminNoTeamChangeTimer 0|1', 'AdminSlomo <speed>'],
};

const GAMES = {
  minecraft: MINECRAFT,
  rust: RUST,
  palworld: PALWORLD,
  terraria: TERRARIA,
  factorio: FACTORIO,
  unturned: UNTURNED,
  squad: SQUAD,
  'seven-days-to-die': SEVEN_DAYS,
  'project-zomboid': ZOMBOID,
  'ark-survival-evolved': ARK,
  'ark-survival-ascended': ARK,
};
for (const id of ['cs2', 'garrysmod', 'tf2', 'left4dead', 'left4dead2', 'counter-strike-source', 'day-of-defeat-source', 'half-life-2-deathmatch', 'insurgency-2014', 'sven-coop', 'no-more-room-in-hell']) GAMES[id] = SOURCE;
GAMES['minecraft-bedrock'] = {
  quick: [q('say', 'Say', '@say', [T()]), q('list', 'Players', 'list'), q('kick', 'Kick', 'kick {player}', [P]), q('time', 'Time', 'time set {when}', [C('when', 'Time', ['day', 'noon', 'night', 'midnight'])]), q('weather', 'Weather', 'weather {kind}', [C('kind', 'Weather', ['clear', 'rain', 'thunder'])])],
  suggest: MINECRAFT.suggest.filter((s) => !/^(spark|datapack|banlist|ban-ip|pardon-ip|save-)/.test(s)),
};
GAMES['squad-44'] = SQUAD;

const EMPTY = { quick: [], suggest: [] };

function catalog(template) {
  if (!template) return EMPTY;
  return GAMES[template.id] || (template.query?.type === 'minecraft' ? GAMES.minecraft : EMPTY);
}

/* ---------------------------------------------------------------- filling -- */

const clean = (value, max = 120) => String(value ?? '').replace(/["\r\n;\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The value for one {field}: a name or text with nothing that could start a second command. */
function fieldValue(arg, raw) {
  const value = clean(raw);
  if (arg.type === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(value)) fail(400, `${arg.label} must be a number`);
    return value;
  }
  if (arg.type === 'choice') {
    if (!arg.options.includes(value)) fail(400, `Pick one of: ${arg.options.join(', ')}`);
    return value;
  }
  return value;
}

/** Build the console command for a catalog button. */
function build(template, quickId, values = {}) {
  const item = catalog(template).quick.find((x) => x.id === quickId);
  if (!item) fail(404, 'This game has no such quick command');
  const given = {};
  for (const arg of item.args) {
    const raw = values?.[arg.name];
    if (raw == null || String(raw).trim() === '') {
      if (item.optional?.includes(arg.name)) {
        given[arg.name] = '';
        continue;
      }
      fail(400, `${arg.label} is required`);
    }
    given[arg.name] = fieldValue(arg, raw);
  }
  if (item.command === '@say') return say(template, given.text);
  return item.command.replace(/\{(\w+)\}/g, (m, name) => given[name] ?? m).replace(/\s+/g, ' ').trim();
}

function say(template, text) {
  const command = players.broadcastCommand(template);
  if (!command) fail(400, 'The panel does not know how to post chat for this game');
  if (!clean(text, 240)) fail(400, 'Type a message');
  return players.fillBroadcast(command, clean(text, 240));
}

/* ----------------------------------------------------------------- macros -- */

const MAX_MACROS = 30;
const MAX_LINES = 10;

function validateMacros(input) {
  if (!Array.isArray(input)) fail(400, 'Macros must be a list');
  if (input.length > MAX_MACROS) fail(400, `At most ${MAX_MACROS} macros per server`);
  const seen = new Set();
  return input.map((m) => {
    const name = String(m?.name || '').replace(/[\r\n]/g, ' ').trim().slice(0, 40);
    if (!name) fail(400, 'Every macro needs a name');
    const lines = (Array.isArray(m.commands) ? m.commands : String(m.commands || '').split('\n'))
      .map((c) => String(c).replace(/[\r\n]/g, ' ').trim().slice(0, 300))
      .filter(Boolean);
    if (!lines.length) fail(400, `${name} has no commands`);
    if (lines.length > MAX_LINES) fail(400, `A macro can have at most ${MAX_LINES} commands`);
    let id = /^[\w-]{4,24}$/.test(String(m.id || '')) ? m.id : crypto.randomBytes(4).toString('hex');
    while (seen.has(id)) id = crypto.randomBytes(4).toString('hex');
    seen.add(id);
    return { id, name, commands: lines };
  });
}

/** The commands a macro sends, in order. "@say text" goes through the game's chat command. */
function macroCommands(template, macro) {
  return macro.commands.map((line) => {
    const m = line.match(/^@say\s+(.*)$/i);
    return m ? say(template, m[1]) : line;
  });
}

module.exports = { catalog, build, say, validateMacros, macroCommands, MAX_LINES };
