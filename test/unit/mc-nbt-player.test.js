'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mcnbt-data-'));
const nbt = require('../../server/core/nbt');
const edit = require('../../server/features/player-data-edit');

const C = nbt.compound;
const L = nbt.list;

/** A hand-built 1.21.4-style player file with every tag type, some the editor knows nothing about. */
function modernPlayer() {
  return C(
    {
      DataVersion: 4189,
      Health: 17.5,
      foodLevel: 18,
      XpLevel: 30,
      XpP: 0.25,
      Pos: L([1.5, 64, -3.25], 'double'),
      Rotation: L([90, 0], 'float'),
      Dimension: 'minecraft:overworld',
      UUID: Object.assign([-1, 2, -3, 4], { [nbt.KIND]: 11 }),
      seenCredits: 1,
      abilities: C({ flying: 0, walkSpeed: 0.1, mayfly: 0 }, { flying: 'byte', walkSpeed: 'float', mayfly: 'byte' }),
      LastDeathLocation: C({ dimension: 'minecraft:overworld', pos: Object.assign([1, 2, 3], { [nbt.KIND]: 11 }) }, { pos: 'ints' }),
      Brain: C({ memories: C({}) }),
      bigNumber: 9007199254740993n,
      Tags: L([], 'string'),
      Inventory: L([
        C(
          {
            Slot: 0,
            id: 'minecraft:diamond_sword',
            count: 1,
            components: C(
              {
                'minecraft:enchantments': C({ levels: C({ 'minecraft:sharpness': 5 }, { 'minecraft:sharpness': 'int' }), show_in_tooltip: 1 }, { levels: 'compound', show_in_tooltip: 'byte' }),
                'minecraft:custom_name': '{"text":"Excalibur"}',
                'minecraft:damage': 12,
                'minecraft:lore': L(['{"text":"keep me"}'], 'string'),
              },
              { 'minecraft:enchantments': 'compound', 'minecraft:custom_name': 'string', 'minecraft:damage': 'int', 'minecraft:lore': 'list' }
            ),
          },
          { Slot: 'byte', id: 'string', count: 'int', components: 'compound' }
        ),
        C({ Slot: 9, id: 'minecraft:oak_log', count: 64 }, { Slot: 'byte', id: 'string', count: 'int' }),
        C({ Slot: 103, id: 'minecraft:iron_helmet', count: 1 }, { Slot: 'byte', id: 'string', count: 'int' }),
      ]),
      EnderItems: L([C({ Slot: 4, id: 'minecraft:elytra', count: 1 }, { Slot: 'byte', id: 'string', count: 'int' })]),
    },
    {
      DataVersion: 'int',
      Health: 'float',
      foodLevel: 'int',
      XpLevel: 'int',
      XpP: 'float',
      Pos: 'list',
      Rotation: 'list',
      Dimension: 'string',
      UUID: 'ints',
      seenCredits: 'byte',
      abilities: 'compound',
      LastDeathLocation: 'compound',
      Brain: 'compound',
      bigNumber: 'long',
      Tags: 'list',
      Inventory: 'list',
      EnderItems: 'list',
    }
  );
}

test('NBT round trip: read what was written, write it again, get the same bytes', () => {
  const original = nbt.write(modernPlayer());
  const typed = nbt.readTyped(original);
  assert.strictEqual(typed.bigNumber, 9007199254740993n, 'longs stay exact as BigInt');
  assert.strictEqual(typeof typed.foodLevel, 'number');
  assert.deepStrictEqual([...typed.UUID], [-1, 2, -3, 4]);
  assert.ok(nbt.write(typed).equals(original), 'unchanged tree writes identical bytes');
  assert.ok(nbt.write(nbt.readTyped(nbt.writeGzip(typed))).equals(original), 'gzip round trip too');
});

test('NBT writer keeps tag types, empty list types, byte arrays and modified UTF-8', () => {
  const root = C(
    { b: 1, s: 2, f: 1.5, d: 2.5, bytes: Object.assign([1, -2, 3], { [nbt.KIND]: 7 }), emptyStrings: L([], 'string'), text: 'hé \u0000 😀' },
    { b: 'byte', s: 'short', f: 'float', d: 'double', bytes: 'bytes', emptyStrings: 'list', text: 'string' }
  );
  const bytes = nbt.write(root);
  const back = nbt.readTyped(bytes);
  assert.strictEqual(back[nbt.TYPES].b, 1);
  assert.strictEqual(back[nbt.TYPES].s, 2);
  assert.strictEqual(back[nbt.TYPES].d, 6);
  assert.deepStrictEqual([...back.bytes], [1, -2, 3]);
  assert.strictEqual(back.emptyStrings[nbt.ELEM], 8);
  assert.strictEqual(back.text, 'hé \u0000 😀');
  assert.ok(nbt.write(back).equals(bytes));
  assert.throws(() => nbt.read(bytes.subarray(0, 10)), /ends early/);
});

