// Tracker on a local validator (./localnet.sh): real Meteora DBC buys and sells from two
// wallets; checks the tracker attributes each one to the right wallet
// with the exact SOL that entered or left the pool, both from history and live.
import assert from 'node:assert/strict';
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import BN from 'bn.js';
import { launch, send } from './lib.ts';
import { track, type Trade } from './tracker.ts';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function funded(n: number) {
  const kp = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, n * LAMPORTS_PER_SOL), 'confirmed');
  return kp;
}

async function main() {
  const [authority, keeper, alice, bob] = await Promise.all([funded(30), funded(5), funded(10), funded(10)]);
  const g0 = await launch(connection, authority, {
    launch: { migrationQuoteThresholdSol: 50 },
    params: { minBuyLamports: new BN(50_000_000), timeAddPerBuy: new BN(30), maxTimer: new BN(1800), initialTimer: new BN(1800), settleGraceSecs: new BN(60) },
    roles: { keeper: keeper.publicKey, team: Keypair.generate().publicKey },
  });
  await sleep(3_000);

  const quoteVault = (await dbc.state.getPool(g0.pool))!.poolState.quoteVault;
  const vaultBal = async () => BigInt((await getAccount(connection, quoteVault)).amount);
  const expected: Omit<Trade, 'sig' | 'slot' | 'time' | 'venue' | 'tokens'>[] = [];

  const swap = async (kp: Keypair, sell: boolean, amount: BN) => {
    const before = await vaultBal();
    const tx = await dbc.pool.swap2({
      owner: kp.publicKey, pool: g0.pool, swapBaseForQuote: sell, referralTokenAccount: null,
      swapMode: SwapMode.ExactIn, amountIn: amount, minimumAmountOut: new BN(0),
    });
    await send(connection, tx, [kp]);
    const d = (await vaultBal()) - before;
    expected.push({ side: sell ? 'sell' : 'buy', wallet: kp.publicKey.toBase58(), lamports: (d < 0n ? -d : d).toString(), game: false });
  };
  const fomoOf = async (kp: Keypair) => new BN((await getAccount(connection, getAssociatedTokenAddressSync(g0.mint, kp.publicKey))).amount.toString());

  console.log('▸ trades: alice buys, bob buys, alice sells half');
  await swap(alice, false, new BN(0.5 * LAMPORTS_PER_SOL));
  await swap(bob, false, new BN(0.2 * LAMPORTS_PER_SOL));
  await swap(alice, true, (await fomoOf(alice)).divn(2));

  console.log('▸ backfill from history');
  const got: Trade[] = [];
  await track(connection, g0.mint, (t) => got.push(t));
  const strip = (t: Trade) => ({ side: t.side, wallet: t.wallet, lamports: t.lamports, game: t.game });
  assert.deepEqual(got.map(strip), expected, 'history matches, in order');
  for (const t of got) assert.ok(BigInt(t.tokens) > 0n && t.venue === 'dbc' && t.slot > 0);

  console.log('▸ live: a new buy shows up within seconds');
  const live: Trade[] = [];
  const seen = new Set(got.map((t) => t.sig));
  await track(connection, g0.mint, (t) => live.push(t), { seen, live: true });
  await swap(bob, false, new BN(0.1 * LAMPORTS_PER_SOL));
  for (let i = 0; i < 20 && !live.length; i++) await sleep(500);
  assert.equal(live.length, 1, 'one live trade');
  assert.deepEqual(strip(live[0]), expected[expected.length - 1]);

  console.log(`\n✓ Tracker checks passed (${got.length} historical + ${live.length} live trades).`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗', e?.message ?? e);
  if (e?.logs) console.error(e.logs.join('\n'));
  process.exit(1);
});
