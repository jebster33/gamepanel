'use strict';

/** Setup-code bypass behind a local proxy, proxy hop counting, download filename header. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-round5-'));

const { config } = require('../../server/core/config');
const { Store } = require('../../server/core/store');
const { Auth } = require('../../server/core/auth');
const { clientIp } = require('../../server/api/helpers');

const auth = new Auth(new Store(config.stateFile), 'x'.repeat(48));
const req = (headers = {}, addr = '127.0.0.1') => ({ headers, socket: { remoteAddress: addr } });

test('setup code is skipped only for a loopback request with no sign of a proxy', () => {
  assert.doesNotThrow(() => auth.checkSetupCode(req(), ''));
  for (const h of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'x-forwarded-host']) {
    assert.throws(() => auth.checkSetupCode(req({ [h]: '203.0.113.9' }), ''), (e) => e.code === 403, h);
  }
  assert.throws(() => auth.checkSetupCode(req({}, '203.0.113.9'), ''), (e) => e.code === 403);
  assert.doesNotThrow(() => auth.checkSetupCode(req({}, '203.0.113.9'), auth.setupCode()));
});

test('setup code is asked for when GP_BEHIND_PROXY is on, even without forwarding headers', () => {
  config.behindProxy = true;
  try {
    assert.throws(() => auth.checkSetupCode(req(), ''), (e) => e.code === 403);
  } finally {
    config.behindProxy = false;
  }
});

test('clientIp counts configured proxy hops from the right', () => {
  config.behindProxy = true;
  try {
    const headers = { 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 172.70.0.1' };
    config.proxyHops = 1;
    assert.strictEqual(clientIp(req(headers)), '172.70.0.1');
    config.proxyHops = 2;
    assert.strictEqual(clientIp(req(headers)), '198.51.100.7');
    config.proxyHops = 9;
    assert.strictEqual(clientIp(req(headers)), '6.6.6.6');
  } finally {
    config.behindProxy = false;
    config.proxyHops = 1;
  }
});

test('download Content-Disposition is valid for any file name', () => {
  const http = require('http');
  const header = (name) => {
    const res = new http.ServerResponse({ method: 'GET' });
    const value = `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
    res.setHeader('Content-Disposition', value);
    return value;
  };
  for (const name of ['世界.txt', 'a\r\nSet-Cookie: x=1', 'it\'s "x".zip']) assert.doesNotThrow(() => header(name));
  assert.match(header('世界.txt'), /filename\*=UTF-8''%E4%B8%96%E7%95%8C\.txt$/);
});