function setup(playerData) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mcedit-'));
  const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
  fs.mkdirSync(path.join(dir, 'world/playerdata'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'usercache.json'), JSON.stringify([{ name: 'Notch', uuid }]));
  const file = path.join(dir, 'world/playerdata', `${uuid}.dat`);
  fs.writeFileSync(file, nbt.writeGzip(playerData));
  const events = [];
  let playing = [];
  const manager = {
    template: () => ({ id: 'minecraft-paper', query: { type: 'minecraft' } }),
    activeWorld: () => 'world',
    isActive: () => playing.length > 0,
    rt: () => ({ playerList: playing }),
    logActivity: (id, e) => events.push(e),
  };
  const store = { addEvent: (t) => events.push({ t }) };
  return { dir, uuid, file, manager, store, server: { id: 'x', name: 'SMP', dir }, events, play: (list) => (playing = list) };
}

test('editing keeps unknown tags, backs up first, and writes a file the reader accepts', async () => {
  const s = setup(modernPlayer());
  const before = await edit.view(s.manager, s.server, 'Notch');
  assert.strictEqual(before.editable, true);
  assert.strictEqual(before.format, 'new');
  const sword = before.inventory.find((i) => i.slot === 0);
  assert.deepStrictEqual([sword.id, sword.name, sword.damage, sword.enchants], ['minecraft:diamond_sword', 'Excalibur', 12, [{ id: 'minecraft:sharpness', level: 5 }]]);

  // Move the sword to slot 5 (from: 0), rename it, add an apple, delete the logs, change the ender chest.
  const after = await edit.save(
    s.manager,
    s.store,
    s.server,
    'Notch',
    {
      version: before.version,
      inventory: [
        { slot: 5, from: { box: 'inventory', slot: 0 }, id: 'minecraft:diamond_sword', count: 1, damage: 0, name: 'Renamed', enchants: [{ id: 'minecraft:sharpness', level: 5 }, { id: 'minecraft:unbreaking', level: 3 }] },
        { slot: 1, id: 'minecraft:apple', count: 16 },
        { slot: 103, from: { box: 'inventory', slot: 103 }, id: 'minecraft:iron_helmet', count: 1 },
      ],
      ender: [{ slot: 0, id: 'minecraft:totem_of_undying', count: 1 }],
    },
    'admin'
  );
  assert.deepStrictEqual(
    after.inventory.map((i) => [i.slot, i.id]).sort((a, b) => a[0] - b[0]),
    [[1, 'minecraft:apple'], [5, 'minecraft:diamond_sword'], [103, 'minecraft:iron_helmet']]
  );
  assert.deepStrictEqual(after.ender.map((i) => i.id), ['minecraft:totem_of_undying']);

  const written = nbt.readTyped(fs.readFileSync(s.file));
  assert.strictEqual(written.bigNumber, 9007199254740993n, 'unrelated long untouched');
  assert.deepStrictEqual([...written.UUID], [-1, 2, -3, 4]);
  assert.strictEqual(written.abilities[nbt.TYPES].walkSpeed, 5);
  assert.ok(written.LastDeathLocation && written.Brain);
  const moved = written.Inventory.find((i) => i.Slot === 5);
  assert.deepStrictEqual([...moved.components['minecraft:lore']], ['{"text":"keep me"}'], 'tags the editor does not show survive a move');
  assert.strictEqual(moved.components['minecraft:enchantments'].show_in_tooltip, 1);
  assert.strictEqual(moved.components['minecraft:enchantments'].levels['minecraft:unbreaking'], 3);
  assert.strictEqual(moved.components['minecraft:custom_name'], '{"text":"Renamed"}');
  assert.strictEqual(moved.components['minecraft:damage'], undefined);
  assert.strictEqual(written.Inventory.find((i) => i.Slot === 1).count, 16);
  assert.strictEqual(written[nbt.TYPES].Inventory, 9);

  // The old file was copied first.
  const dirKept = path.join(s.dir, '.gamepanel/player-rollbacks');
  const kept = fs.readdirSync(dirKept);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(nbt.read(fs.readFileSync(path.join(dirKept, kept[0]))).Inventory.length, 3);
  assert.ok(s.events.some((e) => e.t === 'player.edited'));
});

