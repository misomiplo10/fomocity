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
