'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-infra1-'));
const infra = require('../../server/features/infra-as-code');
const yaml = require('../../server/core/yaml');
const secrets = require('../../server/core/secrets');

const TEMPLATES = {
  mc: {
    id: 'mc',
    name: 'Minecraft',
    ports: [{ name: 'game', protocol: 'tcp' }, { name: 'rcon', protocol: 'tcp' }],
    variables: [
      { name: 'MOTD', label: 'MOTD' },
      { name: 'MAX_PLAYERS', type: 'number' },
      { name: 'DIFFICULTY', options: ['easy', 'hard'] },
      { name: 'RCON_PASSWORD', secret: true },
    ],
  },
};

function fake(servers = []) {
  const calls = [];
  const m = {
    servers,
    calls,
    store: { addEvent() {} },
    templates: { get: (id) => TEMPLATES[id] || null },
    template: (s) => TEMPLATES[s.templateId],
    usedPorts: (except) => new Set(servers.filter((s) => s.id !== except).flatMap((s) => Object.values(s.ports))),
    isActive: () => false,
    create(input) {
      const s = { id: `${input.name.toLowerCase()}-1`, name: input.name, templateId: input.templateId, ports: input.ports, vars: input.vars, memory: input.memory || 1024 };
      servers.push(s);
      calls.push(['create', input]);
      return s;
    },
    update(id, patch) {
      Object.assign(servers.find((s) => s.id === id), { ...patch, vars: { ...servers.find((s) => s.id === id).vars, ...(patch.vars || {}) }, ports: { ...servers.find((s) => s.id === id).ports, ...(patch.ports || {}) } });
      calls.push(['update', id, patch]);
    },
    async remove(id, files) {
      servers.splice(servers.findIndex((s) => s.id === id), 1);
      calls.push(['remove', id, files]);
    },
  };
  return m;
}
const existing = () => ({ id: 'alpha-1', name: 'Alpha', templateId: 'mc', ports: { game: 25565, rcon: 25575 }, vars: { MOTD: 'hi', RCON_PASSWORD: secrets.seal('hunter22') }, memory: 2048, autoStart: true });

test('export leaves secret variables out and round trips through the plan as unchanged', () => {
  const m = fake([existing()]);
  const text = infra.exportYaml(m);
  assert.ok(!/RCON_PASSWORD|hunter22|enc:v1/.test(text));
  const doc = yaml.parse(text);
  assert.strictEqual(doc.servers[0].template, 'mc');
  const plan = infra.computePlan(m, text);
  assert.ok(plan.ok);
  assert.deepStrictEqual(plan.counts, { create: 0, update: 0, unchanged: 1, delete: 0, error: 0 });
});

test('plan: create, update and unchanged; no deletes without prune', () => {
  const m = fake([existing(), { ...existing(), id: 'beta-1', name: 'Beta', ports: { game: 25570, rcon: 25580 } }]);
  const text = `servers:
  - name: Alpha
    memory: 4096
    vars: { MOTD: hi }
  - name: Gamma
    template: mc
    ports: { game: 25590 }
`;
  const plan = infra.computePlan(m, text);
  assert.deepStrictEqual(plan.counts, { create: 1, update: 1, unchanged: 0, delete: 0, error: 0 });
  assert.deepStrictEqual(plan.actions[0].changes, [{ field: 'memory', from: 2048, to: 4096 }]);
  const pruned = infra.computePlan(m, `prune: true\n${text}`);
  assert.strictEqual(pruned.counts.delete, 1);
  assert.strictEqual(pruned.actions.find((a) => a.action === 'delete').name, 'Beta');
});

test('plan reports problems instead of guessing', () => {
  const m = fake([existing()]);
  const plan = infra.computePlan(m, `servers:
  - name: Alpha
    vars: { RCON_PASSWORD: x, NOPE: 1, DIFFICULTY: peaceful, MAX_PLAYERS: many }
    ports: { game: 70000 }
    colour: red
  - name: Bad
    template: nothere
  - name: Clash
    template: mc
    ports: { game: 25565 }
`);
  const errors = plan.actions.filter((a) => a.action === 'error');
  assert.strictEqual(errors.length, 3);
  const text = errors.map((e) => e.errors.join('|')).join('\n');
  for (const needle of ['secret', 'not a setting', 'must be one of', 'must be a number', 'unknown field', 'unknown template', 'already used']) assert.ok(text.includes(needle), needle);
});

test('apply creates, updates and only prunes when confirmed', async () => {
  const m = fake([existing(), { ...existing(), id: 'beta-1', name: 'Beta', ports: { game: 25570, rcon: 25580 } }]);
  const installed = [];
  const text = `prune: true
servers:
  - name: Alpha
    memory: 4096
  - name: Gamma
    template: mc
    notes: hello
`;
  await assert.rejects(infra.apply(m, text, { username: 'a' }, { install: () => {} }), /remove 1 server/);
  assert.strictEqual(m.calls.length, 0);
  const r = await infra.apply(m, text, { username: 'a' }, { confirmPrune: true, install: (id) => installed.push(id) });
  assert.deepStrictEqual(r.applied.map((a) => a.action), ['update', 'create', 'delete']);
  assert.deepStrictEqual(installed, ['gamma-1']);
  assert.deepStrictEqual(m.calls.find((c) => c[0] === 'remove'), ['remove', 'beta-1', false]);
  // notes is applied by an update after create
  assert.ok(m.calls.some((c) => c[0] === 'update' && c[2].notes === 'hello'));
});
