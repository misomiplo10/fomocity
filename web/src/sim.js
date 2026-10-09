// Local simulator backend: same interface the Solana backend will expose.
// Bots buy at random, and get more aggressive as the timer runs low (snipers).
import * as G from './game.js';

const BOT_NAMES = [
  'degen.sol', 'moonboi', 'whale_42', 'paperhands', 'gm_anon', 'rugsurvivor', 'ape.sol', 'chadwick',
  'lp_larry', 'sniper_sue', 'bagholder', 'wagmi', 'ngmi', 'satoshi_jr', 'dlmm_dan', 'fomo_fran',
];

export function createSim({ you = 'you', startBalance = 1_000 * G.UNIT } = {}) {
  // Short timers so a round plays out in a few minutes instead of a day.
  const params = { ...G.DEFAULT_PARAMS, initialTimer: 120, maxTimer: 180, timeAddPerFloor: 8 };
  const listeners = new Set();
  const history = [];
  let roundId = 1;
  let round = G.newRound(roundId, now(), params);
  const balances = { [you]: startBalance };
  let devTotal = 0;

  function now() { return Date.now() / 1000; }
  const emit = (e) => { for (const l of listeners) l(e); };

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
