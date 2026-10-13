// Keeper: runs the game.
//  - Tracks every FOMO buy on the game's Meteora pools (any app) and reports qualifying
//    buys on-chain with record_buy, in chain order.
//  - Settles each round when its countdown (plus grace) runs out; settling pays the jackpot
//    straight to the last buyer.
//  - Harvests Meteora fees, migrates the curve if Meteora's bots don't, and buys back.
// record_buy and the buybacks need the keeper key stored in the game account; the rest
// is permissionless.
//
//   KEEPER=~/.config/solana/keeper.json MINT=<game mint> npm run keeper   (RPC from scripts/.env)
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { getAccount } from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  buybackDamm, buybackDbc, fomocity, jitoSender, recordBuy, redactUrl, rpcUrl, harvestDamm, harvestDbc, harvestDbcSurplus, loadKeypair, readGame, send, settle,
} from './lib.ts';
import { track, type Trade } from './tracker.ts';

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const connection = new Connection(rpcUrl(), 'confirmed');
const keeper = loadKeypair(env('KEEPER').replace(/^~/, process.env.HOME!));
const mint = new PublicKey(env('MINT'));
const INTERVAL = Number(env('INTERVAL_SECS', '20')) * 1000;
const MIN_BUYBACK = new BN(env('MIN_BUYBACK_LAMPORTS', '10000000')); // 0.01 SOL: skip dust
const SLIPPAGE_BPS = Number(env('SLIPPAGE_BPS', '100'));
const MAX_FEE_BPS = Number(env('MAX_FEE_BPS', '200')); // skip buybacks during the anti-sniper window
// Optional: route buybacks through Jito so they can't be sandwiched from the public mempool.
//   JITO_URL=https://mainnet.block-engine.jito.wtf JITO_TIP_LAMPORTS=100000
const JITO_URL = process.env.JITO_URL;

const program = fomocity(connection, keeper);
const sender = JITO_URL ? jitoSender(connection, keeper, JITO_URL, Number(env('JITO_TIP_LAMPORTS', '100000'))) : undefined;
const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const attempt = async (what: string, f: () => Promise<unknown>) => {
  try { const r = await f(); if (r) log(what, r); } catch (e: any) { log(`${what} failed:`, e?.message ?? e); }
};

// record_buy and settle touch the same round, so they run one at a time.
let lock = Promise.resolve();
const exclusive = <T>(f: () => Promise<T>) => { const p = lock.then(f); lock = p.then(() => {}, () => {}); return p; };

// ---------- buys → record_buy ----------

const TRADES_LOG = env('TRACKER_LOG', 'trades.jsonl');
const RECORDED_LOG = env('RECORDED_LOG', 'recorded.jsonl');
const readSigs = (f: string) => new Set(existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).sig) : []);
const tradeSigs = readSigs(TRADES_LOG);
const recorded = readSigs(RECORDED_LOG);

async function report(t: Trade) {
  if (t.side !== 'buy' || t.game || recorded.has(t.sig) || t.time == null) return;
  await exclusive(async () => {
    const g = await readGame(program, mint);
    const round: any = await (program.account as any).round.fetch(g.round(BigInt(g.data.currentRound.toString())));
    const why =
      BigInt(t.lamports) < BigInt(g.data.params.minBuyLamports.toString()) ? 'below minimum' :
      t.time! < round.startTs.toNumber() ? 'before this round' :
      t.time! >= round.endTs.toNumber() ? 'after the countdown ended' :
      t.time! < round.lastBuyTs.toNumber() ? 'out of order' : null;
    const sol = (Number(t.lamports) / 1e9).toFixed(4);
    if (why) { log(`skip buy ${t.wallet} ${sol} SOL (${why})`); return; }
    await attempt(`record_buy ${t.wallet} ${sol} SOL`, async () => {
      const sig = await recordBuy(program, keeper, g, t);
      recorded.add(t.sig);
      appendFileSync(RECORDED_LOG, JSON.stringify({ sig: t.sig, round: round.id.toString(), tx: sig }) + '\n');
      return sig;
    });
  });
}

async function tick() {
  let g = await readGame(program, mint);
  const now = Math.floor(Date.now() / 1000);

  const round: any = await (program.account as any).round.fetch(g.round(BigInt(g.data.currentRound.toString())));
  if (!round.settled && now >= round.endTs.toNumber() + g.data.params.settleGraceSecs.toNumber()) {
    const who = round.buyCount > 0 ? `pays ${round.jackpot.toString()} to ${round.lastBuyer.toBase58()}` : 'no buyers, jackpot carries over';
    await exclusive(() => attempt(`settle round ${round.id} (${who})`, () => settle(program, g, keeper.publicKey)));
  }

  const pool = (await dbc.state.getPool(g.data.dbcPool))!.poolState;
  const migrated = pool.isMigrated === 1;
  if (!migrated) {
    const owed = pool.partnerQuoteFee.add(pool.creatorQuoteFee);
    if (owed.gte(MIN_BUYBACK)) await attempt('harvest_dbc', () => harvestDbc(program, g));
    if (pool.migrationProgress >= 1) {
      // Curve finished. Migration is permissionless; Meteora's keepers usually do it,
      // this is the fallback if they don't (e.g. a non-standard threshold).
      await attempt('migrate', async () => {
        const m = await dbc.migration.migrateToDammV2({ payer: keeper.publicKey, pool: g.data.dbcPool, dammConfig: g.data.buyback.dammConfig });
        return send(connection, m.transaction, [keeper, m.firstPositionNftKeypair, m.secondPositionNftKeypair], 1_000_000);
      });
    }
  } else {
    if (!pool.isPartnerWithdrawSurplus || !pool.isCreatorWithdrawSurplus) await attempt('harvest_dbc_surplus', () => harvestDbcSurplus(program, g));
    await attempt('harvest_damm', () => harvestDamm(program, g));
  }

  g = await readGame(program, mint);
  const wsol = new BN((await getAccount(connection, g.wsolVault)).amount.toString());
  const cooled = now >= g.data.stats.lastBuybackTs.toNumber() + g.data.buyback.minGapSecs.toNumber();
  if (cooled && wsol.gte(MIN_BUYBACK)) {
    const amount = BN.min(wsol, g.data.buyback.maxLamports);
    await attempt(`buyback ${amount.toString()} lamports`, () =>
      migrated ? buybackDamm(program, keeper, g, amount, SLIPPAGE_BPS, sender) : buybackDbc(program, keeper, g, amount, SLIPPAGE_BPS, MAX_FEE_BPS, sender));
  }
}

log(`keeper ${keeper.publicKey.toBase58()} on ${redactUrl(rpcUrl())}, game mint ${mint.toBase58()}${JITO_URL ? ` (buybacks via Jito ${JITO_URL})` : ''}`);
// Backfill and follow the pools; every trade is logged, qualifying buys are reported.
track(connection, mint, (t) => {
  if (!tradeSigs.has(t.sig)) { tradeSigs.add(t.sig); appendFileSync(TRADES_LOG, JSON.stringify(t) + '\n'); }
  report(t);
}, { seen: new Set(), live: true }).catch((e) => log('tracker failed:', e?.message ?? e));
for (;;) {
  await attempt('tick', tick);
  await new Promise((r) => setTimeout(r, INTERVAL));
}
