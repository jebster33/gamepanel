'use strict';

/**
 * Minecraft's NBT format, for player files (world/playerdata/<uuid>.dat,
 * gzipped). Values come back as plain JavaScript: compounds as objects, lists
 * and arrays as arrays, longs as BigInt.
 *
 * read() is the lossy, convenient reader. readTyped() keeps everything needed
 * to write the file back byte-for-byte equivalent: each compound remembers the
 * tag type of every key, each list its element type, arrays their kind and
 * the root its name (non-enumerable symbols, so JSON and Object.keys ignore
 * them). write()/writeGzip() turn such a tree back into NBT; plain values with
 * no remembered type get a sensible one.
 */

const zlib = require('zlib');

const MAX_DEPTH = 64;

const TYPES = Symbol.for('nbt.types'); // compound: { key: tagId }
const ELEM = Symbol.for('nbt.elem'); // list: element tag id
const KIND = Symbol.for('nbt.kind'); // array: 7 byte[], 11 int[], 12 long[]
const ROOT = Symbol.for('nbt.root'); // root compound's name

const hide = (obj, sym, value) => Object.defineProperty(obj, sym, { value, enumerable: false, writable: true, configurable: true });

/** Java's "modified UTF-8" (NUL as C0 80, astral characters as surrogate pairs). */
function mutf8(buf) {
  let out = '';
  for (let i = 0; i < buf.length; ) {
    const a = buf[i++];
    if (a < 0x80) out += String.fromCharCode(a);
    else if ((a & 0xe0) === 0xc0) out += String.fromCharCode(((a & 0x1f) << 6) | (buf[i++] & 0x3f));
    else out += String.fromCharCode(((a & 0x0f) << 12) | ((buf[i++] & 0x3f) << 6) | (buf[i++] & 0x3f));
  }
  return out;
}

function parse(buf, typed = false) {
  let pos = 0;
  const need = (n) => {
    if (pos + n > buf.length) throw new Error('NBT data ends early');
  };
  const string = () => {
    need(2);
    const len = buf.readUInt16BE(pos);
    pos += 2;
    need(len);
    const s = mutf8(buf.subarray(pos, pos + len));
    pos += len;
    return s;
  };
  const payload = (type, depth) => {
    if (depth > MAX_DEPTH) throw new Error('NBT nested too deep');
    switch (type) {
      case 1:
        need(1);
        return buf.readInt8(pos++);
      case 2:
        need(2);
        pos += 2;
        return buf.readInt16BE(pos - 2);
      case 3:
        need(4);
        pos += 4;
        return buf.readInt32BE(pos - 4);
      case 4:
        need(8);
        pos += 8;
        return buf.readBigInt64BE(pos - 8);
      case 5:
        need(4);
        pos += 4;
        return buf.readFloatBE(pos - 4);
      case 6:
        need(8);
        pos += 8;
        return buf.readDoubleBE(pos - 8);
      case 7: {
        need(4);
        const n = buf.readInt32BE(pos);
        pos += 4;
        if (n < 0) throw new Error('bad NBT array length');
        need(n);
        pos += n;
        if (typed) return hide(Array.from(buf.subarray(pos - n, pos), (b) => (b << 24) >> 24), KIND, 7);
        // Nobody reads these here: keep a short sample, not a million-item array.
        return Array.from(buf.subarray(pos - n, pos - n + Math.min(n, 64)), (b) => (b << 24) >> 24);
      }
      case 8:
        return string();
      case 9: {
        need(5);
        const itemType = buf[pos++];
        const n = buf.readInt32BE(pos);
        pos += 4;
        if (n < 0 || n > 1_000_000) throw new Error('bad NBT list length');
        const out = [];
        for (let i = 0; i < n; i++) out.push(payload(itemType, depth + 1));
        return typed ? hide(out, ELEM, itemType) : out;
      }
      case 10: {
        const out = {};
        const types = {};
        for (;;) {
          need(1);
          const t = buf[pos++];
          if (t === 0) return typed ? hide(out, TYPES, types) : out;
          const name = string();
          types[name] = t;
          out[name] = payload(t, depth + 1);
        }
      }
      case 11:
      case 12: {
        need(4);
        const n = buf.readInt32BE(pos);
        pos += 4;
        if (n < 0) throw new Error('bad NBT array length');
        const size = type === 11 ? 4 : 8;
        need(n * size);
        const out = [];
        for (let i = 0; i < n; i++) {
          out.push(type === 11 ? buf.readInt32BE(pos) : buf.readBigInt64BE(pos));
          pos += size;
        }
        return typed ? hide(out, KIND, type) : out;
      }
      default:
        throw new Error(`unknown NBT tag ${type}`);
    }
  };
  need(1);
  const rootType = buf[pos++];
  if (rootType !== 10) throw new Error('not an NBT compound');
  const rootName = string(); // usually empty
  const root = payload(10, 0);
  if (typed) hide(root, ROOT, rootName);
  return root;
}

