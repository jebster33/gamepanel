'use strict';

/**
 * Game settings as a form: the keys of a game's own config file (Minecraft's
 * server.properties, Project Zomboid's servertest.ini, V Rising's JSON…)
 * with labels, switches and dropdowns. Games with a curated list get grouped,
 * explained fields; every other key in the file is still editable, typed by
 * its current value. Saving rewrites only the changed lines, so comments and
 * key order survive.
 */

const fs = require('fs');
const { fail, interpolate } = require('../core/util');
const { containedPath } = require('../features/files');
const { patchKeyValue } = require('../servers/config-files');

const bool = (key, label, description, extra = {}) => ({ key, label, type: 'bool', description, ...extra });
const num = (key, label, description, extra = {}) => ({ key, label, type: 'number', description, ...extra });
const text = (key, label, description, extra = {}) => ({ key, label, type: 'text', description, ...extra });
const select = (key, label, options, description, extra = {}) => ({ key, label, type: 'select', options, description, ...extra });

const MC_JAVA = [
  {
    title: 'Gameplay',
    fields: [
      text('motd', 'Server description (MOTD)', 'Shown under the name in the multiplayer list.'),
      num('max-players', 'Max players', null, { min: 1, max: 1000 }),
      select('gamemode', 'Game mode', ['survival', 'creative', 'adventure', 'spectator']),
      bool('force-gamemode', 'Force game mode', 'Put players back in the default mode every time they join.'),
      select('difficulty', 'Difficulty', ['peaceful', 'easy', 'normal', 'hard']),
      bool('hardcore', 'Hardcore', 'One life. Dying puts a player in spectator mode.'),
      bool('pvp', 'PvP', 'Let players hurt each other.'),
      bool('allow-flight', 'Allow flight', 'Stops players with fly mods or jetpacks from being kicked for flying.'),
      bool('allow-nether', 'Nether'),
      bool('spawn-monsters', 'Monsters'),
      bool('spawn-animals', 'Animals'),
      bool('spawn-npcs', 'Villagers'),
      num('spawn-protection', 'Spawn protection radius', 'Blocks around spawn only operators can change. 0 turns it off.', { min: 0 }),
      bool('enable-command-block', 'Command blocks'),
    ],
  },
  {
    title: 'Players and access',
    fields: [
      bool('online-mode', 'Online mode', 'Checks every player has a real Minecraft account. Turn it off (offline / cracked mode) to let anyone join with any name, for example players without an account or servers behind Velocity or BungeeCord.', {
        warnWhen: false,
        warning: 'Offline mode: anyone can join as any name, including yours or an operator\'s. Turn on the whitelist or use an auth plugin, and only share the address with people you trust.',
      }),
      bool('enforce-secure-profile', 'Require signed chat', 'Kicks players without a Mojang-signed profile. Turn it off with offline mode.'),
      bool('white-list', 'Whitelist', 'Only players on the whitelist can join. Add them with: whitelist add <name>.'),
      bool('enforce-whitelist', 'Kick players removed from the whitelist'),
      select('op-permission-level', 'Operator level', [
        { value: '1', label: '1 · Bypass spawn protection' },
        { value: '2', label: '2 · Cheats and command blocks' },
        { value: '3', label: '3 · Kick and ban' },
        { value: '4', label: '4 · Everything, including /stop' },
      ]),
      num('player-idle-timeout', 'Kick idle players after (minutes)', '0 never kicks.', { min: 0 }),
      bool('hide-online-players', 'Hide who is online', 'Hides names in the multiplayer list (the Players tab then only shows names from the log).'),
      bool('prevent-proxy-connections', 'Block VPN and proxy connections'),
    ],
  },
  {
    title: 'World',
    fields: [
      text('level-name', 'World folder', 'Change it to start a new world; the old one stays on disk.'),
      text('level-seed', 'Seed', 'Only used when a new world is generated.'),
      select('level-type', 'World type', [
        { value: 'minecraft:normal', label: 'Normal' },
        { value: 'minecraft:flat', label: 'Superflat' },
        { value: 'minecraft:large_biomes', label: 'Large biomes' },
        { value: 'minecraft:amplified', label: 'Amplified' },
        { value: 'minecraft:single_biome_surface', label: 'Single biome' },
      ], 'Only used when a new world is generated.'),
      bool('generate-structures', 'Villages, temples and other structures'),
      num('max-world-size', 'World border radius', 'In blocks.', { min: 1, max: 29999984 }),
    ],
  },
  {
    title: 'Performance',
    fields: [
      num('view-distance', 'View distance (chunks)', 'Lower it if the server lags with many players.', { min: 3, max: 32 }),
      num('simulation-distance', 'Simulation distance (chunks)', 'How far from players mobs and crops keep working.', { min: 3, max: 32 }),
      num('entity-broadcast-range-percentage', 'Entity visibility range (%)', null, { min: 10, max: 1000 }),
      num('max-tick-time', 'Watchdog timeout (ms)', 'Stops the server if one tick takes this long. -1 turns it off.'),
      num('network-compression-threshold', 'Network compression threshold (bytes)'),
      bool('sync-chunk-writes', 'Safe chunk saving', 'Slower, but less likely to corrupt chunks on a crash.'),
    ],
  },
  {
    title: 'Resource pack',
    fields: [
      text('resource-pack', 'Resource pack URL', 'A direct download link to a .zip.'),
      text('resource-pack-sha1', 'Resource pack SHA-1', 'Optional, lets clients skip re-downloading an unchanged pack.'),
      bool('require-resource-pack', 'Require the resource pack', 'Players who decline it are disconnected.'),
      text('resource-pack-prompt', 'Message shown with the resource pack prompt'),
    ],
  },
];

