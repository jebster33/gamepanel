'use strict';

/**
 * Hand-written layouts for popular plugin configs. A schema names a plugin,
 * puts its settings into groups in a sensible order and adds the labels and
 * help text the file itself lacks. Keys the schema does not know are still
 * shown (under "Other settings"), so a newer plugin version never loses
 * settings; keys a file does not have are ignored.
 *
 * Schema: { id, title, description, match: RegExp for the file path,
 *   groups: [{ name, help?, keys: ['dotted.path' | 'prefix.*' | 'a.*.b'] }],
 *   fields: { 'dotted.path': { label?, help?, unit?, options?, min?, max? } } }
 * Paths compare case-insensitively; `*` stands for one path part.
 */

const SCHEMAS = [
  {
    id: 'paper-global',
    title: 'Paper: global settings',
    description: 'Server-wide performance and behaviour for Paper and its forks. Most servers only need the Connections and Chunks groups.',
    match: /(^|\/)paper-global\.yml$|(^|\/)config\/paper-global\.yml$/i,
    groups: [
      { name: 'Connections', keys: ['proxies.*', 'misc.max-joins-per-tick', 'packet-limiter.*'] },
      { name: 'Chunks', keys: ['chunk-loading-basic.*', 'chunk-loading-advanced.*', 'chunk-system.*'] },
      { name: 'Performance', keys: ['collisions.*', 'misc.*', 'timings.*', 'async-chunks.*'] },
    ],
    fields: {
      'misc.max-joins-per-tick': { label: 'Max joins per tick', help: 'Players allowed to finish logging in each tick. Lower it if a join rush lags the server.' },
      'chunk-loading-basic.player-max-chunk-send-rate': { label: 'Chunk send rate per player', unit: 'chunks/s', help: 'How fast chunks are sent to each player.' },
      'proxies.velocity.enabled': { label: 'Behind Velocity', help: 'Turn on when this server sits behind a Velocity proxy.' },
      'proxies.velocity.online-mode': { label: 'Velocity online mode' },
      'proxies.bungee-cord.online-mode': { label: 'BungeeCord online mode' },
    },
  },
  {
    id: 'paper-world',
    title: 'Paper: per-world defaults',
    description: 'How the world behaves: anti-xray, mob limits, explosions and fixes. Applies to every world unless one overrides it.',
    match: /paper-world-defaults\.yml$/i,
    groups: [
      { name: 'Anti-xray', keys: ['anticheat.anti-xray.*'] },
      { name: 'Mobs and spawning', keys: ['entities.spawning.*', 'entities.behavior.*', 'spawn-limits.*'] },
      { name: 'Chunks', keys: ['chunks.*'] },
      { name: 'Environment', keys: ['environment.*', 'tick-rates.*', 'hopper.*'] },
      { name: 'Fixes', keys: ['fixes.*', 'unsupported-settings.*'] },
    ],
    fields: {
      'anticheat.anti-xray.enabled': { label: 'Anti-xray', help: 'Hides ores behind other blocks from x-ray clients. Costs some CPU.' },
      'anticheat.anti-xray.engine-mode': { label: 'Anti-xray mode', help: '1 hides ores, 2 fills with fake ores, 3 is mode 2 with chunk-level tricks.', min: 1, max: 3 },
      'chunks.max-auto-save-chunks-per-tick': { label: 'Chunks saved per tick', help: 'Raise on big servers if autosaves lag.' },
      'environment.optimize-explosions': { label: 'Faster explosions' },
      'entities.spawning.per-player-mob-spawns': { label: 'Per-player mob spawns', help: 'Spreads the mob cap between players instead of sharing it.' },
    },
  },
  {
    id: 'bukkit',
    title: 'Bukkit settings',
    description: 'Mob caps, spawn timing and a few core switches.',
    match: /^bukkit\.yml$/i,
    groups: [
      { name: 'Mob limits', keys: ['spawn-limits.*'] },
      { name: 'Spawn timing', keys: ['ticks-per.*'] },
      { name: 'World', keys: ['settings.allow-end', 'chunk-gc.*'] },
      { name: 'Connections', keys: ['settings.connection-throttle', 'settings.query-plugins'] },
    ],
    fields: {
      'spawn-limits.monsters': { label: 'Monster cap', help: 'Per player, not per world. Vanilla is 70.' },
      'spawn-limits.animals': { label: 'Animal cap', help: 'Vanilla is 10.' },
      'spawn-limits.water-animals': { label: 'Water animal cap', help: 'Vanilla is 5.' },
      'spawn-limits.water-ambient': { label: 'Water ambient cap' },
      'spawn-limits.ambient': { label: 'Ambient (bat) cap', help: 'Vanilla is 15.' },
      'ticks-per.animal-spawns': { label: 'Animal spawn interval', unit: 'ticks', help: 'Higher means fewer spawn attempts and less CPU. 400 is the default.' },
      'ticks-per.monster-spawns': { label: 'Monster spawn interval', unit: 'ticks', help: '1 is the default.' },
      'settings.allow-end': { label: 'Allow the End' },
      'settings.connection-throttle': { label: 'Reconnect throttle', unit: 'ms', help: 'Minimum time between connections from the same address. -1 turns it off (needed behind a proxy).' },
    },
  },
  {
    id: 'spigot',
    title: 'Spigot settings',
    description: 'View distance, entity activation ranges and item merging: the knobs that matter most for lag.',
    match: /^spigot\.yml$/i,
    groups: [
      { name: 'Distances', keys: ['world-settings.*.view-distance', 'world-settings.*.simulation-distance', 'world-settings.*.mob-spawn-range'] },
      { name: 'Entity activation range', help: 'How close a player has to be before a mob is fully processed. Smaller means less lag.', keys: ['world-settings.*.entity-activation-range.*'] },
      { name: 'Item and XP merging', keys: ['world-settings.*.merge-radius.*', 'world-settings.*.item-despawn-rate'] },
      { name: 'Crop and plant growth', keys: ['world-settings.*.growth.*'] },
      { name: 'Hoppers', keys: ['world-settings.*.hopper-*'] },
      { name: 'Server', keys: ['settings.*'] },
    ],
    fields: {
      'world-settings.*.view-distance': { label: 'View distance', unit: 'chunks', help: '"default" follows server.properties.' },
      'world-settings.*.simulation-distance': { label: 'Simulation distance', unit: 'chunks' },
      'world-settings.*.mob-spawn-range': { label: 'Mob spawn range', unit: 'chunks' },
      'world-settings.*.item-despawn-rate': { label: 'Item despawn time', unit: 'ticks', help: '6000 ticks is 5 minutes.' },
      'world-settings.*.merge-radius.item': { label: 'Item merge radius', unit: 'blocks' },
      'world-settings.*.merge-radius.exp': { label: 'XP orb merge radius', unit: 'blocks' },
      'world-settings.*.nerf-spawner-mobs': { label: 'Nerf spawner mobs', help: 'Mobs from spawners get no AI. Saves a lot of CPU with big spawner farms.' },
      'settings.bungeecord': { label: 'Behind BungeeCord', help: 'Turn on for BungeeCord or legacy Velocity forwarding.' },
      'settings.save-user-cache-on-stop-only': { label: 'Save user cache on stop only' },
    },
  },
  {
    id: 'essentialsx',
    title: 'EssentialsX',
    description: 'Homes, teleports, economy, chat and AFK.',
    match: /^plugins\/essentials\/config\.yml$/i,
    groups: [
      { name: 'Economy', keys: ['starting-balance', 'currency-symbol', 'min-money', 'max-money', 'economy-log*', 'currency-symbol-suffix', 'minimum-pay-amount'] },
      { name: 'Teleporting', keys: ['teleport-*', 'tpa-*', 'respawn-at-home', 'spawn-on-join', 'per-warp-permission', 'sethome-*'] },
      { name: 'Players', keys: ['max-nick-length', 'change-displayname', 'nickname-*', 'heal-cooldown', 'god-in-pvp', 'newbies.*', 'allow-silent-join-quit', 'custom-join-message', 'custom-quit-message', 'drop-items-if-full', 'unsafe-enchantments'] },
      { name: 'AFK', keys: ['auto-afk*', 'afk-*'] },
      { name: 'Chat', keys: ['chat.*', 'add-prefix-suffix', 'last-message-reply-recipient'] },
    ],
    fields: {
      'starting-balance': { label: 'Starting balance', help: 'What a new player gets in their account.' },
      'currency-symbol': { label: 'Currency symbol' },
      'teleport-cooldown': { label: 'Teleport cooldown', unit: 'seconds', help: '0 turns the cooldown off.' },
      'teleport-delay': { label: 'Teleport delay', unit: 'seconds', help: 'Players have to stand still this long before they teleport.' },
      'teleport-invulnerability': { label: 'Safe time after teleport', unit: 'seconds' },
      'auto-afk': { label: 'Mark idle players AFK after', unit: 'seconds', help: '0 turns it off.' },
      'auto-afk-kick': { label: 'Kick AFK players after', unit: 'seconds', help: '-1 never kicks.' },
      'spawn-on-join': { label: 'Send players to spawn on join', help: 'true, false, or a group name.' },
      'respawn-at-home': { label: 'Respawn at home' },
      'per-warp-permission': { label: 'Permission per warp', help: 'Players need essentials.warps.<name> to use a warp.' },
      'max-nick-length': { label: 'Longest nickname' },
    },
  },
  {
    id: 'worldguard',
    title: 'WorldGuard',
    description: 'Region limits and general protection switches.',
    match: /^plugins\/worldguard\/config\.yml$/i,
    groups: [
      { name: 'Regions', keys: ['regions.*'] },
      { name: 'Security', keys: ['security.*', 'blacklist.*'] },
    ],
    fields: {
      'regions.max-region-count-per-player.default': { label: 'Regions per player', help: '-1 means unlimited.' },
      'regions.claim-only-inside-existing-regions': { label: 'Claim only inside existing regions' },
      'regions.wand': { label: 'Wand item', help: 'The item used with /rg claim selections.' },
    },
  },
  {
    id: 'coreprotect',
    title: 'CoreProtect',
    description: 'What gets logged for rollbacks and lookups. Turn off what you do not need to keep the database small.',
    match: /^plugins\/coreprotect\/config\.yml$/i,
    groups: [
      { name: 'Lookups and rollbacks', keys: ['default-radius', 'max-radius', 'rollback-items', 'rollback-entities', 'skip-generic-data', 'verbose', 'check-updates'] },
      { name: 'Blocks', keys: ['block-place', 'block-break', 'natural-break', 'block-movement', 'pistons', 'leaf-decay', 'tree-growth', 'mushroom-growth', 'vine-growth', 'portals', 'water-flow', 'lava-flow', 'liquid-tracking'] },
      { name: 'Players and items', keys: ['item-transactions', 'item-drops', 'item-pickups', 'hopper-transactions', 'player-interactions', 'player-messages', 'player-commands', 'player-sessions', 'username-changes', 'sign-text', 'buckets', 'entity-change', 'entity-kills', 'worldedit'] },
      { name: 'Database', keys: ['use-mysql', 'mysql-*', 'table-prefix'] },
    ],
    fields: {
      'default-radius': { label: 'Default lookup radius', unit: 'blocks' },
      'max-radius': { label: 'Biggest radius allowed', unit: 'blocks', help: 'Large radii take a long time on big worlds.' },
      'player-messages': { label: 'Log chat' },
      'player-commands': { label: 'Log commands' },
      'item-pickups': { label: 'Log item pickups', help: 'Chatty. Turn off to save space.' },
      'natural-break': { label: 'Log natural block breaks' },
      'use-mysql': { label: 'Use MySQL', help: 'Off uses a local file database.' },
    },
  },
  {
    id: 'geyser',
    title: 'Geyser (Bedrock crossplay)',
    description: 'Lets Bedrock players join a Java server.',
    match: /^plugins\/geyser-[^/]+\/config\.yml$/i,
    groups: [
      { name: 'Bedrock side', keys: ['bedrock.*'] },
      { name: 'Java server', keys: ['remote.*'] },
      { name: 'Players', keys: ['max-players', 'passthrough-*', 'show-cooldown', 'forward-player-ping', 'default-locale', 'allow-third-party-*'] },
    ],
    fields: {
      'bedrock.port': { label: 'Bedrock port', unit: 'UDP', help: 'Open this UDP port on your router and firewall.' },
      'bedrock.motd1': { label: 'Server name, line 1' },
      'bedrock.motd2': { label: 'Server name, line 2' },
      'remote.auth-type': { label: 'Sign-in', help: 'floodgate lets Bedrock players join without a Java account. online needs one.', options: ['online', 'offline', 'floodgate'] },
      'remote.address': { label: 'Java server address', help: 'auto if Geyser runs on the same server as a plugin.' },
    },
  },
  {
    id: 'gathermanager',
    title: 'Gather Manager (Rust)',
    description: 'Gather rates. 1 is vanilla, 2 is double, 10 is ten times. For a quick 2x to 10x preset use the Game settings tab.',
    match: /^oxide\/config\/gathermanager\.json$/i,
    groups: [
      { name: 'Hitting trees, rocks and animals', help: 'Per resource multiplier.', keys: ['gatherresourcemodifiers.*'] },
      { name: 'Corpses and animals', keys: ['gatherdispensermodifiers.*'] },
      { name: 'Pickups', keys: ['pickupresourcemodifiers.*'] },
      { name: 'Quarries and excavators', keys: ['quarryresourcemodifiers.*', 'excavatorresourcemodifiers.*', 'surveyresourcemodifiers.*', 'miningquarryresourcetickrate', 'excavatorresourcetickrate', 'excavatortimebeforebreak'] },
    ],
    fields: {
      miningquarryresourcetickrate: { label: 'Mining quarry tick rate', unit: 'seconds', help: 'Lower means faster output.' },
      excavatorresourcetickrate: { label: 'Excavator tick rate', unit: 'seconds', help: 'Lower means faster output.' },
    },
  },
];

