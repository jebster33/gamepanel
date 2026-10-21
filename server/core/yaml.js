'use strict';

/**
 * A small, dependency-free YAML subset: enough for configuration files a
 * person edits by hand, and for the panel to write them back out.
 *
 * Supported
 *   block maps and lists (indent with spaces), lists of maps ("- name: x")
 *   flow lists and maps on one line ([a, b], {a: 1}), "[]" and "{}"
 *   scalars: null (null, ~, empty), true/false, numbers, plain strings
 *   "double quoted" (JSON-style escapes) and 'single quoted' strings
 *   block scalars: | (keep line breaks) and > (fold), with - and + chomping
 *   # comments, and a leading "---"
 *   JSON documents (a text that starts with { or [ is tried as JSON first)
 * Not supported: anchors and aliases, tags, multiple documents, tabs for
 * indentation, "?" complex keys. Those throw a plain error with a line number.
 *
 * Numbers only become numbers when they print back the same (25565, 1.5), so
 * 1.20 and 007 stay strings and a game version is never changed by a round trip.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 64;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line || null;
  }
}

/* --------------------------------------------------------------- scalars -- */

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function typedScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (NUMBER.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && String(n) === s) return n;
  }
  return s;
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', '0': '\0', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/', ' ': ' ', e: '\x1b' };

/** Read a quoted string starting at s[at]; returns { value, end } with end just past the closing quote. */
function readQuoted(s, at, line) {
  const q = s[at];
  let out = '';
  let i = at + 1;
  for (; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += c;
    } else {
      if (c === '"') return { value: out, end: i + 1 };
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = s[++i];
      if (e === 'x' || e === 'u' || e === 'U') {
        const len = e === 'x' ? 2 : e === 'u' ? 4 : 8;
        const hex = s.slice(i + 1, i + 1 + len);
        if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) throw new YamlError('bad \\' + e + ' escape in a quoted string', line);
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) throw new YamlError('bad \\' + e + ' escape in a quoted string', line);
        out += String.fromCodePoint(cp);
        i += len;
      } else if (e in ESCAPES) out += ESCAPES[e];
      else throw new YamlError(`unknown escape \\${e || ''} in a quoted string`, line);
    }
  }
  throw new YamlError('a quoted string is not closed', line);
}

/** Cut a trailing "# comment" that is outside quotes. */
function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i++;
        else quote = null;
      }
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(s[i - 1]))) quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

/* ------------------------------------------------------------ flow values -- */

function parseFlow(text, line) {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const value = (depth) => {
    if (depth > MAX_DEPTH) throw new YamlError('nested too deeply', line);
    ws();
    const c = text[i];
    if (c === '[') {
      i++;
      const arr = [];
      ws();
      if (text[i] === ']') return i++, arr;
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') {
          i++;
          ws();
          if (text[i] === ']') return i++, arr;
          continue;
        }
        if (text[i] === ']') return i++, arr;
        throw new YamlError('expected , or ] in a list', line);
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      ws();
      if (text[i] === '}') return i++, obj;
      for (;;) {
        ws();
        let key;
        if (text[i] === '"' || text[i] === "'") {
          const r = readQuoted(text, i, line);
          key = r.value;
          i = r.end;
        } else {
          const m = /^[^:,{}[\]]+/.exec(text.slice(i));
          if (!m) throw new YamlError('expected a key in { }', line);
          key = m[0].trim();
          i += m[0].length;
        }
        ws();
        if (text[i] !== ':') throw new YamlError('expected : after a key in { }', line);
        i++;
        if (BAD_KEYS.has(key)) throw new YamlError(`the key "${key}" is not allowed`, line);
        if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlError(`the key "${key}" appears twice`, line);
        obj[key] = value(depth + 1);
        ws();
        if (text[i] === ',') {
          i++;
          ws();
          if (text[i] === '}') return i++, obj;
          continue;
        }
        if (text[i] === '}') return i++, obj;
        throw new YamlError('expected , or } in a map', line);
      }
    }
    if (c === '"' || c === "'") {
      const r = readQuoted(text, i, line);
      i = r.end;
      return r.value;
    }
    const m = /^[^,\]}]*/.exec(text.slice(i));
    i += m[0].length;
    return typedScalar(m[0]);
  };
  const v = value(0);
  ws();
  if (i < text.length) throw new YamlError('unexpected text after the value', line);
  return v;
}

/** The value written after "key:" or "- " on one line. */
function inlineValue(raw, line) {
  const s = raw.trim();
  if (s[0] === '[' || s[0] === '{') return parseFlow(s, line);
  if (s[0] === '"' || s[0] === "'") {
    const r = readQuoted(s, 0, line);
    if (s.slice(r.end).trim()) throw new YamlError('unexpected text after a quoted string', line);
    return r.value;
  }
  if (/^[&*!]/.test(s)) throw new YamlError('anchors, aliases and tags are not supported', line);
  return typedScalar(s);
}

/* ---------------------------------------------------------------- parser -- */

