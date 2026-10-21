'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-pdf-'));
const { PdfDocument, textWidth, pdfString } = require('../../server/features/pdf');
const reports = require('../../server/features/reports');

test('the PDF generator writes a structurally valid file', () => {
  const doc = new PdfDocument({ title: 'T (1)', footer: 'foot' });
  doc.h1('Heading');
  doc.para('word '.repeat(300));
  doc.stats([{ label: 'a', value: '99%', tone: 'good' }]);
  doc.table(['A', 'B'], Array.from({ length: 80 }, (_, i) => [`row ${i}`, String(i)]));
  doc.bars([{ label: 'x', value: 0.5, text: '50%' }, { label: 'y', value: null }]);
  doc.columns([1, 0.5, null, 0.95]);
  const buf = doc.build();
  const text = buf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const pages = Number(/\/Count (\d+)/.exec(text)[1]);
  assert.ok(pages >= 2, 'long table spills to more pages');
  assert.strictEqual((text.match(/\/Type \/Page /g) || []).length, pages);
  // The cross-reference table points at real objects.
  const startxref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.ok(text.slice(startxref).startsWith('xref'));
  const size = Number(/\/Size (\d+)/.exec(text)[1]);
  const entries = text.slice(startxref).split('\n').slice(3, 3 + size - 1);
  entries.forEach((line, i) => {
    const off = Number(line.slice(0, 10));
    assert.ok(text.slice(off).startsWith(`${i + 1} 0 obj`), `object ${i + 1} offset`);
  });
  // A page stream inflates to drawing operators.
  const m = /\/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/.exec(text);
  const start = m.index + m[0].length;
  const content = zlib.inflateSync(buf.subarray(start, start + Number(m[1]))).toString('latin1');
  assert.match(content, /BT .* Tj ET/);
  assert.match(content, / re f/);
});

test('PDF text is escaped', () => {
  assert.strictEqual(pdfString('a(b)c\\'), '(a\\(b\\)c\\\\)');
  assert.strictEqual(pdfString('中'), '(?)');
  assert.ok(textWidth('WWW', 10) > textWidth('iii', 10));
});

test('the monthly report counts uptime, crashes, restarts, backups and disk', () => {
  const store = new EventEmitter();
  store.state = { events: [], settings: { panelName: 'Test' } };
  store.save = () => {};
  const from = new Date(2026, 8, 1).getTime();
  const samples = [];
  for (let i = 0; i < 100; i++) samples.push([from + i * 300_000, i < 90 ? (i === 10 ? 7 : 2) : null]);
  const history = { samples, log: [{ t: from + 1000, type: 'crash' }, { t: from + 20_000, type: 'start' }, { t: from + 900_000, type: 'stop' }, { t: from + 5_000_000, type: 'start' }] };
  const manager = { servers: [{ id: 's1', name: 'Survival', templateId: 'minecraft' }], history: () => history, rt: () => ({ diskBytes: 2e9 }) };
  const tracker = new reports.Tracker(store, manager, path.join(process.env.GP_DATA_DIR, 'stats.json'));
  store.emit('event', { type: 'backup.created', serverId: 's1', at: from + 10 });
  store.emit('event', { type: 'backup.failed', serverId: 's1', at: from + 20 });
  tracker.data.disk.s1 = [[Math.floor(from / 86400000) + 1, 1e9], [Math.floor(from / 86400000) + 20, 3e9]];
  const data = reports.collect({ manager, store, tracker }, '2026-09');
  const s = data.servers[0];
  assert.strictEqual(s.uptime, 0.9);
  assert.strictEqual(s.peakPlayers, 7);
  assert.strictEqual(s.crashes, 1);
  assert.strictEqual(s.restarts, 1);
  assert.strictEqual(s.backupsOk, 1);
  assert.strictEqual(s.backupsFailed, 1);
  assert.strictEqual(s.diskGrowth, 2e9);
  assert.strictEqual(data.fleet.crashes, 1);
  assert.ok(reports.renderPdf(data).toString('latin1').startsWith('%PDF-'));
  assert.throws(() => reports.parseMonth('2026-13'));
  assert.throws(() => reports.parseMonth('../x'));
  assert.strictEqual(reports.previousMonthKey(new Date(2026, 0, 5)), '2025-12');
  assert.ok(reports.FILE_RE.test('uptime-2026-09.pdf'));
  assert.ok(!reports.FILE_RE.test('../uptime-2026-09.pdf'));
});