const norm = (s) => String(s).toLowerCase();
const matcher = (pattern) => {
  const re = new RegExp(`^${norm(pattern).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*')}$`);
  // "a.*" also covers everything below a; "a.*.b" is one part in the middle.
  const deep = norm(pattern).endsWith('.*') ? new RegExp(`^${norm(pattern).slice(0, -2).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*')}\\.`) : null;
  return (p) => re.test(p) || Boolean(deep && deep.test(p));
};

const compiled = SCHEMAS.map((s) => ({
  ...s,
  groups: s.groups.map((g) => ({ ...g, tests: g.keys.map(matcher) })),
  fieldTests: Object.entries(s.fields || {}).map(([key, def]) => ({ test: matcher(key), def })),
}));

const schemaFor = (rel) => compiled.find((s) => s.match.test(rel)) || null;

/**
 * Applies the schema of `rel` (if any) to parsed fields: labels, help, units,
 * options, and a `crumbs` path (group › section) for the form to nest by.
 * Returns { plugin, groups } or null when the file has no schema.
 */
function decorate(rel, fields) {
  const schema = schemaFor(rel);
  if (!schema) return null;
  const used = new Set();
  for (const f of fields) {
    const p = norm(f.path.join('.'));
    const def = schema.fieldTests.find((t) => t.test(p))?.def;
    if (def) {
      if (def.label) f.label = def.label;
      if (def.help) f.help = def.help;
      if (def.unit) f.unit = def.unit;
      if (def.min !== undefined) f.min = def.min;
      if (def.max !== undefined) f.max = def.max;
      if (def.options && f.type === 'string') {
        f.type = 'select';
        f.options = def.options;
      }
    }
    const group = schema.groups.find((g) => g.tests.some((t) => t(p)));
    if (group) {
      f.crumbs = [group.name];
      used.add(group.name);
    } else f.crumbs = ['Other settings', ...String(f.section || '').split(' › ').filter(Boolean)];
  }
  const groups = schema.groups.filter((g) => used.has(g.name)).map((g) => ({ name: g.name, help: g.help }));
  if (fields.some((f) => f.crumbs[0] === 'Other settings')) groups.push({ name: 'Other settings', collapsed: true });
  return { plugin: { id: schema.id, title: schema.title, description: schema.description }, groups };
}

module.exports = { decorate, schemaFor, SCHEMAS };
