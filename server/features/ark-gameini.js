'use strict';

/**
 * ARK's Game.ini helpers shared by the level, engram and supply crate editors.
 *
 * Game.ini repeats some keys (one ConfigOverrideSupplyCrateItems line per crate,
 * one OverrideEngramEntries line per engram), which the panel's one-value-per-key
 * patcher cannot handle, so this file reads and rewrites whole groups of lines
 * inside the [/script/shooter.shootergamemode] section and leaves everything
 * else byte for byte as it was.
 */

const fs = require('fs');
const path = require('path');
const { fail } = require('../core/util');
const { containedPath } = require('./files');

const ARK_TEMPLATES = ['ark-survival-evolved', 'ark-survival-ascended'];
const SECTION = '/script/shooter.shootergamemode';

function isArk(server) {
  return ARK_TEMPLATES.includes(server.templateId);
}

/** Game.ini (or GameUserSettings.ini) of a server, inside its folder. */
function iniPath(manager, server, file = 'Game.ini') {
  const windows = process.platform === 'win32' && manager.runtimeFor?.(server) !== 'docker';
  // ARK: Survival Ascended only exists for Windows (and Proton), so it always uses WindowsServer.
  const side = windows || server.templateId === 'ark-survival-ascended' ? 'WindowsServer' : 'LinuxServer';
  return containedPath(server.dir, `ShooterGame/Saved/Config/${side}/${file}`);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Write a config file, keeping the previous version next to it as <name>.panel-backup once. */
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !fs.existsSync(`${file}.panel-backup`)) fs.copyFileSync(file, `${file}.panel-backup`);
  fs.writeFileSync(file, text);
}

const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const headerOf = (line) => line.match(/^\s*\[([^\]]*)\]\s*$/);

/** The section's lines for the given keys, in file order: [{ key, value }]. */
function readEntries(text, keys, section = SECTION) {
  const out = [];
  let inside = false;
  for (const line of String(text).split(/\r?\n/)) {
    const h = headerOf(line);
    if (h) {
      inside = sameName(h[1], section);
      continue;
    }
    if (!inside) continue;
    const m = line.match(/^\s*([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$/);
    if (m && keys.some((k) => sameName(k, m[1]))) out.push({ key: keys.find((k) => sameName(k, m[1])), value: m[2] });
  }
  return out;
}

/**
 * Replace every line of the given keys in the section with `lines` (full
 * "Key=Value" strings). Lines for other keys, comments and other sections stay.
 * The new lines go where the first old one was, or at the end of the section.
 */
function replaceEntries(text, keys, lines, section = SECTION) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const src = text ? text.split(/\r?\n/) : [];
  const out = [];
  let inside = false;
  let at = -1;
  let sectionSeen = false;
  let lastInSection = -1;
  for (const line of src) {
    const h = headerOf(line);
    if (h) {
      inside = sameName(h[1], section);
      if (inside) sectionSeen = true;
      out.push(line);
      if (inside) lastInSection = out.length - 1;
      continue;
    }
    if (inside) {
      const m = line.match(/^\s*([A-Za-z0-9_.]+)\s*=/);
      if (m && keys.some((k) => sameName(k, m[1]))) {
        if (at === -1) at = out.length;
        continue;
      }
      if (line.trim()) lastInSection = out.length;
    }
    out.push(line);
  }
  if (!lines.length) return out.join(eol);
  if (at !== -1) {
    out.splice(at, 0, ...lines);
    return out.join(eol);
  }
  if (sectionSeen) {
    out.splice(lastInSection + 1, 0, ...lines);
    return out.join(eol);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return [...out, ...(out.length ? [''] : []), `[${section}]`, ...lines, ''].join(eol);
}

/* ---------------------------------------------------------- tuple parser -- */

/**
 * ARK writes nested tuples: (A=1,B="x",C=(1,2),D=((E=1),(E=2))).
 * parseTuple returns { pairs: [[key, value]] } for keyed tuples and
 * { items: [value] } for plain lists; values are strings (quotes removed) or
 * nested tuples. Returns null for text that is not one balanced tuple.
 */
function parseTuple(text) {
  const s = String(text).trim();
  let i = 0;
  const fault = () => {
    throw new SyntaxError('bad tuple');
  };
  const skip = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const value = () => {
    skip();
    if (s[i] === '(') return tuple();
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j++;
      if (j >= s.length) fault();
      const v = s.slice(i + 1, j);
      i = j + 1;
      return { str: v };
    }
    let j = i;
    while (j < s.length && !',)'.includes(s[j])) j++;
    const v = s.slice(i, j).trim();
    i = j;
    return v;
  };
  const tuple = () => {
    i++; // (
    const pairs = [];
    const items = [];
    skip();
    if (s[i] === ')') {
      i++;
      return { pairs, items };
    }
    for (;;) {
      skip();
      const key = s.slice(i).match(/^([A-Za-z0-9_.\[\]]+)\s*=/);
      if (key) {
        i += key[0].length;
        pairs.push([key[1], value()]);
      } else {
        items.push(value());
      }
      skip();
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === ')') {
        i++;
        break;
      }
      fault();
    }
    return { pairs, items };
  };
  try {
    if (s[0] !== '(') return null;
    const t = tuple();
    skip();
    return i === s.length ? t : null;
  } catch {
    return null;
  }
}

const plain = (v) => (v && typeof v === 'object' && 'str' in v ? v.str : typeof v === 'string' ? v : null);
const pair = (t, key) => t?.pairs?.find(([k]) => sameName(k, key))?.[1];

/** One decimal formatted for the ini: no exponent, at most 6 places, never NaN. */
function num(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) fail(400, 'A number in the form is not valid');
  return String(Math.round(v * 1e6) / 1e6);
}

/** Float-looking number for ARK ("1.0", not "1"), which the game reads either way but humans expect. */
function dec(n) {
  const s = num(n);
  return s.includes('.') ? s : `${s}.0`;
}

module.exports = { ARK_TEMPLATES, SECTION, isArk, iniPath, readText, writeText, readEntries, replaceEntries, parseTuple, plain, pair, num, dec };
