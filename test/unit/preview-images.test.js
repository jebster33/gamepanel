'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

const load = (f) => import(pathToFileURL(path.join(__dirname, '../../public/js/preview', f)).href);

// One BC1 block: colour0 pure red, colour1 pure blue, every texel index 0.
const RED_BLOCK = [0x00, 0xf8, 0x1f, 0x00, 0, 0, 0, 0];

test('inflate matches zlib for stored, fixed and dynamic blocks', async () => {
  const { inflateRaw, inflateZlib, inflateGzip } = await load('inflate.js');
  const text = Buffer.from('hello hello hello world '.repeat(500) + Array.from({ length: 3000 }, (_, i) => i % 251).join(','));
  for (const level of [0, 1, 9]) {
    assert.deepStrictEqual(Buffer.from(inflateRaw(new Uint8Array(zlib.deflateRawSync(text, { level })))), text);
  }
  assert.deepStrictEqual(Buffer.from(inflateZlib(new Uint8Array(zlib.deflateSync(text)))), text);
  assert.deepStrictEqual(Buffer.from(inflateGzip(new Uint8Array(zlib.gzipSync(text)))), text);
  assert.throws(() => inflateRaw(new Uint8Array([1, 2, 3, 4, 5])));
});

test('DXT1 4x4 decodes to red', async () => {
  const { decodeBC } = await load('images.js');
  const px = decodeBC('bc1a', new Uint8Array(RED_BLOCK), 4, 4);
  assert.strictEqual(px.length, 64);
  assert.deepStrictEqual([...px.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepStrictEqual([...px.slice(60, 64)], [255, 0, 0, 255]);
});

test('DDS with DXT1 and a mip chain', async () => {
  const { decodeImage } = await load('images.js');
  const buf = Buffer.alloc(128 + 8 + 8);
  buf.write('DDS ', 0);
  buf.writeUInt32LE(124, 4);
  buf.writeUInt32LE(0x20000 | 0x1007, 8);
  buf.writeUInt32LE(4, 12);
  buf.writeUInt32LE(4, 16);
  buf.writeUInt32LE(2, 28); // 4x4 then 2x2
  buf.writeUInt32LE(32, 76);
  buf.writeUInt32LE(4, 80);
  buf.write('DXT1', 84);
  Buffer.from(RED_BLOCK).copy(buf, 128);
  Buffer.from(RED_BLOCK).copy(buf, 136);
  const img = decodeImage(new Uint8Array(buf), 'x.dds');
  assert.strictEqual(img.mips.length, 2);
  assert.deepStrictEqual([img.mips[1].width, img.mips[1].height], [2, 2]);
  assert.deepStrictEqual([...img.mips[0].rgba.slice(0, 4)], [255, 0, 0, 255]);
});

test('uncompressed TGA (bottom-left origin) and RLE TGA', async () => {
  const { decodeImage } = await load('images.js');
  const head = (type) => {
    const h = Buffer.alloc(18);
    h[2] = type;
    h.writeUInt16LE(2, 12);
    h.writeUInt16LE(2, 14);
    h[16] = 24;
    return h;
  };
  // Rows are stored bottom-up: the first row in the file is the bottom of the image.
  const bottom = [255, 0, 0, 0, 255, 0]; // BGR: blue, green
  const top = [0, 0, 255, 255, 255, 255]; // red, white
  const raw = decodeImage(new Uint8Array(Buffer.concat([head(2), Buffer.from([...bottom, ...top])])), 'a.tga');
  const px = raw.mips[0].rgba;
  assert.deepStrictEqual([...px.slice(0, 4)], [255, 0, 0, 255], 'top-left is red');
  assert.deepStrictEqual([...px.slice(8, 12)], [0, 0, 255, 255], 'bottom-left is blue');
  const rle = Buffer.concat([head(10), Buffer.from([0x81, 7, 8, 9, 0x81, 1, 2, 3])]);
  const r2 = decodeImage(new Uint8Array(rle), 'b.tga');
  assert.deepStrictEqual([...r2.mips[0].rgba.slice(0, 4)], [3, 2, 1, 255]);
});

test('PSD raw and RLE merged image', async () => {
  const { decodeImage } = await load('images.js');
  const mk = (comp, body) => {
    const h = Buffer.alloc(26);
    h.write('8BPS', 0);
    h.writeUInt16BE(1, 4);
    h.writeUInt16BE(3, 12);
    h.writeUInt32BE(1, 14);
    h.writeUInt32BE(2, 18);
    h.writeUInt16BE(8, 22);
    h.writeUInt16BE(3, 24);
    const tail = Buffer.alloc(12 + 2);
    tail.writeUInt16BE(comp, 12);
    return new Uint8Array(Buffer.concat([h, tail, body]));
  };
  const raw = decodeImage(mk(0, Buffer.from([10, 20, 30, 40, 50, 60])), 'a.psd');
  assert.deepStrictEqual([...raw.mips[0].rgba], [10, 30, 50, 255, 20, 40, 60, 255]);
  // RLE: 3 channels x 1 row, counts table (2 bytes each) then rows (literal run of 2).
  const body = Buffer.concat([Buffer.from([0, 3, 0, 3, 0, 3]), Buffer.from([1, 10, 20, 1, 30, 40, 1, 50, 60])]);
  const rle = decodeImage(mk(1, body), 'b.psd');
  assert.deepStrictEqual([...rle.mips[0].rgba.slice(0, 4)], [10, 30, 50, 255]);
});

test('TIFF uncompressed RGB and PackBits', async () => {
  const { decodeImage } = await load('images.js');
  const entries = (offset, comp, count) => {
    const e = [[256, 3, 1, 2], [257, 3, 1, 1], [258, 3, 1, 8], [259, 3, 1, comp], [262, 3, 1, 2], [273, 4, 1, offset], [277, 3, 1, 3], [278, 3, 1, 1], [279, 4, 1, count]];
    const b = Buffer.alloc(2 + e.length * 12 + 4);
    b.writeUInt16LE(e.length, 0);
    e.forEach(([t, ty, c, v], i) => {
      b.writeUInt16LE(t, 2 + i * 12);
      b.writeUInt16LE(ty, 4 + i * 12);
      b.writeUInt32LE(c, 6 + i * 12);
      b.writeUInt32LE(v, 10 + i * 12);
    });
    return b;
  };
  const wrap = (comp, data) => {
    const head = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
    const ifdLen = 2 + 9 * 12 + 4;
    return new Uint8Array(Buffer.concat([head, entries(8 + ifdLen, comp, data.length), data]));
  };
  const a = decodeImage(wrap(1, Buffer.from([1, 2, 3, 4, 5, 6])), 'a.tif');
  assert.deepStrictEqual([...a.mips[0].rgba], [1, 2, 3, 255, 4, 5, 6, 255]);
  const b = decodeImage(wrap(32773, Buffer.from([5, 1, 2, 3, 4, 5, 6])), 'b.tiff');
  assert.deepStrictEqual([...b.mips[0].rgba], [1, 2, 3, 255, 4, 5, 6, 255]);
});

test('Radiance HDR flat and VTF DXT1', async () => {
  const { decodeImage } = await load('images.js');
  const hdr = Buffer.concat([Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'), Buffer.from([128, 128, 128, 129])]);
  const h = decodeImage(new Uint8Array(hdr), 'a.hdr');
  assert.strictEqual(h.width, 1);
  assert.strictEqual(h.mips[0].rgba[3], 255);
  const vtf = Buffer.alloc(80 + 8);
  vtf.write('VTF\0', 0, 'latin1');
  vtf.writeUInt32LE(7, 4);
  vtf.writeUInt32LE(2, 8);
  vtf.writeUInt32LE(80, 12);
  vtf.writeUInt16LE(4, 16);
  vtf.writeUInt16LE(4, 18);
  vtf.writeUInt16LE(1, 24);
  vtf.writeInt32LE(13, 52);
  vtf[56] = 1;
  vtf.writeInt32LE(-1, 57);
  Buffer.from(RED_BLOCK).copy(vtf, 80);
  const v = decodeImage(new Uint8Array(vtf), 'a.vtf');
  assert.deepStrictEqual([...v.mips[0].rgba.slice(0, 4)], [255, 0, 0, 255]);
});

test('corrupt images throw instead of hanging', async () => {
  const { decodeImage } = await load('images.js');
  for (const n of ['a.tga', 'a.dds', 'a.psd', 'a.tif', 'a.hdr', 'a.exr', 'a.ktx', 'a.vtf']) {
    assert.throws(() => decodeImage(new Uint8Array(40), n), undefined, n);
  }
});
