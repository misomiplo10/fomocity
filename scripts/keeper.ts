// Keeper loop: settles expired rounds, harvests Meteora fees, migrates the curve when it
// completes, and buys back with harvested SOL. Everything except the buyback is
// permissionless; the buyback needs the keeper key stored in the game account.
//
//   RPC_URL=... KEEPER=~/.config/solana/keeper.json MINT=<game mint> npm run keeper
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { getAccount } from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  buybackDamm, buybackDbc, fomocity, harvestDamm, harvestDbc, harvestDbcSurplus, loadKeypair, readGame, send, settle,
} from './lib.ts';

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const connection = new Connection(env('RPC_URL', 'http://127.0.0.1:8899'), 'confirmed');
const keeper = loadKeypair(env('KEEPER').replace(/^~/, process.env.HOME!));
const mint = new PublicKey(env('MINT'));
const INTERVAL = Number(env('INTERVAL_SECS', '20')) * 1000;
const MIN_BUYBACK = new BN(env('MIN_BUYBACK_LAMPORTS', '10000000')); // 0.01 SOL: skip dust
const SLIPPAGE_BPS = Number(env('SLIPPAGE_BPS', '100'));
const MAX_FEE_BPS = Number(env('MAX_FEE_BPS', '200')); // skip buybacks during the anti-sniper window

const program = fomocity(connection, keeper);
const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const attempt = async (what: string, f: () => Promise<unknown>) => {
  try { const r = await f(); if (r) log(what, r); } catch (e: any) { log(`${what} failed:`, e?.message ?? e); }
};

async function tick() {
  let g = await readGame(program, mint);
  const now = Math.floor(Date.now() / 1000);

  const round: any = await (program.account as any).round.fetch(g.round(BigInt(g.data.currentRound.toString())));
  if (!round.settled && now >= round.endTs.toNumber()) await attempt('settle', () => settle(program, g, keeper.publicKey));

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
      migrated ? buybackDamm(program, keeper, g, amount, SLIPPAGE_BPS) : buybackDbc(program, keeper, g, amount, SLIPPAGE_BPS, MAX_FEE_BPS));
  }
}

log(`keeper ${keeper.publicKey.toBase58()} watching game for mint ${mint.toBase58()}`);
for (;;) {
  await attempt('tick', tick);
  await new Promise((r) => setTimeout(r, INTERVAL));
}
