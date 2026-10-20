'use strict';

/**
 * uMod search against a fake uMod: the game filter is sent the way uMod reads it, and one
 * panel page of 24 is stitched from uMod's pages of 10. No network needed.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('../../server/features/mods/http');

const TOTAL = 57;
const plugins = Array.from({ length: TOTAL }, (_, i) => ({ name: `Plugin${i}`, title: `Plugin ${i}`, slug: `plugin-${i}` }));
const urls = [];
http.getJson = async (url) => {
  urls.push(url);
  const page = Number(new URL(url).searchParams.get('page'));
  return { total: TOTAL, per_page: 10, last_page: Math.ceil(TOTAL / 10), data: plugins.slice((page - 1) * 10, page * 10) };
};
const umod = require('../../server/features/mods/providers/umod');

test('uMod: filters by game with categories[] and fills a page of 24 from pages of 10', async () => {
  const first = await umod.search({ page: 0, limit: 24, ctx: { umodGame: 'rust' } });
  assert.strictEqual(first.total, TOTAL);
  assert.deepStrictEqual(first.items.map((p) => p.id), plugins.slice(0, 24).map((p) => p.name));
  assert.ok(urls.every((u) => new URL(u).searchParams.get('categories[]') === 'rust' && !new URL(u).searchParams.has('categories')));

  const second = await umod.search({ page: 1, limit: 24, ctx: { umodGame: 'rust' } });
  assert.deepStrictEqual(second.items.map((p) => p.id), plugins.slice(24, 48).map((p) => p.name));

  const last = await umod.search({ page: 2, limit: 24, ctx: { umodGame: 'rust' } });
  assert.deepStrictEqual(last.items.map((p) => p.id), plugins.slice(48).map((p) => p.name));
});
