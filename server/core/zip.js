'use strict';

/**
 * Just enough zip reading to look inside a .jar: list the entries and pull a
 * few small files out, without loading a 100 MB modpack jar into memory.
 * Works on a file path or a Buffer (a jar inside a jar). No zip64.
 */

const fs = require('fs');
const zlib = require('zlib');

const MAX_ENTRY = 8 * 1024 * 1024;

/** Reads `length` bytes at `position` from a Buffer or an open file. */
function reader(source) {
  if (Buffer.isBuffer(source)) {
    return { size: source.length, read: (position, length) => source.subarray(position, position + length), close() {} };
  }
  const fd = require('./safefs').openRegular(source);
  return {
    size: fs.fstatSync(fd).size,
    read(position, length) {
      const buf = Buffer.alloc(length);
      const n = fs.readSync(fd, buf, 0, length, position);
      return buf.subarray(0, n);
    },
    close: () => fs.closeSync(fd),
  };
}

/**
 * Open a zip. Returns { names, has(name), read(name) → Buffer|null, close() }.
 * Throws when it is not a zip.
 */
function open(source) {
  const r = reader(source);
  try {
    const tailLength = Math.min(r.size, 22 + 65535);
    const tail = r.read(r.size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new Error('not a zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    // The sizes come from the file itself: never trust them past the end of it.
    if (cdOffset + cdSize > r.size || cdSize > 64 * 1024 * 1024) throw new Error('not a zip file');
    const cd = r.read(cdOffset, cdSize);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const nameLength = cd.readUInt16LE(p + 28);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLength);
      entries.set(name, {
        method: cd.readUInt16LE(p + 10),
        compressed: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLength + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    }
    return {
      names: [...entries.keys()],
      has: (name) => entries.has(name),
      read(name) {
        const e = entries.get(name);
        if (!e || e.size > MAX_ENTRY || e.compressed > MAX_ENTRY) return null;
        const header = r.read(e.offset, 30);
        if (header.length < 30 || header.readUInt32LE(0) !== 0x04034b50) return null;
        const start = e.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        const raw = r.read(start, e.compressed);
        if (e.method === 0) return Buffer.from(raw);
        if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
        return null;
      },
      close: () => r.close(),
    };
  } catch (err) {
    r.close();
    throw err;
  }
}

/** Build a zip from { name: content }, stored or deflated. For tests. */
function build(files, { deflate = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const plain = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const data = deflate ? zlib.deflateRawSync(plain) : plain;
    const method = deflate ? 8 : 0;
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32 ? zlib.crc32(plain) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { open, build };
