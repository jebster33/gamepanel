'use strict';

const test = require('node:test');
const assert = require('node:assert');
const totp = require('../../server/core/totp');
const { setPlayers } = require('../../server/games/players');

// RFC 6238 appendix B (SHA-1), last six digits.
const SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));

test('TOTP matches the RFC 6238 test vectors', () => {
  assert.strictEqual(SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.strictEqual(totp.hotp(SECRET, Math.floor(59 / 30)), '287082');
  assert.strictEqual(totp.hotp(SECRET, Math.floor(1111111109 / 30)), '081804');
  assert.strictEqual(totp.hotp(SECRET, Math.floor(2000000000 / 30)), '279037');
});

test('TOTP accepts one step of drift and refuses a replay', () => {
  const now = 1111111109 * 1000;
  const step = totp.verify(SECRET, '081804', { now });
  assert.strictEqual(step, Math.floor(1111111109 / 30));
  assert.strictEqual(totp.verify(SECRET, '081804', { now: now + 30_000 }), step);
  assert.strictEqual(totp.verify(SECRET, '081804', { now, lastStep: step }), -1);
  assert.strictEqual(totp.verify(SECRET, '000000', { now }), -1);
});

test('player list keeps join times across updates', () => {
  const rt = {};
  setPlayers(rt, ['Steve']);
  const since = rt.playerInfo.get('Steve').since;
  setPlayers(rt, ['Steve', 'Alex']);
  assert.deepStrictEqual(rt.playerList, ['Steve', 'Alex']);
  assert.strictEqual(rt.playerInfo.get('Steve').since, since);
  setPlayers(rt, [{ name: 'Alex', score: 3, time: 60 }]);
  assert.deepStrictEqual(rt.playerList, ['Alex']);
  assert.strictEqual(rt.playerInfo.get('Alex').score, 3);
});
