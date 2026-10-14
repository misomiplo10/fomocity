// End-to-end test against Meteora's real programs on a local validator (./localnet.sh).
// Covers the whole token lifecycle: launch on DBC (flat 3% fee, fees to the game) → trades →
// fees claimed and split 80% jackpot / 20% team → a buy recorded as last buyer → curve
// completes → migrate to DAMM v2 → surplus + LP fees claimed → round settles and the winner
// is paid in SOL → the team is paid its share in SOL.
import assert from 'node:assert/strict';
import { DynamicBondingCurveClient, MigrationFeeOption, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAccount } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import BN from 'bn.js';
import {
  DAMM_V2_CONFIGS, fomocity, harvestDamm, harvestDbc, harvestDbcSurplus, launch, readGame, recordBuy, send, settle,
  withdrawTeam,
} from './lib.ts';
import { track, type Trade } from './tracker.ts';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const sol = (n: number) => new BN(n * LAMPORTS_PER_SOL);
const fmtSol = (n: bigint | BN | number) => `${(Number(n.toString()) / 1e9).toFixed(4)} SOL`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`\n▸ ${s}`);
const big = (v: BN | bigint | number) => BigInt(v.toString());

async function funded(n: number) {
  const kp = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, n * LAMPORTS_PER_SOL), 'confirmed');
  return kp;
}
const chainNow = async () => Number((await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed'))!.data.readBigInt64LE(32));
async function waitUntil(ts: number) { while ((await chainNow()) < ts) await sleep(500); }

const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const lamportsOf = async (k: PublicKey) => BigInt(await connection.getBalance(k, 'confirmed'));

async function traderBuy(trader: Keypair, pool: PublicKey, lamports: BN) {
  const tx = await dbc.pool.swap2({
    owner: trader.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.PartialFill, amountIn: lamports, minimumAmountOut: new BN(0),
  });
  await send(connection, tx, [trader]);
}

async function main() {
  step('Funding wallets');
  const authority = await funded(100);
  const keeper = await funded(5);
  const team = Keypair.generate();
  const traders = await Promise.all([funded(100), funded(100), funded(100)]);
  const rent = BigInt(await connection.getMinimumBalanceForRentExemption(165));

  step('Launching on DBC (flat 3% fee, fees to the game) and binding the game');
  const g0 = await launch(connection, authority, {
    launch: { migrationQuoteThresholdSol: 10, migrationFeeOption: MigrationFeeOption.FixedBps100 },
    params: {
      minBuyLamports: sol(0.05), timeAddPerBuy: new BN(30), maxTimer: new BN(120), initialTimer: new BN(120), settleGraceSecs: new BN(2),
    },
    roles: { keeper: keeper.publicKey, team: team.publicKey },
  });
  console.log(`  mint ${g0.mint.toBase58()}\n  DBC pool ${g0.pool.toBase58()}\n  fee address ${g0.treasury.toBase58()}`);
  const program = fomocity(connection, authority);
  let g = await readGame(program, g0.mint);

  step('Trading pays a flat 3% fee');
  await traderBuy(traders[0], g0.pool, sol(1));
  await traderBuy(traders[1], g0.pool, sol(1));
  const before = (await dbc.state.getPool(g0.pool))!.poolState;
  const owed = big(before.partnerQuoteFee.add(before.creatorQuoteFee));
  // 3% of 2 SOL = 0.06 SOL in fees; Meteora keeps 20%, the game is owed the other 80%.
  assert.ok(owed > 0n && owed <= 48_000_000n, `game owed ${owed} lamports`);

  step('harvest_dbc: fees claimed, 80% jackpot / 20% team');
  await harvestDbc(program, g);
  g = await readGame(program, g0.mint);
  assert.equal(big(g.data.stats.harvestedLamports), owed, 'claimed exactly what the game was owed');
  let r1: any = await (program.account as any).round.fetch(g.round(1));
  assert.equal(big(r1.jackpot), owed - (owed * 2000n) / 10000n);
  assert.equal(big(g.data.teamOwed), (owed * 2000n) / 10000n);
  console.log(`  claimed ${fmtSol(owed)} → jackpot ${fmtSol(r1.jackpot)}, team ${fmtSol(g.data.teamOwed)}`);

  step('A Meteora buy is tracked and recorded as the last buyer');
  await traderBuy(traders[2], g0.pool, sol(0.5));
  const trades: Trade[] = [];
  await track(connection, g.mint, (t) => trades.push(t));
  const last = trades.filter((t) => t.side === 'buy' && !t.game).pop()!;
  assert.equal(last.wallet, traders[2].publicKey.toBase58());
  await recordBuy(fomocity(connection, keeper), keeper, g, last);
  r1 = await (program.account as any).round.fetch(g.round(1));
  assert.equal(r1.lastBuyer.toBase58(), traders[2].publicKey.toBase58());

  step('Completing the bonding curve');
  await traderBuy(traders[0], g0.pool, sol(20));
  const done = (await dbc.state.getPool(g0.pool))!.poolState;
  assert.ok(done.migrationProgress >= 1, `curve complete (progress ${done.migrationProgress})`);

  step('Migrating to DAMM v2 (permissionless)');
  const mig = await dbc.migration.migrateToDammV2({
    payer: authority.publicKey, pool: g0.pool, dammConfig: DAMM_V2_CONFIGS[MigrationFeeOption.FixedBps100],
  });
  await send(connection, mig.transaction, [authority, mig.firstPositionNftKeypair, mig.secondPositionNftKeypair], 1_000_000);
  assert.equal((await dbc.state.getPool(g0.pool))!.poolState.isMigrated, 1);
  const cp = new CpAmm(connection);
  const dammPool = await cp.fetchPoolState(g.data.dammPool);
  assert.equal(dammPool.tokenAMint.toBase58(), g.mint.toBase58(), 'game derived the right DAMM pool');
  assert.equal((await cp.getUserPositionByPool(g.data.dammPool, g.treasury)).length, 2, 'fee address owns both locked LP positions');

  step('Surplus + remaining curve fees claimed');
  const h0 = big(g.data.stats.harvestedLamports);
  await harvestDbcSurplus(program, g);
  await harvestDbc(program, g);
  g = await readGame(program, g0.mint);
  console.log(`  +${fmtSol(big(g.data.stats.harvestedLamports) - h0)}`);

  step('Trading on DAMM v2, then LP fees claimed');
  await send(connection, await cp.swap({
    payer: traders[1].publicKey, pool: g.data.dammPool, inputTokenMint: NATIVE_MINT, outputTokenMint: g.mint,
    amountIn: sol(5), minimumAmountOut: new BN(0), tokenAMint: g.mint, tokenBMint: NATIVE_MINT,
    tokenAVault: dammPool.tokenAVault, tokenBVault: dammPool.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
  }), [traders[1]]);
  const h1 = big(g.data.stats.harvestedLamports);
  await harvestDamm(program, g);
  g = await readGame(program, g0.mint);
  assert.ok(big(g.data.stats.harvestedLamports) > h1, 'LP fees reached the game');
  console.log(`  LP fees +${fmtSol(big(g.data.stats.harvestedLamports) - h1)}`);

  step('Round ends: the last buyer is paid the jackpot in SOL');
  r1 = await (program.account as any).round.fetch(g.round(1));
  const jackpot = big(r1.jackpot);
  await waitUntil(r1.endTs.toNumber() + 2);
  const w0 = await lamportsOf(traders[2].publicKey);
  await settle(fomocity(connection, keeper), g, keeper.publicKey);
  assert.equal(await lamportsOf(traders[2].publicKey) - w0, jackpot + rent);

  step('Team share paid in SOL');
  g = await readGame(program, g0.mint);
  const teamOwed = big(g.data.teamOwed);
  await withdrawTeam(fomocity(connection, keeper), g, keeper.publicKey);
  assert.equal(await lamportsOf(team.publicKey), teamOwed + rent);
  g = await readGame(program, g0.mint);
  assert.equal((await getAccount(connection, g.wsolVault)).amount, big((await (program.account as any).round.fetch(g.round(2))).jackpot), 'vault holds exactly the next jackpot');

  const s = g.data.stats;
  console.log(`\n✓ All checks passed.
  Fees claimed: ${fmtSol(s.harvestedLamports)} → jackpots ${fmtSol(s.toJackpotLamports)}, team ${fmtSol(s.toTeamLamports)}
  Paid: ${fmtSol(jackpot)} to the round 1 winner, ${fmtSol(teamOwed)} to the team`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗', e?.message ?? e);
  if (e?.logs) console.error(e.logs.join('\n'));
  process.exit(1);
});
