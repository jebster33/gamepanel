'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Sftp } = require('../../server/features/sftp');
const { u32, str, byte, Reader } = require('../../server/core/ssh');

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

/** Drive one SFTP session in memory: send requests, read the answers. */
function session({ write = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-sftp-'));
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'server.properties'), 'motd=hi\n');
  fs.symlinkSync('/etc', path.join(a, 'etc-link'));
  const servers = [
    { id: 'a', dir: a },
    { id: 'b', dir: b },
  ];
  const can = (id, cap) => id === 'a' && (cap === 'files' || write);
  let out = Buffer.alloc(0);
  const sftp = new Sftp({ servers, single: null, can }, { write: (buf) => (out = Buffer.concat([out, buf])), close() {} }, { manager: {} });
  let id = 0;
  const send = async (type, ...parts) => {
    const reqId = ++id;
    const payload = Buffer.concat([byte(type), u32(reqId), ...parts]);
    out = Buffer.alloc(0);
    sftp.data(Buffer.concat([u32(payload.length), payload]));
    await sftp.queue;
    const r = new Reader(out, 4);
    const kind = r.byte();
    r.u32();
    return { kind, r };
  };
  return { root, send, sftp };
}

const statusOf = (res) => (res.kind === 101 ? res.r.u32() : null);

test('paths stay inside the server folders; reads and writes follow permissions', async () => {
  const s = session();
  // REALPATH never goes above "/".
  let res = await s.send(16, str('/../../etc'));
  res.r.u32();
  assert.strictEqual(res.r.string(), '/etc');
  // "/" lists only servers this account may browse.
  res = await s.send(11, str('/'));
  const handle = res.r.bytes();
  res = await s.send(12, str(handle));
  const n = res.r.u32();
  const names = Array.from({ length: n }, () => {
    const name = res.r.string();
    res.r.string();
    const flags = res.r.u32();
    res.r.u64();
    res.r.u32();
    res.r.u32();
    res.r.u32();
    if (flags & 8) {
      res.r.u32();
      res.r.u32();
    }
    return name;
  });
  assert.deepStrictEqual(names, ['.', 'a']);
  assert.strictEqual(statusOf(await s.send(17, str('/b'))), 3); // permission denied
  assert.strictEqual(statusOf(await s.send(17, str('/etc/passwd'))), 2); // no such server
  assert.strictEqual(statusOf(await s.send(17, str('/a/etc-link/passwd'))), 3); // the symlink leads out

  // Write a file, read it back.
  res = await s.send(3, str('/a/new.txt'), u32(2 | 8 | 16), u32(0));
  assert.strictEqual(res.kind, 102);
  const fh = res.r.bytes();
  assert.strictEqual(statusOf(await s.send(6, str(fh), u64(0), str('hello'))), 0);
  assert.strictEqual(statusOf(await s.send(4, str(fh))), 0);
  assert.strictEqual(fs.readFileSync(path.join(s.root, 'a/new.txt'), 'utf8'), 'hello');
  res = await s.send(3, str('/a/new.txt'), u32(1), u32(0));
  const rh = res.r.bytes();
  res = await s.send(5, str(rh), u64(0), u32(100));
  assert.strictEqual(res.kind, 103);
  assert.strictEqual(res.r.string(), 'hello');
  assert.strictEqual(statusOf(await s.send(5, str(rh), u64(5), u32(100))), 1); // EOF

  // No symlinks, no changing the server folder itself.
  assert.strictEqual(statusOf(await s.send(20, str('/a/l'), str('/etc/passwd'))), 3);
  assert.strictEqual(statusOf(await s.send(15, str('/a'))), 3);
  fs.rmSync(s.root, { recursive: true, force: true });
});

test('a read-only account cannot change anything', async () => {
  const s = session({ write: false });
  assert.strictEqual(statusOf(await s.send(3, str('/a/x.txt'), u32(2 | 8), u32(0))), 3);
  assert.strictEqual(statusOf(await s.send(13, str('/a/server.properties'))), 3);
  assert.strictEqual(statusOf(await s.send(14, str('/a/dir'), u32(0))), 3);
  assert.strictEqual(statusOf(await s.send(18, str('/a/server.properties'), str('/a/y'))), 3);
  assert.ok(fs.existsSync(path.join(s.root, 'a/server.properties')));
  fs.rmSync(s.root, { recursive: true, force: true });
});
