'use strict';

const test = require('node:test');
const assert = require('node:assert');
const updater = require('../../server/features/updater');

test('release channels: stable skips pre-releases and non-panel tags', async () => {
  updater.clearReleasesCache();
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

const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});

test('releases are cached, then revalidated with the ETag (a 304 is free against the rate limit)', async () => {
  updater.clearReleasesCache();
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(opts.headers['If-None-Match'] || null);
    return calls.length === 1 ? reply(200, [{ tag_name: 'v2.5.0', prerelease: false, draft: false }], { etag: '"abc"' }) : reply(304, null);
  };
  try {
    const t0 = 1_000_000;
    assert.strictEqual((await updater.fetchReleases(t0))[0].tag_name, 'v2.5.0');
    await updater.fetchReleases(t0 + 60_000); // inside the cache window: no request
    assert.deepStrictEqual(calls, [null]);
    assert.strictEqual((await updater.fetchReleases(t0 + 11 * 60_000))[0].tag_name, 'v2.5.0');
    assert.deepStrictEqual(calls, [null, '"abc"']);
  } finally {
    global.fetch = realFetch;
  }
});

test('rate limited: the last list is used, or the error says what happened', async () => {
  const realFetch = global.fetch;
  const limited = reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792193051' });
  try {
    updater.clearReleasesCache();
    global.fetch = async () => reply(200, [{ tag_name: 'v2.5.0', prerelease: false, draft: false }]);
    await updater.fetchReleases(0);
    global.fetch = async () => limited;
    assert.strictEqual((await updater.fetchReleases(20 * 60_000))[0].tag_name, 'v2.5.0');

    updater.clearReleasesCache();
    const result = await updater.checkForUpdate({ channel: 'stable' }).catch((err) => ({ error: err.message }));
    if (result.mode === 'release') assert.match(result.error, /limit of 60 checks an hour/);
    await assert.rejects(updater.fetchReleases(), /limit of 60 checks an hour for this address is used up/);
  } finally {
    global.fetch = realFetch;
  }
});
