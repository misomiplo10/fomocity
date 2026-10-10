// Shared vectors with programs/fomocity/src/lib.rs tests. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from './game.js';

test('floor cost matches the program', () => {
  const p = G.DEFAULT_PARAMS;
  assert.equal(G.costOf(p, 0, 20), 21_900_000);
  assert.equal(G.costOf(p, 20, 6), 7_350_000);
});

test('buyback split matches the program', () => {
  const s = (o) => Object.values(G.splitBuyback(o));
  assert.deepEqual(s(1_000_000), [700_000, 200_000, 100_000]);
  assert.deepEqual(s(12_345_679), [8_641_977, 2_469_135, 1_234_567]);
  assert.deepEqual(s(7), [6, 1, 0]);
  for (const o of [1, 9, 10_001, 999_999_999_999]) assert.equal(s(o).reduce((a, b) => a + b), o);
});

test('buyback after the timer ran out seeds the next round only', () => {
  const r = G.newRound(1, 0, G.DEFAULT_PARAMS);
  G.fundFromBuyback(r, 1_000_000, 10);
  assert.equal(r.jackpot, 700_000);
  G.fundFromBuyback(r, 1_000_000, r.endTs);
  assert.equal(r.jackpot, 700_000);
  assert.equal(r.nextRoundPot, 200_000 + 900_000);
});

test('dividends match the program (same vectors as scripts/rounds.test.ts)', () => {
  const p = G.DEFAULT_PARAMS;
  const r = G.newRound(1, 0, p);
  G.buy(r, p, 'alice', 4, 1);
  G.buy(r, p, 'bob', 2, 1);
  const c2 = G.costOf(p, 4, 2);
  const div2 = Math.floor((c2 * 3_500) / 10_000);
  assert.equal(r.accPerFloor, (BigInt(div2) * 1_000_000_000_000n) / 4n);
  assert.equal(G.pendingDividends(r, 'alice'), Math.floor(div2 / 4) * 4);
  assert.equal(G.pendingDividends(r, 'bob'), 0);
  assert.equal(G.claim(r, 'alice'), Math.floor(div2 / 4) * 4);
  assert.equal(G.pendingDividends(r, 'alice'), 0);
});
