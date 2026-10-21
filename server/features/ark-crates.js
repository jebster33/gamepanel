'use strict';

/**
 * ARK supply drop loot in Game.ini: one ConfigOverrideSupplyCrateItems line per crate.
 *
 *   ConfigOverrideSupplyCrateItems=(SupplyCrateClassString="SupplyCrate_Level03_C",
 *     MinItemSets=1,MaxItemSets=3,NumItemSetsPower=1.0,bSetsRandomWithoutReplacement=true,
 *     ItemSets=((SetName="Tools",MinNumItems=1,MaxNumItems=2,NumItemsPower=1.0,SetWeight=1.0,
 *       bItemsRandomWithoutReplacement=true,
 *       ItemEntries=((EntryWeight=1.0,ItemClassStrings=("PrimalItemResource_Metal_C"),ItemsWeights=(1.0),
 *         MinQuantity=1,MaxQuantity=10,MinQuality=1.0,MaxQuality=5.0,bForceBlueprint=false,ChanceToBeBlueprintOverride=0.0)))))
 *
 * Crates the editor fully understands round-trip as a form. A crate with keys it
 * does not know is kept as its original line (`raw`) so saving never loses anything.
 * Written from the ARK wiki's description; not run against a live server.
 */

const { fail } = require('../core/util');
const G = require('./ark-gameini');

const KEY = 'ConfigOverrideSupplyCrateItems';

/** The crates players meet most. Anything else can be typed in as a class name. */
const CRATES = [
  ['SupplyCrate_Level03_C', 'Supply drop, level 3 (white)'],
  ['SupplyCrate_Level03_Double_C', 'Supply drop, level 3 (white, double)'],
  ['SupplyCrate_Level15_C', 'Supply drop, level 15 (green)'],
  ['SupplyCrate_Level15_Double_C', 'Supply drop, level 15 (green, double)'],
  ['SupplyCrate_Level30_C', 'Supply drop, level 30 (blue)'],
  ['SupplyCrate_Level30_Double_C', 'Supply drop, level 30 (blue, double)'],
  ['SupplyCrate_Level45_C', 'Supply drop, level 45 (purple)'],
  ['SupplyCrate_Level45_Double_C', 'Supply drop, level 45 (purple, double)'],
  ['SupplyCrate_Level60_C', 'Supply drop, level 60 (yellow)'],
  ['SupplyCrate_Level60_Double_C', 'Supply drop, level 60 (yellow, double)'],
  ['SupplyCrate_OceanInstant_C', 'Ocean crate (loot crate in the water)'],
  ['SupplyCrate_Cave_QualityTier1_C', 'Cave crate, tier 1'],
  ['SupplyCrate_Cave_QualityTier2_C', 'Cave crate, tier 2'],
  ['SupplyCrate_Cave_QualityTier3_C', 'Cave crate, tier 3'],
].map(([id, label]) => ({ id, label }));

const NAME = /^[A-Za-z0-9_]{1,100}_C$/;
const SET_NAME = /^[A-Za-z0-9 _.-]{1,60}$/;

const numberIn = (label, v, min, max, whole = false) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) fail(400, `${label} must be ${whole ? 'a whole number' : 'a number'} from ${min} to ${max}`);
  return n;
};
const bool = (v) => v === true || /^true$/i.test(String(v));
const isTrue = (v) => /^true$/i.test(String(G.plain(v) ?? ''));
const asNumber = (v, fallback) => {
  const n = Number(G.plain(v));
  return Number.isFinite(n) ? n : fallback;
};

const CRATE_KEYS = ['SupplyCrateClassString', 'MinItemSets', 'MaxItemSets', 'NumItemSetsPower', 'bSetsRandomWithoutReplacement', 'ItemSets'];
const SET_KEYS = ['SetName', 'MinNumItems', 'MaxNumItems', 'NumItemsPower', 'SetWeight', 'bItemsRandomWithoutReplacement', 'ItemEntries'];
const ENTRY_KEYS = ['EntryWeight', 'ItemClassStrings', 'ItemsWeights', 'MinQuantity', 'MaxQuantity', 'MinQuality', 'MaxQuality', 'bForceBlueprint', 'ChanceToBeBlueprintOverride'];

const onlyKnown = (t, keys) => t.pairs.every(([k]) => keys.some((n) => n.toLowerCase() === k.toLowerCase())) && !t.items.length;

