'use strict';

const test = require('node:test');
const assert = require('node:assert');
const updater = require('../../server/features/updater');

test('release channels: stable skips pre-releases and non-panel tags', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { tag_name: 'bridge-v1.0.0', prerelease: false, draft: false },
      { tag_name: 'v2.3.0-beta.1', prerelease: true, draft: false },
      { tag_name: 'v2.2.0', prerelease: false, draft: false },
      { tag_name: 'v2.10.0', prerelease: false, draft: true },
      { tag_name: 'v2.1.0', prerelease: false, draft: false },
    ],
  });
  try {
    assert.strictEqual((await updater.latestRelease('stable')).tag_name, 'v2.2.0');
    assert.strictEqual((await updater.latestRelease('beta')).tag_name, 'v2.3.0-beta.1');
  } finally {
    global.fetch = realFetch;
  }
  assert.ok(updater.newer('2.10.0', '2.9.1'));
  assert.ok(!updater.newer('2.2.0', '2.2.0'));
  assert.strictEqual(updater.channelOf('stable'), 'stable');
});
