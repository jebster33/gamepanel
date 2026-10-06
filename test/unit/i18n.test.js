'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('every translation has all five languages and keeps placeholders', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'core', 'i18n.js'), 'utf8');
  const body = src.slice(src.indexOf('const DICT = {'), src.indexOf('};', src.indexOf('const DICT = {')) + 2);
  // The dictionary is plain data: evaluate just that object.
  const DICT = new Function(`${body.replace('const DICT =', 'return')}`)();
  assert.ok(Object.keys(DICT).length > 200);
  for (const [en, langs] of Object.entries(DICT)) {
    assert.strictEqual(langs.length, 5, `${en} needs nl, de, es, fr and pt`);
    const holes = (s) => (s.match(/\{\{\w+\}\}|\$\d/g) || []).sort().join();
    for (const l of langs) {
      assert.ok(l && typeof l === 'string', `${en} has an empty translation`);
      assert.strictEqual(holes(l), holes(en), `${en} → ${l} lost a placeholder`);
    }
  }
});
