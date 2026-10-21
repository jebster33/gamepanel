'use strict';

/**
 * ARK level cap and engram overrides in Game.ini:
 *
 *   OverrideMaxExperiencePointsPlayer / OverrideMaxExperiencePointsDino
 *   LevelExperienceRampOverrides=(ExperiencePointsForLevel[0]=..,[1]=..)   first line players, second line dinos
 *   OverridePlayerLevelEngramPoints=N                                       one line per level
 *   OverrideEngramEntries=(EngramClassName="..",EngramHidden=..,...)        one line per engram
 *   EngramEntryAutoUnlocks=(EngramClassName="..",LevelToAutoUnlock=N)
 *   bOnlyAllowSpecifiedEngrams=True
 *
 * ExperiencePointsForLevel[i] is the total XP needed to reach level i+2, so a
 * level cap of L is L-1 entries and the max XP is the last one.
 * Written from the ARK wiki's description of these keys; not run against a live server.
 */

const { fail } = require('../core/util');
const G = require('./ark-gameini');

const KEYS = [
  'OverrideMaxExperiencePointsPlayer',
  'OverrideMaxExperiencePointsDino',
  'LevelExperienceRampOverrides',
  'OverridePlayerLevelEngramPoints',
  'OverrideEngramEntries',
  'EngramEntryAutoUnlocks',
  'bOnlyAllowSpecifiedEngrams',
];
const MAX_LEVEL = 1000;
const MAX_XP = 2147483647;
const CLASS = /^EngramEntry_[A-Za-z0-9_]{1,120}_C$/;

/* ------------------------------------------------------------ calculator -- */

/**
 * The XP ramp for a level cap: `cap - 1` whole numbers, strictly rising, from
 * `firstXp` (XP for level 2) to `finalXp` (XP for the cap). `curve` 1 is a
 * straight line, higher values keep early levels cheap and make the last ones steep.
 */
function generateRamp({ cap, firstXp = 5, finalXp, curve = 2.4 }) {
  cap = Math.floor(Number(cap));
  if (!Number.isFinite(cap) || cap < 2 || cap > MAX_LEVEL) fail(400, `The level cap must be between 2 and ${MAX_LEVEL}`);
  const n = cap - 1;
  const first = Math.floor(Number(firstXp));
  const last = Math.floor(Number(finalXp ?? suggestFinalXp(cap)));
  const p = Number(curve);
  if (!Number.isFinite(first) || first < 1) fail(400, 'XP for level 2 must be at least 1');
  if (!Number.isFinite(last) || last > MAX_XP) fail(400, `XP for the level cap cannot be above ${MAX_XP.toLocaleString('en-US')}`);
  if (last < first + n - 1) fail(400, `XP for the level cap must be at least ${first + n - 1} so every level costs more than the one before`);
  if (!Number.isFinite(p) || p < 0.5 || p > 6) fail(400, 'The curve must be between 0.5 and 6');
  const ramp = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    let xp = Math.round(first + (last - first) * Math.pow(t, p));
    if (i && xp <= ramp[i - 1]) xp = ramp[i - 1] + 1;
    ramp.push(xp);
  }
  // Rounding up to keep the order can push the end past the target; the target wins.
  for (let i = n - 1; i >= 0 && ramp[i] > last; i--) ramp[i] = last - (n - 1 - i);
  return ramp;
}

/** A starting point for "XP for the cap": roughly cap cubed times four, as the official ramp grows. */
function suggestFinalXp(cap) {
  return Math.min(MAX_XP, Math.round(Math.pow(Number(cap) || 0, 3) * 4));
}

/** Engram points handed out per level: `perLevel` each, plus `bonus` on every `bonusEvery`th level. */
function generatePoints({ cap, perLevel = 10, bonusEvery = 0, bonus = 0 }) {
  cap = Math.floor(Number(cap));
  if (!Number.isFinite(cap) || cap < 1 || cap > MAX_LEVEL) fail(400, `The level cap must be between 1 and ${MAX_LEVEL}`);
  const per = Math.floor(Number(perLevel));
  const every = Math.floor(Number(bonusEvery) || 0);
  const extra = Math.floor(Number(bonus) || 0);
  if (!(per >= 0 && per <= 10000) || !(extra >= 0 && extra <= 10000) || !(every >= 0 && every <= MAX_LEVEL)) fail(400, 'Engram points must be whole numbers from 0 to 10000');
  const out = [];
  for (let level = 1; level <= cap; level++) out.push(per + (every && level % every === 0 ? extra : 0));
  return out;
}

