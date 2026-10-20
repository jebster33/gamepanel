'use strict';

const test = require('node:test');
const assert = require('node:assert');

const rustmaps = require('../../server/features/rustmaps');
const oxide = require('../../server/features/oxide');
const template = require('../../templates/rust.json');

test('RustMaps preview link follows the size and seed', () => {
  assert.strictEqual(rustmaps.previewUrl(3500, 1337), 'https://rustmaps.com/map/3500_1337');
  const manager = { vars: () => ({ WORLD_SIZE: 4000, WORLD_SEED: 42 }) };
  const store = { state: { settings: {} } };
  const info = rustmaps.describe(manager, store, { id: 's1' });
  assert.strictEqual(info.keySet, false);
  assert.strictEqual(info.preview.url, 'https://rustmaps.com/map/4000_42');
  assert.throws(() => rustmaps.generate(manager, store, { id: 's1' }, { blocked: ['Bandit Town'] }), /API key/);
});

test('Rust game updates put Oxide back on every platform', () => {
  for (const steps of [template.update, template.windows.update]) {
    assert.ok(steps[0].type === 'steamcmd');
    assert.ok(steps.some((s) => s.id === 'oxide'));
  }
  const manager = { template: () => template, vars: () => ({ INSTALL_OXIDE: 'true' }) };
  assert.ok(oxide.step(manager, {}));
  assert.strictEqual(oxide.enabled(manager, { templateId: 'rust' }), true);
  assert.strictEqual(oxide.enabled({ vars: () => ({ INSTALL_OXIDE: 'false' }) }, { templateId: 'rust' }), false);
});
