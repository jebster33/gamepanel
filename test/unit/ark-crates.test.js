'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crates = require('../../server/features/ark-crates');

const crate = () => ({
  crate: 'SupplyCrate_Level03_C',
  minItemSets: 1,
  maxItemSets: 2,
  numItemSetsPower: 1,
  withoutReplacement: true,
  sets: [
    {
      name: 'Tools',
      minItems: 1,
      maxItems: 2,
      numItemsPower: 1,
      weight: 2,
      withoutReplacement: true,
      entries: [
        {
          weight: 1,
          items: [
            { cls: 'PrimalItemResource_Metal_C', weight: 1 },
            { cls: 'PrimalItemResource_Stone_C', weight: 3 },
          ],
          minQuantity: 5,
          maxQuantity: 10,
          minQuality: 1,
          maxQuality: 5,
          forceBlueprint: false,
          blueprintChance: 0.25,
        },
      ],
    },
  ],
});

test('a supply crate is generated as one ini line and read back unchanged', () => {
  const text = crates.apply('[/script/shooter.shootergamemode]\nXPMultiplier=2\n', [crate()]);
  const line = text.split('\n').find((l) => l.startsWith('ConfigOverrideSupplyCrateItems='));
  assert.match(line, /SupplyCrateClassString="SupplyCrate_Level03_C",MinItemSets=1,MaxItemSets=2/);
  assert.match(line, /ItemClassStrings=\("PrimalItemResource_Metal_C","PrimalItemResource_Stone_C"\),ItemsWeights=\(1\.0,3\.0\)/);
  assert.match(line, /ChanceToBeBlueprintOverride=0\.25/);
  const parsed = crates.parse(text);
  assert.deepStrictEqual(parsed, [crate()]);
  assert.strictEqual(crates.apply(text, parsed), text);
});

test('crates with settings the form does not know are kept exactly as they were', () => {
  const odd =
    'ConfigOverrideSupplyCrateItems=(SupplyCrateClassString="SupplyCrate_Level15_C",MinItemSets=1,MaxItemSets=1,SomethingNew=5,ItemSets=((SetName="a",ItemEntries=((ItemClassStrings=("X_C"),ItemsWeights=(1.0))))))';
  const parsed = crates.parse(`[/script/shooter.shootergamemode]\n${odd}\n`);
  assert.strictEqual(parsed[0].raw, odd);
  assert.strictEqual(parsed[0].crate, 'SupplyCrate_Level15_C');
  const out = crates.apply('[/script/shooter.shootergamemode]\n', [parsed[0], crate()]);
  assert.ok(out.includes(odd));
});

test('crate input is validated', () => {
  const bad = (fn, re) => assert.throws(() => crates.apply('', [fn(crate())]), re);
  bad((c) => ({ ...c, crate: 'Crate"; x' }), /crate class name/);
  bad((c) => ({ ...c, minItemSets: 5, maxItemSets: 2 }), /minimum number of item sets/);
  bad((c) => ({ ...c, sets: [] }), /item sets/);
  bad((c) => ((c.sets[0].name = 'a"b'), c), /name may only/);
  bad((c) => ((c.sets[0].entries[0].items[0].cls = 'Bad Item'), c), /item class name/);
  bad((c) => ((c.sets[0].entries[0].minQuantity = 50), c), /minimum quantity/);
  bad((c) => ((c.sets[0].entries[0].minQuality = 9), c), /minimum quality/);
  bad((c) => ((c.sets[0].entries[0].weight = 'abc'), c), /weight/);
  assert.throws(() => crates.apply('', [{ raw: 'ConfigOverrideSupplyCrateItems=(a=1)\nquit' }]), /not valid/);
  assert.throws(() => crates.apply('', [crate(), crate()]), /twice/);
});
