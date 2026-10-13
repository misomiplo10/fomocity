// Pure game engine. Mirrors programs/fomocity/src/lib.rs exactly: same params, same
// countdown math, same buyback split. Token amounts are integer base units (6 decimals)
// and SOL amounts are lamports, so JS math matches the program's u64s.
//
// Playing = buying the game token anywhere. Each qualifying buy (at least
// `minBuyLamports` of SOL into the pool) adds time to the countdown; when it runs out, the
// last buyer is paid the whole jackpot automatically.

export const DECIMALS = 6;
export const UNIT = 10 ** DECIMALS;
export const LAMPORTS = 1_000_000_000;

export const DEFAULT_PARAMS = {
  minBuyLamports: 0.05 * LAMPORTS, // smallest buy that counts
  timeAddPerBuy: 30,               // seconds each counted buy adds
  maxTimer: 30 * 60,               // the countdown never shows more than this
  initialTimer: 30 * 60,           // countdown when a round opens
  settleGraceSecs: 60,             // wait after zero for late-reported buys
};

// Meteora fee flywheel: trading fees (SOL) are harvested by the treasury PDA and swapped
// for the game token. The output is split like this (jackpot takes the rounding dust).
export const BUYBACK_SPLIT = {
  jackpot: 7_000,
  nextRound: 2_000,
  burn: 1_000,
};

const bp = (amount, bps) => Math.floor((amount * bps) / 10_000);

export function newRound(id, now, params, seedJackpot = 0) {
  return {
    id,
    startTs: now,
    endTs: now + params.initialTimer,
    buyCount: 0,
    totalLamports: 0,
    jackpot: seedJackpot,
    nextRoundPot: 0,
    lastBuyer: null,
    lastBuyTs: 0,
    settled: false,
    winner: null,
    buyers: {}, // wallet -> lamports bought this round (for the towers)
  };
}

export function isLive(round, now) {
  return !round.settled && now < round.endTs;
}

// Mirrors record_buy. Returns false (and changes nothing) for buys that don't count.
export function recordBuy(round, params, wallet, lamports, ts) {
  if (round.settled || lamports < params.minBuyLamports) return false;
  if (ts < round.startTs || ts >= round.endTs || ts < round.lastBuyTs) return false;
  round.endTs = Math.min(round.endTs + params.timeAddPerBuy, ts + params.maxTimer);
  round.lastBuyer = wallet;
  round.lastBuyTs = ts;
  round.buyCount += 1;
  round.totalLamports += lamports;
  round.buyers[wallet] = (round.buyers[wallet] ?? 0) + lamports;
  return true;
}

export const canSettle = (round, params, now) => !round.settled && now >= round.endTs + params.settleGraceSecs;

// Mirrors settle: the last buyer is paid the jackpot; a round with no buys carries it over.
export function settle(round, params, now) {
  if (round.settled) throw new Error('already settled');
  if (!canSettle(round, params, now)) throw new Error('timer still running');
  round.settled = true;
  const hasWinner = round.buyCount > 0;
  round.winner = hasWinner ? round.lastBuyer : null;
  const payout = hasWinner ? round.jackpot : 0;
  const carry = hasWinner ? round.nextRoundPot : round.jackpot + round.nextRoundPot;
  if (!hasWinner) round.jackpot = 0;
  return { winner: round.winner, payout, carry };
}

// Mirrors split_buyback in lib.rs.
export function splitBuyback(out) {
  const toNext = bp(out, BUYBACK_SPLIT.nextRound);
  const burn = bp(out, BUYBACK_SPLIT.burn);
  return { toJackpot: out - toNext - burn, toNext, burn };
}

// Mirrors distribute_buyback in lib.rs: once the timer has run out, the winner is already
// decided, so the jackpot share goes to the next round instead.
export function fundFromBuyback(round, out, now) {
  let { toJackpot, toNext, burn } = splitBuyback(out);
  if (!isLive(round, now)) { toNext += toJackpot; toJackpot = 0; }
  round.jackpot += toJackpot;
  round.nextRoundPot += toNext;
  return { out, toJackpot, toNext, burn };
}

// Token amounts for display. Real launches deal in millions of tokens, so large values
// switch to compact notation (3.20M).
export const fmt = (base, dp = 2) => {
  const v = base / UNIT;
  if (Math.abs(v) >= 1e6) return v.toLocaleString(undefined, { notation: 'compact', minimumFractionDigits: dp, maximumFractionDigits: dp });
  return v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

export const fmtSol = (lamports, dp = 3) => `${(lamports / LAMPORTS).toFixed(dp)} SOL`;
