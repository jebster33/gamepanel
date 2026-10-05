'use strict';

/**
 * Whitelist, operators and bans for games that keep them in files the panel
 * can read (Minecraft Java and Bedrock).
 *
 * While the server runs, changes go through the game's own console commands so
 * it picks them up at once and writes its files itself. While it is stopped the
 * panel edits the files directly, looking up the player's UUID the same way the
 * game would (Mojang in online mode, the offline UUID otherwise).
 */

const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { fail } = require('../core/util');
const { containedPath } = require('../features/files');
const { getJson } = require('../features/mods/http');

const JAVA = {
  whitelist: {
    label: 'Whitelist',
    file: 'whitelist.json',
    add: 'whitelist add {name}',
    remove: 'whitelist remove {name}',
    toggle: { property: 'white-list', on: 'whitelist on', off: 'whitelist off' },
    log: ['whitelist', 'unwhitelist'],
  },
  ops: { label: 'Operators', file: 'ops.json', add: 'op {name}', remove: 'deop {name}', log: ['op', 'deop'] },
  bans: { label: 'Banned players', file: 'banned-players.json', add: 'ban {name}{reason}', remove: 'pardon {name}', reason: true, log: ['ban', 'unban'] },
  ipbans: { label: 'Banned IPs', file: 'banned-ips.json', add: 'ban-ip {name}{reason}', remove: 'pardon-ip {name}', reason: true, ip: true, log: ['ban', 'unban'] },
};

const BEDROCK = {
  whitelist: {
    label: 'Allowlist',
    file: 'allowlist.json',
    add: 'allowlist add "{name}"',
    remove: 'allowlist remove "{name}"',
    toggle: { property: 'allow-list' },
    log: ['whitelist', 'unwhitelist'],
    bedrock: true,
  },
};

function listsFor(template) {
  if (!template) return null;
  if (template.id === 'minecraft-bedrock') return BEDROCK;
  if (template.id?.startsWith('minecraft') || template.query?.type === 'minecraft') return JAVA;
  return null;
}

/** Version 3 UUID of "OfflinePlayer:<name>", as Minecraft makes for offline-mode servers. */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readProperty(server, key) {
  try {
    const raw = fs.readFileSync(containedPath(server.dir, 'server.properties'), 'utf8');
    const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : null;
  } catch {
    return null;
  }
}

function readJson(server, file) {
  try {
    const data = JSON.parse(fs.readFileSync(containedPath(server.dir, file), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeJson(server, file, data) {
  fs.writeFileSync(containedPath(server.dir, file), `${JSON.stringify(data, null, 2)}\n`);
}

function cleanName(def, raw) {
  const name = String(raw || '').trim();
  if (def.ip) {
    if (!net.isIP(name)) fail(400, 'Enter an IP address, like 203.0.113.7');
    return name;
  }
  const ok = def.bedrock ? /^[A-Za-z0-9 _]{1,32}$/ : /^[A-Za-z0-9_]{1,16}$/;
  if (!ok.test(name)) fail(400, def.bedrock ? 'Enter a gamertag (letters, numbers, spaces)' : 'Enter a Minecraft username (letters, numbers and _ only)');
  return name;
}

function cleanReason(raw) {
  return String(raw || '')
    .replace(/[\x00-\x1f"]/g, ' ')
    .trim()
    .slice(0, 120);
}

async function lookupUuid(server, name) {
  if (readProperty(server, 'online-mode') === 'false') return offlineUuid(name);
  let profile;
  try {
    profile = await getJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  } catch (err) {
    fail(err.code === 404 ? 404 : 502, err.code === 404 ? `There is no Minecraft account called ${name}` : `Could not look up ${name}: ${err.message}`);
  }
  if (!profile?.id) fail(404, `There is no Minecraft account called ${name}`);
  const id = profile.id;
  return { uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`, name: profile.name };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  listsFor,
  offlineUuid,

  /** Every list with its entries, plus whether the whitelist is switched on. */
  readLists(manager, server) {
    const lists = listsFor(manager.template(server));
    if (!lists) return { supported: false };
    return {
      supported: true,
      running: manager.rt(server.id).status === 'running',
      lists: Object.entries(lists).map(([id, def]) => ({
        id,
        label: def.label,
        ip: Boolean(def.ip),
        reason: Boolean(def.reason),
        enabled: def.toggle ? readProperty(server, def.toggle.property) === 'true' : undefined,
        entries: readJson(server, def.file).map((e) => ({
          name: e.name || e.ip,
          uuid: e.uuid || e.xuid || null,
          reason: e.reason || null,
          created: e.created || null,
          source: e.source || null,
          level: e.level ?? null,
        })),
      })),
    };
  },

  async changeList(manager, server, { list, action, name, reason }, by) {
    const lists = listsFor(manager.template(server));
    const def = lists?.[list];
    if (!def) fail(400, 'This game has no such list');
    if (action !== 'add' && action !== 'remove') fail(400, 'Choose add or remove');
    name = cleanName(def, name);
    const why = def.reason ? cleanReason(reason) : '';
    const running = manager.rt(server.id).status === 'running';

    if (running) {
      const command = def[action].replace('{name}', name).replace('{reason}', why ? ` ${why}` : '');
      await manager.sendCommand(server.id, command);
      await sleep(800); // give the game a moment to write its file
    } else {
      const entries = readJson(server, def.file);
      const key = def.ip ? 'ip' : 'name';
      const index = entries.findIndex((e) => String(e[key]).toLowerCase() === name.toLowerCase());
      if (action === 'remove') {
        if (index === -1) fail(404, `${name} is not on the ${def.label.toLowerCase()}`);
        entries.splice(index, 1);
      } else if (index === -1) {
        const entry = def.ip || def.bedrock ? { [key]: name } : await lookupUuid(server, name);
        const record = typeof entry === 'string' ? { uuid: entry, name } : entry;
        if (def.bedrock) record.ignoresPlayerLimit = false;
        if (list === 'ops') Object.assign(record, { level: 4, bypassesPlayerLimit: false });
        if (def.reason) {
          const created = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000');
          Object.assign(record, { created, source: by ? `GamePanel (${by})` : 'GamePanel', expires: 'forever', reason: why || 'Banned by an operator.' });
        }
        entries.push(record);
      }
      writeJson(server, def.file, entries);
    }
    manager.logActivity(server.id, { type: def.log[action === 'add' ? 0 : 1], name, by, ...(why ? { text: why } : {}) });
    return module.exports.readLists(manager, server);
  },

  /** Switch the whitelist on or off. */
  async setWhitelist(manager, server, on, by) {
    const def = listsFor(manager.template(server))?.whitelist;
    if (!def?.toggle) fail(400, 'This game has no whitelist');
    const running = manager.rt(server.id).status === 'running';
    if (running && def.toggle.on) {
      await manager.sendCommand(server.id, on ? def.toggle.on : def.toggle.off);
      await sleep(800);
    } else {
      const { patchKeyValue } = require('../servers/config-files');
      const file = containedPath(server.dir, 'server.properties');
      const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      fs.writeFileSync(file, patchKeyValue(raw, { [def.toggle.property]: String(Boolean(on)) }));
    }
    manager.logActivity(server.id, { type: on ? 'whitelist-on' : 'whitelist-off', by });
    return { ...module.exports.readLists(manager, server), restartNeeded: running && !def.toggle.on };
  },
};
