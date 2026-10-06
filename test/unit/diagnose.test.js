'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { diagnose } = require('../../server/games/diagnose');

const first = (text, ctx) => diagnose(text.split('\n'), ctx)[0] || {};

test('crash doctor recognises the usual crashes', () => {
  const java = first(
    'Error: LinkageError occurred while loading main class io.papermc.paperclip.Main\n\tjava.lang.UnsupportedClassVersionError: io/papermc/paperclip/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0'
  );
  assert.strictEqual(java.id, 'java-version');
  assert.strictEqual(java.fix.java, 21);

  assert.strictEqual(first('[12:00:00] [Server thread/WARN]: **** FAILED TO BIND TO PORT!\n[12:00:00] [Server thread/WARN]: The exception was: java.net.BindException: Address already in use').id, 'port');
  assert.strictEqual(first('[Server thread/INFO]: You need to agree to the EULA in order to run the server. Go to eula.txt for more info.').id, 'eula');
  assert.strictEqual(first('Exception in thread "main" java.lang.OutOfMemoryError: Java heap space', { memory: 2048 }).fix.action, 'memory');
  assert.strictEqual(first('', { signal: 'SIGKILL' }).id, 'memory');
  assert.strictEqual(first("[Server thread/ERROR]: Could not load 'plugins/OldPlugin-1.8.jar' in folder 'plugins'").fix.file, 'OldPlugin-1.8.jar');
  assert.strictEqual(first('Error: Unable to access jarfile server.jar').id, 'jar-missing');
  assert.deepStrictEqual(diagnose(['[Server thread/INFO]: Done (3.2s)!']), []);
});