function parse(input) {
  let text = String(input ?? '').replace(/^﻿/, '');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new YamlError('The document is larger than 2 MB');
  if (/^\s*[{[]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      /* may still be a YAML flow collection */
    }
  }
  const lines = text.split(/\r?\n/);
  let pos = 0;

  const indentOf = (l) => {
    const m = /^( *)/.exec(l);
    if (l[m[1].length] === '\t') throw new YamlError('use spaces, not tabs, for indentation', pos + 1);
    return m[1].length;
  };
  const lineNo = () => pos + 1;

  /** Skip blank and comment-only lines; returns false at the end. */
  function skip() {
    while (pos < lines.length) {
      const t = lines[pos].trim();
      if (t === '' || t[0] === '#') pos++;
      else if (t === '---' && pos === firstContent()) pos++;
      else if (t === '...' || /^---\s/.test(t) || t === '---') throw new YamlError('only one document per file is supported', lineNo());
      else return true;
    }
    return false;
  }
  let first = null;
  function firstContent() {
    if (first === null) {
      first = lines.findIndex((l) => l.trim() !== '' && l.trim()[0] !== '#');
    }
    return first;
  }

  function peek() {
    if (!skip()) return null;
    const raw = lines[pos];
    const indent = indentOf(raw);
    return { indent, content: stripComment(raw.slice(indent)), line: pos + 1 };
  }

  /** key: rest, where key is plain or quoted. Returns null when the line is not a map entry. */
  function splitKey(content, line) {
    let key;
    let rest;
    if (content[0] === '"' || content[0] === "'") {
      const r = readQuoted(content, 0, line);
      const after = content.slice(r.end);
      const m = /^\s*:(\s+|$)/.exec(after);
      if (!m) return null;
      key = r.value;
      rest = after.slice(m[0].length);
    } else {
      const m = /^([^\s:#[\]{}&*!|>'"%@`,?-][^:]*?|-[^\s:][^:]*?|\?[^\s:][^:]*?):(\s+|$)/.exec(content);
      if (!m) return null;
      key = m[1].trim();
      rest = content.slice(m[0].length);
    }
    return { key, rest };
  }

  function blockScalar(header, parentIndent) {
    const m = /^([|>])([+-]?)([1-9]?)([+-]?)$/.exec(header);
    const chomp = m[2] || m[4];
    const folded = m[1] === '>';
    const body = [];
    let blockIndent = m[3] ? parentIndent + Number(m[3]) : null;
    for (; pos < lines.length; pos++) {
      const raw = lines[pos];
      if (raw.trim() === '') {
        body.push('');
        continue;
      }
      const ind = indentOf(raw);
      if (blockIndent === null) {
        if (ind <= parentIndent) break;
        blockIndent = ind;
      }
      if (ind < blockIndent) break;
      body.push(raw.slice(blockIndent));
    }
    // Trailing blank lines belong to the chomping, not the text.
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    let out;
    if (!folded) out = body.join('\n');
    else {
      out = '';
      body.forEach((l, i) => {
        if (i === 0) out = l;
        else if (l === '') out += '\n';
        else if (body[i - 1] === '' || /^\s/.test(l) || /^\s/.test(body[i - 1])) out += (body[i - 1] === '' ? '' : '\n') + l;
        else out += ' ' + l;
      });
    }
    if (!body.length) return chomp === '+' ? '\n'.repeat(trailing) : '';
    if (chomp === '-') return out;
    if (chomp === '+') return out + '\n'.repeat(trailing + 1);
    return out + '\n';
  }

  function parseValueAfter(rest, parentIndent, line, depth) {
    if (/^[|>][+-]?[1-9]?[+-]?$/.test(rest)) {
      pos++;
      return blockScalar(rest, parentIndent);
    }
    if (rest !== '') {
      pos++;
      return inlineValue(rest, line);
    }
    pos++;
    const nx = peek();
    if (!nx) return null;
    if (nx.indent > parentIndent) return parseNode(nx.indent, depth + 1);
    // "key:" followed by a list at the same indent is a list value.
    if (nx.indent === parentIndent && /^-(\s|$)/.test(nx.content)) return parseList(nx.indent, depth + 1);
    return null;
  }

  function parseNode(indent, depth) {
    if (depth > MAX_DEPTH) throw new YamlError('nested too deeply', lineNo());
    const nx = peek();
    if (!nx || nx.indent < indent) return null;
    if (/^-(\s|$)/.test(nx.content)) return parseList(nx.indent, depth);
    if (splitKey(nx.content, nx.line)) return parseMap(nx.indent, depth);
    // A lone scalar (or a flow collection) on its own line(s).
    pos++;
    return inlineValue(nx.content, nx.line);
  }

  function parseMap(indent, depth) {
    const obj = {};
    for (;;) {
      const nx = peek();
      if (!nx || nx.indent < indent) return obj;
      if (nx.indent > indent) throw new YamlError('this line is indented more than the lines above it', nx.line);
      if (/^-(\s|$)/.test(nx.content)) return obj;
      const kv = splitKey(nx.content, nx.line);
      if (!kv) throw new YamlError(`expected "key: value" but found "${nx.content.slice(0, 40)}"`, nx.line);
      if (BAD_KEYS.has(kv.key)) throw new YamlError(`the key "${kv.key}" is not allowed`, nx.line);
      if (Object.prototype.hasOwnProperty.call(obj, kv.key)) throw new YamlError(`the key "${kv.key}" appears twice`, nx.line);
      obj[kv.key] = parseValueAfter(kv.rest, indent, nx.line, depth);
    }
  }

  function parseList(indent, depth) {
    const arr = [];
    for (;;) {
      const nx = peek();
      if (!nx || nx.indent < indent) return arr;
      if (nx.indent > indent) throw new YamlError('this line is indented more than the lines above it', nx.line);
      if (!/^-(\s|$)/.test(nx.content)) return arr;
      const rest = nx.content.slice(1).trimStart();
      const offset = nx.content.length - rest.length;
      if (rest === '') {
        pos++;
        const inner = peek();
        arr.push(inner && inner.indent > indent ? parseNode(inner.indent, depth + 1) : null);
      } else if (/^[|>][+-]?[1-9]?[+-]?$/.test(rest)) {
        pos++;
        arr.push(blockScalar(rest, indent));
      } else if (/^-(\s|$)/.test(rest) || splitKey(rest, nx.line)) {
        // "- key: v" / "- - x": the item starts at the column after the dash.
        lines[pos] = ' '.repeat(indent + offset) + lines[pos].slice(indent + offset);
        arr.push(parseNode(indent + offset, depth + 1));
      } else {
        pos++;
        arr.push(inlineValue(rest, nx.line));
      }
    }
  }

  const top = peek();
  if (!top) return null;
  const result = parseNode(top.indent, 0);
  const left = peek();
  if (left) throw new YamlError(`unexpected text "${left.content.slice(0, 40)}"`, left.line);
  return result;
}

/* --------------------------------------------------------------- emitter -- */

const RESERVED = /^(null|true|false|yes|no|on|off|y|n|~)$/i;
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_./@+~()-]*(?: [A-Za-z0-9_./@+~()-]+)*$/;

function plainOk(s) {
  return PLAIN.test(s) && !RESERVED.test(s) && !NUMBER.test(s);
}

function scalarText(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  const s = String(v);
  return plainOk(s) ? s : JSON.stringify(s);
}

const keyText = (k) => (plainOk(k) ? k : JSON.stringify(k));
const isScalar = (v) => v === null || v === undefined || typeof v !== 'object';
const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);

/** A multi-line string as a block scalar, or null when it needs quoting instead. */
function blockLines(s, pad) {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f\r]/.test(s) || /^[\s]/.test(s)) return null;
  const body = s.replace(/\n+$/, '');
  const trailing = s.length - body.length;
  const chomp = trailing === 0 ? '-' : trailing === 1 ? '' : '+';
  const text = body.split('\n').map((l) => (l === '' ? '' : pad + l));
  for (let i = 1; i < trailing; i++) text.push('');
  return { header: `|${chomp}`, text };
}

