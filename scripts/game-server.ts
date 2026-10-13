// Game server for the no-program setup ("option D"). There is no on-chain game program:
// this process runs the whole game and holds the jackpot in an ordinary wallet.
//
//  - Tracks every FOMO buy on the token's Meteora pools (any app) and runs the rounds with
//    the same rules as web/src/game.js: buys of at least MIN_BUY_SOL add SECS_PER_BUY to the
//    countdown (capped at MAX_TIMER_SECS); the last buyer wins.
//  - Holds the jackpot in the JACKPOT wallet and pays the winner when a round ends. Every
//    payout carries a memo "FOMO City round N payout" so it's easy to verify on-chain and
//    so a restart can tell whether a round was already paid.
//  - Top-ups: FOMO sent to the jackpot wallet goes into the jackpot; SOL sent to it is
//    swapped for FOMO on the token's pool and split 70% jackpot · 20% next round · 10% burned.
//  - Serves the public game state for the website: GET /api/state, GET /api/events (SSE),
//    GET /api/history.
//
// TRUST: whoever holds the JACKPOT key controls the pot. Players are told this on the site.
//
//   MINT=<CA> JACKPOT=<jackpot.json> KEEPER=<keeper.json> npm run game   (RPC from scripts/.env)
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { CpAmm, SwapMode as DammSwapMode, getPriceFromSqrtPrice as dammPrice } from '@meteora-ag/cp-amm-sdk';
import {
  DynamicBondingCurveClient, SwapMode, getCurrentPoint, getPriceFromSqrtPrice as dbcPrice,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction,
  createTransferCheckedInstruction, getAccount, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
// @ts-ignore: plain JS module shared with the website (same rules, same math).
import * as G from '../web/src/game.js';
import { loadKeypair, redactUrl, rpcUrl } from './lib.ts';
import { poolsForMint, track, type Trade } from './tracker.ts';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const payoutMemo = (round: number) => `FOMO City round ${round} payout`;

export type GameConfig = {
  connection: Connection;
  mint: PublicKey;
  jackpot: Keypair;           // holds the pot; signs payouts, buybacks, burns
  keeper: Keypair;            // pays transaction fees and winners' token-account rent
  params: { minBuyLamports: number; timeAddPerBuy: number; maxTimer: number; initialTimer: number; settleGraceSecs: number };
  dataDir: string;
  port?: number;              // HTTP API; omit to not serve
  allowedOrigin?: string;
  maxBuybackLamports: number;
  minBuybackLamports: number;
  buybackGapSecs: number;
  maxFeeBps: number;          // skip buybacks while the pool's swap fee is higher (launch window)
  slippageBps: number;
  solReserveLamports: number; // left in the jackpot wallet so it stays rent-exempt
  tickMs?: number;
  log?: (...a: unknown[]) => void;
};

type Round = any; // game.js round object
type HistoryEntry = { round: number; winner: string | null; payout: number; buys: number; endedAt: number; payoutSig: string | null };
type State = {
  version: 1;
  mint: string;
  jackpotWallet: string;
  params: GameConfig['params'];
  round: Round;
  history: HistoryEntry[];
  recent: { round: number; wallet: string; lamports: number; ts: number; sig: string }[];
  applied: string[];        // signatures of trades already applied (last 2000)
  pendingPayout: { round: number; winner: string; amount: number } | null;
  stats: { boughtTokens: number; burnedTokens: number; spentLamports: number; fundedTokens: number; fundedLamports: number; lastBuybackTs: number };
};

export async function startGame(cfg: GameConfig) {
  const { connection, mint, jackpot, keeper, params } = cfg;
  const log = cfg.log ?? ((...a: unknown[]) => console.log(new Date().toISOString(), ...a));
  // Rounds run on the chain's clock (the Clock sysvar), the same clock buys are timestamped
  // with, so a buy is never judged against a server clock that's a few seconds off.
  let clockOffset = 0;
  const syncClock = async () => {
    const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
    if (info) clockOffset = Number(info.data.readBigInt64LE(32)) - Date.now() / 1000;
  };
  await syncClock();
  const now = () => Date.now() / 1000 + clockOffset;
  mkdirSync(cfg.dataDir, { recursive: true });
  const statePath = join(cfg.dataDir, 'state.json');
  const eventsPath = join(cfg.dataDir, 'events.jsonl');
  const tradesPath = join(cfg.dataDir, 'trades.jsonl');
  const jackpotAta = getAssociatedTokenAddressSync(mint, jackpot.publicKey);

  // ---------- state ----------

  let state: State;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.mint !== mint.toBase58() || state.jackpotWallet !== jackpot.publicKey.toBase58()) {
      throw new Error(`${statePath} belongs to a different token or jackpot wallet`);
    }
    state.params = params;
    log(`resuming at round ${state.round.id}`);
  } else {
    // Round 1 opens now: only buys from this moment count.
    state = {
      version: 1, mint: mint.toBase58(), jackpotWallet: jackpot.publicKey.toBase58(), params,
      round: G.newRound(1, Math.floor(now()), params, 0), history: [], recent: [], applied: [], pendingPayout: null,
      stats: { boughtTokens: 0, burnedTokens: 0, spentLamports: 0, fundedTokens: 0, fundedLamports: 0, lastBuybackTs: 0 },
    };
    log('starting round 1');
  }
  const applied = new Set(state.applied);
  const save = () => {
    state.applied = [...applied].slice(-2000);
    writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
    renameSync(`${statePath}.tmp`, statePath); // atomic replace
  };
  save();

  // ---------- events (SSE + audit log) ----------

  const clients = new Set<(e: object) => void>();
  const emit = (e: Record<string, unknown>) => {
    const ev = { ...e, at: Math.floor(now()) };
    appendFileSync(eventsPath, JSON.stringify(ev) + '\n');
    for (const c of clients) c(ev);
  };

  // One thing at a time: buys, top-ups, buybacks and payouts all touch the same round.
  let lock = Promise.resolve();
  const exclusive = <T>(f: () => Promise<T>) => { const p = lock.then(f); lock = p.then(() => {}, () => {}); return p; };

  async function sendTx(ixs: TransactionInstruction[], signers: Keypair[], cu = 300_000) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs);
    tx.feePayer = keeper.publicKey;
    return sendAndConfirmTransaction(connection, tx, [keeper, ...signers], { commitment: 'confirmed' });
  }
  const tokenBalance = async () => { try { return Number((await getAccount(connection, jackpotAta)).amount); } catch { return 0; } };

  // ---------- buys ----------

  function onTrade(t: Trade) {
    appendFileSync(tradesPath, JSON.stringify(t) + '\n');
    if (t.side !== 'buy' || t.game || t.time == null) return;
    exclusive(async () => {
      if (applied.has(t.sig)) return;
      applied.add(t.sig);
      const lamports = Number(t.lamports);
      if (G.recordBuy(state.round, params, t.wallet, lamports, t.time)) {
        state.recent.unshift({ round: state.round.id, wallet: t.wallet, lamports, ts: t.time!, sig: t.sig });
        state.recent = state.recent.slice(0, 50);
        save();
        emit({ type: 'buy', round: state.round.id, who: t.wallet, lamports, total: state.round.buyers[t.wallet], sig: t.sig, endTs: state.round.endTs });
        log(`buy ${t.wallet} ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL → round ${state.round.id} ends ${new Date(state.round.endTs * 1000).toISOString()}`);
      } else {
        save();
      }
    });
  }

  // ---------- top-ups ----------

  // FOMO in the jackpot wallet beyond what's owed is a top-up (our own buybacks are split
  // when they happen, so after one there's no surplus).
  async function creditTokenTopUps() {
    const owed = state.round.jackpot + state.round.nextRoundPot + (state.pendingPayout?.amount ?? 0);
    const surplus = (await tokenBalance()) - owed;
    if (surplus <= 0) return;
    const live = G.isLive(state.round, now());
    if (live) state.round.jackpot += surplus; else state.round.nextRoundPot += surplus;
    state.stats.fundedTokens += surplus;
    save();
    emit({ type: 'funded', tokens: surplus, lamports: 0, toCurrentRound: live });
    log(`FOMO top-up ${surplus} → ${live ? 'jackpot' : 'next round'}`);
  }

  // SOL in the jackpot wallet (above the reserve) is a top-up: swap it for FOMO.
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const cp = new CpAmm(connection);
  const pools = await poolsForMint(connection, mint);
  const dbcConfig = await dbc.state.getPoolConfig((await dbc.state.getPool(pools.dbcPool))!.poolState.config);

  async function buyback() {
    if (now() < state.stats.lastBuybackTs + cfg.buybackGapSecs) return;
    const spare = (await connection.getBalance(jackpot.publicKey)) - cfg.solReserveLamports;
    if (spare < cfg.minBuybackLamports) return;
    const amountIn = new BN(Math.min(spare, cfg.maxBuybackLamports));
    const pool = (await dbc.state.getPool(pools.dbcPool))!;
    let tx: Transaction;
    if (pool.poolState.isMigrated !== 1) {
      if (pool.poolState.migrationProgress >= 1) return; // curve full, waiting for migration
      const q = dbc.pool.swapQuote2({
        virtualPool: pool, config: dbcConfig!, swapBaseForQuote: false, hasReferral: false, eligibleForFirstSwapWithMinFee: false,
        currentPoint: await getCurrentPoint(connection, dbcConfig!.activationType), slippageBps: cfg.slippageBps,
        swapMode: SwapMode.ExactIn, amountIn,
      });
      const feeBps = q.tradingFee.add(q.protocolFee).add(q.referralFee).muln(10_000).div(amountIn).toNumber();
      if (feeBps > cfg.maxFeeBps) return; // launch fee window: wait
      tx = await dbc.pool.swap2({
        owner: jackpot.publicKey, payer: keeper.publicKey, pool: pools.dbcPool, swapBaseForQuote: false,
        referralTokenAccount: null, swapMode: SwapMode.ExactIn, amountIn, minimumAmountOut: q.minimumAmountOut!,
      });
    } else {
      const ps = await cp.fetchPoolState(pools.dammPool);
      const point = ps.activationType === 0 ? new BN(await connection.getSlot()) : new BN(Math.floor(now()));
      const q = cp.getQuote2({
        inputTokenMint: NATIVE_MINT, slippage: cfg.slippageBps / 100, currentPoint: point, poolState: ps,
        tokenADecimal: 6, tokenBDecimal: 9, hasReferral: false, swapMode: DammSwapMode.ExactIn, amountIn,
      });
      tx = await cp.swap({
        payer: jackpot.publicKey, pool: pools.dammPool, inputTokenMint: NATIVE_MINT, outputTokenMint: mint,
        amountIn, minimumAmountOut: q.minimumAmountOut!, tokenAMint: mint, tokenBMint: NATIVE_MINT,
        tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
      });
    }
    // Credit any FOMO top-ups first so the swap output can be measured exactly.
    await creditTokenTopUps();
    const before = await tokenBalance();
    tx.feePayer = keeper.publicKey;
    const swapSig = await sendAndConfirmTransaction(connection, tx, [keeper, jackpot], { commitment: 'confirmed' });
    const out = (await tokenBalance()) - before;
    const r = G.fundFromBuyback(state.round, out, now());
    let burnSig = null;
    if (r.burn > 0) burnSig = await sendTx([createBurnCheckedInstruction(jackpotAta, mint, jackpot.publicKey, r.burn, 6)], [jackpot]);
    state.stats.boughtTokens += out;
    state.stats.burnedTokens += r.burn;
    state.stats.spentLamports += amountIn.toNumber();
    state.stats.fundedLamports += amountIn.toNumber();
    state.stats.lastBuybackTs = Math.floor(now());
    save();
    emit({ type: 'buyback', sol: amountIn.toNumber() / LAMPORTS_PER_SOL, out, toJackpot: r.toJackpot, toNext: r.toNext, burn: r.burn, sig: swapSig, burnSig });
    log(`buyback ${amountIn.toString()} lamports → ${out} FOMO (jackpot +${r.toJackpot}, next +${r.toNext}, burned ${r.burn})`);
  }

  // ---------- payouts ----------

  /** Was this round already paid? Looks for our memo among the jackpot wallet's recent transactions. */
  async function findPayout(round: number): Promise<string | null> {
    const sigs = await connection.getSignaturesForAddress(jackpotAta, { limit: 100 }, 'confirmed');
    for (const s of sigs) {
      if (s.err || !s.memo?.includes(payoutMemo(round))) continue;
      return s.signature;
    }
    return null;
  }

  async function payPending() {
    const p = state.pendingPayout;
    if (!p) return;
    let sig = await findPayout(p.round); // paid before a crash?
    if (!sig) {
      const winner = new PublicKey(p.winner);
      const winnerAta = getAssociatedTokenAddressSync(mint, winner, true);
      sig = await sendTx([
        createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, winnerAta, winner, mint),
        createTransferCheckedInstruction(jackpotAta, mint, winnerAta, jackpot.publicKey, p.amount, 6),
        new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: jackpot.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(payoutMemo(p.round)) }),
      ], [jackpot]);
    }
    const h = state.history.find((x) => x.round === p.round);
    if (h) h.payoutSig = sig;
    state.pendingPayout = null;
    save();
    emit({ type: 'paid', round: p.round, winner: p.winner, payout: p.amount, sig });
    log(`paid round ${p.round}: ${p.amount} FOMO to ${p.winner} (${sig})`);
  }

  async function maybeSettle() {
    const t = now();
    if (!G.canSettle(state.round, params, t)) return;
    await creditTokenTopUps();
    const r = state.round;
    const res = G.settle(r, params, t);
    state.history.unshift({ round: r.id, winner: res.winner, payout: res.payout, buys: r.buyCount, endedAt: Math.floor(t), payoutSig: null });
    if (res.winner && res.payout > 0) state.pendingPayout = { round: r.id, winner: res.winner, amount: res.payout };
    state.round = G.newRound(r.id + 1, Math.floor(t), params, res.carry);
    save(); // the round is decided and the next one open before any money moves
    emit({ type: 'settled', round: r.id, winner: res.winner, payout: res.payout, buys: r.buyCount });
    emit({ type: 'round', round: state.round.id });
    log(`round ${r.id} over: ${res.winner ? `${res.winner} wins ${res.payout}` : 'no buys, carries over'}`);
  }

  // ---------- market info for the site ----------

  let market: Record<string, unknown> = {};
  async function refreshMarket() {
    const pool = (await dbc.state.getPool(pools.dbcPool))!.poolState;
    const phase = pool.isMigrated === 1 ? 'damm' : pool.migrationProgress >= 1 ? 'migrating' : 'curve';
    let price = Number(dbcPrice(pool.sqrtPrice, 6, 9));
    let feeBps = 0;
    const probe = new BN(LAMPORTS_PER_SOL / 10);
    try {
      if (phase === 'damm') {
        const ps = await cp.fetchPoolState(pools.dammPool);
        price = Number(dammPrice(ps.sqrtPrice, 6, 9));
        const point = ps.activationType === 0 ? new BN(await connection.getSlot()) : new BN(Math.floor(now()));
        const q = cp.getQuote2({ inputTokenMint: NATIVE_MINT, slippage: 1, currentPoint: point, poolState: ps, tokenADecimal: 6, tokenBDecimal: 9, hasReferral: false, swapMode: DammSwapMode.ExactIn, amountIn: probe });
        feeBps = q.includedFeeInputAmount.sub(q.excludedFeeInputAmount).toNumber() * 10_000 / probe.toNumber(); // total fee
      } else if (phase === 'curve') {
        const q = dbc.pool.swapQuote2({
          virtualPool: { poolState: pool } as any, config: dbcConfig!, swapBaseForQuote: false, hasReferral: false, eligibleForFirstSwapWithMinFee: false,
          currentPoint: await getCurrentPoint(connection, dbcConfig!.activationType), swapMode: SwapMode.ExactIn, amountIn: probe,
        });
        feeBps = q.tradingFee.add(q.protocolFee).add(q.referralFee).toNumber() * 10_000 / probe.toNumber();
      }
    } catch {}
    const pendingSol = Math.max(0, (await connection.getBalance(jackpot.publicKey)) - cfg.solReserveLamports) / LAMPORTS_PER_SOL;
    market = {
      phase, price, feeBps,
      raisedSol: Number(pool.quoteReserve.toString()) / LAMPORTS_PER_SOL,
      thresholdSol: Number(dbcConfig!.migrationQuoteThreshold.toString()) / LAMPORTS_PER_SOL,
      pendingSol,
      boughtTokens: state.stats.boughtTokens, burnedTokens: state.stats.burnedTokens,
    };
  }

  // ---------- public API ----------

  const publicState = () => ({
    mode: 'custodial',
    mint: state.mint,
    jackpotWallet: state.jackpotWallet,
    params,
    now: Math.floor(now()),
    round: state.round,
    winners: state.history.filter((h) => h.winner).slice(0, 10),
    recent: state.recent.slice(0, 20),
    market,
    stats: state.stats,
    paying: state.pendingPayout,
  });

  let server: Server | null = null;
  if (cfg.port) {
    const origin = cfg.allowedOrigin ?? '*';
    server = createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Cache-Control', 'no-store');
      const url = (req.url ?? '/').split('?')[0];
      if (url === '/api/state') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(publicState()));
      } else if (url === '/api/history') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(state.history));
      } else if (url === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        const send = (e: object) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        clients.add(send);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clients.delete(send); clearInterval(ping); });
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    server.listen(cfg.port);
    log(`API on :${cfg.port}`);
  }

  // ---------- run ----------

  const seen = new Set(existsSync(tradesPath) ? readFileSync(tradesPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).sig) : []);
  await track(connection, mint, onTrade, { seen, live: true, pools, gameOwners: [jackpot.publicKey] });

  const attempt = (what: string, f: () => Promise<unknown>) => exclusive(f).catch((e) => log(`${what} failed:`, e?.message ?? e));
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await attempt('payout', payPending);
      await attempt('settle', maybeSettle);
      await attempt('payout', payPending);
      await attempt('top-ups', creditTokenTopUps);
      await attempt('buyback', buyback);
    } finally { busy = false; }
  }, cfg.tickMs ?? 2_000);
  const marketTimer = setInterval(() => { refreshMarket().catch(() => {}); syncClock().catch(() => {}); }, 10_000);
  await refreshMarket().catch(() => {});

  return {
    get state() { return state; },
    publicState,
    stop() { clearInterval(timer); clearInterval(marketTimer); server?.close(); },
  };
}