const MC_BEDROCK = [
  {
    title: 'Gameplay',
    fields: [
      text('server-name', 'Server name'),
      num('max-players', 'Max players', null, { min: 1, max: 1000 }),
      select('gamemode', 'Game mode', ['survival', 'creative', 'adventure']),
      bool('force-gamemode', 'Force game mode'),
      select('difficulty', 'Difficulty', ['peaceful', 'easy', 'normal', 'hard']),
      bool('allow-cheats', 'Cheats', 'Lets operators use commands like /give.'),
    ],
  },
  {
    title: 'Players and access',
    fields: [
      bool('online-mode', 'Online mode', 'Requires players to be signed in to Xbox Live.', {
        warnWhen: false,
        warning: 'Offline mode: players are not checked against Xbox Live, so anyone on your network can join as any name.',
      }),
      bool('allow-list', 'Allow list', 'Only players on allowlist.json can join.'),
      select('default-player-permission-level', 'New players join as', ['visitor', 'member', 'operator']),
      num('player-idle-timeout', 'Kick idle players after (minutes)', '0 never kicks.', { min: 0 }),
      bool('texturepack-required', 'Require the world\'s resource packs'),
    ],
  },
  {
    title: 'World and performance',
    fields: [
      text('level-name', 'World folder'),
      text('level-seed', 'Seed', 'Only used when a new world is generated.'),
      num('view-distance', 'View distance (chunks)', null, { min: 5 }),
      num('tick-distance', 'Simulation distance (chunks)', null, { min: 4, max: 12 }),
    ],
  },
];

const TERRARIA = [
  {
    title: 'Server',
    fields: [
      num('maxplayers', 'Max players', null, { min: 1, max: 255 }),
      text('password', 'Join password', 'Leave empty for no password.', { secret: true }),
      text('motd', 'Message of the day'),
      select('difficulty', 'Difficulty (new worlds)', [
        { value: '0', label: 'Classic' },
        { value: '1', label: 'Expert' },
        { value: '2', label: 'Master' },
        { value: '3', label: 'Journey' },
      ]),
      select('autocreate', 'World size (new worlds)', [
        { value: '1', label: 'Small' },
        { value: '2', label: 'Medium' },
        { value: '3', label: 'Large' },
      ]),
      text('worldname', 'World name'),
      bool('secure', 'Cheat protection', null, { on: '1', off: '0' }),
    ],
  },
];

