'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { scanNbt, rewriteRegion, inhabitedOf } = require('../../server/servers/trim');

/** A chunk's NBT: root compound holding InhabitedTime (1.18+ layout). */
function chunkNbt(ticks) {
  const name = Buffer.from('InhabitedTime');
  const value = Buffer.alloc(8);
  value.writeBigInt64BE(BigInt(ticks));
  const junk = Buffer.concat([Buffer.from([8, 0, 3]), Buffer.from('Tag'), Buffer.from([0, 2]), Buffer.from('hi')]);
  return Buffer.concat([Buffer.from([10, 0, 0]), junk, Buffer.from([4, 0, name.length]), name, value, Buffer.from([0])]);
}

/** A region file with the chunks at the given indexes, one sector each. */
function region(chunks) {
  const header = Buffer.alloc(8192);
  const sectors = [];
  let next = 2;
  for (const [i, ticks] of Object.entries(chunks)) {
    const data = zlib.deflateSync(chunkNbt(ticks));
    const sector = Buffer.alloc(4096);
    sector.writeInt32BE(data.length + 1, 0);
    sector.writeUInt8(2, 4);
    data.copy(sector, 5);
    header.writeUInt32BE(((next << 8) | 1) >>> 0, Number(i) * 4);
    sectors.push(sector);
    next++;
  }
  return Buffer.concat([header, ...sectors]);
}

test('scanNbt reads InhabitedTime past other tags', () => {
  assert.strictEqual(scanNbt(chunkNbt(12345), ['InhabitedTime'], ['Level']).InhabitedTime, 12345);
});

test('rewriteRegion cuts dropped chunks and packs the rest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-trim-'));
  const file = path.join(dir, 'r.0.0.mca');
  fs.writeFileSync(file, region({ 0: 5, 1: 9000, 40: 2 }));
  const dry = await rewriteRegion(file, new Set([0, 40]), true);
  assert.strictEqual(dry.after, 8192 + 4096);
  assert.strictEqual(fs.statSync(file).size, 8192 + 3 * 4096);
  await rewriteRegion(file, new Set([0, 40]), false);
  const out = fs.readFileSync(file);
  assert.strictEqual(out.length, 8192 + 4096);
  assert.strictEqual(out.readUInt32BE(0), 0);
  assert.strictEqual(inhabitedOf(out, out.readUInt32BE(4) >>> 8), 9000);
  await rewriteRegion(file, new Set([1]), false);
  assert.ok(!fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
});