function emitNode(value, indent, out, depth) {
  if (depth > MAX_DEPTH) throw new YamlError('nested too deeply to write');
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isScalar(item)) {
        if (typeof item === 'string' && item.includes('\n')) {
          const b = blockLines(item, ' '.repeat(indent + 2));
          if (b) {
            out.push(`${pad}- ${b.header}`, ...b.text);
            continue;
          }
        }
        out.push(`${pad}- ${scalarText(item)}`);
      } else if (isEmpty(item)) out.push(`${pad}- ${Array.isArray(item) ? '[]' : '{}'}`);
      else {
        const inner = [];
        emitNode(item, indent + 2, inner, depth + 1);
        inner[0] = `${pad}- ${inner[0].slice(indent + 2)}`;
        out.push(...inner);
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const key = keyText(k);
    if (isScalar(v)) {
      if (typeof v === 'string' && v.includes('\n')) {
        const b = blockLines(v, ' '.repeat(indent + 2));
        if (b) {
          out.push(`${pad}${key}: ${b.header}`, ...b.text);
          continue;
        }
      }
      out.push(`${pad}${key}: ${scalarText(v)}`);
    } else if (isEmpty(v)) out.push(`${pad}${key}: ${Array.isArray(v) ? '[]' : '{}'}`);
    else {
      out.push(`${pad}${key}:`);
      emitNode(v, indent + 2, out, depth + 1);
    }
  }
}

/** Write a value as YAML (two-space indent). Keys with undefined values are skipped. */
function emit(value, { header = '' } = {}) {
  const out = [];
  if (header) out.push(...String(header).split('\n').map((l) => (l ? `# ${l}` : '#')));
  if (isScalar(value)) out.push(scalarText(value));
  else if (isEmpty(value)) out.push(Array.isArray(value) ? '[]' : '{}');
  else emitNode(value, 0, out, 0);
  return out.join('\n') + '\n';
}

module.exports = { parse, emit, YamlError };
