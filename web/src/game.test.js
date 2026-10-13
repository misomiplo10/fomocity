// Shared vectors with programs/fomocity/src/lib.rs and scripts/rounds.test.ts. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from './game.js';

const P = { minBuyLamports: 50_000_000, timeAddPerBuy: 5, maxTimer: 15, initialTimer: 10, settleGraceSecs: 3 };

test('buyback split matches the program', () => {
  const s = (o) => Object.values(G.splitBuyback(o));
  assert.deepEqual(s(1_000_000), [700_000, 200_000, 100_000]);
  assert.deepEqual(s(12_345_679), [8_641_977, 2_469_135, 1_234_567]);
  assert.deepEqual(s(7), [6, 1, 0]);
  for (const o of [1, 9, 10_001, 999_999_999_999]) assert.equal(s(o).reduce((a, b) => a + b), o);
});

test('countdown math matches record_buy', () => {
  const r = G.newRound(1, 100, P);                      // ends at 110
  assert.ok(G.recordBuy(r, P, 'alice', 60_000_000, 101));
  assert.equal(r.endTs, Math.min(110 + 5, 101 + 15));   // 115
  assert.ok(G.recordBuy(r, P, 'bob', 50_000_000, 103));
  assert.equal(r.endTs, Math.min(115 + 5, 103 + 15));   // 118: capped
  assert.equal(r.lastBuyer, 'bob');
  assert.equal(r.buyCount, 2);
  assert.equal(r.totalLamports, 110_000_000);
});

test('buys that do not count change nothing', () => {
  const r = G.newRound(1, 100, P);
  assert.equal(G.recordBuy(r, P, 'small', 49_999_999, 101), false); // below minimum
  assert.equal(G.recordBuy(r, P, 'early', 60_000_000, 99), false);  // before the round
  assert.equal(G.recordBuy(r, P, 'late', 60_000_000, 110), false);  // at/after the deadline
  G.recordBuy(r, P, 'alice', 60_000_000, 105);
  assert.equal(G.recordBuy(r, P, 'old', 60_000_000, 104), false);   // out of order
  assert.equal(r.buyCount, 1);
  assert.equal(r.lastBuyer, 'alice');
});

test('settle pays the last buyer, or carries over with no buys', () => {
  const r = G.newRound(1, 100, P, 1_000);
  G.recordBuy(r, P, 'alice', 60_000_000, 101);
  G.fundFromBuyback(r, 1_000_000, 102);
  assert.throws(() => G.settle(r, P, r.endTs + 2), /timer still running/); // inside the grace period
  const res = G.settle(r, P, r.endTs + 3);
  assert.deepEqual(res, { winner: 'alice', payout: 1_000 + 700_000, carry: 200_000 });

  const empty = G.newRound(2, 200, P, 5_000);
  empty.nextRoundPot = 7;
  assert.deepEqual(G.settle(empty, P, empty.endTs + 3), { winner: null, payout: 0, carry: 5_007 });
});

test('buyback after the timer ran out seeds the next round only', () => {
  const r = G.newRound(1, 0, G.DEFAULT_PARAMS);
  G.fundFromBuyback(r, 1_000_000, 10);
  assert.equal(r.jackpot, 700_000);
  G.fundFromBuyback(r, 1_000_000, r.endTs);
  assert.equal(r.jackpot, 700_000);
  assert.equal(r.nextRoundPot, 200_000 + 900_000);
});