/** One ini value into the editor's model, or null when it holds something the form cannot represent. */
function toModel(value) {
  const t = G.parseTuple(value);
  if (!t || !onlyKnown(t, CRATE_KEYS)) return null;
  const crate = G.plain(G.pair(t, 'SupplyCrateClassString'));
  const sets = G.pair(t, 'ItemSets');
  if (!crate || !sets?.items) return null;
  const model = {
    crate,
    minItemSets: asNumber(G.pair(t, 'MinItemSets'), 1),
    maxItemSets: asNumber(G.pair(t, 'MaxItemSets'), 1),
    numItemSetsPower: asNumber(G.pair(t, 'NumItemSetsPower'), 1),
    withoutReplacement: G.pair(t, 'bSetsRandomWithoutReplacement') === undefined ? true : isTrue(G.pair(t, 'bSetsRandomWithoutReplacement')),
    sets: [],
  };
  for (const s of sets.items) {
    if (!s?.pairs || !onlyKnown(s, SET_KEYS)) return null;
    const entries = G.pair(s, 'ItemEntries');
    if (!entries?.items) return null;
    const set = {
      name: G.plain(G.pair(s, 'SetName')) || 'Set',
      minItems: asNumber(G.pair(s, 'MinNumItems'), 1),
      maxItems: asNumber(G.pair(s, 'MaxNumItems'), 1),
      numItemsPower: asNumber(G.pair(s, 'NumItemsPower'), 1),
      weight: asNumber(G.pair(s, 'SetWeight'), 1),
      withoutReplacement: G.pair(s, 'bItemsRandomWithoutReplacement') === undefined ? true : isTrue(G.pair(s, 'bItemsRandomWithoutReplacement')),
      entries: [],
    };
    for (const e of entries.items) {
      if (!e?.pairs || !onlyKnown(e, ENTRY_KEYS)) return null;
      const classes = G.pair(e, 'ItemClassStrings');
      const weights = G.pair(e, 'ItemsWeights');
      if (!classes?.items?.length) return null;
      set.entries.push({
        weight: asNumber(G.pair(e, 'EntryWeight'), 1),
        items: classes.items.map((c, i) => ({ cls: G.plain(c), weight: asNumber(weights?.items?.[i], 1) })),
        minQuantity: asNumber(G.pair(e, 'MinQuantity'), 1),
        maxQuantity: asNumber(G.pair(e, 'MaxQuantity'), 1),
        minQuality: asNumber(G.pair(e, 'MinQuality'), 1),
        maxQuality: asNumber(G.pair(e, 'MaxQuality'), 1),
        forceBlueprint: isTrue(G.pair(e, 'bForceBlueprint')),
        blueprintChance: asNumber(G.pair(e, 'ChanceToBeBlueprintOverride'), 0),
      });
    }
    model.sets.push(set);
  }
  return model;
}

/** The crates in a Game.ini text: [{ crate, ...model }] or [{ raw, crate }] for ones the form cannot show. */
function parse(text) {
  return G.readEntries(text, [KEY]).map((e) => {
    const model = toModel(e.value);
    if (model) return model;
    const t = G.parseTuple(e.value);
    return { raw: `${KEY}=${e.value}`, crate: (t && G.plain(G.pair(t, 'SupplyCrateClassString'))) || null };
  });
}