/* --------------------------------------------------------------- reading -- */

const rampOf = (value) => {
  const t = G.parseTuple(value);
  if (!t || !t.pairs.length) return null;
  const rows = [];
  for (const [k, v] of t.pairs) {
    const m = k.match(/^ExperiencePointsForLevel\[(\d+)\]$/i);
    const xp = Number(G.plain(v));
    if (!m || !Number.isFinite(xp)) return null;
    rows[Number(m[1])] = xp;
  }
  return rows.every((v) => v !== undefined) ? rows : null; // a gap in the indexes is not something the editor can show
};

const truthy = (v) => /^true$/i.test(String(G.plain(v) ?? '').trim());
const intOf = (v) => {
  const n = Number(G.plain(v));
  return Number.isFinite(n) ? n : null;
};

/** Everything this editor manages, from the text of Game.ini. */
function parse(text) {
  const entries = G.readEntries(text, KEYS);
  const of = (key) => entries.filter((e) => e.key === key);
  const one = (key) => of(key)[0]?.value;
  const ramps = of('LevelExperienceRampOverrides').map((e) => rampOf(e.value));
  const out = {
    player: ramps[0] ? { cap: ramps[0].length + 1, ramp: ramps[0] } : null,
    dino: ramps[1] ? { cap: ramps[1].length + 1, ramp: ramps[1] } : null,
    maxXpPlayer: one('OverrideMaxExperiencePointsPlayer') != null ? Number(one('OverrideMaxExperiencePointsPlayer')) : null,
    maxXpDino: one('OverrideMaxExperiencePointsDino') != null ? Number(one('OverrideMaxExperiencePointsDino')) : null,
    engramPoints: of('OverridePlayerLevelEngramPoints').length ? of('OverridePlayerLevelEngramPoints').map((e) => Number(e.value) || 0) : null,
    onlyAllowSpecified: truthy(one('bOnlyAllowSpecifiedEngrams')),
    engrams: [],
    autoUnlocks: [],
    unreadable: ramps.some((r) => r === null),
  };
  for (const e of of('OverrideEngramEntries')) {
    const t = G.parseTuple(e.value);
    const cls = G.plain(G.pair(t, 'EngramClassName'));
    const known = ['EngramClassName', 'EngramHidden', 'EngramPointsCost', 'EngramLevelRequirement', 'RemoveEngramPreReq'];
    if (!t || !cls || t.pairs.some(([k]) => !known.some((n) => n.toLowerCase() === k.toLowerCase()))) {
      out.engrams.push({ raw: `OverrideEngramEntries=${e.value}`, className: cls || null });
      continue;
    }
    out.engrams.push({
      className: cls,
      hidden: truthy(G.pair(t, 'EngramHidden')),
      cost: intOf(G.pair(t, 'EngramPointsCost')) ?? 0,
      level: intOf(G.pair(t, 'EngramLevelRequirement')) ?? 0,
      removePrereq: truthy(G.pair(t, 'RemoveEngramPreReq')),
    });
  }
  for (const e of of('EngramEntryAutoUnlocks')) {
    const t = G.parseTuple(e.value);
    const cls = G.plain(G.pair(t, 'EngramClassName'));
    const level = intOf(G.pair(t, 'LevelToAutoUnlock'));
    if (t && cls && level != null) out.autoUnlocks.push({ className: cls, level });
    else out.autoUnlocks.push({ raw: `EngramEntryAutoUnlocks=${e.value}`, className: cls || null });
  }
  return out;
}

/* --------------------------------------------------------------- writing -- */

function checkRamp(label, ramp) {
  if (!Array.isArray(ramp) || !ramp.length || ramp.length >= MAX_LEVEL) fail(400, `${label}: the XP list needs between 1 and ${MAX_LEVEL - 1} entries`);
  let prev = 0;
  return ramp.map((v, i) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > MAX_XP) fail(400, `${label}: level ${i + 2} needs a whole number of XP between 1 and ${MAX_XP}`);
    if (n <= prev) fail(400, `${label}: level ${i + 2} needs more XP than level ${i + 1}`);
    prev = n;
    return n;
  });
}

const rampLine = (ramp) => `LevelExperienceRampOverrides=(${ramp.map((xp, i) => `ExperiencePointsForLevel[${i}]=${xp}`).join(',')})`;

