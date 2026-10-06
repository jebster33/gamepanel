'use strict';

const test = require('node:test');
const assert = require('node:assert');
const quotas = require('../../server/features/quotas');

const manager = (servers) => ({ servers, rt: (id) => ({ diskBytes: servers.find((s) => s.id === id)?.disk || 0 }) });
const user = { id: 'u', role: 'user', quota: { servers: 2, memoryMb: 6144, diskGb: 1 } };

test('a new server must fit the account quota', () => {
  const m = manager([{ id: 'a', ownerId: 'u', memory: 4096 }, { id: 'b', ownerId: 'x', memory: 8192 }]);
  assert.doesNotThrow(() => quotas.checkCreate(m, user, 2048));
  assert.throws(() => quotas.checkCreate(m, user, 4096), /2048 MB of its 6144 MB left/);
  m.servers.push({ id: 'c', ownerId: 'u', memory: 1024 });
  assert.throws(() => quotas.checkCreate(m, user, 512), /can have 2 servers/);
});

test('memory changes and disk use count against the owner', () => {
  const server = { id: 'a', ownerId: 'u', memory: 4096, disk: 2 * 1024 ** 3 };
  const m = manager([server, { id: 'c', ownerId: 'u', memory: 1024 }]);
  assert.doesNotThrow(() => quotas.checkMemory(m, user, server, 5120));
  assert.throws(() => quotas.checkMemory(m, user, server, 6000), /5120 MB is free/);
  assert.throws(() => quotas.checkDisk(m, server, [user]), /more than their 1 GB/);
  assert.doesNotThrow(() => quotas.checkDisk(m, { id: 'z' }, [user]), 'servers without an owner are not counted');
});

test('self-service deploys use the same rules as sub-user edits', () => {
  const { checkPatch } = require('../../server/servers/untrusted');
  const template = { startCommand: './run -name "{{SERVER_NAME}}" {{JAVA_ARGS}}', variables: [{ name: 'WORLD', default: 'w' }, { name: 'JAVA_ARGS', default: '-Xmx2G' }] };
  const base = { name: '', vars: { WORLD: 'w', JAVA_ARGS: '-Xmx2G' } };
  assert.doesNotThrow(() => checkPatch(template, { name: 'Survival SMP #2', vars: { WORLD: 'My World-1', JAVA_ARGS: '-Xmx2G' } }, base));
  assert.throws(() => checkPatch(template, { name: 'x"; rm -rf ~; "' }, base), /server name/);
  assert.throws(() => checkPatch(template, { vars: { JAVA_ARGS: '-XX:OnOutOfMemoryError=wget' } }, base), /Only administrators/);
  assert.throws(() => checkPatch(template, { vars: { LD_PRELOAD: '/tmp/x.so' } }, base), /not a setting/);
});
