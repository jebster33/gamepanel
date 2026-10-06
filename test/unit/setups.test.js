'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('every ready-made setup points at a real game, mod source and valid schedules', () => {
  const setups = require('../../server/features/setups').load();
  const { parseCron, ACTIONS } = require('../../server/features/scheduler');
  const { PROVIDERS } = require('../../server/features/mods');
  assert.ok(setups.length >= 4);
  for (const s of setups) {
    const file = path.join(__dirname, '..', '..', 'templates', `${s.templateId}.json`);
    assert.ok(fs.existsSync(file), `${s.id}: no template ${s.templateId}`);
    const template = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of Object.keys(s.vars || {})) assert.ok((template.variables || []).some((v) => v.name === key), `${s.id}: ${template.id} has no variable ${key}`);
    for (const mod of s.mods || []) {
      assert.ok(PROVIDERS[mod.provider], `${s.id}: unknown mod source ${mod.provider}`);
      assert.ok((template.mods?.providers || []).includes(mod.provider), `${s.id}: ${template.id} does not take ${mod.provider} mods`);
    }
    for (const sch of s.schedules || []) {
      assert.doesNotThrow(() => parseCron(sch.cron), `${s.id}: bad cron ${sch.cron}`);
      assert.ok(ACTIONS.includes(sch.action), `${s.id}: unknown action ${sch.action}`);
    }
  }
});