// ---------- CLI ----------

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
  const sol = (k: string, d: string) => Math.round(Number(env(k, d)) * LAMPORTS_PER_SOL);
  const key = (k: string) => loadKeypair(env(k).replace(/^~/, process.env.HOME!));
  const url = rpcUrl();
  const maxTimer = Number(env('MAX_TIMER_SECS', '1800'));
  const game = await startGame({
    connection: new Connection(url, 'confirmed'),
    mint: new PublicKey(env('MINT')),
    jackpot: key('JACKPOT'),
    keeper: key('KEEPER'),
    params: {
      minBuyLamports: sol('MIN_BUY_SOL', '0.05'),
      timeAddPerBuy: Number(env('SECS_PER_BUY', '30')),
      maxTimer, initialTimer: maxTimer,
      settleGraceSecs: Number(env('SETTLE_GRACE_SECS', '30')),
    },
    dataDir: env('DATA_DIR', 'data'),
    port: Number(env('PORT', '8787')),
    allowedOrigin: process.env.ALLOWED_ORIGIN,
    maxBuybackLamports: sol('MAX_BUYBACK_SOL', '1'),
    minBuybackLamports: sol('MIN_BUYBACK_SOL', '0.01'),
    buybackGapSecs: Number(env('BUYBACK_GAP_SECS', '300')),
    maxFeeBps: Number(env('MAX_FEE_BPS', '200')),
    slippageBps: Number(env('SLIPPAGE_BPS', '100')),
    solReserveLamports: sol('SOL_RESERVE', '0.003'),
  });
  console.log(`game server on ${redactUrl(url)}, jackpot wallet ${game.state.jackpotWallet}`);
}
