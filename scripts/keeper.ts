// Keeper: runs the game.
//  - Tracks every token buy on the game's Meteora pools (any app) and reports qualifying buys
//    on-chain with record_buy, in chain order.
//  - Collects the trading fees owed to the game's fee address (80% jackpot, 20% team).
//  - Settles each round when its countdown (plus grace) runs out; settling pays the jackpot
//    straight to the last buyer, in SOL.
//  - Sends the team its share once it passes TEAM_MIN_SOL.
//  - Migrates the curve if Meteora's own bots don't.
// record_buy needs the keeper key stored in the game account; everything else is
// permissionless.
//
//   KEEPER=~/.config/solana/fomocity-keeper.json MINT=<token CA> npm run keeper   (RPC from scripts/.env)
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  claimableDbcFees, fomocity, harvestDamm, harvestDbc, harvestDbcSurplus, loadKeypair, readGame, recordBuy, redactUrl,
  rpcUrl, send, settle, withdrawTeam,
} from './lib.ts';
import { track, type Trade } from './tracker.ts';

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const sol = (k: string, d: string) => new BN(Math.round(Number(env(k, d)) * LAMPORTS_PER_SOL));
const connection = new Connection(rpcUrl(), 'confirmed');
const keeper = loadKeypair(env('KEEPER').replace(/^~/, process.env.HOME!));
const mint = new PublicKey(env('MINT'));
const INTERVAL = Number(env('INTERVAL_SECS', '20')) * 1000;
const MIN_HARVEST = sol('MIN_HARVEST_SOL', '0.01');   // don't claim dust
const TEAM_MIN = sol('TEAM_MIN_SOL', '0.1');          // send the team's share once it reaches this
const LOW_BALANCE = Number(env('LOW_BALANCE_SOL', '0.2'));

const program = fomocity(connection, keeper);
const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const attempt = async (what: string, f: () => Promise<unknown>) => {
  try { const r = await f(); if (r) log(what, r); } catch (e: any) { log(`${what} failed:`, e?.message ?? e); }
};

// record_buy, harvests and settle touch the same round, so they run one at a time.
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
      g.data.ended ? 'the game has ended' :
      round.settled ? 'round already settled' :
      BigInt(t.lamports) < BigInt(g.data.params.minBuyLamports.toString()) ? 'below minimum' :
      t.time! < round.startTs.toNumber() ? 'before this round' :
      t.time! >= round.endTs.toNumber() ? 'after the countdown ended' :
      t.time! < round.lastBuyTs.toNumber() ? 'out of order' : null;
    const amount = (Number(t.lamports) / 1e9).toFixed(4);
    if (why) { log(`skip buy ${t.wallet} ${amount} SOL (${why})`); return; }
    await attempt(`record_buy ${t.wallet} ${amount} SOL`, async () => {
      const sig = await recordBuy(program, keeper, g, t);
      recorded.add(t.sig);
      appendFileSync(RECORDED_LOG, JSON.stringify({ sig: t.sig, round: round.id.toString(), tx: sig }) + '\n');
      return sig;
    });
  });
}

// ---------- the loop ----------

async function tick() {
  let g = await readGame(program, mint);
  const now = Math.floor(Date.now() / 1000);

  // Fees first, so a round that's about to end still gets everything owed to it.
  const pool = (await dbc.state.getPool(g.data.dbcPool))!.poolState;
  const migrated = pool.isMigrated === 1;
  if (!migrated) {
    if ((await claimableDbcFees(connection, g)).gte(MIN_HARVEST)) await exclusive(() => attempt('harvest_dbc', () => harvestDbc(program, g)));
    if (pool.migrationProgress >= 1) {
      // Curve finished. Migration is permissionless; Meteora's bots usually do it, this is
      // the fallback if they don't (e.g. a non-standard threshold).
      await attempt('migrate', async () => {
        const m = await dbc.migration.migrateToDammV2({ payer: keeper.publicKey, pool: g.data.dbcPool, dammConfig: g.data.cfg.dammConfig });
        return send(connection, m.transaction, [keeper, m.firstPositionNftKeypair, m.secondPositionNftKeypair], 1_000_000);
      });
    }
  } else {
    if (!pool.isPartnerWithdrawSurplus || !pool.isCreatorWithdrawSurplus) await exclusive(() => attempt('harvest_dbc_surplus', () => harvestDbcSurplus(program, g)));
    await exclusive(() => attempt('harvest_damm', () => harvestDamm(program, g)));
  }

  g = await readGame(program, mint);
  const round: any = await (program.account as any).round.fetch(g.round(BigInt(g.data.currentRound.toString())));
  if (!round.settled && now >= round.endTs.toNumber() + g.data.params.settleGraceSecs.toNumber()) {
    const what = round.buyCount > 0
      ? `pays ${(round.jackpot.toNumber() / 1e9).toFixed(4)} SOL to ${round.lastBuyer.toBase58()}`
      : 'no buys, jackpot carries over';
    await exclusive(() => attempt(`settle round ${round.id} (${what})`, () => settle(program, g, keeper.publicKey)));
    g = await readGame(program, mint);
  }

  if (new BN(g.data.teamOwed.toString()).gte(TEAM_MIN)) {
    await exclusive(() => attempt(`team payout ${(g.data.teamOwed.toNumber() / 1e9).toFixed(4)} SOL`, () => withdrawTeam(program, g, keeper.publicKey)));
  }

  const balance = (await connection.getBalance(keeper.publicKey)) / LAMPORTS_PER_SOL;
  if (balance < LOW_BALANCE) log(`⚠ keeper wallet low: ${balance.toFixed(4)} SOL. Top up ${keeper.publicKey.toBase58()}`);
}

log(`keeper ${keeper.publicKey.toBase58()} on ${redactUrl(rpcUrl())}, game token ${mint.toBase58()}`);
// Backfill and follow the pools; every trade is logged, qualifying buys are reported.
track(connection, mint, (t) => {
  if (!tradeSigs.has(t.sig)) { tradeSigs.add(t.sig); appendFileSync(TRADES_LOG, JSON.stringify(t) + '\n'); }
  report(t);
}, { seen: new Set(), live: true }).catch((e) => log('tracker failed:', e?.message ?? e));
for (;;) {
  await attempt('tick', tick);
  await new Promise((r) => setTimeout(r, INTERVAL));
}
