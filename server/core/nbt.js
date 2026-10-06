'use strict';

/**
 * Minecraft's NBT format, read-only, for player files (world/playerdata/<uuid>.dat,
 * gzipped). Values come back as plain JavaScript: compounds as objects, lists
 * and arrays as arrays, longs as BigInt.
 */

const zlib = require('zlib');

const MAX_DEPTH = 64;

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

function parse(buf) {
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
        return out;
      }
      case 10: {
        const out = {};
        for (;;) {
          need(1);
          const t = buf[pos++];
          if (t === 0) return out;
          const name = string();
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
        return out;
      }
      default:
        throw new Error(`unknown NBT tag ${type}`);
    }
  };
  need(1);
  const rootType = buf[pos++];
  if (rootType !== 10) throw new Error('not an NBT compound');
  string(); // the root's name, usually empty
  return payload(10, 0);
}

/** Read a (usually gzipped) NBT file's contents. */
function read(data) {
  const raw = data[0] === 0x1f && data[1] === 0x8b ? zlib.gunzipSync(data, { maxOutputLength: 64 * 1024 * 1024 }) : data;
  return parse(raw);
}

module.exports = { read, parse };
