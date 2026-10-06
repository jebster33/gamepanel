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

test('names and variables cannot reach the shell', () => {
  assert.doesNotThrow(() => quotas.assertSafeInput({ name: 'Survival SMP #2', vars: { WORLD_NAME: 'My World-1' } }));
  assert.throws(() => quotas.assertSafeInput({ name: 'x"; rm -rf ~; "' }), /server name/);
  assert.throws(() => quotas.assertSafeInput({ vars: { SERVER_PASSWORD: '$(id)' } }), /SERVER_PASSWORD/);
  // A value an administrator set may be saved back unchanged.
  assert.doesNotThrow(() => quotas.assertSafeInput({ vars: { SERVER_PASSWORD: 'pa$$' } }, { vars: { SERVER_PASSWORD: 'pa$$' } }));
});
