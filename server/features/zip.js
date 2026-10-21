'use strict';

/**
 * A small, defensive zip reader (and a tiny writer for tests): no
 * dependencies, only what extension packages need. It reads the central
 * directory, supports stored and deflated entries, and refuses anything that
 * could write outside the target folder (absolute paths, "..", drive letters,
 * backslashes, symlinks) or that is oversized (zip bombs).
 */

const zlib = require('zlib');
const { HttpError } = require('../core/util');

const LIMITS = { files: 500, fileBytes: 5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 };

const bad = (msg) => new HttpError(400, msg);

/** The cleaned relative path of an entry, or null when it is not safe to extract. */
function safeEntryPath(name) {
  if (typeof name !== 'string' || !name || name.length > 200 || name.includes('\0') || name.includes('\\')) return null;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length || parts.some((p) => p === '..' || p.length > 100)) return null;
  // Windows device names and trailing dots/spaces are not real files there.
  // eslint-disable-next-line no-control-regex
  if (parts.some((p) => /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(p) || /[. ]$/.test(p) || /[<>:"|?*\x00-\x1f]/.test(p))) return null;
  return parts.join('/');
}

/** @returns {{path: string, data: Buffer}[]} files only (folders are skipped). */
function readZip(buf, limits = LIMITS) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw bad('That is not a zip file');
  // End of central directory record: search backwards (it may be followed by a comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad('That is not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw bad('Zip64 archives are not supported');
  if (count > limits.files) throw bad(`The zip has too many files (limit ${limits.files})`);
  if (dirOffset + dirSize > buf.length) throw bad('The zip is damaged');

  const out = [];
  let total = 0;
  let pos = dirOffset;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw bad('The zip is damaged');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const usize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const attrs = buf.readUInt32LE(pos + 38);
    const local = buf.readUInt32LE(pos + 42);
    const rawName = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) throw bad('Encrypted zips are not supported');
    const isDir = rawName.endsWith('/');
    // Unix mode lives in the high 16 bits: refuse symbolic links and special files.
    const mode = attrs >>> 16;
    const kind = mode & 0o170000;
    if (kind && kind !== 0o100000 && kind !== 0o040000) throw bad(`The zip contains a link or special file: ${rawName.slice(0, 60)}`);
    if (isDir) {
      if (!safeEntryPath(rawName.slice(0, -1))) throw bad(`Unsafe path in the zip: ${rawName.slice(0, 60)}`);
      continue;
    }
    const clean = safeEntryPath(rawName);
    if (!clean) throw bad(`Unsafe path in the zip: ${rawName.slice(0, 60)}`);
    if (usize > limits.fileBytes) throw bad(`${clean} is too large (limit ${Math.round(limits.fileBytes / 1048576)} MB per file)`);
    total += usize;
    if (total > limits.totalBytes) throw bad(`The zip unpacks to more than ${Math.round(limits.totalBytes / 1048576)} MB`);

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad('The zip is damaged');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw bad('The zip is damaged');
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: limits.fileBytes });
      } catch {
        throw bad(`${clean} could not be unpacked`);
      }
    } else throw bad(`${clean} uses an unsupported compression method`);
    if (data.length !== usize) throw bad(`${clean} does not match its recorded size`);
    out.push({ path: clean, data });
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a zip from {name: Buffer|string} (deflated). Used by tests; `modes` can set a unix mode per name. */
function writeZip(files, modes = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(comp.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    parts.push(head, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(((modes[name] ?? 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += head.length + nameBuf.length + comp.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

module.exports = { readZip, writeZip, safeEntryPath, LIMITS };
