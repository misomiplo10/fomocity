// Solana backend: same interface as sim.js, read-only. It watches the fomocity program and
// the token's Meteora pool; it never sends transactions and needs no wallet. Players play
// by buying the token anywhere; the keeper records those buys on-chain and settling pays
// the winner, so the site only has to show what happened.
//
// State is polled (so it can't drift) and program logs are followed (so buys and payouts
// show up within a second or two).
import './polyfill.js';
import { AnchorProvider, BorshCoder, EventParser, Program } from '@coral-xyz/anchor';
import { CpAmm, SwapMode as DammSwapMode, getPriceFromSqrtPrice as dammPrice } from '@meteora-ag/cp-amm-sdk';
import {
  DynamicBondingCurveClient, SwapMode, getCurrentPoint, getPriceFromSqrtPrice as dbcPrice,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import IDL from '../../idls/fomocity.json';

const PROGRAM_ID = new PublicKey(IDL.address);
const DEFAULT_KEY = PublicKey.default.toBase58();
const POLL_MS = 2_000;
const MARKET_POLL_MS = 5_000;

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const num = (bn) => Number(bn.toString());

export async function createChain(cfg) {
  // VITE_RPC_URL=/api/rpc goes through the site's own relay (api/rpc.js), which keeps the
  // Helius key private. The relay is plain HTTP, so live log streaming is off and the
  // regular polling below carries everything.
  const relayed = cfg.rpcUrl.startsWith('/');
  const connection = new Connection(relayed ? new URL(cfg.rpcUrl, location.origin).href : cfg.rpcUrl, 'confirmed');
  const mint = new PublicKey(cfg.mint);
  const game = pda([Buffer.from('game'), mint.toBuffer()]);
  const roundKey = (id) => pda([Buffer.from('round'), game.toBuffer(), u64le(id)]);
  const feeAddress = pda([Buffer.from('treasury')]); // the game's fee address (treasury PDA)

  // Read-only: a throwaway key satisfies Anchor's provider; nothing is ever signed.
  const ro = Keypair.generate();
  const wallet = { publicKey: ro.publicKey, signTransaction: async (t) => t, signAllTransactions: async (t) => t };
  const program = new Program(IDL, new AnchorProvider(connection, wallet, { commitment: 'confirmed' }));

  // No game for this mint (program not deployed yet, or a leftover VITE_MINT from an earlier
  // launch): return null so the site shows the simulation and "Launching soon" instead.
  // A closed program keeps its program account, so check its ProgramData account too (the
  // program account's data is a 4-byte tag followed by the ProgramData address).
  const [progInfo, gameInfo] = await connection.getMultipleAccountsInfo([PROGRAM_ID, game]);
  const programData = progInfo?.data?.length >= 36 ? new PublicKey(progInfo.data.subarray(4, 36)) : null;
  const deployed = programData && (await connection.getAccountInfo(programData));
  if (!deployed || !gameInfo) {
    console.warn('[fomocity] no live game for', cfg.mint, '- showing the simulation');
    return null;
  }
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const cp = new CpAmm(connection);

  const listeners = new Set();
  const emit = (e) => { for (const l of listeners) l(e); };

  // ---------- game state ----------

  let gameData = await program.account.game.fetch(game);
  const params = {
    minBuyLamports: num(gameData.params.minBuyLamports),
    timeAddPerBuy: num(gameData.params.timeAddPerBuy),
    maxTimer: num(gameData.params.maxTimer),
    initialTimer: num(gameData.params.initialTimer),
    settleGraceSecs: num(gameData.params.settleGraceSecs),
  };
  const dbcConfig = await dbc.state.getPoolConfig(gameData.dbcConfig);

  let clockOffset = 0; // chain time − local time
  async function syncClock() {
    const t = await connection.getBlockTime(await connection.getSlot('confirmed'));
    if (t) clockOffset = t - Date.now() / 1000;
  }
  const now = () => Date.now() / 1000 + clockOffset;

  // Same shape as game.js rounds, so the UI and plaza don't care which backend runs.
  const toRound = (r, buyers) => ({
    id: num(r.id),
    startTs: num(r.startTs),
    endTs: num(r.endTs),
    buyCount: r.buyCount,
    totalLamports: num(r.totalLamports),
    jackpot: num(r.jackpot),
    nextRoundPot: num(r.nextRoundPot),
    lastBuyer: r.lastBuyer.toBase58() === DEFAULT_KEY ? null : r.lastBuyer.toBase58(),
    lastBuyTs: num(r.lastBuyTs),
    settled: r.settled,
    winner: null,
    buyers,
  });

  const winnersOf = (g) => g.winners
    .filter((w) => w.wallet.toBase58() !== DEFAULT_KEY)
    .map((w) => ({ round: num(w.round), wallet: w.wallet.toBase58(), amount: num(w.amount), ts: num(w.ts) }))
    .sort((a, b) => b.round - a.round);
  let winners = winnersOf(gameData);

  let round = toRound(await program.account.round.fetch(roundKey(gameData.currentRound)), {});
  // Each counted buy, keyed so the event stream and the on-chain recent-buys list dedupe.
  const seenBuys = new Set();
  const buyKey = (wallet, lamports, ts) => `${ts}:${wallet}:${lamports}`;
  function addBuy(roundId, wallet, lamports, ts) {
    const k = buyKey(wallet, lamports, ts);
    if (roundId !== round.id || seenBuys.has(k)) return;
    seenBuys.add(k);
    round.buyers[wallet] = (round.buyers[wallet] ?? 0) + lamports;
    emit({ type: 'buy', who: wallet, lamports, total: round.buyers[wallet], ts });
  }
  // The program keeps the latest 16 counted buys; replay this round's, oldest first.
  function mergeRecent(g) {
    const recent = g.recent
      .filter((b) => b.wallet.toBase58() !== DEFAULT_KEY)
      .map((b) => ({ round: num(b.round), wallet: b.wallet.toBase58(), lamports: num(b.lamports), ts: num(b.ts) }))
      .sort((a, b) => a.ts - b.ts);
    for (const b of recent) addBuy(b.round, b.wallet, b.lamports, b.ts);
  }

  const settledSeen = new Set();
  function emitSettled(id, buyCount) {
    if (settledSeen.has(id)) return;
    settledSeen.add(id);
    const w = winners.find((x) => x.round === id);
    emit({ type: 'settled', round: id, winner: w?.wallet ?? null, payout: w?.amount ?? 0, buys: buyCount });
  }

  async function refreshRound() {
    const prev = round;
    gameData = await program.account.game.fetch(game);
    winners = winnersOf(gameData);
    const id = num(gameData.currentRound);
    if (id !== prev.id) {
      // A settle happened since the last poll: announce the winner, start fresh.
      emitSettled(prev.id, prev.buyCount);
      seenBuys.clear();
      round = toRound(await program.account.round.fetch(roundKey(id)), {});
      emit({ type: 'round', round: id });
    } else {
      round = toRound(await program.account.round.fetch(roundKey(id)), prev.buyers);
    }
    mergeRecent(gameData);
  }

  // ---------- market (Meteora) ----------

  const market = {
    phase: 'curve', raisedSol: 0, thresholdSol: num(dbcConfig.migrationQuoteThreshold) / LAMPORTS_PER_SOL,
    price: 0, feeBps: 0,
    unclaimedSol: 0,   // fees owed to the game, still in the Meteora pool
    collectedSol: 0,   // fees claimed so far
    toJackpotSol: 0,   // 80% of them
    toTeamSol: 0,      // 20% of them
    volumeSol: 0,
  };
  // The game's fee roles on the bonding curve: fee claimer (partner share) and/or creator.
  const isFeeClaimer = dbcConfig.feeClaimer.equals(feeAddress);

  async function refreshMarket() {
    const pool = (await dbc.state.getPool(gameData.dbcPool)).poolState;
    const prevPhase = market.phase;
    market.phase = pool.isMigrated === 1 ? 'damm' : pool.migrationProgress >= 1 ? 'migrating' : 'curve';
    market.raisedSol = num(pool.quoteReserve) / LAMPORTS_PER_SOL;
    const owed = (isFeeClaimer ? num(pool.partnerQuoteFee) : 0) + (pool.creator.equals(feeAddress) ? num(pool.creatorQuoteFee) : 0);
    market.unclaimedSol = market.phase === 'damm' ? 0 : owed / LAMPORTS_PER_SOL;
    const probe = new BN(LAMPORTS_PER_SOL / 10);
    if (market.phase === 'damm') {
      const ps = await cp.fetchPoolState(gameData.dammPool);
      market.price = Number(dammPrice(ps.sqrtPrice, 6, 9));
      try {
        const slot = await connection.getSlot();
        const point = ps.activationType === 0 ? new BN(slot) : new BN(Math.floor(now()));
        const q = cp.getQuote2({ inputTokenMint: NATIVE_MINT, slippage: 1, currentPoint: point, poolState: ps, tokenADecimal: 6, tokenBDecimal: 9, hasReferral: false, swapMode: DammSwapMode.ExactIn, amountIn: probe });
        market.feeBps = num(q.includedFeeInputAmount.sub(q.excludedFeeInputAmount)) * 10_000 / num(probe); // total fee
      } catch {}
    } else {
      market.price = Number(dbcPrice(pool.sqrtPrice, 6, 9));
      if (market.phase === 'curve') {
        try {
          const q = dbc.pool.swapQuote2({
            virtualPool: { poolState: pool }, config: dbcConfig, swapBaseForQuote: false, hasReferral: false,
            eligibleForFirstSwapWithMinFee: false, currentPoint: await getCurrentPoint(connection, dbcConfig.activationType),
            swapMode: SwapMode.ExactIn, amountIn: probe,
          });
          market.feeBps = num(q.tradingFee.add(q.protocolFee).add(q.referralFee)) * 10_000 / num(probe);
        } catch {}
      }
    }
    const s = gameData.stats;
    const collected = num(s.harvestedLamports);
    // Through the relay there are no live events: spot new fee claims from the totals.
    if (relayed && market.collectedSol && collected > market.collectedSol * LAMPORTS_PER_SOL + 0.5) {
      const lamports = collected - Math.round(market.collectedSol * LAMPORTS_PER_SOL);
      const toTeam = Math.floor(lamports * 0.2);
      emit({ type: 'fees', lamports, toJackpot: lamports - toTeam, toTeam });
    }
    market.collectedSol = collected / LAMPORTS_PER_SOL;
    market.toJackpotSol = num(s.toJackpotLamports) / LAMPORTS_PER_SOL;
    market.toTeamSol = num(s.toTeamLamports) / LAMPORTS_PER_SOL;
    if (prevPhase === 'curve' && market.phase !== 'curve') emit({ type: 'curveComplete', raisedSol: market.raisedSol });
    if (prevPhase !== 'damm' && market.phase === 'damm') emit({ type: 'migrated', price: market.price });
  }

  // ---------- live events ----------

  const parser = new EventParser(PROGRAM_ID, new BorshCoder(IDL));
  if (!relayed) connection.onLogs(PROGRAM_ID, ({ logs, err }) => {
    if (err) return;
    for (const ev of parser.parseLogs(logs)) {
      // Anchor 1.x IDLs keep snake_case field names; accept camelCase too. Event names may
      // carry a "fomocity::" prefix.
      const d = new Proxy(ev.data, { get: (o, k) => o[k] ?? o[String(k).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] });
      const name = ev.name.split('::').pop();
      if (name === 'BuyRecorded') {
        addBuy(num(d.round), d.wallet.toBase58(), num(d.lamports), num(d.buyTs));
        refreshRound().catch(() => {});
      } else if (name === 'Harvested') {
        emit({ type: 'fees', lamports: num(d.lamports), toJackpot: num(d.toJackpot), toTeam: num(d.toTeam) });
        refreshRound().catch(() => {});
        refreshMarket().catch(() => {});
      } else if (name === 'JackpotFunded') {
        emit({ type: 'funded', funder: d.funder.toBase58(), lamports: num(d.lamports) });
        refreshRound().catch(() => {});
      } else if (name === 'Settled') {
        refreshRound().catch(() => {});
      }
    }
  }, 'confirmed');

  mergeRecent(gameData);
  await Promise.all([syncClock(), refreshMarket()]);
  const poll = (f, ms) => setInterval(() => f().catch((e) => console.warn('[fomocity]', e?.message ?? e)), ms);
  poll(refreshRound, POLL_MS);
  poll(refreshMarket, MARKET_POLL_MS);
  poll(syncClock, 30_000);

  return {
    mode: cfg.cluster,
    mint: mint.toBase58(),
    params,
    marketInfo: {
      thresholdSol: market.thresholdSol,
      // Launch fee schedule as configured on the DBC pool.
      sniperFeeBps: Math.round(num(dbcConfig.poolFees.baseFee.cliffFeeNumerator) / 100_000),
      baseFeeBps: null,
      keeperMaxFeeBps: 200,
    },
    get round() { return round; },
    // Set on-chain by the admin (npm run final-round): 'final' while the last round runs,
    // 'ended' once it has been paid out.
    get phase() { return gameData?.ended ? 'ended' : num(gameData?.finalRound ?? 0) ? 'final' : 'live'; },
    get winners() { return winners; },
    get market() { return market; },
    now,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
