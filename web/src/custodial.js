// Backend for the no-program setup: reads the game from the game server's public API
// (scripts/game-server.ts), same interface as sim.js and solana.js. Read-only.
//   GET /api/state   full state, polled
//   GET /api/events  live events (server-sent events)

export async function createCustodial(cfg) {
  const base = cfg.apiUrl.replace(/\/$/, '');
  const getState = async () => {
    const res = await fetch(`${base}/api/state`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`game server: HTTP ${res.status}`);
    return res.json();
  };

  const listeners = new Set();
  const emit = (e) => { for (const l of listeners) l(e); };

  let s = await getState();
  let clockOffset = s.now - Date.now() / 1000; // server (chain) time − local time
  const now = () => Date.now() / 1000 + clockOffset;

  const toWinners = (st) => st.winners.map((h) => ({ round: h.round, wallet: h.winner, amount: h.payout, ts: h.endedAt, sig: h.payoutSig }));
  const toMarket = (m) => ({
    phase: m.phase ?? 'curve', raisedSol: m.raisedSol ?? 0, thresholdSol: m.thresholdSol ?? 0, price: m.price ?? 0,
    feeBps: m.feeBps ?? 0, unclaimedSol: 0, wsolSol: m.pendingSol ?? 0, boughtTokens: m.boughtTokens ?? 0,
    burnedTokens: m.burnedTokens ?? 0, volumeSol: 0,
  });

  let round = { ...s.round, buyers: {} };
  let winners = toWinners(s);
  const market = toMarket(s.market ?? {});

  // Rebuild this round's towers from the recent buys, oldest first.
  const seenBuys = new Set();
  function addBuy(roundId, wallet, lamports, sig, total) {
    if (roundId !== round.id || seenBuys.has(sig)) return;
    seenBuys.add(sig);
    round.buyers[wallet] = total ?? (round.buyers[wallet] ?? 0) + lamports;
    emit({ type: 'buy', who: wallet, lamports, total: round.buyers[wallet] });
  }
  for (const b of [...s.recent].reverse()) addBuy(b.round, b.wallet, b.lamports, b.sig);
  // Prefer the server's exact per-wallet totals.
  round.buyers = { ...s.round.buyers };

  const settledSeen = new Set();
  function announceSettled(id) {
    if (settledSeen.has(id)) return;
    settledSeen.add(id);
    const w = winners.find((x) => x.round === id);
    emit({ type: 'settled', round: id, winner: w?.wallet ?? null, payout: w?.amount ?? 0 });
  }

  async function refresh() {
    const prevId = round.id;
    s = await getState();
    clockOffset = s.now - Date.now() / 1000;
    winners = toWinners(s);
    Object.assign(market, toMarket(s.market ?? {}));
    if (s.round.id !== prevId) {
      announceSettled(prevId);
      seenBuys.clear();
      round = { ...s.round, buyers: { ...s.round.buyers } };
      emit({ type: 'round', round: round.id });
    } else {
      const buyers = round.buyers;
      round = { ...s.round, buyers };
      for (const b of [...s.recent].reverse()) addBuy(b.round, b.wallet, b.lamports, b.sig, s.round.buyers[b.wallet]);
    }
  }

  // Live events; polling below catches anything missed.
  try {
    const es = new EventSource(`${base}/api/events`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'buy') addBuy(e.round, e.who, e.lamports, e.sig, e.total);
      else if (e.type === 'buyback' || e.type === 'funded') { emit(e); refresh().catch(() => {}); }
      else if (e.type === 'settled' || e.type === 'paid') refresh().catch(() => {});
    };
  } catch {}
  setInterval(() => refresh().catch((e) => console.warn('[fomocity]', e?.message ?? e)), 3_000);

  return {
    mode: cfg.cluster ?? 'mainnet',
    custodial: true,
    mint: s.mint,
    jackpotWallet: s.jackpotWallet,
    params: s.params,
    marketInfo: { external: true, custodial: true, thresholdSol: market.thresholdSol, sniperFeeBps: null, baseFeeBps: null, keeperMaxFeeBps: 200 },
    get round() { return round; },
    get winners() { return winners; },
    get market() { return market; },
    now,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
