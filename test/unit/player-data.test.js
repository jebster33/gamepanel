'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-pd-data-'));
const nbt = require('../../server/core/nbt');
const pd = require('../../server/features/player-data');
const backups = require('../../server/features/backups');

/* A tiny NBT writer, enough to make player files. Typed values: ['byte', 1], ['int', 3], ... */
function write(root) {
  const parts = [];
  const name = (s) => {
    const b = Buffer.from(s, 'utf8');
    const h = Buffer.alloc(2);
    h.writeUInt16BE(b.length);
    parts.push(h, b);
  };
  const TYPES = { byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6, string: 8, list: 9, compound: 10 };
  const typeOf = (v) => (Array.isArray(v) && typeof v[0] === 'string' && TYPES[v[0]] && v[0] !== 'list' ? TYPES[v[0]] : Array.isArray(v) ? 9 : typeof v === 'string' ? 8 : 10);
  const payload = (v) => {
    const t = typeOf(v);
    const b = (n) => Buffer.alloc(n);
    if (t === 1) parts.push(Buffer.from([v[1] & 0xff]));
    else if (t === 2) {
      const x = b(2);
      x.writeInt16BE(v[1]);
      parts.push(x);
    } else if (t === 3) {
      const x = b(4);
      x.writeInt32BE(v[1]);
      parts.push(x);
    } else if (t === 5) {
      const x = b(4);
      x.writeFloatBE(v[1]);
      parts.push(x);
    } else if (t === 6) {
      const x = b(8);
      x.writeDoubleBE(v[1]);
      parts.push(x);
    } else if (t === 8) name(v);
    else if (t === 9) {
      const items = v;
      const it = items.length ? typeOf(items[0]) : 0;
      const x = b(5);
      x[0] = it;
      x.writeInt32BE(items.length, 1);
      parts.push(x);
      for (const i of items) payload(i);
    } else {
      for (const [k, val] of Object.entries(v)) {
        parts.push(Buffer.from([typeOf(val)]));
        name(k);
        payload(val);
      }
      parts.push(Buffer.from([0]));
    }
  };
  parts.push(Buffer.from([10]));
  name('');
  payload(root);
  return zlib.gzipSync(Buffer.concat(parts));
}

const modern = {
  Health: ['float', 17.5],
  foodLevel: ['int', 18],
  XpLevel: ['int', 30],
  playerGameType: ['int', 0],
  Dimension: 'minecraft:the_nether',
  Pos: [['double', 10.25], ['double', 64], ['double', -3.5]],
  Inventory: [
    { Slot: ['byte', 0], id: 'minecraft:diamond_sword', count: ['int', 1], components: { 'minecraft:enchantments': { levels: { 'minecraft:sharpness': ['int', 5] } }, 'minecraft:custom_name': '{"text":"Excalibur"}', 'minecraft:damage': ['int', 12] } },
    { Slot: ['byte', 9], id: 'minecraft:oak_log', count: ['int', 64] },
    { Slot: ['byte', 103], id: 'minecraft:netherite_helmet', count: ['int', 1] },
  ],
  equipment: { offhand: { id: 'minecraft:shield', count: ['int', 1] }, feet: { id: 'minecraft:diamond_boots', count: ['int', 1] } },
  EnderItems: [{ Slot: ['byte', 4], id: 'minecraft:elytra', count: ['int', 1] }],
};

const legacy = {
  Health: ['float', 20],
  Inventory: [
    { Slot: ['byte', 2], id: 'minecraft:bow', Count: ['byte', 1], tag: { Enchantments: [{ id: 'minecraft:power', lvl: ['short', 4] }], display: { Name: '{"text":"Old Bow"}' } } },
    { Slot: ['byte', -106], id: 'minecraft:torch', Count: ['byte', 32] },
    { Slot: ['byte', 102], id: 'minecraft:iron_chestplate', Count: ['byte', 1] },
  ],
};

test('reads both save formats', () => {
  const m = pd.summarize(nbt.read(write(modern)));
  assert.deepStrictEqual([m.health, m.food, m.level, m.gamemode, m.dimension], [17.5, 18, 30, 'Survival', 'the_nether']);
  assert.deepStrictEqual(m.pos, [10.3, 64, -3.5]);
  const sword = m.inventory.find((i) => i.slot === 0);
  assert.deepStrictEqual([sword.name, sword.custom, sword.damage, sword.enchants], ['Excalibur', true, 12, [{ id: 'Sharpness', level: 5 }]]);
  assert.strictEqual(m.inventory.find((i) => i.slot === 9).count, 64);
  assert.strictEqual(m.armor.head.id, 'netherite_helmet');
  assert.strictEqual(m.armor.feet.id, 'diamond_boots');
  assert.strictEqual(m.offhand.id, 'shield');
  assert.strictEqual(m.ender[0].id, 'elytra');

  const l = pd.summarize(nbt.read(write(legacy)));
  assert.deepStrictEqual(l.inventory[0].enchants, [{ id: 'Power', level: 4 }]);
  assert.strictEqual(l.inventory[0].name, 'Old Bow');
  assert.strictEqual(l.offhand.count, 32);
  assert.strictEqual(l.armor.chest.id, 'iron_chestplate');
});

test('one player comes back from a backup; refused while they are online', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-pd-'));
  const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
  fs.mkdirSync(path.join(dir, 'world/playerdata'), { recursive: true });
  // No usercache entry: found by the name Paper keeps in the file.
  fs.writeFileSync(path.join(dir, 'usercache.json'), '[]');
  fs.writeFileSync(path.join(dir, 'world/playerdata', `${uuid}.dat`), write({ ...modern, bukkit: { lastKnownName: 'Notch' } }));
  const server = { id: `pd${process.pid}`, name: 'SMP', dir };
  const { name: backup } = await backups.create(server);
  // Griefed: everything gone.
  fs.writeFileSync(path.join(dir, 'world/playerdata', `${uuid}.dat`), write({ Health: ['float', 1], Inventory: [], bukkit: { lastKnownName: 'Notch' } }));
  let playing = ['Notch'];
  const events = [];
  const manager = {
    template: () => ({ id: 'minecraft-paper', query: { type: 'minecraft' } }),
    readProperties: () => '',
    activeWorld: () => 'world',
    isActive: () => true,
    rt: () => ({ playerList: playing }),
    logActivity: (id, e) => events.push(e),
  };
  const store = { addEvent: (t) => events.push({ t }) };
  assert.strictEqual((await pd.inventory(manager, server, 'notch')).inventory.length, 0);
  assert.strictEqual((await pd.inventory(manager, server, 'notch', { backup })).inventory.length, 2);
  await assert.rejects(() => pd.restore(manager, store, server, 'Notch', backup, 'admin'), /online/);
  playing = [];
  await pd.restore(manager, store, server, 'Notch', backup, 'admin');
  const now = await pd.inventory(manager, server, 'Notch');
  assert.strictEqual(now.inventory.length, 2);
  assert.strictEqual(fs.readdirSync(path.join(dir, '.gamepanel/player-rollbacks')).length, 1);
  assert.ok(events.some((e) => e.type === 'inventory'));
  fs.rmSync(dir, { recursive: true, force: true });
});
