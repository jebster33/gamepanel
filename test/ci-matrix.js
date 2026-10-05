'use strict';

/**
 * Prints the CI job matrix: which templates to boot on which OS.
 * A template runs on every platform listed in its "platforms" array
 * (Linux only when it has none). Pass --only=a,b to narrow it down.
 */

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'templates');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

const matrix = { linux: [], windows: [] };
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const tpl = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  if (only.length && !only.includes(tpl.id)) continue;
  for (const platform of tpl.platforms || ['linux']) {
    if (matrix[platform]) matrix[platform].push(tpl.id);
  }
}

const out = process.env.GITHUB_OUTPUT;
const lines = [`linux=${JSON.stringify(matrix.linux)}`, `windows=${JSON.stringify(matrix.windows)}`];
if (out) fs.appendFileSync(out, lines.join('\n') + '\n');
console.log(lines.join('\n'));