const gunzipIfNeeded = (data) => (data[0] === 0x1f && data[1] === 0x8b ? zlib.gunzipSync(data, { maxOutputLength: 64 * 1024 * 1024 }) : data);

/** Read a (usually gzipped) NBT file's contents. */
function read(data) {
  return parse(gunzipIfNeeded(data));
}

/** Like read(), but the result remembers its tag types so write() can reproduce it. */
function readTyped(data) {
  return parse(gunzipIfNeeded(data), true);
}

/* ------------------------------------------------------------ writing -- */

/** Java's "modified UTF-8": NUL as C0 80, every UTF-16 unit on its own (so astral characters are two 3-byte surrogates). */
function toMutf8(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c !== 0 && c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(out);
}

/** A tag id for a value that has no remembered type. */
function guessType(v) {
  if (typeof v === 'bigint') return 4;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? 3 : 6;
  if (typeof v === 'string') return 8;
  if (Array.isArray(v)) return v[KIND] || 9;
  if (v && typeof v === 'object') return 10;
  throw new Error(`cannot store ${typeof v} in NBT`);
}

function serialize(root, rootName = '') {
  const parts = [];
  const u16 = (n) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n);
    parts.push(b);
  };
  const i32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    parts.push(b);
  };
  const str = (s) => {
    const b = toMutf8(String(s));
    if (b.length > 0xffff) throw new Error('NBT string too long');
    u16(b.length);
    parts.push(b);
  };
  const num = (type, v) => {
    const b = Buffer.alloc(type === 1 ? 1 : type === 2 ? 2 : type === 3 || type === 5 ? 4 : 8);
    const n = typeof v === 'boolean' ? Number(v) : v;
    if (type === 1) b.writeInt8(((Number(n) + 128) & 0xff) - 128);
    else if (type === 2) b.writeInt16BE(Number(n));
    else if (type === 3) b.writeInt32BE(Number(n));
    else if (type === 4) b.writeBigInt64BE(BigInt.asIntN(64, BigInt(n)));
    else if (type === 5) b.writeFloatBE(Number(n));
    else b.writeDoubleBE(Number(n));
    parts.push(b);
  };
  const payload = (type, v, depth) => {
    if (depth > MAX_DEPTH) throw new Error('NBT nested too deep');
    if (type >= 1 && type <= 6) return num(type, v);
    if (type === 8) return str(v);
    if (type === 7) {
      i32(v.length);
      parts.push(Buffer.from(Int8Array.from(v, Number).buffer));
      return undefined;
    }
    if (type === 11 || type === 12) {
      i32(v.length);
      for (const x of v) num(type === 11 ? 3 : 4, x);
      return undefined;
    }
    if (type === 9) {
      const elem = v[ELEM] ?? (v.length ? guessType(v[0]) : 0);
      parts.push(Buffer.from([v.length ? elem : v[ELEM] ?? 0]));
      i32(v.length);
      for (const x of v) payload(elem, x, depth + 1);
      return undefined;
    }
    if (type === 10) {
      const types = v[TYPES] || {};
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined || x === null) continue;
        const t = types[k] || guessType(x);
        parts.push(Buffer.from([t]));
        str(k);
        payload(t, x, depth + 1);
      }
      parts.push(Buffer.from([0]));
      return undefined;
    }
    throw new Error(`unknown NBT tag ${type}`);
  };
  parts.push(Buffer.from([10]));
  str(rootName ?? root[ROOT] ?? '');
  payload(10, root, 0);
  return Buffer.concat(parts);
}

/** NBT bytes (uncompressed) for a compound read with readTyped() or built with compound(). */
function write(root) {
  return serialize(root, root[ROOT] ?? '');
}

/** The same, gzipped, the way player files are stored. */
function writeGzip(root) {
  return zlib.gzipSync(write(root));
}

/** A compound with explicit tag types: compound({ Count: 1 }, { Count: 'byte' }). */
const NAMES = { byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6, bytes: 7, string: 8, list: 9, compound: 10, ints: 11, longs: 12 };
function compound(values = {}, types = {}) {
  const out = { ...values };
  hide(
    out,
    TYPES,
    Object.fromEntries(Object.entries(types).map(([k, t]) => [k, typeof t === 'string' ? NAMES[t] : t]))
  );
  return out;
}

/** A list with a fixed element type ('compound', 'string', ...), even when empty. */
function list(items = [], elem = 'compound') {
  return hide([...items], ELEM, typeof elem === 'string' ? NAMES[elem] : elem);
}

module.exports = { read, parse, readTyped, write, writeGzip, compound, list, TYPES, ELEM, KIND, ROOT, TAG: NAMES };
