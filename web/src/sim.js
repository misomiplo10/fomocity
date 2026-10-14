// Local simulator backend: same interface as the Solana backend (solana.js).
// Bots trade the token on a simulated Meteora market. Every bot buy of at least the
// minimum counts as a game move (exactly like a real Jupiter/Meteora buy reported by the
// keeper): it adds time to the countdown and makes that bot the last buyer. Trading comes
// in waves, so calm spells let rounds end, and snipers pile in near zero. Every trade pays a
// flat 3% fee; the game's share is claimed and split 80% jackpot (SOL), 20% team.
import * as G from './game.js';

const BOT_NAMES = [
  'degen.sol', 'moonboi', 'whale_42', 'paperhands', 'gm_anon', 'rugsurvivor', 'ape.sol', 'chadwick',
  'lp_larry', 'sniper_sue', 'bagholder', 'wagmi', 'ngmi', 'satoshi_jr', 'dlmm_dan', 'fomo_fran',
];

// Sim-scale version of scripts/lib.ts DEFAULT_LAUNCH: smaller threshold so the curve
// completes within a session, same fee shape.
export const MARKET = {
  thresholdSol: 20,          // curve completes here, then migrates to DAMM v2
  startPrice: 0.0004,        // SOL per token at launch
  endPrice: 0.004,           // SOL per token when the curve completes
  feeBps: 300,               // flat 3% trading fee, before and after graduation
  gameShareBps: 8_000,       // Meteora keeps 20% of each fee; the game is owed the rest
  harvestEverySecs: 8,
  migrationSecs: 5,
  seedSol: 0.5,              // sim only: round 1 starts with a seeded jackpot
};

export function createSim() {
  // Short timers so a round plays out in a couple of minutes instead of half an hour.
  const params = { ...G.DEFAULT_PARAMS, initialTimer: 90, maxTimer: 90, timeAddPerBuy: 10, settleGraceSecs: 3 };
  const listeners = new Set();
  const history = [];
  const winners = []; // newest first: { round, wallet, amount, ts }
  let roundId = 1;
  let round = G.newRound(roundId, now(), params, Math.round(MARKET.seedSol * G.LAMPORTS));

  const launchTs = now();
  const market = {
    phase: 'curve',         // 'curve' → 'migrating' → 'damm'
    raisedSol: 0,
    price: MARKET.startPrice,
    feeBps: MARKET.feeBps,
    unclaimedSol: 0,        // fees owed to the game, still in the Meteora pool
    collectedSol: 0,        // fees claimed so far
    toJackpotSol: 0,        // 80% of them
    toTeamSol: 0,           // 20% of them
    volumeSol: 0,
    migratedAt: 0,
    lastHarvest: launchTs,
  };

  function now() { return Date.now() / 1000; }
  const emit = (e) => { for (const l of listeners) l(e); };

  function feeBpsAt() {
    return MARKET.feeBps;
  }

  function curvePrice() {
    // Price rises with SOL raised (quadratic-ish, like a constant-product segment).
    const f = Math.min(1, market.raisedSol / MARKET.thresholdSol);
    const s = Math.sqrt(MARKET.startPrice) + (Math.sqrt(MARKET.endPrice) - Math.sqrt(MARKET.startPrice)) * f;
    return s * s;
  }

  function trade(sol, t, who = null) {
    if (market.phase === 'migrating') return; // pool closed while liquidity moves
    // A buy is a game move if it's big enough (sellers pass no `who`).
    if (who && sol > 0 && G.recordBuy(round, params, who, Math.round(sol * G.LAMPORTS), t)) {
      emit({ type: 'buy', who, lamports: Math.round(sol * G.LAMPORTS), total: round.buyers[who] });
    }
    const fee = Math.abs(sol) * market.feeBps / 10_000;
    market.unclaimedSol += fee * MARKET.gameShareBps / 10_000;
    market.volumeSol += Math.abs(sol);
    if (market.phase === 'curve') {
      market.raisedSol = Math.max(0, market.raisedSol + sol - (sol > 0 ? fee : 0));
      market.price = curvePrice();
      if (market.raisedSol >= MARKET.thresholdSol) {
        market.phase = 'migrating';
        market.migratedAt = t;
        emit({ type: 'curveComplete', raisedSol: market.raisedSol });
      }
    } else {
      // After migration the price random-walks with order flow.
      market.price *= 1 + Math.sign(sol) * Math.min(0.03, Math.abs(sol) / 400);
    }
  }

  function keeper(t) {
    if (market.phase === 'migrating' && t - market.migratedAt >= MARKET.migrationSecs) {
      market.phase = 'damm';
      emit({ type: 'migrated', price: market.price });
    }
    // Claim the game's fees: 80% to the jackpot (in SOL), 20% to the team.
    if (t - market.lastHarvest >= MARKET.harvestEverySecs && market.unclaimedSol > 0.0005) {
      const lamports = Math.round(market.unclaimedSol * G.LAMPORTS);
      market.unclaimedSol = 0;
      market.lastHarvest = t;
      const r = G.fundFromFees(round, lamports, t);
      market.collectedSol += lamports / G.LAMPORTS;
      market.toJackpotSol += r.toJackpot / G.LAMPORTS;
      market.toTeamSol += r.toTeam / G.LAMPORTS;
      emit({ type: 'fees', ...r });
    }
  }

  function tick() {
    const t = now();
    market.feeBps = feeBpsAt();

    if (G.canSettle(round, params, t)) {
      const res = G.settle(round, params, t);
      history.unshift({ id: round.id, winner: res.winner, payout: res.payout, buys: round.buyCount });
      if (res.winner) winners.unshift({ round: round.id, wallet: res.winner, amount: res.payout, ts: t });
      if (winners.length > 10) winners.pop();
      emit({ type: 'settled', round: round.id, ...res });
      round = G.newRound(++roundId, t, params, res.carry);
      emit({ type: 'round', round: round.id });
    }

    // Trading comes in waves (about 2.5 minutes per cycle): busy spells keep the clock
    // topped up, calm spells let it run out. Snipers pile in during the last seconds.
    const heat = 0.5 + 0.5 * Math.cos(((t - launchTs) / 150) * 2 * Math.PI); // starts busy
    const left = round.endTs - t;
    const pBuy = 0.012 + 0.09 * heat ** 3 + (left > 0 && left < 8 ? 0.04 : 0);
    if (Math.random() < pBuy) {
      const who = BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0];
      const whale = Math.random() < 0.06;
      trade(whale ? 0.5 + Math.random() * 1.5 : 0.02 + Math.random() ** 2 * 0.35, t, who);
    }
    // Sellers (never game moves).
    if (Math.random() < (market.phase === 'curve' ? 0.02 : 0.05)) trade(-(0.02 + Math.random() ** 2 * 0.3), t);
    keeper(t);
  }
  setInterval(tick, 250);

  return {
    mode: 'sim',
    params,
    get round() { return round; },
    get history() { return history; },
    get winners() { return winners; },
    get market() { return market; },
    now,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
