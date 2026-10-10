// Solana backend: same interface as sim.js, backed by the fomocity program and the token's
// Meteora pool. State is polled (so it can't drift) and program logs are followed for the
// live feed (so buys show up with their exact cost as soon as they land).
import './polyfill.js';
import { AnchorProvider, BorshCoder, EventParser, Program } from '@coral-xyz/anchor';
import { CpAmm, SwapMode as DammSwapMode, getPriceFromSqrtPrice as dammPrice } from '@meteora-ag/cp-amm-sdk';
import {
  DynamicBondingCurveClient, SwapMode, getCurrentPoint, getPriceFromSqrtPrice as dbcPrice,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import IDL from '../../idls/fomocity.json';
import * as G from './game.js';

const PROGRAM_ID = new PublicKey(IDL.address);
const DEFAULT_KEY = PublicKey.default.toBase58();
const POLL_MS = 2_000;
const MARKET_POLL_MS = 5_000;

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const num = (bn) => Number(bn.toString());

// Read-only wallet until the player connects one.
const readOnlyWallet = (publicKey) => ({
  publicKey,
  signTransaction: () => Promise.reject(new Error('connect a wallet first')),
  signAllTransactions: () => Promise.reject(new Error('connect a wallet first')),
});

export async function createChain(cfg) {
  const connection = new Connection(cfg.rpcUrl, 'confirmed');
  const mint = new PublicKey(cfg.mint);
  const game = pda([Buffer.from('game'), mint.toBuffer()]);
  const roundKey = (id) => pda([Buffer.from('round'), game.toBuffer(), u64le(id)]);
  const playerKey = (round, owner) => pda([Buffer.from('player'), round.toBuffer(), owner.toBuffer()]);
  const vault = pda([Buffer.from('vault'), mint.toBuffer()]);
  const treasury = pda([Buffer.from('treasury'), game.toBuffer()]);
  const wsolVault = pda([Buffer.from('wsol'), game.toBuffer()]);

  let wallet = readOnlyWallet(PublicKey.default);
  let program = new Program(IDL, new AnchorProvider(connection, wallet, { commitment: 'confirmed' }));
  const coder = new BorshCoder(IDL);
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const cp = new CpAmm(connection);

  const listeners = new Set();
  const emit = (e) => { for (const l of listeners) l(e); };

  // ---------- state ----------

  let gameData = await program.account.game.fetch(game);
  const params = {
    basePrice: num(gameData.params.basePrice),
    priceStep: num(gameData.params.priceStep),
    timeAddPerFloor: num(gameData.params.timeAddPerFloor),
    maxTimer: num(gameData.params.maxTimer),
    initialTimer: num(gameData.params.initialTimer),
    maxFloorsPerBuy: gameData.params.maxFloorsPerBuy,
  };
  const dbcConfig = await dbc.state.getPoolConfig(gameData.dbcConfig);

  let clockOffset = 0; // chain time − local time
  async function syncClock() {
    const t = await connection.getBlockTime(await connection.getSlot('confirmed'));
    if (t) clockOffset = t - Date.now() / 1000;
  }
  const now = () => Date.now() / 1000 + clockOffset;

  // Same shape as game.js rounds, so the UI and plaza don't care which backend runs.
  function toRound(r, players) {
    return {
      id: num(r.id),
      startTs: num(r.startTs),
      endTs: num(r.endTs),
      totalFloors: num(r.totalFloors),
      jackpot: num(r.jackpot),
      nextRoundPot: num(r.nextRoundPot),
      devFees: 0,
      accPerFloor: BigInt(r.accPerFloor.toString()),
      lastBuyer: r.lastBuyer.toBase58() === DEFAULT_KEY ? null : r.lastBuyer.toBase58(),
      settled: r.settled,
      jackpotClaimed: r.jackpotClaimed,
      winner: r.settled && r.totalFloors.gtn(0) ? r.lastBuyer.toBase58() : null,
      players,
    };
  }

  // All PlayerRound accounts of a round. The memcmp on the round id can match other games
  // under the same program, so each result is checked against its PDA.
  async function fetchPlayers(id) {
    const rk = roundKey(id);
    const accs = await program.account.playerRound.all([{ memcmp: { offset: 8, bytes: bs58u64(id) } }]);
    const players = {};
    for (const { publicKey, account } of accs) {
      if (!publicKey.equals(playerKey(rk, account.owner))) continue;
      players[account.owner.toBase58()] = { floors: num(account.floors), rewardDebt: num(account.rewardDebt), claimed: num(account.claimed) };
    }
    return players;
  }

  let round = toRound(await program.account.round.fetch(roundKey(gameData.currentRound)), await fetchPlayers(num(gameData.currentRound)));
  const shown = Object.fromEntries(Object.entries(round.players).map(([k, p]) => [k, p.floors]));
  const history = [];
  let pendingJackpot = null; // { roundId, amount } if the connected wallet won and hasn't claimed

  async function refreshRound() {
    const prevId = round.id;
    gameData = await program.account.game.fetch(game);
    const id = num(gameData.currentRound);
    if (id !== prevId) {
      // A settle happened since the last poll.
      const old = toRound(await program.account.round.fetch(roundKey(prevId)), round.players);
      emitSettled(old);
      for (const k of Object.keys(shown)) delete shown[k];
    }
    round = toRound(await program.account.round.fetch(roundKey(id)), await fetchPlayers(id));
    if (id !== prevId) emit({ type: 'round', round: id });
    // Buys we missed in the logs (e.g. websocket hiccup) still animate, with estimated cost.
    for (const [who, p] of Object.entries(round.players)) {
      const before = shown[who] ?? 0;
      if (p.floors > before) {
        shown[who] = p.floors;
        emit({ type: 'buy', who, n: p.floors - before, cost: G.costOf(params, round.totalFloors - (p.floors - before), p.floors - before), floors: p.floors });
      }
    }
    await checkPendingJackpot();
  }

  const settledSeen = new Set();
  function emitSettled(r) {
    if (settledSeen.has(r.id)) return;
    settledSeen.add(r.id);
    const winner = r.totalFloors > 0 ? r.lastBuyer : null;
    history.unshift({ id: r.id, winner, payout: winner ? r.jackpot : 0, floors: r.totalFloors });
    emit({ type: 'settled', round: r.id, winner, payout: winner ? r.jackpot : 0 });
  }

  async function checkPendingJackpot() {
    pendingJackpot = null;
    if (wallet.publicKey.equals(PublicKey.default)) return;
    for (let id = round.id - 1; id >= Math.max(1, round.id - 3); id--) {
      const r = await program.account.round.fetch(roundKey(id));
      if (r.settled && !r.jackpotClaimed && r.jackpot.gtn(0) && r.totalFloors.gtn(0) && r.lastBuyer.equals(wallet.publicKey)) {
        pendingJackpot = { roundId: id, amount: num(r.jackpot) };
        return;
      }
    }
  }

  // ---------- market (Meteora) ----------

  const market = {
    phase: 'curve', raisedSol: 0, thresholdSol: num(dbcConfig.migrationQuoteThreshold) / LAMPORTS_PER_SOL,
    price: 0, feeBps: 0, unclaimedSol: 0, wsolSol: 0, harvestedSol: 0, spentSol: 0,
    boughtTokens: 0, burnedTokens: 0, volumeSol: 0,
  };
  let dammPool = null;

  async function refreshMarket() {
    const pool = (await dbc.state.getPool(gameData.dbcPool)).poolState;
    const prevPhase = market.phase;
    market.phase = pool.isMigrated === 1 ? 'damm' : pool.migrationProgress >= 1 ? 'migrating' : 'curve';
    market.raisedSol = num(pool.quoteReserve) / LAMPORTS_PER_SOL;
    market.unclaimedSol = num(pool.partnerQuoteFee.add(pool.creatorQuoteFee)) / LAMPORTS_PER_SOL;
    const probe = new BN(LAMPORTS_PER_SOL / 10);
    if (market.phase === 'damm') {
      dammPool = await cp.fetchPoolState(gameData.dammPool);
      market.price = Number(dammPrice(dammPool.sqrtPrice, 6, 9));
      try {
        const slot = await connection.getSlot();
        const point = dammPool.activationType === 0 ? new BN(slot) : new BN(Math.floor(now()));
        const q = cp.getQuote2({ inputTokenMint: NATIVE_MINT, slippage: 1, currentPoint: point, poolState: dammPool, tokenADecimal: 6, tokenBDecimal: 9, hasReferral: false, swapMode: DammSwapMode.ExactIn, amountIn: probe });
        market.feeBps = num(q.tradingFee.add(q.protocolFee)) * 10_000 / num(probe);
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
    const wsol = await connection.getTokenAccountBalance(wsolVault).catch(() => null);
    market.wsolSol = wsol ? Number(wsol.value.amount) / LAMPORTS_PER_SOL : 0;
    const s = gameData.stats;
    market.harvestedSol = num(s.harvestedLamports) / LAMPORTS_PER_SOL;
    market.spentSol = num(s.spentLamports) / LAMPORTS_PER_SOL;
    market.boughtTokens = num(s.boughtTokens);
    market.burnedTokens = num(s.burnedTokens);
    if (prevPhase === 'curve' && market.phase !== 'curve') emit({ type: 'curveComplete', raisedSol: market.raisedSol });
    if (prevPhase !== 'damm' && market.phase === 'damm') emit({ type: 'migrated', price: market.price });
  }

  // ---------- live events ----------

  const parser = new EventParser(PROGRAM_ID, coder);
  connection.onLogs(PROGRAM_ID, async ({ logs, err }) => {
    if (err) return;
    for (const ev of parser.parseLogs(logs)) {
      // Anchor 1.x IDLs keep snake_case field names; accept camelCase too in case the
      // coder converts them. Event names may carry a "fomocity::" prefix.
      const d = new Proxy(ev.data, { get: (o, k) => o[k] ?? o[String(k).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] });
      const name = ev.name.split('::').pop();
      if (name === 'Bought' && num(d.round) === round.id) {
        const who = d.buyer.toBase58();
        await refreshRound().catch(() => {});
        // refreshRound already emitted a diff-based buy if it saw it first; otherwise emit exact.
        const floors = round.players[who]?.floors ?? d.floors;
        if ((shown[who] ?? 0) < floors) {
          shown[who] = floors;
          emit({ type: 'buy', who, n: d.floors, cost: num(d.cost), floors });
        }
      } else if (name === 'BoughtBack') {
        emit({
          type: 'buyback', sol: num(d.lamportsIn) / LAMPORTS_PER_SOL, out: num(d.tokensOut),
          toJackpot: num(d.toJackpot), toNext: num(d.toNext), burn: num(d.burned),
        });
        refreshMarket().catch(() => {});
      } else if (name === 'Settled') {
        refreshRound().catch(() => {});
      }
    }
  }, 'confirmed');

  await Promise.all([syncClock(), refreshMarket()]);
  const poll = (f, ms) => setInterval(() => f().catch((e) => console.warn('[fomocity]', e?.message ?? e)), ms);
  poll(refreshRound, POLL_MS);
  poll(refreshMarket, MARKET_POLL_MS);
  poll(syncClock, 30_000);

  // ---------- transactions ----------

  async function sendTx(tx) {
    tx.feePayer = wallet.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    const signed = await wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (res.value.err) throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  const youKey = () => {
    if (wallet.publicKey.equals(PublicKey.default)) throw new Error('connect a wallet first');
    return wallet.publicKey;
  };
  const yourAta = () => getAssociatedTokenAddressSync(mint, youKey());

  async function tokenBalance() {
    try { return Number((await connection.getTokenAccountBalance(yourAta())).value.amount); } catch { return 0; }
  }

  let balanceCache = 0;
  let solCache = 0;
  async function refreshBalances() {
    if (wallet.publicKey.equals(PublicKey.default)) return;
    balanceCache = await tokenBalance();
    solCache = (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
  }
  poll(refreshBalances, 4_000);

  const friendly = (e) => {
    const m = e?.error?.errorMessage ?? e?.message ?? String(e);
    if (/0x1\b|insufficient funds|InsufficientFunds/.test(m)) return 'insufficient balance';
    return m.length > 140 ? `${m.slice(0, 140)}…` : m;
  };

  return {
    mode: cfg.cluster,
    connection,
    burnerAllowed: cfg.burnerAllowed,
    get you() { return wallet.publicKey.equals(PublicKey.default) ? '' : wallet.publicKey.toBase58(); },
    params,
    marketInfo: {
      thresholdSol: market.thresholdSol,
      // Launch fee schedule as configured on the DBC pool.
      sniperFeeBps: Math.round(num(dbcConfig.poolFees.baseFee.cliffFeeNumerator) / 100_000),
      baseFeeBps: null,
      keeperMaxFeeBps: 200,
    },
    get round() { return round; },
    get history() { return history; },
    get market() { return market; },
    get pendingJackpot() { return pendingJackpot; },
    get solBalance() { return solCache; },
    now,
    balance: () => balanceCache,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    get wallet() { return wallet.name ? wallet : null; },
    async connect(w) {
      wallet = w;
      program = new Program(IDL, new AnchorProvider(connection, wallet, { commitment: 'confirmed' }));
      await Promise.all([refreshBalances(), checkPendingJackpot()]);
      emit({ type: 'wallet', who: this.you });
    },

    async buy(n) {
      const you = youKey();
      const rk = roundKey(round.id);
      const cost = G.costOf(params, round.totalFloors, n);
      // 3% headroom for buys that land just before ours; the program enforces max_cost.
      const maxCost = Math.ceil(cost * 1.03);
      if (balanceCache < cost) throw new Error(`need ${G.fmt(cost)} FOMO, you have ${G.fmt(balanceCache)}`);
      try {
        const tx = await program.methods.buy(n, new BN(maxCost)).accountsStrict({
          buyer: you, game, mint, round: rk, playerRound: playerKey(rk, you), buyerTokenAccount: yourAta(),
          vault, devTokenAccount: gameData.devTokenAccount, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).transaction();
        await sendTx(tx);
      } catch (e) { throw new Error(friendly(e)); }
      refreshBalances();
      return { n, cost };
    },

    // Claims dividends from the current and the previous round, in one transaction.
    async claim() {
      const you = youKey();
      const ixs = [];
      let total = 0;
      for (const id of [round.id, round.id - 1].filter((i) => i >= 1)) {
        const rk = roundKey(id);
        const p = await program.account.playerRound.fetchNullable(playerKey(rk, you));
        if (!p) continue;
        const r = await program.account.round.fetch(rk);
        const owed = Number((BigInt(p.floors.toString()) * BigInt(r.accPerFloor.toString())) / G.ACC_PRECISION) - num(p.rewardDebt);
        if (owed <= 0) continue;
        total += owed;
        ixs.push(await program.methods.claimDividends().accountsStrict({
          owner: you, game, mint, round: rk, playerRound: playerKey(rk, you), ownerTokenAccount: yourAta(),
          vault, tokenProgram: TOKEN_PROGRAM_ID,
        }).instruction());
      }
      if (!ixs.length) return 0;
      const tx = new Transaction().add(...ixs);
      try { await sendTx(tx); } catch (e) { throw new Error(friendly(e)); }
      emit({ type: 'claim', who: this.you, amount: total });
      refreshBalances();
      return total;
    },

    async claimJackpot() {
      if (!pendingJackpot) return 0;
      const { roundId, amount } = pendingJackpot;
      const tx = await program.methods.claimJackpot().accountsStrict({
        game, mint, round: roundKey(roundId), winnerTokenAccount: yourAta(), vault, tokenProgram: TOKEN_PROGRAM_ID,
      }).transaction();
      try { await sendTx(tx); } catch (e) { throw new Error(friendly(e)); }
      pendingJackpot = null;
      refreshBalances();
      return amount;
    },

    // Anyone can settle an expired round; the keeper usually does it first.
    async settle() {
      const you = youKey();
      const id = round.id;
      const tx = await program.methods.settle().accountsStrict({
        cranker: you, game, round: roundKey(id), nextRound: roundKey(id + 1), systemProgram: SystemProgram.programId,
      }).transaction();
      try { await sendTx(tx); } catch (e) { throw new Error(friendly(e)); }
      await refreshRound();
    },

    // Buy FOMO with SOL on whichever Meteora pool is live. `slippageBps` guards the quote.
    async swapSol(sol, slippageBps = 300) {
      const you = youKey();
      const amountIn = new BN(Math.round(sol * LAMPORTS_PER_SOL));
      let tx;
      try {
        if (market.phase === 'curve') {
          const pool = await dbc.state.getPool(gameData.dbcPool);
          const q = dbc.pool.swapQuote2({
            virtualPool: pool, config: dbcConfig, swapBaseForQuote: false, hasReferral: false, eligibleForFirstSwapWithMinFee: false,
            currentPoint: await getCurrentPoint(connection, dbcConfig.activationType), slippageBps, swapMode: SwapMode.ExactIn, amountIn,
          });
          tx = await dbc.pool.swap2({
            owner: you, pool: gameData.dbcPool, swapBaseForQuote: false, referralTokenAccount: null,
            swapMode: SwapMode.ExactIn, amountIn, minimumAmountOut: q.minimumAmountOut,
          });
        } else if (market.phase === 'damm') {
          const ps = dammPool ?? await cp.fetchPoolState(gameData.dammPool);
          const slot = await connection.getSlot();
          const point = ps.activationType === 0 ? new BN(slot) : new BN(Math.floor(now()));
          const q = cp.getQuote2({ inputTokenMint: NATIVE_MINT, slippage: slippageBps / 100, currentPoint: point, poolState: ps, tokenADecimal: 6, tokenBDecimal: 9, hasReferral: false, swapMode: DammSwapMode.ExactIn, amountIn });
          tx = await cp.swap({
            payer: you, pool: gameData.dammPool, inputTokenMint: NATIVE_MINT, outputTokenMint: mint, amountIn,
            minimumAmountOut: q.minimumAmountOut, tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAVault: ps.tokenAVault,
            tokenBVault: ps.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
          });
        } else {
          throw new Error('pool is migrating, try again in a moment');
        }
        await sendTx(tx);
      } catch (e) { throw new Error(friendly(e)); }
      const before = balanceCache;
      await refreshBalances();
      return balanceCache - before;
    },
  };
}

// base58 of a little-endian u64, for memcmp filters.
function bs58u64(n) {
  return bs58encode(u64le(n));
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58encode(bytes) {
  let x = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';
  while (x > 0n) { out = B58[Number(x % 58n)] + out; x /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}
