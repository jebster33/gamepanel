'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ab3-data-'));
const { Store } = require('../../server/core/store');
const { Auth, isAccountRoute } = require('../../server/core/auth');
const settings = require('../../server/games/settings');
const { Nodes } = require('../../server/features/nodes');

test('account routes are recognised however the path is spelled', () => {
  for (const url of ['/api/auth/api-keys', '/api//auth/x', '/api///users/1', '/api/servers/s//access', '/api/servers/s/access/u']) assert.ok(isAccountRoute(url), url);
  for (const url of ['/api/servers', '/api/servers/s/files', '/api/authors']) assert.ok(!isAccountRoute(url), url);
});

test('a node keeps its key only for the address it was given for', () => {
  const store = new Store();
  store.state.settings.nodes = [{ id: 'n1', name: 'N', url: 'http://10.0.0.5:8080', key: 'gp_secret' }];
  const nodes = new Nodes({ store, manager: { broadcastServers() {} }, wss: {} });
  assert.throws(() => nodes.update('n1', { url: 'http://attacker.example:9' }), /needs the node's API key again/);
  assert.strictEqual(nodes.require('n1').url, 'http://10.0.0.5:8080');
  assert.doesNotThrow(() => nodes.update('n1', { url: 'http://attacker.example:9', key: 'gp_other' }));
  assert.doesNotThrow(() => nodes.update('n1', { name: 'Renamed' }));
});

test('level-name is a folder name, not a path to another server', () => {
  const server = { id: 's', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ab3-')), templateId: 'minecraft-paper', vars: {} };
  fs.writeFileSync(path.join(server.dir, 'server.properties'), 'level-name=world\nmotd=hi\n');
  const manager = {
    template: () => ({ id: 'minecraft-paper', variables: [], configFiles: [], patchProperties: [{ path: 'server.properties', format: 'properties' }] }),
  };
  let error = null;
  for (const bad of ['../other-server/world', 'a/b', 'a\\b', '..', 'C:evil']) {
    try {
      settings.writeGameSettings(manager, server, { 'level-name': bad }, { trusted: false });
    } catch (err) {
      error = err;
    }
    // Either the field check or the "no settings file" path stops it; never a write.
    assert.ok(!/level-name=.*(\.\.|\/|\\\\|C:)/.test(fs.readFileSync(path.join(server.dir, 'server.properties'), 'utf8')), bad);
  }
  assert.ok(error);
});
