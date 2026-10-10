// Local simulator backend: same interface the Solana backend will expose.
// Bots buy floors at random and get more aggressive as the timer runs low (snipers).
// A simulated Meteora market runs alongside: bots trade the token on the bonding curve,
// 80% of every trading fee goes to the treasury, and a keeper harvests and buys back.
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
  sniperFeeBps: 5_000,       // anti-sniper fee at launch...
  baseFeeBps: 100,           // ...decaying exponentially to this
  sniperWindowSecs: 60,
  dammFeeBps: 100,           // migrated pool fee (FixedBps100)
  treasuryShareBps: 8_000,   // protocol keeps 20%
  harvestEverySecs: 8,
  buybackGapSecs: 12,
  maxBuybackSol: 0.25,
  keeperMaxFeeBps: 200,      // keeper waits out the sniper window
  migrationSecs: 5,
};

export function createSim({ you = 'you', startBalance = 1_000 * G.UNIT } = {}) {
  // Short timers so a round plays out in a few minutes instead of a day.
  const params = { ...G.DEFAULT_PARAMS, initialTimer: 120, maxTimer: 180, timeAddPerFloor: 8 };
  const listeners = new Set();
  const history = [];
  let roundId = 1;
  let round = G.newRound(roundId, now(), params);
  const balances = { [you]: startBalance };
  let devTotal = 0;

  const launchTs = now();
  const market = {
    phase: 'curve',         // 'curve' → 'migrating' → 'damm'
    raisedSol: 0,
    price: MARKET.startPrice,
    feeBps: MARKET.sniperFeeBps,
    unclaimedSol: 0,        // treasury fees still sitting in the Meteora pool
    wsolSol: 0,             // harvested, waiting for a buyback
    harvestedSol: 0,
    spentSol: 0,
    boughtTokens: 0,
    burnedTokens: 0,
    volumeSol: 0,
    migratedAt: 0,
    lastHarvest: launchTs,
    lastBuyback: 0,
  };

  function now() { return Date.now() / 1000; }
  const emit = (e) => { for (const l of listeners) l(e); };

  function feeBpsAt(t) {
    if (market.phase !== 'curve') return MARKET.dammFeeBps;
    // Exponential decay from the sniper fee to the base fee over the window.
    const k = Math.min(1, (t - launchTs) / MARKET.sniperWindowSecs);
    return Math.round(MARKET.sniperFeeBps * Math.pow(MARKET.baseFeeBps / MARKET.sniperFeeBps, k));
  }

  function curvePrice() {
    // Price rises with SOL raised (quadratic-ish, like a constant-product segment).
    const f = Math.min(1, market.raisedSol / MARKET.thresholdSol);
    const s = Math.sqrt(MARKET.startPrice) + (Math.sqrt(MARKET.endPrice) - Math.sqrt(MARKET.startPrice)) * f;
    return s * s;
  }

  function trade(sol, t) {
    if (market.phase === 'migrating') return; // pool closed while liquidity moves
    const fee = Math.abs(sol) * market.feeBps / 10_000;
    market.unclaimedSol += fee * MARKET.treasuryShareBps / 10_000;
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
    if (t - market.lastHarvest >= MARKET.harvestEverySecs && market.unclaimedSol > 0.0005) {
      const sol = market.unclaimedSol;
      market.unclaimedSol = 0;
      market.wsolSol += sol;
      market.harvestedSol += sol;
      market.lastHarvest = t;
      emit({ type: 'harvest', sol, venue: market.phase === 'damm' ? 'DAMM v2' : 'DBC' });
    }
    const cooled = t - market.lastBuyback >= MARKET.buybackGapSecs;
    if (cooled && market.phase !== 'migrating' && market.wsolSol > 0.002 && market.feeBps <= MARKET.keeperMaxFeeBps) {
      const sol = Math.min(market.wsolSol, MARKET.maxBuybackSol);
      const tokens = Math.floor((sol * (1 - market.feeBps / 10_000) / market.price) * G.UNIT);
      market.wsolSol -= sol;
      trade(sol, t); // the buyback is a real swap: it pays fees and moves the price too
      const r = G.fundFromBuyback(round, tokens, t);
      market.spentSol += sol;
      market.boughtTokens += r.out;
      market.burnedTokens += r.burn;
      market.lastBuyback = t;
      emit({ type: 'buyback', sol, ...r });
    }
  }

  function doBuy(who, n) {
    const cost = G.costOf(params, round.totalFloors, n);
    if ((balances[who] ?? Infinity) < cost) throw new Error('insufficient balance');
    const r = G.buy(round, params, who, n, now());
    if (who in balances) balances[who] -= cost;
    emit({ type: 'buy', ...r, totalFloors: round.totalFloors, floors: round.players[who].floors });
    return r;
  }

  function tick() {
    const t = now();
    market.feeBps = feeBpsAt(t);
    // Market bots: mostly buys while the curve is filling, two-way flow after.
    if (Math.random() < 0.12) {
      const size = 0.02 + Math.random() ** 2 * 0.4;
      const sellBias = market.phase === 'curve' ? 0.25 : 0.48;
      trade(Math.random() < sellBias ? -size : size, t);
    }
    keeper(t);

    if (t >= round.endTs) {
      const res = G.settle(round, t);
      if (res.winner && res.winner in balances) balances[res.winner] += res.payout;
      devTotal += round.devFees;
      history.unshift({ id: round.id, winner: res.winner, payout: res.payout, floors: round.totalFloors });
      emit({ type: 'settled', round: round.id, ...res });
      // Unclaimed dividends from the old round are auto-credited to the player in the sim.
      const pend = G.pendingDividends(round, you);
      if (pend > 0) { G.claim(round, you); balances[you] += pend; }
      round = G.newRound(++roundId, t + 6, params, res.carry); // 6s intermission
      round.endTs = t + 6 + params.initialTimer;
      emit({ type: 'round', round: round.id });
      return;
    }
    if (t < round.startTs) return;
    const left = round.endTs - t;
    // Buy probability per tick (4 Hz): slow mid-round, frantic in the last 15s.
    const p = left < 15 ? 0.09 : left < 40 ? 0.05 : 0.025;
    if (Math.random() < p) {
      const who = BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0];
      const whale = Math.random() < 0.08;
      const n = whale ? 10 + ((Math.random() * 40) | 0) : 1 + ((Math.random() ** 3 * 8) | 0);
      try { doBuy(who, n); } catch {}
    }
  }
  setInterval(tick, 250);

  return {
    mode: 'sim',
    you,
    params,
    get round() { return round; },
    get history() { return history; },
    get market() { return market; },
    now,
    balance: () => balances[you],
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async buy(n) { return doBuy(you, n); },
    async claim() {
      const amt = G.claim(round, you);
      balances[you] += amt;
      emit({ type: 'claim', who: you, amount: amt });
      return amt;
    },
  };
}
