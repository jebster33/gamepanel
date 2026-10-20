'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const files = require('../../server/servers/config-files');
const { variant } = require('../../server/games/templates');

const template = (id, platform = 'linux') => variant(JSON.parse(fs.readFileSync(path.join(__dirname, '../../templates', `${id}.json`), 'utf8')), platform);
const defaults = (tpl) => Object.fromEntries((tpl.variables || []).map((v) => [v.name, v.default]));

/** A server folder and just enough of the manager for the config-file mixin. */
function harness(tpl, vars = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-rules-'));
  const values = { SERVER_NAME: 'Test', PORT: 1, ...defaults(tpl), ...vars };
  return { dir, server: { dir }, ctx: { vars: () => values }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('patchTuple changes and adds entries on a one-line OptionSettings', () => {
  const before = '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,ServerName="A, b",CrossplayPlatforms=(Steam,Xbox),ExpRate=1.000000)\n';
  const after = files.patchTuple(before, { ExpRate: '3', bIsPvP: 'True' }, { key: 'OptionSettings', section: '/Script/Pal.PalGameWorldSettings' });
  assert.ok(after.includes('OptionSettings=(Difficulty=None,ServerName="A, b",CrossplayPlatforms=(Steam,Xbox),ExpRate=3,bIsPvP=True)'));
  assert.ok(files.patchTuple('', { ExpRate: '3' }, { key: 'OptionSettings', section: 'S' }).includes('[S]\nOptionSettings=(ExpRate=3)'));
});

test('Palworld gets its rates from the game settings, and old servers get the defaults', () => {
  const tpl = template('palworld');
  const h = harness(tpl, { EXP_RATE: 5 });
  try {
    const file = path.join(h.dir, 'Pal/Saved/Config/LinuxServer/PalWorldSettings.ini');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,ExpRate=1.000000,ServerName="x")\n');
    files.applyPropertyPatches.call(h.ctx, h.server, tpl);
    const out = fs.readFileSync(file, 'utf8');
    assert.match(out, /ExpRate=5/);
    assert.match(out, /DeathPenalty=All/);
    assert.match(out, /bIsPvP=False/);
    assert.match(out, /ServerName="x"/);
  } finally {
    h.cleanup();
  }
});

test('ARK writes its multipliers to the config folder of the platform it runs on', () => {
  for (const [platform, folder] of [['linux', 'LinuxServer'], ['windows', 'WindowsServer']]) {
    const tpl = template('ark-survival-evolved', platform);
    const h = harness(tpl, { HARVEST_MULTIPLIER: 3 });
    try {
      files.applyPropertyPatches.call(h.ctx, h.server, tpl);
      const out = fs.readFileSync(path.join(h.dir, `ShooterGame/Saved/Config/${folder}/GameUserSettings.ini`), 'utf8');
      assert.match(out, /\[ServerSettings\]/);
      assert.match(out, /HarvestAmountMultiplier=3/);
      assert.match(out, /ServerPVE=False/);
    } finally {
      h.cleanup();
    }
  }
});

test('Source games write the rules they were given and leave blank ones alone', () => {
  const tpl = template('tf2');
  const h = harness(tpl, { FRIENDLY_FIRE: '1', TIME_LIMIT: '15' });
  try {
    files.writeConfigFiles.call(h.ctx, h.server, tpl);
    const out = fs.readFileSync(path.join(h.dir, 'tf/cfg/gamepanel-rules.cfg'), 'utf8');
    assert.match(out, /^mp_friendlyfire 1$/m);
    assert.match(out, /^mp_timelimit 15$/m);
    assert.match(out, /^mp_winlimit $/m);
    assert.ok(tpl.startCommand.includes('+exec gamepanel-rules.cfg'));
  } finally {
    h.cleanup();
  }
});

test('7 Days to Die puts its rules in the settings file on every start', () => {
  const tpl = template('seven-days-to-die');
  const h = harness(tpl, { BLOOD_MOON_FREQUENCY: 3 });
  try {
    files.writeConfigFiles.call(h.ctx, h.server, tpl);
    const out = fs.readFileSync(path.join(h.dir, 'gamepanel.xml'), 'utf8');
    assert.match(out, /name="BloodMoonFrequency" value="3"/);
    assert.match(out, /name="DropOnDeath" value="1"/);
    assert.ok(out.trim().endsWith('</ServerSettings>'));
  } finally {
    h.cleanup();
  }
});

test('every grouped setting has a label and a default that is one of its options', () => {
  for (const file of fs.readdirSync(path.join(__dirname, '../../templates'))) {
    const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, '../../templates', file), 'utf8'));
    for (const v of (tpl.variables || []).filter((x) => x.group)) {
      assert.ok(v.label, `${tpl.id}: ${v.name} has no label`);
      assert.notStrictEqual(v.default, undefined, `${tpl.id}: ${v.name} has no default`);
      if (v.options) assert.ok(v.options.some((o) => String(o.value) === String(v.default)), `${tpl.id}: ${v.name} default is not an option`);
    }
  }
});

test('presets only set settings the template declares, with values its dropdowns allow', () => {
  for (const file of fs.readdirSync(path.join(__dirname, '../../templates'))) {
    const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, '../../templates', file), 'utf8'));
    const byName = new Map((tpl.variables || []).map((v) => [v.name, v]));
    for (const preset of tpl.presets || []) {
      for (const [name, value] of Object.entries(preset.vars)) {
        const v = byName.get(name);
        assert.ok(v, `${tpl.id}: preset ${preset.id} sets unknown ${name}`);
        if (v.options) assert.ok(v.options.some((o) => String(o.value) === String(value)), `${tpl.id}: preset ${preset.id} sets ${name} to ${value}`);
      }
    }
  }
});

test('Rust sends its gather rate once the server is up', () => {
  const tpl = template('rust');
  assert.deepStrictEqual(tpl.readyCommands[0], 'gather.rate dispenser * {{GATHER_RATE}}');
  assert.ok(tpl.variables.some((v) => v.name === 'GATHER_RATE'));
});
