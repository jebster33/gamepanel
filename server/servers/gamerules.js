'use strict';

/**
 * Game rules for Minecraft Java (keep inventory, daylight cycle, mob
 * griefing…), read and changed over RCON while the server runs, like the
 * switches on Aternos. Mixed into ServerManager (see manager.js).
 */

const { fail } = require('../core/util');
const { rconCommand } = require('../games/rcon');

const JAVA = ['minecraft-vanilla', 'minecraft-paper', 'minecraft-purpur', 'minecraft-fabric', 'minecraft-forge', 'minecraft-neoforge', 'minecraft-quilt', 'minecraft-modpack'];

// [rule, label, kind]. Newer releases (1.21.11+) renamed rules to snake_case, so both are tried.
const RULES = [
  ['keepInventory', 'Keep inventory after death', 'bool'],
  ['doDaylightCycle', 'Day and night cycle', 'bool'],
  ['doWeatherCycle', 'Weather changes', 'bool'],
  ['doMobSpawning', 'Mobs spawn', 'bool'],
  ['mobGriefing', 'Mobs break blocks (creepers, endermen)', 'bool'],
  ['doFireTick', 'Fire spreads', 'bool'],
  ['doInsomnia', 'Phantoms', 'bool'],
  ['naturalRegeneration', 'Health regenerates', 'bool'],
  ['doImmediateRespawn', 'Skip the death screen', 'bool'],
  ['announceAdvancements', 'Announce advancements in chat', 'bool'],
  ['showDeathMessages', 'Death messages in chat', 'bool'],
  ['fallDamage', 'Fall damage', 'bool'],
  ['doTraderSpawning', 'Wandering traders', 'bool'],
  ['doPatrolSpawning', 'Pillager patrols', 'bool'],
  ['playersSleepingPercentage', 'Players who must sleep to skip night (%)', 'int'],
  ['spawnRadius', 'Spawn radius (blocks)', 'int'],
  ['randomTickSpeed', 'Random tick speed (crop growth)', 'int'],
];

const snake = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const VALUE = /(?:currently set to|is now set to)[:\s]*([\w.-]+)/i;

module.exports = {
  gameruleTarget(server) {
    if (!JAVA.includes(server.templateId)) fail(400, 'Game rules are for Minecraft Java servers');
    if (this.rt(server.id).status !== 'running') fail(409, 'Start the server to see and change game rules');
    const port = server.ports?.rcon;
    const password = server.vars?.RCON_PASSWORD;
    if (!port || !password) fail(400, 'This server has no RCON set up');
    return (command) => rconCommand({ port, password, command, timeout: 4000 });
  },

  async gamerules(server) {
    if (!JAVA.includes(server.templateId)) return { supported: false };
    if (this.rt(server.id).status !== 'running') return { supported: true, running: false, rules: [] };
    const rcon = this.gameruleTarget(server);
    const rules = [];
    for (const [name, label, kind] of RULES) {
      let value = null;
      let id = name;
      for (const candidate of [name, snake(name)]) {
        const out = String(await rcon(`gamerule ${candidate}`).catch(() => '')).replace(/§./g, '');
        const m = out.match(VALUE);
        if (m) {
          value = m[1];
          id = candidate;
          break;
        }
      }
      if (value === null) continue;
      rules.push({ name: id, label, kind, value: kind === 'bool' ? value === 'true' : Number(value) });
    }
    return { supported: true, running: true, rules };
  },

  async setGamerule(server, name, value) {
    const rule = RULES.find(([n]) => n === name || snake(n) === name);
    if (!rule) fail(400, 'Unknown game rule');
    const v = rule[2] === 'bool' ? String(Boolean(value)) : String(Math.max(0, Math.min(rule[0] === 'randomTickSpeed' ? 4096 : 100000, Math.round(Number(value) || 0))));
    const out = String(await this.gameruleTarget(server)(`gamerule ${name} ${v}`)).replace(/§./g, '');
    if (!VALUE.test(out)) fail(400, out.trim() || 'The server did not accept that');
    return { name, value: rule[2] === 'bool' ? v === 'true' : Number(v) };
  },
};
