'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { editIniLines, editKf2, editAvorion } = require('../../server/features/mods/workshop');

const server = (vars = {}) => ({ id: 's', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'gp-wsg-')), vars });

test('Killing Floor 2: one ServerSubscribedWorkshopItems line per item, Workshop download manager first', () => {
  const s = server();
  const rel = 'KFGame/Config/LinuxServer-KFEngine.ini';
  fs.mkdirSync(path.join(s.dir, 'KFGame/Config'), { recursive: true });
  fs.writeFileSync(path.join(s.dir, rel), '[IpDrv.TcpNetDriver]\nDownloadManagers=IpDrv.HTTPDownload\nDownloadManagers=Engine.ChannelDownload\n\n[Engine.GameEngine]\nbUsedForTakeover=FALSE\n');
  const spec = { file: 'KFGame/Config/*Server-KFEngine.ini' };
  assert.strictEqual(editKf2(s, spec, { add: ['111', '222'] }), 1);
  editKf2(s, spec, { add: ['222', '333'], remove: ['111'] });
  const text = fs.readFileSync(path.join(s.dir, rel), 'utf8');
  assert.match(text, /\[OnlineSubsystemSteamworks\.KFWorkshopSteamworks\]\nServerSubscribedWorkshopItems=222\nServerSubscribedWorkshopItems=333\n$/);
  assert.match(text, /\[IpDrv\.TcpNetDriver\]\nDownloadManagers=OnlineSubsystemSteamworks\.SteamWorkshopDownload\nDownloadManagers=IpDrv\.HTTPDownload\nDownloadManagers=Engine\.ChannelDownload\n\n\[Engine\.GameEngine\]/);
  assert.strictEqual(text.match(/SteamWorkshopDownload/g).length, 1);
  assert.strictEqual(editKf2(server(), spec, { add: ['1'] }), 0);
});

test('editIniLines adds a missing section at the end', () => {
  assert.strictEqual(editIniLines('[A]\nx=1\n', 'B', 'k', { add: ['1', '2'] }), '[A]\nx=1\n\n[B]\nk=1\nk=2\n');
  assert.strictEqual(editIniLines('[A]\r\nk=1\r\n', 'A', 'k', { remove: ['1'] }), '[A]\r\n');
});

test('Avorion: workshopid entries in modconfig.lua, other settings untouched', () => {
  const s = server({ GALAXY_NAME: 'home' });
  const spec = { file: 'galaxy/{{GALAXY_NAME}}/modconfig.lua' };
  editAvorion(s, spec, { add: ['1819452708', '1751636748'] });
  const file = path.join(s.dir, 'galaxy/home/modconfig.lua');
  let lua = fs.readFileSync(file, 'utf8');
  assert.match(lua, /mods =\n\{\n    \{workshopid = "1819452708"\},\n    \{workshopid = "1751636748"\},\n\}/);
  fs.writeFileSync(file, lua.replace('forceEnabling = false', 'forceEnabling = true'));
  editAvorion(s, spec, { remove: ['1819452708'] });
  lua = fs.readFileSync(file, 'utf8');
  assert.ok(lua.includes('forceEnabling = true'));
  assert.ok(!lua.includes('1819452708'));
  assert.match(lua, /allowed =\n\{\n\}/);
});