test('editing is refused while the player is online, with a stale version, or with bad items', async () => {
  const s = setup(modernPlayer());
  const view = await edit.view(s.manager, s.server, 'Notch');
  s.play(['notch']);
  assert.strictEqual((await edit.view(s.manager, s.server, 'Notch')).editable, false);
  await assert.rejects(() => edit.save(s.manager, s.store, s.server, 'Notch', { inventory: [] }, 'a'), /online/);
  s.play([]);
  await assert.rejects(() => edit.save(s.manager, s.store, s.server, 'Notch', { version: 'stale', inventory: [] }, 'a'), /changed/);
  for (const bad of [
    { slot: 0, id: 'minecraft:stone;op', count: 1 },
    { slot: 0, id: 'minecraft:stone', count: 0 },
    { slot: 99, id: 'minecraft:stone', count: 1 },
    { slot: 0, id: 'minecraft:stone', count: 1, enchants: [{ id: 'minecraft:sharpness', level: 999 }] },
  ]) {
    await assert.rejects(() => edit.save(s.manager, s.store, s.server, 'Notch', { version: view.version, inventory: [bad] }, 'a'), /./);
  }
  await assert.rejects(
    () => edit.save(s.manager, s.store, s.server, 'Notch', { version: view.version, inventory: [{ slot: 1, id: 'a', count: 1 }, { slot: 1, id: 'b', count: 1 }] }, 'a'),
    /share a slot/
  );
  // Nothing was written by any of the refusals.
  assert.strictEqual(fs.existsSync(path.join(s.dir, '.gamepanel/player-rollbacks')), false);
});

test('legacy (tag) files and 1.21.5+ equipment files edit in their own format', async () => {
  const legacy = C(
    {
      DataVersion: 3465,
      Inventory: L([
        C(
          {
            Slot: 2,
            id: 'minecraft:bow',
            Count: 1,
            tag: C({ Enchantments: L([C({ id: 'minecraft:power', lvl: 4 }, { id: 'string', lvl: 'short' })]), display: C({ Name: '{"text":"Old Bow"}' }), Custom: 7 }, { Enchantments: 'list', display: 'compound', Custom: 'int' }),
          },
          { Slot: 'byte', id: 'string', Count: 'byte', tag: 'compound' }
        ),
      ]),
    },
    { DataVersion: 'int', Inventory: 'list' }
  );
  const a = setup(legacy);
  const v = await edit.view(a.manager, a.server, 'Notch');
  assert.strictEqual(v.format, 'legacy');
  await edit.save(
    a.manager,
    a.store,
    a.server,
    'Notch',
    { version: v.version, inventory: [{ slot: 2, from: { box: 'inventory', slot: 2 }, id: 'minecraft:bow', count: 1, name: 'Old Bow', enchants: [{ id: 'minecraft:power', level: 5 }] }, { slot: 3, id: 'minecraft:arrow', count: 64 }] },
    'a'
  );
  const w = nbt.readTyped(fs.readFileSync(a.file));
  const bow = w.Inventory.find((i) => i.Slot === 2);
  assert.strictEqual(bow.tag.Enchantments[0].lvl, 5);
  assert.strictEqual(bow.tag.Enchantments[0][nbt.TYPES].lvl, 2, 'lvl stays a short');
  assert.strictEqual(bow.tag.Custom, 7);
  assert.strictEqual(bow[nbt.TYPES].Count, 1);
  assert.strictEqual(w.Inventory.find((i) => i.Slot === 3).Count, 64);

  const flat = C(
    {
      DataVersion: 4440,
      Inventory: L([]),
      equipment: C({ offhand: C({ id: 'minecraft:shield', count: 1 }, { id: 'string', count: 'int' }) }, { offhand: 'compound' }),
    },
    { DataVersion: 'int', Inventory: 'list', equipment: 'compound' }
  );
  const b = setup(flat);
  const bv = await edit.view(b.manager, b.server, 'Notch');
  assert.deepStrictEqual(bv.inventory.map((i) => [i.slot, i.id]), [[-106, 'minecraft:shield']]);
  await edit.save(
    b.manager,
    b.store,
    b.server,
    'Notch',
    {
      version: bv.version,
      inventory: [
        { slot: -106, from: { box: 'inventory', slot: -106 }, id: 'minecraft:shield', count: 1 },
        { slot: 100, id: 'minecraft:diamond_boots', count: 1, enchants: [{ id: 'minecraft:protection', level: 4 }] },
      ],
    },
    'a'
  );
  const bw = nbt.readTyped(fs.readFileSync(b.file));
  assert.strictEqual(bw.equipment.feet.id, 'minecraft:diamond_boots');
  assert.strictEqual(bw.equipment.feet.Slot, undefined);
  assert.strictEqual(bw.equipment.feet.components['minecraft:enchantments']['minecraft:protection'], 4, '1.21.5+ stores a flat enchantment map');
  assert.strictEqual(bw.Inventory.length, 0);
});
