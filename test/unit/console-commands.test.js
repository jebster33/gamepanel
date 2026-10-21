'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cmds = require('../../server/games/commands');

const mc = { id: 'minecraft-paper', query: { type: 'minecraft' } };

test('quick commands are built by the panel and sanitized', () => {
  assert.strictEqual(cmds.build(mc, 'time', { when: 'night' }), 'time set night');
  assert.throws(() => cmds.build(mc, 'time', { when: 'night; stop' }));
  assert.strictEqual(cmds.build(mc, 'kick', { player: 'Bob; stop', reason: '' }), 'kick Bob stop');
  assert.strictEqual(cmds.build(mc, 'say', { text: 'hi "all"; stop' }), 'say hi all stop');
  assert.throws(() => cmds.build(mc, 'nope', {}));
  assert.throws(() => cmds.build({ id: 'rust' }, 'time', { hour: 'x' }));
});

test('macros are validated and @say uses the game chat command', () => {
  const [m] = cmds.validateMacros([{ name: 'Hi', commands: ['save-all', '@say hello\nstop'] }]);
  assert.ok(m.id);
  assert.deepStrictEqual(cmds.macroCommands(mc, m), ['save-all', 'say hello stop']);
  assert.throws(() => cmds.validateMacros([{ name: '', commands: ['x'] }]));
  assert.throws(() => cmds.validateMacros([{ name: 'a', commands: [] }]));
});
