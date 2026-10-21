'use strict';

const test = require('node:test');
const assert = require('node:assert');
const yaml = require('../../server/core/yaml');

test('parses maps, lists, comments, quotes, flow and block scalars', () => {
  const doc = `# top
version: 1   # trailing
servers:
  - name: "Sur: vival"
    ports: {game: 25565, query: 25566}
    vars:
      VERSION: '1.20'
      MOTD: |
        hello
          world
      FOLD: >-
        a
        b
    tags: [a, "b c", 3]
  - name: Two
    items:
    - x
    - y: 1
      z: []
    - - 1
      - 2
`;
  assert.deepStrictEqual(yaml.parse(doc), {
    version: 1,
    servers: [
      { name: 'Sur: vival', ports: { game: 25565, query: 25566 }, vars: { VERSION: '1.20', MOTD: 'hello\n  world\n', FOLD: 'a b' }, tags: ['a', 'b c', 3] },
      { name: 'Two', items: ['x', { y: 1, z: [] }, [1, 2]] },
    ],
  });
});

test('numbers that would not print back the same stay strings', () => {
  assert.deepStrictEqual(yaml.parse('a: 1.20\nb: 007\nc: 25565\nd: null\ne: true\nf: ~'), { a: '1.20', b: '007', c: 25565, d: null, e: true, f: null });
});

test('accepts JSON', () => {
  assert.deepStrictEqual(yaml.parse('{"servers":[{"name":"a","memory":2048}]}'), { servers: [{ name: 'a', memory: 2048 }] });
});

test('round trips awkward values', () => {
  const value = {
    plain: 'hello world',
    reserved: ['yes', 'null', 'true', '~', ''],
    numeric: ['1.20', '42', '-3', '1e3'],
    odd: 'a: b # not a comment',
    multi: 'line one\nline two\n',
    multiNoEnd: 'x\ny',
    quotes: 'say "hi" and \'bye\'',
    unicode: 'caf\u00e9 \u2603',
    nested: { list: [{ a: 1, b: [1, 2, { c: null }] }, [], {}, 'z'], empty: {} },
    'key with: colon': true,
    n: [0, 1.5, -2],
  };
  assert.deepStrictEqual(yaml.parse(yaml.emit(value)), value);
});

test('refuses prototype keys, duplicates, tabs and aliases', () => {
  assert.throws(() => yaml.parse('__proto__: 1'), /not allowed/);
  assert.throws(() => yaml.parse('{"__proto__": 1}x'), /./);
  assert.throws(() => yaml.parse('a: 1\na: 2'), /twice/);
  assert.throws(() => yaml.parse('a:\n\tb: 1'), /tabs/);
  assert.throws(() => yaml.parse('a: *x'), /not supported/);
  assert.throws(() => yaml.parse('a: "open'), /not closed/);
  assert.strictEqual({}.polluted, undefined);
});

test('errors name the line', () => {
  assert.throws(() => yaml.parse('a: 1\nb: 2\n  c: 3'), /Line 3/);
});
