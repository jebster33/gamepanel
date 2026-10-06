'use strict';

/**
 * Plugin and mod config files as forms. Reads YAML (Bukkit plugins), TOML
 * (Forge/NeoForge, Velocity), INI-style .cfg (BepInEx), .properties and JSON
 * (Fabric mods, Oxide), turns every plain value into a field (toggle, number,
 * text, list, or a choice when the file lists the allowed values) and writes
 * changes back into the same lines: comments, order and layout stay as they
 * were. Anything the reader does not understand is left untouched and can
 * still be edited as text on the Files tab.
 *
 * Field: { id, path, label, type: bool|number|string|list|select, value,
 *          help, options?, min?, max?, section }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fail } = require('../core/util');
const { containedPath } = require('./files');

const MAX_BYTES = 512 * 1024;
const FORMATS = { '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.cfg': 'ini', '.ini': 'ini', '.properties': 'properties', '.json': 'json' };

const formatOf = (file) => FORMATS[path.extname(file).toLowerCase()] || null;
const versionOf = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
const humanize = (key) => String(key).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());

/* ---------------------------------------------------------------- values -- */

/** A scalar's text → { type, value, quote }. */
function scalar(raw, format) {
  const text = raw.trim();
  const q = text[0];
  if ((q === '"' || q === "'") && text.endsWith(q) && text.length >= 2) {
    const inner = text.slice(1, -1);
    const value = q === '"' ? inner.replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t' })[c] || c) : format === 'yaml' ? inner.replace(/''/g, "'") : inner;
    return { type: 'string', value, quote: q };
  }
  if (/^(true|false)$/i.test(text)) return { type: 'bool', value: text.toLowerCase() === 'true' };
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) && text.length < 16) return { type: 'number', value: Number(text), decimal: text.includes('.') };
  return { type: 'string', value: text, quote: '' };
}

/** Text for a value, in the file's own style. */
function render(value, field, format) {
  if (field.type === 'bool') return value ? 'true' : 'false';
  if (field.type === 'number') return Number.isInteger(value) && field.decimal ? value.toFixed(1) : String(value);
  const text = String(value);
  if (format === 'ini' || format === 'properties') return text.replace(/\n/g, '\\n');
  if (format === 'json') return JSON.stringify(text);
  const quote = field.quote ?? '';
  if (format === 'toml') return quote === "'" && !text.includes("'") && !text.includes('\n') ? `'${text}'` : JSON.stringify(text);
  // YAML: keep plain when it stays a plain string, else quote.
  const plainSafe =
    /^[^\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) && !/\s$/.test(text) && !/: |:$| #/.test(text) && !/[\n\t]/.test(text) && !/^(true|false|yes|no|y|n|on|off|null|~|[-+]?[\d.][\d._eE+-]*)$/i.test(text);
  if (quote === "'" && !text.includes('\n')) return `'${text.replace(/'/g, "''")}'`;
  if (!quote && plainSafe) return text;
  return JSON.stringify(text);
}

/** Splits "value # comment" without cutting inside quotes. */
function splitComment(rest, marks = ['#']) {
  let quote = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (marks.includes(c) && (i === 0 || /\s/.test(rest[i - 1]))) return [rest.slice(0, i).replace(/\s+$/, ''), rest.slice(rest.slice(0, i).replace(/\s+$/, '').length)];
  }
  return [rest.replace(/\s+$/, ''), rest.slice(rest.replace(/\s+$/, '').length)];
}

/** Items of an inline list "[a, 'b', 3]". */
function inlineList(text, format) {
  const inner = text.trim().slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let cur = '';
  let quote = null;
  for (const c of inner) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      items.push(cur);
      cur = '';
    } else if (c === '[' || c === '{') return null; // nested: not ours to edit
    else cur += c;
  }
  if (cur.trim()) items.push(cur);
  return items.map((s) => scalar(s, format));
}

