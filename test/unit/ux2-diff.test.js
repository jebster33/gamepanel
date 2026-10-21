'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// public/js is plain ES modules; copy one dependency-free file to .mjs to load it here.
async function loadModule(rel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ux2-'));
  const file = path.join(dir, path.basename(rel, '.js') + '.mjs');
  fs.copyFileSync(path.join(__dirname, '../../public/js', rel), file);
  return import(pathToFileURL(file).href);
}

test('lineDiff marks added, removed and unchanged lines', async () => {
  const { lineDiff, diffStats } = await loadModule('ui/diff-core.js');
  const rows = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepStrictEqual(rows.map((r) => r.op), [' ', '-', '+', ' ', ' ', '+']);
  assert.deepStrictEqual(diffStats(rows), { added: 2, removed: 1 });
  assert.strictEqual(lineDiff('x', 'x').every((r) => r.op === ' '), true);
});

test('sideBySide pairs a removed line with its replacement and numbers both sides', async () => {
  const { lineDiff, sideBySide, changeStarts, visibleRows } = await loadModule('ui/diff-core.js');
  const paired = sideBySide(lineDiff('one\ntwo\nthree', 'one\n2\nthree\nfour'));
  assert.deepStrictEqual(paired.map((p) => p.op), [' ', '~', ' ', '+']);
  assert.strictEqual(paired[1].left.text, 'two');
  assert.strictEqual(paired[1].right.text, '2');
  assert.strictEqual(paired[1].left.n, 2);
  assert.strictEqual(paired[3].left, null);
  assert.strictEqual(paired[3].right.n, 4);
  assert.deepStrictEqual(changeStarts(paired), [1, 3]);
  assert.deepStrictEqual(visibleRows([' ', ' ', ' ', ' ', '+', ' '], 1), [false, false, false, true, true, true]);
});

test('uneven change blocks leave a gap on the shorter side', async () => {
  const { lineDiff, sideBySide } = await loadModule('ui/diff-core.js');
  const paired = sideBySide(lineDiff('a\nb\nc', 'a\nx'));
  assert.deepStrictEqual(paired.map((p) => p.op), [' ', '~', '-']);
  assert.strictEqual(paired[2].right, null);
});