/** Check one crate from the form and write its ini line. */
function line(c) {
  if (c.raw) {
    const s = String(c.raw);
    const m = s.match(new RegExp(`^${KEY}=(\\(.*\\))$`));
    if (!m || /[\r\n\x00-\x08\x0b-\x1f]/.test(s) || !G.parseTuple(m[1])) fail(400, 'A kept crate line is not valid');
    return s;
  }
  if (!NAME.test(String(c.crate))) fail(400, `"${String(c.crate).slice(0, 60)}" is not a crate class name (they look like SupplyCrate_Level03_C)`);
  const where = c.crate;
  if (!Array.isArray(c.sets) || !c.sets.length || c.sets.length > 50) fail(400, `${where}: add between 1 and 50 item sets`);
  const minSets = numberIn(`${where}: minimum item sets`, c.minItemSets, 0, 100, true);
  const maxSets = numberIn(`${where}: maximum item sets`, c.maxItemSets, 1, 100, true);
  if (minSets > maxSets) fail(400, `${where}: the minimum number of item sets is above the maximum`);
  const sets = c.sets.map((s, si) => {
    const label = `${where}, set ${si + 1}`;
    if (!SET_NAME.test(String(s.name))) fail(400, `${label}: the name may only use letters, numbers, spaces, dots, dashes and underscores (up to 60)`);
    const minItems = numberIn(`${label}: minimum items`, s.minItems, 0, 100, true);
    const maxItems = numberIn(`${label}: maximum items`, s.maxItems, 1, 100, true);
    if (minItems > maxItems) fail(400, `${label}: the minimum number of items is above the maximum`);
    if (!Array.isArray(s.entries) || !s.entries.length || s.entries.length > 100) fail(400, `${label}: add between 1 and 100 entries`);
    const entries = s.entries.map((e, ei) => {
      const el = `${label}, entry ${ei + 1}`;
      if (!Array.isArray(e.items) || !e.items.length || e.items.length > 20) fail(400, `${el}: pick between 1 and 20 items`);
      for (const it of e.items) if (!NAME.test(String(it.cls))) fail(400, `${el}: "${String(it.cls).slice(0, 60)}" is not an item class name (they look like PrimalItemResource_Metal_C)`);
      const minQ = numberIn(`${el}: minimum quantity`, e.minQuantity, 1, 1000000, true);
      const maxQ = numberIn(`${el}: maximum quantity`, e.maxQuantity, 1, 1000000, true);
      const minQual = numberIn(`${el}: minimum quality`, e.minQuality, 0, 100000);
      const maxQual = numberIn(`${el}: maximum quality`, e.maxQuality, 0, 100000);
      if (minQ > maxQ) fail(400, `${el}: the minimum quantity is above the maximum`);
      if (minQual > maxQual) fail(400, `${el}: the minimum quality is above the maximum`);
      return (
        `(EntryWeight=${G.dec(numberIn(`${el}: weight`, e.weight, 0.0001, 1000000))},` +
        `ItemClassStrings=(${e.items.map((it) => `"${it.cls}"`).join(',')}),` +
        `ItemsWeights=(${e.items.map((it) => G.dec(numberIn(`${el}: item weight`, it.weight ?? 1, 0.0001, 1000000))).join(',')}),` +
        `MinQuantity=${minQ},MaxQuantity=${maxQ},MinQuality=${G.dec(minQual)},MaxQuality=${G.dec(maxQual)},` +
        `bForceBlueprint=${bool(e.forceBlueprint) ? 'true' : 'false'},ChanceToBeBlueprintOverride=${G.dec(numberIn(`${el}: blueprint chance`, e.blueprintChance ?? 0, 0, 1))})`
      );
    });
    return (
      `(SetName="${s.name}",MinNumItems=${minItems},MaxNumItems=${maxItems},NumItemsPower=${G.dec(numberIn(`${label}: power`, s.numItemsPower ?? 1, 0.0001, 1000))},` +
      `SetWeight=${G.dec(numberIn(`${label}: weight`, s.weight ?? 1, 0.0001, 1000000))},bItemsRandomWithoutReplacement=${s.withoutReplacement === false ? 'false' : 'true'},ItemEntries=(${entries.join(',')}))`
    );
  });
  return (
    `${KEY}=(SupplyCrateClassString="${c.crate}",MinItemSets=${minSets},MaxItemSets=${maxSets},NumItemSetsPower=${G.dec(numberIn(`${where}: item sets power`, c.numItemSetsPower ?? 1, 0.0001, 1000))},` +
    `bSetsRandomWithoutReplacement=${c.withoutReplacement === false ? 'false' : 'true'},ItemSets=(${sets.join(',')}))`
  );
}

/** New Game.ini text with exactly these crates (an empty list removes the overrides). */
function apply(text, crates) {
  if (!Array.isArray(crates) || crates.length > 60) fail(400, 'Give a list of at most 60 crates');
  const seen = new Set();
  const lines = crates.map((c) => {
    const l = line(c);
    // One override per crate: ARK only uses the last one it reads.
    const name = c.raw ? G.plain(G.pair(G.parseTuple(l.slice(KEY.length + 1)), 'SupplyCrateClassString')) : c.crate;
    if (name) {
      if (seen.has(name)) fail(400, `${name} is listed twice`);
      seen.add(name);
    }
    return l;
  });
  return G.replaceEntries(text, [KEY], lines);
}

module.exports = { KEY, CRATES, parse, line, apply, toModel };
