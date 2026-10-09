// Pure game engine. Mirrors programs/fomocity/src/lib.rs exactly:
// same params, same split, same dividend accumulator math. All amounts are
// integer base units of the game token (6 decimals), so JS math matches Rust u64.

export const DECIMALS = 6;
export const UNIT = 10 ** DECIMALS;
export const ACC_PRECISION = 1_000_000_000_000; // 1e12, scales per-floor dividend accumulator

// Basis points; must sum to 10_000.
export const SPLIT = {
  jackpot: 5_000,   // to the last buyer when the timer hits zero
  dividends: 3_500, // to everyone who already holds floors this round
  nextRound: 1_000, // seeds the next round's jackpot
  dev: 500,         // protocol fee
};

export const DEFAULT_PARAMS = {
  basePrice: 1 * UNIT,       // price of floor #1
  priceStep: UNIT / 100,     // each floor sold raises the next floor's price by 0.01
  timeAddPerFloor: 30,       // seconds added to the timer per floor bought
  maxTimer: 24 * 3600,       // timer can never exceed this from "now"
  initialTimer: 24 * 3600,   // timer length when a round opens
  maxFloorsPerBuy: 100,
};

const bp = (amount, bps) => Math.floor((amount * bps) / 10_000);

// Cost of buying n floors when `sold` floors already exist.
// Linear bonding curve: price(k) = base + step * k, summed for k = sold..sold+n-1.
export function costOf(params, sold, n) {
  return n * params.basePrice + params.priceStep * (n * sold + (n * (n - 1)) / 2);
}

export function priceOfNext(params, sold) {
  return params.basePrice + params.priceStep * sold;
}

export function newRound(id, now, params, seedJackpot = 0) {
  return {
    id,
    startTs: now,
    endTs: now + params.initialTimer,
    totalFloors: 0,
    jackpot: seedJackpot,
    nextRoundPot: 0,
    devFees: 0,
    accPerFloor: 0, // scaled by ACC_PRECISION
    lastBuyer: null,
    settled: false,
    winner: null,
    players: {}, // pubkey -> { floors, rewardDebt, claimed }
  };
}

export function isLive(round, now) {
  return !round.settled && now < round.endTs;
}

export function pendingDividends(round, who) {
  const p = round.players[who];
  if (!p) return 0;
  return Math.floor((p.floors * round.accPerFloor) / ACC_PRECISION) - p.rewardDebt;
}

// Returns a receipt describing exactly where the money went.
export function buy(round, params, who, n, now) {
  if (!isLive(round, now)) throw new Error('round is over');
  if (!Number.isInteger(n) || n < 1 || n > params.maxFloorsPerBuy) throw new Error('bad floor count');

  const cost = costOf(params, round.totalFloors, n);
  const toDividends = bp(cost, SPLIT.dividends);
  const toNext = bp(cost, SPLIT.nextRound);
  const toDev = bp(cost, SPLIT.dev);
  let toJackpot = cost - toDividends - toNext - toDev; // remainder avoids rounding dust

  // Dividends go to floors that existed *before* this buy. First buyer of a
  // round has nobody to pay, so that slice rolls into the jackpot.
  if (round.totalFloors > 0) {
    round.accPerFloor += Math.floor((toDividends * ACC_PRECISION) / round.totalFloors);
  } else {
    toJackpot += toDividends;
  }

  round.jackpot += toJackpot;
  round.nextRoundPot += toNext;
  round.devFees += toDev;

  const p = (round.players[who] ??= { floors: 0, rewardDebt: 0, claimed: 0 });
  p.floors += n;
  // New floors start with zero accrued dividends.
  p.rewardDebt += Math.floor((n * round.accPerFloor) / ACC_PRECISION);
  round.totalFloors += n;
  round.lastBuyer = who;
  round.endTs = Math.min(round.endTs + n * params.timeAddPerFloor, now + params.maxTimer);

  return { who, n, cost, toJackpot, toDividends, toNext, toDev, ts: now };
}

export function claim(round, who) {
  const amount = pendingDividends(round, who);
  const p = round.players[who];
  if (!p || amount <= 0) return 0;
  p.rewardDebt += amount;
  p.claimed += amount;
  return amount;
}

// Anyone can call once the timer is past zero. Returns the payout.
export function settle(round, now) {
  if (round.settled) throw new Error('already settled');
  if (now < round.endTs) throw new Error('timer still running');
  round.settled = true;
  round.winner = round.lastBuyer;
  // A round with no buyers carries its jackpot forward untouched.
  return { winner: round.winner, payout: round.winner ? round.jackpot : 0, carry: round.winner ? round.nextRoundPot : round.jackpot + round.nextRoundPot };
}

export const fmt = (base, dp = 2) =>
  (base / UNIT).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