/** Hints the comments give: Forge's "Range: 1 ~ 100", BepInEx's "Acceptable values: A, B". */
function hintsFrom(comments) {
  const out = { help: [], options: null, min: undefined, max: undefined };
  for (const raw of comments) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^Range:\s*(-?[\d.]+)\s*~\s*(-?[\d.]+)/i))) {
      out.min = Number(m[1]);
      out.max = Number(m[2]);
    } else if ((m = line.match(/^Range:\s*([<>]=?)\s*(-?[\d.]+)/i))) {
      if (m[1].startsWith('>')) out.min = Number(m[2]);
      else out.max = Number(m[2]);
    } else if ((m = line.match(/^Acceptable value range:\s*From\s*(-?[\d.]+)\s*to\s*(-?[\d.]+)/i))) {
      out.min = Number(m[1]);
      out.max = Number(m[2]);
    } else if ((m = line.match(/^(?:Allowed|Acceptable) Values?:\s*(.+)$/i))) {
      out.options = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (/^(Setting type|Default value):/i.test(line) || /^-+$/.test(line)) {
      // BepInEx bookkeeping
    } else if (line) out.help.push(line.replace(/^#+\s*/, ''));
  }
  return { ...out, help: out.help.join(' ').slice(0, 600) };
}

function makeField(fields, p, info, comments, section) {
  const hints = hintsFrom(comments);
  let { type } = info;
  if (type === 'string' && hints.options?.length) type = 'select';
  let id = p.join('.');
  if (fields.some((f) => f.id === id)) id += `#${fields.length}`;
  fields.push({ id, path: p, label: humanize(p[p.length - 1]), type, value: info.value, help: hints.help || undefined, options: type === 'select' ? hints.options : undefined, min: hints.min, max: hints.max, section, quote: info.quote, decimal: info.decimal, loc: info.loc, itemType: info.itemType });
}

/* ------------------------------------------------------------------ YAML -- */

function parseYaml(text) {
  const lines = text.split('\n');
  const fields = [];
  const stack = [{ indent: -1, path: [] }];
  let comments = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed) {
      comments = [];
      continue;
    }
    if (trimmed.startsWith('#')) {
      comments.push(trimmed.replace(/^#+\s?/, ''));
      continue;
    }
    if (trimmed === '---' || trimmed === '...') continue;
    const indent = line.match(/^ */)[0].length;
    const m = line.match(/^(\s*)("[^"]*"|'[^']*'|[^\s#'"\-][^:#]*?|-[^\s][^:#]*?)\s*:(?:\s+(.*)|\s*)$/);
    if (!m) {
      // A list item or something else we skip: jump over its block.
      comments = [];
      continue;
    }
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = m[2].replace(/^["']|["']$/g, '');
    const p = [...stack[stack.length - 1].path, key];
    const section = stack.length > 1 ? stack.slice(1).map((s) => s.path[s.path.length - 1]).join(' › ') : '';
    const [valueText, trailing] = splitComment(m[3] || '');
    const here = comments;
    comments = [];
    if (!valueText) {
      // A block list of scalars, or a nested mapping.
      let j = i + 1;
      const items = [];
      let itemIndent = null;
      let scalarList = true;
      while (j < lines.length) {
        const l = lines[j].replace(/\r$/, '');
        if (!l.trim() || l.trim().startsWith('#')) {
          j++;
          continue;
        }
        const ind = l.match(/^ */)[0].length;
        const li = l.match(/^(\s*)-(?:\s+(.*)|\s*$)/);
        if (ind < indent || (ind === indent && !li)) break;
        if (!li) {
          if (itemIndent === null) break; // a nested mapping, not a list
          scalarList = false; // a map inside a list item
          j++;
          continue;
        }
        if (itemIndent === null) itemIndent = ind;
        if (ind < itemIndent) break;
        if (ind !== itemIndent) {
          scalarList = false;
          j++;
          continue;
        }
        const [itemText] = splitComment(li[2] || '');
        if (!itemText || /^[^'"]*:\s/.test(itemText) || /:$/.test(itemText) || /^[[{|>&*]/.test(itemText)) scalarList = false;
        items.push({ line: j, ...scalar(itemText, 'yaml') });
        j++;
      }
      if (items.length) {
        if (scalarList) {
          makeField(fields, p, { type: 'list', value: items.map((x) => String(x.value)), itemType: items.every((x) => x.type === 'number') ? 'number' : 'string', quote: items[0].quote, loc: { start: items[0].line, end: items[items.length - 1].line, indent: itemIndent, keyLine: i } }, here, section);
        }
        i = j - 1;
        continue;
      }
      stack.push({ indent, path: p });
      continue;
    }
    if (/^[|>]/.test(valueText) || /^[&*!]/.test(valueText) || valueText.startsWith('{')) {
      // Block text, anchors and flow maps: skip their lines.
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].match(/^ */)[0].length > indent)) j++;
      i = j - 1;
      continue;
    }
    if (valueText.startsWith('[')) {
      if (!valueText.endsWith(']')) continue;
      const items = inlineList(valueText, 'yaml');
      if (items && items.every((x) => x.type !== 'bool')) {
        makeField(fields, p, { type: 'list', value: items.map((x) => String(x.value)), itemType: items.length && items.every((x) => x.type === 'number') ? 'number' : 'string', quote: items[0]?.quote, loc: { line: i, inline: true, prefix: line.slice(0, line.length - (m[3] || '').length), trailing } }, here, section);
      }
      continue;
    }
    makeField(fields, p, { ...scalar(valueText, 'yaml'), loc: { line: i, prefix: line.slice(0, line.length - (m[3] || '').length), trailing } }, here, section);
  }
  return fields;
}

/* ------------------------------------------------- TOML / INI / properties -- */

function parseIniLike(text, format) {
  const lines = text.split('\n');
  const fields = [];
  let section = [];
  let skipSection = false;
  let comments = [];
  const commentMarks = format === 'toml' ? ['#'] : format === 'properties' ? ['#', '!'] : ['#', ';'];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed) {
      if (format !== 'ini') comments = [];
      continue;
    }
    if (commentMarks.includes(trimmed[0])) {
      comments.push(trimmed.replace(/^[#;!]+\s?/, ''));
      continue;
    }
    if (format !== 'properties') {
      const sec = trimmed.match(/^\[(\[)?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
      if (sec) {
        skipSection = Boolean(sec[1]); // [[array of tables]]: paths are ambiguous
        section = sec[2].split('.').map((s) => s.trim().replace(/^["']|["']$/g, ''));
        comments = [];
        continue;
      }
    }
    const m = format === 'properties' ? line.match(/^(\s*)([^=:\s]+)(\s*[=:]\s*)(.*)$/) : line.match(/^(\s*)("[^"]+"|'[^']+'|[A-Za-z0-9_.\- ]+?)(\s*=\s*)(.*)$/);
    if (!m || skipSection) {
      comments = [];
      continue;
    }
    const key = m[2].replace(/^["']|["']$/g, '').trim();
    const here = comments;
    comments = [];
    const prefix = m[1] + m[2] + m[3];
    if (format === 'properties' || format === 'ini') {
      const [valueText, trailing] = format === 'ini' ? splitComment(m[4], [';', '#']) : [m[4].replace(/\s+$/, ''), ''];
      const info = scalar(valueText, format);
      // INI and .properties have no quotes: a quoted-looking value is just text.
      if (info.type === 'string') Object.assign(info, { value: valueText, quote: '' });
      makeField(fields, [...section, key], { ...info, loc: { line: i, prefix, trailing } }, here, section.join(' › '));
      continue;
    }
    const [valueText, trailing] = splitComment(m[4]);
    if (valueText.startsWith('"""') || valueText.startsWith("'''") || valueText.startsWith('{')) {
      // Multi-line strings and inline tables: skip.
      if (/^("""|''')/.test(valueText) && !valueText.slice(3).includes(valueText.slice(0, 3))) {
        const end = valueText.slice(0, 3);
        while (i + 1 < lines.length && !lines[++i].includes(end));
      }
      continue;
    }
    if (valueText.startsWith('[')) {
      if (!valueText.endsWith(']')) {
        while (i + 1 < lines.length && !/\]\s*(#.*)?$/.test(lines[++i].replace(/\r$/, '')));
        continue;
      }
      const items = inlineList(valueText, 'toml');
      if (items && items.every((x) => x.type !== 'bool')) {
        makeField(fields, [...section, key], { type: 'list', value: items.map((x) => String(x.value)), itemType: items.length && items.every((x) => x.type === 'number') ? 'number' : 'string', quote: items[0]?.quote ?? '"', loc: { line: i, inline: true, prefix, trailing } }, here, section.join(' › '));
      }
      continue;
    }
    makeField(fields, [...section, key], { ...scalar(valueText, 'toml'), loc: { line: i, prefix, trailing } }, here, section.join(' › '));
  }
  return fields;
}

/* ------------------------------------------------------------------ JSON -- */

function parseJson(text) {
  const data = JSON.parse(text.replace(/^\uFEFF/, ''));
  const fields = [];
  const walk = (node, p) => {
    for (const [key, value] of Object.entries(node)) {
      const here = [...p, key];
      const section = p.join(' › ');
      if (value === null) continue;
      if (Array.isArray(value)) {
        if (value.every((v) => typeof v === 'string' || typeof v === 'number')) {
          makeField(fields, here, { type: 'list', value: value.map(String), itemType: value.length && value.every((v) => typeof v === 'number') ? 'number' : 'string' }, [], section);
        }
      } else if (typeof value === 'object') walk(value, here);
      else makeField(fields, here, { type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'number' : 'string', value }, [], section);
    }
  };
  if (data && typeof data === 'object' && !Array.isArray(data)) walk(data, []);
  return { fields, data };
}

/* ------------------------------------------------------------------- API -- */

function parse(text, format) {
  if (format === 'yaml') return parseYaml(text);
  if (format === 'json') return parseJson(text).fields;
  return parseIniLike(text, format);
}

/** Check and convert one submitted value. */
function coerce(field, value) {
  const label = field.path.join('.');
  switch (field.type) {
    case 'bool':
      if (typeof value !== 'boolean') fail(400, `${label} must be on or off`);
      return value;
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n) || String(value).trim() === '') fail(400, `${label} must be a number`);
      if (field.min !== undefined && n < field.min) fail(400, `${label} must be at least ${field.min}`);
      if (field.max !== undefined && n > field.max) fail(400, `${label} must be at most ${field.max}`);
      return n;
    }
    case 'select':
      if (!field.options.includes(String(value))) fail(400, `${label} must be one of ${field.options.join(', ')}`);
      return String(value);
    case 'list': {
      if (!Array.isArray(value)) fail(400, `${label} must be a list`);
      const items = value.map((v) => String(v).replace(/[\r\n]/g, ' ').slice(0, 1000)).filter((v) => v.trim() !== '');
      if (items.length > 2000) fail(400, `${label} has too many entries`);
      if (field.itemType === 'number' && items.some((v) => !Number.isFinite(Number(v)))) fail(400, `${label} takes numbers only`);
      return items;
    }
    default: {
      const text = String(value ?? '');
      if (text.length > 10000) fail(400, `${label} is too long`);
      return text;
    }
  }
}

/** The new text of a file with `changes` ({ fieldId: value }) applied. */
function apply(text, format, changes) {
  const ids = Object.keys(changes || {});
  if (!ids.length) return text;
  if (format === 'json') {
    const { fields, data } = parseJson(text);
    for (const id of ids) {
      const field = fields.find((f) => f.id === id);
      if (!field) fail(400, `Unknown setting: ${id}`);
      let value = coerce(field, changes[id]);
      if (field.type === 'list' && field.itemType === 'number') value = value.map(Number);
      let node = data;
      for (const key of field.path.slice(0, -1)) node = node[key];
      node[field.path[field.path.length - 1]] = value;
    }
    const indent = text.match(/\n([ \t]+)"/)?.[1] || '  ';
    return JSON.stringify(data, null, indent) + (text.endsWith('\n') ? '\n' : '');
  }
  const fields = parse(text, format);
  const lines = text.split('\n');
  const replaced = new Map(); // line → new text (null removes the line)
  for (const id of ids) {
    const field = fields.find((f) => f.id === id);
    if (!field) fail(400, `Unknown setting: ${id}`);
    const value = coerce(field, changes[id]);
    if (JSON.stringify(value) === JSON.stringify(field.type === 'list' ? field.value.map((v) => (field.itemType === 'number' ? String(Number(v)) : v)) : field.value)) continue;
    const cr = lines[field.loc.line ?? field.loc.start]?.endsWith('\r') ? '\r' : '';
    if (field.type === 'list') {
      const item = (v) => (field.itemType === 'number' ? String(Number(v)) : render(v, { type: 'string', quote: field.quote }, format));
      if (field.loc.inline) {
        replaced.set(field.loc.line, `${field.loc.prefix}[${value.map(item).join(', ')}]${field.loc.trailing}${cr}`);
      } else {
        const pad = ' '.repeat(field.loc.indent);
        const block = value.length ? value.map((v) => `${pad}- ${item(v)}${cr}`).join('\n') : null;
        for (let l = field.loc.start; l <= field.loc.end; l++) replaced.set(l, l === field.loc.start ? block : null);
        if (!value.length) {
          // An empty block list becomes "key: []" on the key's own line.
          const { keyLine } = field.loc;
          replaced.set(keyLine, `${lines[keyLine].replace(/\r$/, '').replace(/:\s*$/, ':')} []${cr}`);
        }
      }
      continue;
    }
    replaced.set(field.loc.line, `${field.loc.prefix}${render(value, field, format)}${field.loc.trailing}${cr}`);
  }
  return lines
    .map((l, i) => (replaced.has(i) ? replaced.get(i) : l))
    .filter((l) => l !== null)
    .join('\n');
}

/* ------------------------------------------------------------- discovery -- */

const SCAN = [
  // [folder, depth]
  ['plugins', 2],
  ['config', 3],
  ['world/serverconfig', 1],
  ['defaultconfigs', 2],
  ['oxide/config', 1],
  ['carbon/configs', 1],
  ['BepInEx/config', 1],
];
const ROOT_FILES = /^(bukkit|spigot|purpur|paper|pufferfish|commands|velocity|config|leaves)\.(yml|toml)$|^paper-(global|world-defaults)\.yml$/i;
const SKIP_NAME = /^(usercache|usernamecache|whitelist|ops|banned-players|banned-ips|permissions|help|version_history|\.[^/]*)\.(json|yml)$|cache|\.lock$|-data\.|^data\.(yml|json)$/i;
const SKIP_DIR = /^(userdata|data|playerdata|players|lang|languages|locale|locales|translations|logs|cache|libs|libraries|backups?|storage|db)$/i;

function groupOf(rel) {
  const parts = rel.split('/');
  if (parts[0] === 'plugins' && parts.length > 2) return parts[1];
  if (parts.length === 1) return 'Server';
  if (parts[0] === 'oxide' || parts[0] === 'carbon') return 'Plugins';
  if (parts[0] === 'BepInEx') return 'Mods';
  if (parts.length > 2 && parts[0] === 'config') return parts[1];
  return path.basename(rel).replace(/[-_.](common|server|client)?\.?(toml|json|ya?ml|cfg|properties)$/i, '').replace(/\.(toml|json|ya?ml|cfg|properties)$/i, '');
}

/** The config files of a server, grouped by plugin or mod. */
function list(server) {
  const out = [];
  const visit = (rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(containedPath(server.dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 500) return;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (depth > 0 && !SKIP_DIR.test(e.name) && !e.name.startsWith('.')) visit(child, depth - 1);
        continue;
      }
      if (!e.isFile() || !formatOf(e.name) || SKIP_NAME.test(e.name)) continue;
      if (/client/i.test(e.name) && /\.toml$/i.test(e.name)) continue; // a server never reads client configs
      let size = 0;
      try {
        size = fs.statSync(containedPath(server.dir, child)).size;
      } catch {
        continue;
      }
      if (size > MAX_BYTES || size === 0) continue;
      out.push({ path: child, name: e.name, group: groupOf(child), format: formatOf(e.name), size });
    }
  };
  for (const [dir, depth] of SCAN) visit(dir, depth);
  try {
    for (const e of fs.readdirSync(server.dir, { withFileTypes: true })) {
      if (e.isFile() && ROOT_FILES.test(e.name)) out.push({ path: e.name, name: e.name, group: 'Server', format: formatOf(e.name), size: fs.statSync(path.join(server.dir, e.name)).size });
    }
  } catch {
    /* no server folder yet */
  }
  return out.sort((a, b) => (a.group === 'Server' ? -1 : b.group === 'Server' ? 1 : a.group.localeCompare(b.group)) || a.path.localeCompare(b.path));
}

function readText(server, rel) {
  const format = formatOf(rel);
  if (!format) fail(400, 'The panel cannot show this kind of file as a form; open it on the Files tab');
  const file = containedPath(server.dir, rel);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    fail(404, 'File not found');
  }
  if (!stat.isFile()) fail(400, 'That is not a file');
  if (stat.size > MAX_BYTES) fail(413, 'This file is too big for the form; open it on the Files tab');
  return { file, format, text: fs.readFileSync(file, 'utf8') };
}

/** A config file as a form. */
function form(server, rel) {
  const { format, text } = readText(server, rel);
  let fields;
  try {
    fields = parse(text, format);
  } catch (err) {
    return { path: rel, format, version: versionOf(text), fields: [], error: `The file could not be read as ${format.toUpperCase()}: ${err.message}` };
  }
  return { path: rel, format, version: versionOf(text), fields: fields.map(({ loc, quote, decimal, ...f }) => f) };
}

/** Save changed values. `version` is what the form was built from; a file changed since is refused. */
function save(server, rel, { version, changes }) {
  const { file, format, text } = readText(server, rel);
  if (version && version !== versionOf(text)) fail(409, 'The file changed since you opened it. Reload it and make your changes again.');
  const next = apply(text, format, changes);
  if (next !== text) fs.writeFileSync(file, next);
  return { before: text, after: next, version: versionOf(next), changed: next !== text };
}

module.exports = { list, form, save, parse, apply, formatOf, hintsFrom };