const CURATED = { minecraft: MC_JAVA, 'minecraft-bedrock': MC_BEDROCK, terraria: TERRARIA };

function curatedFor(template) {
  if (CURATED[template.id]) return CURATED[template.id];
  if (template.query?.type === 'minecraft') return CURATED.minecraft;
  return null;
}

/** The settings file of a game: the first key/value or JSON file the template patches or creates. */
function settingsFileFor(template) {
  for (const p of template.patchProperties || []) {
    const format = p.format || 'properties';
    if (['properties', 'ini', 'json'].includes(format)) return { path: p.path, format, section: p.section || null };
  }
  for (const f of template.configFiles || []) {
    if (/\.(properties|ini|txt)$/i.test(f.path)) return { path: f.path, format: /\.ini$/i.test(f.path) ? 'ini' : 'properties', section: null };
    if (/\.json$/i.test(f.path)) return { path: f.path, format: 'json', section: null };
  }
  return null;
}

/** Keys the panel sets itself before every start, and the variable each comes from. */
function boundKeys(template, file) {
  const out = {};
  for (const p of template.patchProperties || []) {
    if (p.path !== file.path || (p.section || null) !== file.section) continue;
    for (const [key, value] of Object.entries(p.set || {})) {
      const m = String(value).match(/^\{\{([A-Z0-9_]+)\}\}$/);
      const variable = m?.[1] || null;
      // Ports and passwords belong to the panel; MOTD, slots, difficulty… are just mirrored from a variable.
      const managed = !variable || /PORT|PASSWORD|SECRET|TOKEN/.test(variable);
      out[key] = { variable, managed };
    }
  }
  return out;
}

