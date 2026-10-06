'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dns = require('../../server/features/dns');

test('Cloudflare: A + SRV records for Minecraft, removed again on release', async () => {
  const calls = [];
  const realFetch = global.fetch;
  let next = 1;
  global.fetch = async (url, opts = {}) => {
    calls.push([opts.method || 'GET', String(url).replace('https://api.cloudflare.com/client/v4', ''), opts.body ? JSON.parse(opts.body) : null]);
    const result = String(url).includes('/zones?name=') ? [{ id: 'z1' }] : opts.method === 'POST' ? { id: `r${next++}` } : opts.method === 'GET' ? [] : {};
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  try {
    const store = { state: { settings: { integrations: { cloudflare: { token: 't', domain: 'example.com' } } } }, save() {} };
    const server = { name: 'SMP', templateId: 'minecraft-paper', ports: { game: 25599 } };
    const sub = await dns.assign(store, server, 'Play', { ip: '203.0.113.7' });
    assert.strictEqual(sub.host, 'play.example.com');
    assert.strictEqual(dns.playerAddress(server), 'play.example.com');
    const posts = calls.filter((c) => c[0] === 'POST').map((c) => c[2]);
    assert.deepStrictEqual(posts.map((p) => p.type), ['A', 'SRV']);
    assert.deepStrictEqual(posts[1].data, { priority: 0, weight: 5, port: 25599, target: 'play.example.com' });
    await dns.release(store, server);
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'DELETE').map((c) => c[1]), ['/zones/z1/dns_records/r1', '/zones/z1/dns_records/r2']);
    assert.strictEqual(server.subdomain, undefined);
    await assert.rejects(dns.assign(store, server, 'bad name!'), /letters, numbers/);
  } finally {
    global.fetch = realFetch;
  }
});

test('server list: links must be http(s), join links only for games that have them', () => {
  const page = require('../../server/features/status-page');
  const store = { state: { settings: {} }, save: () => {} };
  assert.throws(() => page.update(store, { links: { vote: 'javascript:alert(1)' } }), /must start with https/);
  const s = page.update(store, { links: { discord: 'https://discord.gg/x' }, blurbs: { a: ' Semi-vanilla\nno resets ', b: '' } });
  assert.strictEqual(s.links.discord, 'https://discord.gg/x');
  assert.deepStrictEqual(s.blurbs, { a: 'Semi-vanilla no resets' });
  assert.strictEqual(page.joinUrl({ templateId: 'rust' }, 'play.example.com:28015'), 'steam://connect/play.example.com:28015');
  assert.strictEqual(page.joinUrl({ templateId: 'valheim' }, 'play.example.com:2456'), null);
});
