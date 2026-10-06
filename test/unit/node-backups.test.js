'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-nb-data-'));
const nb = require('../../server/features/node-backups');

const req = (buf, size = buf.length) => Object.assign(Readable.from([buf]), { headers: { 'x-backup-size': String(size) } });

test('a node keeps copies for other panels, and refuses bad names or short copies', async () => {
  const data = Buffer.from('pretend this is a tar.gz');
  assert.deepStrictEqual(await nb.receive(req(data), 'panelA', 'mc-1', '2026-10-06-a.tar.gz'), { ok: true, size: data.length });
  await nb.receive(req(Buffer.from('x')), 'panelA', 'mc-1', '2026-10-06-b.tar.gz');
  const list = nb.listStored('panelA', 'mc-1');
  assert.deepStrictEqual(list.map((b) => b.name).sort(), ['2026-10-06-a.tar.gz', '2026-10-06-b.tar.gz']);
  assert.strictEqual(fs.readFileSync(nb.storeFile('panelA', 'mc-1', '2026-10-06-a.tar.gz'), 'utf8'), data.toString());
  assert.deepStrictEqual(nb.storedSummary().map((s) => [s.source, s.serverId, s.count]), [['panelA', 'mc-1', 2]]);

  await assert.rejects(nb.receive(req(data, data.length + 5), 'panelA', 'mc-1', 'cut.tar.gz'), /incomplete/);
  assert.ok(!nb.listStored('panelA', 'mc-1').some((b) => b.name.startsWith('cut')));
  assert.throws(() => nb.storeFile('panelA', 'mc-1', '../../etc.tar.gz'), /Invalid backup name/);
  assert.throws(() => nb.storeFile('../x', 'mc-1', 'a.tar.gz'), /Bad panel or server id/);
  assert.deepStrictEqual(nb.listStored('panelB', 'none'), []);
});