function parseKeyValue(raw, section) {
  const values = {};
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      current = header[1];
      continue;
    }
    if (section && current !== section) continue;
    if (/^\s*[#;]/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/);
    // Java writes "minecraft\:normal"; show it the way people type it.
    if (m && !(m[1] in values)) values[m[1]] = m[2].replace(/\\([:=!#])/g, '$1');
  }
  return values;
}

function flattenJson(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenJson(v, key, out);
    else if (!Array.isArray(v)) out[key] = v;
  }
  return out;
}

const looksSecret = (key) => /pass(word)?|secret|token|key$/i.test(key);

/** A field for a key nobody described: switch, number or text, from its value. */
function inferField(key, value) {
  const label = key.replace(/[._-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());
  const s = String(value);
  if (typeof value === 'boolean' || s === 'true' || s === 'false') return bool(key, label);
  if (typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(s)) return num(key, label);
  return text(key, label, null, looksSecret(key) ? { secret: true } : {});
}

function asText(value) {
  return value === undefined || value === null ? '' : String(value);
}

module.exports = {
  /** The form for a server: groups of fields with their current values. */
  readGameSettings(manager, server) {
    const template = manager.template(server);
    if (!template) fail(400, 'The template this server was created from is no longer available');
    const file = settingsFileFor(template);
    if (!file) return { supported: false };
    const target = containedPath(server.dir, interpolate(file.path, manager.vars(server)));
    let raw;
    try {
      raw = fs.readFileSync(target, 'utf8');
    } catch {
      return { supported: true, missing: true, file: file.path };
    }

    let values;
    try {
      values = file.format === 'json' ? flattenJson(JSON.parse(raw || '{}')) : parseKeyValue(raw, file.section);
    } catch (err) {
      return { supported: true, file: file.path, error: `${file.path} could not be read: ${err.message}` };
    }
    const bound = boundKeys(template, file);
    const decorate = (field) => {
      const b = bound[field.key];
      const value = values[field.key];
      if (b?.managed && looksSecret(field.key)) return { ...field, type: 'text', value: '••••••••', managed: true, variable: b.variable };
      return {
        ...field,
        value: field.type === 'bool' ? (field.on ? asText(value) === field.on : asText(value) === 'true' || value === true) : asText(value),
        managed: Boolean(b?.managed),
        variable: b?.variable || null,
      };
    };

    const curated = curatedFor(template);
    const seen = new Set();
    const groups = [];
    for (const group of curated || []) {
      const fields = group.fields.filter((f) => f.key in values || (bound[f.key] && !bound[f.key].managed)).map(decorate);
      fields.forEach((f) => seen.add(f.key));
      if (fields.length) groups.push({ title: group.title, fields });
    }
    const rest = Object.keys(values)
      .filter((k) => !seen.has(k))
      .map((k) => decorate(inferField(k, values[k])));
    const editable = rest.filter((f) => !f.managed);
    const managed = rest.filter((f) => f.managed);
    if (editable.length) groups.push({ title: curated ? 'Everything else' : 'Settings', fields: editable });
    if (managed.length) groups.push({ title: 'Set by the panel', fields: managed, managedGroup: true });
    return { supported: true, file: file.path, format: file.format, curated: Boolean(curated), groups };
  },

  /** Save changed keys. Mirrored keys (MOTD, max players…) update their variable too, or the next start would undo them. */
  writeGameSettings(manager, server, changes) {
    const template = manager.template(server);
    const file = template && settingsFileFor(template);
    if (!file) fail(400, 'This game has no settings file the panel can edit');
    const current = module.exports.readGameSettings(manager, server);
    if (current.missing) fail(409, 'Install the server first; its settings file does not exist yet');
    if (current.error) fail(409, current.error);
    const fields = new Map(current.groups.flatMap((g) => g.fields).map((f) => [f.key, f]));

    const toWrite = {};
    const varPatch = {};
    for (const [key, raw] of Object.entries(changes || {})) {
      const field = fields.get(key);
      if (!field) fail(400, `Unknown setting: ${key}`);
      if (field.managed) fail(400, `${field.label} is set by the panel (change it on the Settings tab)`);
      let value;
      if (field.type === 'bool') value = raw ? field.on || 'true' : field.off || 'false';
      else if (field.type === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n) || String(raw).trim() === '') fail(400, `${field.label} must be a number`);
        if (field.min !== undefined && n < field.min) fail(400, `${field.label} must be at least ${field.min}`);
        if (field.max !== undefined && n > field.max) fail(400, `${field.label} must be at most ${field.max}`);
        value = String(n);
      } else {
        value = String(raw ?? '');
        if (/[\r\n]/.test(value)) fail(400, `${field.label} must be on one line`);
        if (field.type === 'select') {
          const allowed = field.options.map((o) => String(typeof o === 'object' ? o.value : o));
          if (!allowed.includes(value)) fail(400, `${field.label} must be one of: ${allowed.join(', ')}`);
        }
      }
      toWrite[key] = value;
      if (field.variable) varPatch[field.variable] = field.type === 'number' ? Number(value) : value;
    }
    if (!Object.keys(toWrite).length) return { ok: true, changed: 0 };

    const target = containedPath(server.dir, interpolate(file.path, manager.vars(server)));
    const raw = fs.readFileSync(target, 'utf8');
    let next;
    if (file.format === 'json') {
      const obj = JSON.parse(raw || '{}');
      for (const [key, value] of Object.entries(toWrite)) {
        const parts = key.split('.');
        let node = obj;
        while (parts.length > 1) node = node[parts.shift()];
        const old = node[parts[0]];
        node[parts[0]] = typeof old === 'number' ? Number(value) : typeof old === 'boolean' ? value === 'true' : value;
      }
      next = JSON.stringify(obj, null, 2);
    } else {
      next = patchKeyValue(raw, toWrite, { section: file.section });
    }
    fs.writeFileSync(target, next);

    if (Object.keys(varPatch).length) {
      const patch = { vars: varPatch };
      if (varPatch.MAX_PLAYERS !== undefined) patch.maxPlayers = Number(varPatch.MAX_PLAYERS);
      manager.update(server.id, patch);
    }
    return { ok: true, changed: Object.keys(toWrite).length };
  },

  settingsFileFor,
};
