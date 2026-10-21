'use strict';

// The Minecraft UI modules are plain ES modules the browser loads; make sure each one at least parses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', '..', 'public', 'js', 'pages', 'server');
const files = fs.readdirSync(dir).filter((f) => /^mc-.*\.js$/.test(f) || ['game.js', 'worlds.js', 'players.js', 'inventory.js'].includes(f));

test('mc-* page modules parse as ES modules', () => {
  assert.ok(files.length >= 6);
  for (const f of files) {
    // No flags needed: drop the static imports and exports, then compile the rest as an async function body.
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^import [^;]*;$/gm, '').replace(/^export (async )?(function|const)/gm, '$1$2');
    assert.doesNotThrow(() => new vm.Script(`(async () => {\n${src}\n})`, { filename: f }), f);
  }
});
