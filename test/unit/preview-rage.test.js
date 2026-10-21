'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

const load = (f) => import(pathToFileURL(path.join(__dirname, '../../public/js/preview', f)).href);

// These fixtures are built from the documented RSC7 layout, so they prove the parser matches that
// layout and fails cleanly otherwise. They are not real game files.
const SYS = 0x50000000;
const GFX = 0x60000000;
const RED_BLOCK = [0x00, 0xf8, 0x1f, 0x00, 0, 0, 0, 0];

function rsc7(sys, gfx, sysFlags, gfxFlags, version = 13) {
  const head = Buffer.alloc(16);
  head.write('RSC7', 0);
  head.writeUInt32LE(version, 4);
  head.writeUInt32LE(sysFlags, 8);
  head.writeUInt32LE(gfxFlags, 12);
  return Buffer.concat([head, zlib.deflateRawSync(Buffer.concat([sys, gfx]))]);
}
const ptr = (buf, off, addr) => {
  buf.writeUInt32LE(addr >>> 0, off);
  buf.writeUInt32LE(0, off + 4);
};

function makeYtd() {
  const sys = Buffer.alloc(0x400);
  const gfx = Buffer.alloc(0x200);
  ptr(sys, 0x30, SYS + 0x100);
  sys.writeUInt16LE(1, 0x38);
  ptr(sys, 0x100, SYS + 0x200);
  ptr(sys, 0x200 + 0x28, SYS + 0x300);
  sys.writeUInt16LE(4, 0x200 + 0x50);
  sys.writeUInt16LE(4, 0x200 + 0x52);
  sys.writeUInt32LE(0x31545844, 0x200 + 0x58);
  sys[0x200 + 0x5d] = 1;
  ptr(sys, 0x200 + 0x70, GFX);
  sys.write('test_tex\0', 0x300);
  Buffer.from(RED_BLOCK).copy(gfx, 0);
  return rsc7(sys, gfx, 1 << 26, 1 << 27);
}

test('synthetic .ytd: names, size, format and decoded pixels', async () => {
  const { parseYTD } = await load('rage.js');
  const { textures } = parseYTD(new Uint8Array(makeYtd()));
  assert.strictEqual(textures.length, 1);
  assert.strictEqual(textures[0].name, 'test_tex');
  assert.deepStrictEqual([textures[0].width, textures[0].height, textures[0].format], [4, 4, 'DXT1']);
  assert.deepStrictEqual([...textures[0].mips[0].rgba.slice(0, 4)], [255, 0, 0, 255]);
});

test('encrypted-looking or foreign data gives a clear error, never keys', async () => {
  const { parseYTD, RageError } = await load('rage.js');
  const bad = Buffer.concat([makeYtd().subarray(0, 16), Buffer.from('this is not deflate data at all, it is AES noise!!')]);
  assert.throws(() => parseYTD(new Uint8Array(bad)), (e) => e instanceof RageError && e.code === 'encrypted' && /key/i.test(e.message));
  assert.throws(() => parseYTD(new Uint8Array(Buffer.from('not a resource at all, just text'))), (e) => e.code === 'format');
});

test('joaat hashes and flag sizes', async () => {
  const { joaat, sizeFromFlags } = await load('rage.js');
  assert.strictEqual(joaat('a'), 0xca2e9442);
  assert.strictEqual(joaat('DiffuseSampler'), joaat('diffusesampler'));
  assert.strictEqual(sizeFromFlags(1 << 26), 0x400);
  assert.strictEqual(sizeFromFlags(1 << 27), 0x200);
});

test('synthetic .ydr: geometry, UVs and the shader texture name', async () => {
  const { parseRageModel, joaat } = await load('rage.js');
  const sys = Buffer.alloc(0x800);
  const gfx = Buffer.alloc(0x200);
  ptr(sys, 0x10, SYS + 0x100); // shader group
  ptr(sys, 0x50, SYS + 0x180); // high LOD model list
  ptr(sys, 0x100 + 0x10, SYS + 0x140);
  sys.writeUInt16LE(1, 0x100 + 0x18);
  ptr(sys, 0x140, SYS + 0x150);
  ptr(sys, 0x150, SYS + 0x1c0); // shader parameters
  sys[0x150 + 0x10] = 1;
  ptr(sys, 0x180, SYS + 0x190);
  sys.writeUInt16LE(1, 0x180 + 8);
  ptr(sys, 0x190, SYS + 0x1a0);
  ptr(sys, 0x1a0 + 8, SYS + 0x1e0);
  sys.writeUInt16LE(1, 0x1a0 + 0x10);
  ptr(sys, 0x1a0 + 0x20, SYS + 0x1f0);
  sys[0x1c0] = 0;
  ptr(sys, 0x1c0 + 8, SYS + 0x200);
  sys.writeUInt32LE(joaat('diffusesampler'), 0x1c0 + 16);
  ptr(sys, 0x1e0, SYS + 0x300);
  ptr(sys, 0x200 + 0x28, SYS + 0x240);
  sys.write('dif.dds\0', 0x240);
  ptr(sys, 0x300 + 0x18, SYS + 0x400);
  ptr(sys, 0x300 + 0x38, SYS + 0x480);
  sys.writeUInt16LE(20, 0x400 + 8);
  ptr(sys, 0x400 + 0x10, GFX);
  sys.writeUInt32LE(3, 0x400 + 0x18);
  ptr(sys, 0x400 + 0x30, SYS + 0x440);
  sys.writeUInt32LE((1 | (1 << 6)) >>> 0, 0x440);
  sys.writeUInt32LE((6 | (5 << 24)) >>> 0, 0x440 + 8);
  sys.writeUInt32LE(3, 0x480 + 8);
  ptr(sys, 0x480 + 0x10, GFX + 0x100);
  [[0, 0, 0, 0, 0], [1, 0, 0, 1, 0], [0, 0, 1, 0, 1]].forEach((v, i) => v.forEach((x, k) => gfx.writeFloatLE(x, i * 20 + k * 4)));
  [0, 1, 2].forEach((x, i) => gfx.writeUInt16LE(x, 0x100 + i * 2));
  const file = rsc7(sys, gfx, 1 << 25, 1 << 27, 165);
  const { model } = parseRageModel(new Uint8Array(file), 'ydr');
  const m = model.meshes[0];
  assert.strictEqual(m.indices.length, 3);
  assert.strictEqual(m.material.map, 'dif.dds');
  assert.deepStrictEqual(model.wants, ['dif.dds']);
  assert.deepStrictEqual([...m.uvs], [0, 0, 1, 0, 0, 1]);
  assert.strictEqual(m.positions[7], 1, 'game Z became display Y');
  // The same drawable is found inside a "fragment" by shape.
  const frag = parseRageModel(new Uint8Array(file), 'yft');
  assert.strictEqual(frag.model.meshes.length, 1);
  assert.throws(() => parseRageModel(new Uint8Array(makeYtd()), 'ydr'));
});

test('RSC header is readable for info-only resources', async () => {
  const { rscHeader } = await load('rage.js');
  const h = rscHeader(new Uint8Array(makeYtd()));
  assert.strictEqual(h.version, 13);
  assert.strictEqual(h.sysSize, 0x400);
  assert.strictEqual(rscHeader(new Uint8Array(20)), null);
});
