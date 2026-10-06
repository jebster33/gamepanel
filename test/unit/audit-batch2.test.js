'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ab2-data-'));
const manifest = require('../../server/features/mods/manifest');
const workshop = require('../../server/features/mods/workshop');
const resolvers = require('../../server/games/resolvers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ab2-'));

test('mods.json: only plain names are believed (it sits where mods and players can edit it)', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.gamepanel'));
  fs.writeFileSync(
    path.join(dir, '.gamepanel/mods.json'),
    JSON.stringify({
      mods: [
        { key: 'workshop:1', provider: 'workshop', strategy: 'bohemia', folder: '@123456', keys: ['a.bikey', '../../etc'], paks: ['Mod/x.pak', '../../../x'] },
        { key: 'workshop:2', provider: 'workshop', strategy: 'bohemia', folder: '$(touch /tmp/pwned)' },
        { key: 'workshop:3', provider: 'workshop', strategy: 'bohemia', folder: '@1" -x; id #' },
        { key: 'modrinth:x', provider: 'modrinth', file: '../../panel.json' },
        { key: 'modrinth:y', provider: 'modrinth', file: 'Good-1.0.jar.disabled' },
        { nokey: true },
      ],
    })
  );
  const server = { id: 's', dir };
  const mods = manifest.load(server);
  assert.strictEqual(mods.length, 5);
  assert.strictEqual(mods[0].folder, '@123456');
  assert.deepStrictEqual(mods[0].keys, ['a.bikey']);
  assert.deepStrictEqual(mods[0].paks, ['Mod/x.pak']);
  assert.strictEqual(mods[1].folder, undefined);
  assert.strictEqual(mods[2].folder, undefined);
  assert.strictEqual(mods[3].file, undefined);
  assert.strictEqual(mods[4].file, 'Good-1.0.jar.disabled');
  // What reaches the Arma/DayZ start command is only the sane folder.
  assert.strictEqual(workshop.modArgument(server), '@123456');
  // A link planted at the old predictable temp name is not written through.
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'panel.json'), 'precious');
  fs.symlinkSync(path.join(outside, 'panel.json'), path.join(dir, '.gamepanel/mods.json.tmp'));
  manifest.save(server, [{ key: 'a:b' }]);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'panel.json'), 'utf8'), 'precious');
  assert.strictEqual(manifest.load(server).length, 1);
});

test('a modpack cannot put shell text in the loader or game version', async () => {
  await assert.rejects(resolvers.loaderInstallScript({ name: 'quilt', version: '0.26;touch /tmp/x' }, '1.21.1'), /characters GamePanel does not accept/);
  await assert.rejects(resolvers.loaderInstallScript({ name: 'forge', version: '47.2.0' }, '1.20.1 $(id)'), /characters GamePanel does not accept/);
  await assert.rejects(resolvers.loaderInstallScript({ name: 'neoforge', version: '../../x' }, '1.21'), /characters/);
});