function checkRaw(key, raw) {
  const s = String(raw);
  const m = s.match(new RegExp(`^${key}=(\\(.*\\))$`));
  if (!m || /[\r\n\x00-\x08\x0b-\x1f]/.test(s) || !G.parseTuple(m[1])) fail(400, `A ${key} line is not valid`);
  return s;
}

const flag = (v) => (v ? 'True' : 'False');

function wholeNumber(label, v, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
}

/** The Game.ini lines for this form state, in the order they are written. */
function build(input = {}) {
  const lines = [];
  const player = input.player ? checkRamp('Players', input.player.ramp) : null;
  const dino = input.dino ? checkRamp('Dinos', input.dino.ramp) : null;
  if (dino && !player) fail(400, 'ARK reads the first ramp line as the players and the second as the dinos, so set the player levels too');
  if (player) {
    lines.push(`OverrideMaxExperiencePointsPlayer=${input.maxXpPlayer ? wholeNumber('Player max XP', input.maxXpPlayer, player.at(-1), MAX_XP) : player.at(-1)}`);
    if (dino) lines.push(`OverrideMaxExperiencePointsDino=${input.maxXpDino ? wholeNumber('Dino max XP', input.maxXpDino, dino.at(-1), MAX_XP) : dino.at(-1)}`);
    lines.push(rampLine(player));
    if (dino) lines.push(rampLine(dino));
  }
  if (input.engramPoints) {
    if (!Array.isArray(input.engramPoints) || !input.engramPoints.length || input.engramPoints.length > MAX_LEVEL) fail(400, `Engram points need between 1 and ${MAX_LEVEL} levels`);
    for (const p of input.engramPoints) lines.push(`OverridePlayerLevelEngramPoints=${wholeNumber('Engram points', p, 0, 10000)}`);
  }
  if (input.onlyAllowSpecified) lines.push('bOnlyAllowSpecifiedEngrams=True');
  const seen = new Set();
  for (const e of input.engrams || []) {
    if (e.raw) {
      lines.push(checkRaw('OverrideEngramEntries', e.raw));
      continue;
    }
    if (!CLASS.test(String(e.className))) fail(400, `"${String(e.className).slice(0, 60)}" is not an engram class name (they look like EngramEntry_Campfire_C)`);
    if (seen.has(e.className)) fail(400, `${e.className} is listed twice`);
    seen.add(e.className);
    lines.push(
      `OverrideEngramEntries=(EngramClassName="${e.className}",EngramHidden=${flag(e.hidden)},EngramPointsCost=${wholeNumber('Engram cost', e.cost ?? 0, 0, 100000)},EngramLevelRequirement=${wholeNumber('Engram level', e.level ?? 0, 0, MAX_LEVEL)},RemoveEngramPreReq=${flag(e.removePrereq)})`
    );
  }
  const unlocked = new Set();
  for (const u of input.autoUnlocks || []) {
    if (u.raw) {
      lines.push(checkRaw('EngramEntryAutoUnlocks', u.raw));
      continue;
    }
    if (!CLASS.test(String(u.className))) fail(400, `"${String(u.className).slice(0, 60)}" is not an engram class name (they look like EngramEntry_Campfire_C)`);
    if (unlocked.has(u.className)) fail(400, `${u.className} is auto-unlocked twice`);
    unlocked.add(u.className);
    lines.push(`EngramEntryAutoUnlocks=(EngramClassName="${u.className}",LevelToAutoUnlock=${wholeNumber('Auto-unlock level', u.level, 0, MAX_LEVEL)})`);
  }
  return lines;
}

/** New Game.ini text: this editor's keys replaced, everything else kept. */
function apply(text, input) {
  return G.replaceEntries(text, KEYS, build(input));
}

/** A few engram names to start from; the field takes any EngramEntry_..._C class. */
const ENGRAM_SUGGESTIONS = [
  'EngramEntry_Campfire_C',
  'EngramEntry_StoneHatchet_C',
  'EngramEntry_Spear_C',
  'EngramEntry_Torch_C',
  'EngramEntry_Slingshot_C',
  'EngramEntry_Smithy_C',
  'EngramEntry_Fabricator_C',
];

module.exports = { KEYS, MAX_LEVEL, generateRamp, generatePoints, suggestFinalXp, parse, build, apply, ENGRAM_SUGGESTIONS };
