'use strict';

// `node --test <dir>` behaves differently across Node versions and Windows
// shells do not expand globs, so list the files here. The output is passed
// through, and a failure ends with a short summary of what failed (the TAP
// output of hundreds of tests is long, and the failures are in the middle).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).map((f) => path.join(__dirname, f));
const child = spawn(process.execPath, ['--test', ...files], { stdio: ['inherit', 'pipe', 'inherit'] });
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.on('close', (code) => {
  if (code) {
    const lines = output.split('\n');
    const failed = [];
    lines.forEach((line, i) => {
      if (/^\s*not ok /.test(line)) failed.push(...lines.slice(i, i + 14).filter((l) => !/duration_ms|type: 'test'|^\s*---$|^\s*\.\.\.$/.test(l)), '');
    });
    if (failed.length) console.log(`\n=== FAILED TESTS ===\n${failed.join('\n')}`);
  }
  process.exit(code ?? 1);
});
