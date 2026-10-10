// End-to-end test against Meteora's real programs on a local validator (./localnet.sh).
// Covers the whole token lifecycle: launch on DBC → trades pay fees to the treasury →
// harvest → buyback into the jackpot → floor buys → curve completes → migrate to DAMM v2
// → harvest surplus + LP fees → buyback on DAMM v2.
import assert from 'node:assert/strict';
import { DynamicBondingCurveClient, MigrationFeeOption, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAccount, getMint, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';
import {
  DAMM_V2_CONFIGS, buybackDamm, buybackDbc, fomocity, harvestDamm, harvestDbc, harvestDbcSurplus,
  launch, readGame, send,
} from './lib.ts';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const sol = (n: number) => new BN(n * LAMPORTS_PER_SOL);
const fmt = (n: bigint | BN | number, d = 6) => (Number(n.toString()) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: 4 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`\n▸ ${s}`);

async function funded(n: number) {
  const kp = Keypair.generate();
  const sig = await connection.requestAirdrop(kp.publicKey, n * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, 'confirmed');
  return kp;
}

async function expectError(p: Promise<unknown>, name: string) {
  try { await p; } catch (e: any) {
    const text = `${e?.message ?? ''} ${(e?.logs ?? []).join(' ')} ${e?.error?.errorCode?.code ?? ''}`;
    assert.ok(text.includes(name), `expected ${name}, got: ${text.slice(0, 400)}`);
    return;
  }
  assert.fail(`expected ${name}, but it succeeded`);
}

const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const tokenBal = async (a: PublicKey) => (await getAccount(connection, a)).amount;

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
  const traders = await Promise.all([funded(100), funded(100), funded(100)]);

  step('Launching token on DBC and binding the game');
  const BUYBACK_GAP = 3;
  const g0 = await launch(connection, authority, {
    // Small numbers so the test can finish the curve: 10 SOL threshold, 10s anti-sniper window.
    launch: {
      migrationQuoteThresholdSol: 10,
      antiSniper: { startingFeeBps: 5_000, endingFeeBps: 100, numberOfPeriod: 10, totalDurationSecs: 10 },
      migrationFeeOption: MigrationFeeOption.FixedBps100,
    },
    params: {
      basePrice: new BN(1_000_000), priceStep: new BN(10_000), timeAddPerFloor: new BN(30),
      maxTimer: new BN(3_600), initialTimer: new BN(3_600), maxFloorsPerBuy: 100,
    },
    keeper: keeper.publicKey,
    maxBuybackLamports: sol(2),
    buybackGapSecs: new BN(BUYBACK_GAP),
    devTokenAccount: async (mint) => (await getOrCreateAssociatedTokenAccount(connection, authority, mint, authority.publicKey)).address,
  });
  console.log(`  mint ${g0.mint.toBase58()}\n  DBC pool ${g0.pool.toBase58()}\n  treasury ${g0.treasury.toBase58()}`);
  const program = fomocity(connection, authority);
  let g = await readGame(program, g0.mint);
  assert.equal(g.data.dbcPool.toBase58(), g0.pool.toBase58());

  step('Sniper buys in the first seconds (50% fee), then normal trading');
  await traderBuy(traders[0], g0.pool, sol(1));
  await sleep(11_000); // anti-sniper window over, fee is down to 1%
  await traderBuy(traders[1], g0.pool, sol(1));
  await traderBuy(traders[2], g0.pool, sol(0.5));

  step('harvest_dbc: treasury claims partner + creator fees');
  const before = (await dbc.state.getPool(g0.pool))!.poolState;
  const owed = BigInt(before.partnerQuoteFee.add(before.creatorQuoteFee).toString());
  assert.ok(owed > 0n, 'fees accrued');
  await harvestDbc(program, g);
  const wsol1 = await tokenBal(g.wsolVault);
  assert.equal(wsol1, owed, 'harvested exactly the treasury fees');
  console.log(`  harvested ${fmt(wsol1, 9)} SOL of fees (80% of all trading fees)`);
  const after = (await dbc.state.getPool(g0.pool))!.poolState;
  assert.ok(after.partnerQuoteFee.isZero() && after.creatorQuoteFee.isZero());

  step('buyback_dbc guards: only the keeper, size cap');
  const stranger = await funded(1);
  await expectError(buybackDbc(fomocity(connection, stranger), stranger, g, new BN(1_000)), 'NotKeeper');
  await expectError(buybackDbc(program, keeper, g, sol(3)), 'BadBuybackSize');

  step('buyback_dbc: SOL → token, split 70/20/10');
  const supply0 = (await getMint(connection, g.mint)).supply;
  const vault0 = await tokenBal(g.vault);
  const round0: any = await (program.account as any).round.fetch(g.round(1));
  const spend = new BN(wsol1.toString());
  const { minOut } = await buybackDbc(program, keeper, g, spend);
  const round1: any = await (program.account as any).round.fetch(g.round(1));
  g = await readGame(program, g0.mint);
  const out = BigInt(g.data.stats.boughtTokens.toString());
  const burned = BigInt(g.data.stats.burnedTokens.toString());
  assert.ok(out >= BigInt(minOut.toString()), 'got at least min_out');
  assert.equal(await tokenBal(g.stash), 0n, 'stash fully distributed');
  assert.equal(await tokenBal(g.wsolVault), 0n, 'all harvested SOL spent');
  assert.equal(burned, (out * 1000n) / 10000n);
  const toNext = (out * 2000n) / 10000n;
  assert.equal(BigInt(round1.jackpot.sub(round0.jackpot).toString()), out - toNext - burned, '70% to jackpot');
  assert.equal(BigInt(round1.nextRoundPot.sub(round0.nextRoundPot).toString()), toNext, '20% to next round');
  assert.equal(await tokenBal(g.vault) - vault0, out - burned);
  assert.equal(supply0 - (await getMint(connection, g.mint)).supply, burned, '10% burned');
  console.log(`  bought ${fmt(out)} FOMO → jackpot +${fmt(out - toNext - burned)}, next round +${fmt(toNext)}, burned ${fmt(burned)}`);

  step('buyback cooldown');
  await traderBuy(traders[1], g0.pool, sol(1));
  await harvestDbc(program, g);
  await expectError(buybackDbc(program, keeper, g, new BN(1_000)), 'BuybackCooldown');

  step('Player buys floors with the token');
  const p = traders[0];
  const pAta = (await getOrCreateAssociatedTokenAccount(connection, p, g.mint, p.publicKey)).address;
  const roundKey = g.round(1);
  await fomocity(connection, p).methods.buy(5, new BN(10_000_000))
    .accountsStrict({
      buyer: p.publicKey, game: g.game, mint: g.mint, round: roundKey,
      playerRound: g.player(roundKey, p.publicKey), buyerTokenAccount: pAta, vault: g.vault,
      devTokenAccount: g.data.devTokenAccount, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
  const round2: any = await (program.account as any).round.fetch(roundKey);
  assert.equal(round2.totalFloors.toNumber(), 5);
  assert.equal(round2.lastBuyer.toBase58(), p.publicKey.toBase58());

  step('Completing the bonding curve');
  await traderBuy(traders[2], g0.pool, sol(20));
  const done = (await dbc.state.getPool(g0.pool))!.poolState;
  assert.ok(done.migrationProgress >= 1, `curve complete (progress ${done.migrationProgress})`);
  await expectError(buybackDbc(program, keeper, g, new BN(1_000)), ''); // curve is closed to swaps

  step('Migrating to DAMM v2 (permissionless)');
  const mig = await dbc.migration.migrateToDammV2({
    payer: authority.publicKey, pool: g0.pool, dammConfig: DAMM_V2_CONFIGS[MigrationFeeOption.FixedBps100],
  });
  await send(connection, mig.transaction, [authority, mig.firstPositionNftKeypair, mig.secondPositionNftKeypair], 1_000_000);
  const migrated = (await dbc.state.getPool(g0.pool))!.poolState;
  assert.equal(migrated.isMigrated, 1);
  const cp = new CpAmm(connection);
  const dammPool = await cp.fetchPoolState(g.data.dammPool);
  assert.equal(dammPool.tokenAMint.toBase58(), g.mint.toBase58(), 'game derived the right DAMM pool');
  const positions = await cp.getUserPositionByPool(g.data.dammPool, g.treasury);
  assert.equal(positions.length, 2, 'treasury owns both locked LP positions');
  console.log(`  DAMM v2 pool ${g.data.dammPool.toBase58()}, treasury holds ${positions.length} locked positions`);

  step('harvest_dbc_surplus + leftover fees');
  const wsolPre = await tokenBal(g.wsolVault);
  await harvestDbcSurplus(program, g);
  await harvestDbc(program, g);
  console.log(`  surplus + fees: ${fmt((await tokenBal(g.wsolVault)) - wsolPre, 9)} SOL`);

  step('Trading on DAMM v2, then harvest_damm');
  const trader = traders[1];
  const swapTx = await cp.swap({
    payer: trader.publicKey, pool: g.data.dammPool, inputTokenMint: NATIVE_MINT, outputTokenMint: g.mint,
    amountIn: sol(5), minimumAmountOut: new BN(0), tokenAMint: g.mint, tokenBMint: NATIVE_MINT,
    tokenAVault: dammPool.tokenAVault, tokenBVault: dammPool.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
  });
  await send(connection, swapTx, [trader]);
  const wsolPre2 = await tokenBal(g.wsolVault);
  const stashPre2 = await tokenBal(g.stash);
  await harvestDamm(program, g);
  const lpSol = (await tokenBal(g.wsolVault)) - wsolPre2;
  const lpTok = (await tokenBal(g.stash)) - stashPre2;
  assert.ok(lpSol > 0n || lpTok > 0n, 'LP fees claimed');
  console.log(`  LP fees: ${fmt(lpSol, 9)} SOL + ${fmt(lpTok)} FOMO`);

  step('buyback_damm');
  await sleep(BUYBACK_GAP * 1000 + 1000);
  g = await readGame(program, g0.mint);
  const bought0 = BigInt(g.data.stats.boughtTokens.toString());
  const r0: any = await (program.account as any).round.fetch(g.round(1));
  const spend2 = BN.min(new BN((await tokenBal(g.wsolVault)).toString()), sol(2));
  await buybackDamm(program, keeper, g, spend2);
  g = await readGame(program, g0.mint);
  const r1: any = await (program.account as any).round.fetch(g.round(1));
  assert.ok(r1.jackpot.gt(r0.jackpot), 'jackpot grew from post-migration fees');
  assert.equal(await tokenBal(g.stash), 0n);
  console.log(`  bought ${fmt(BigInt(g.data.stats.boughtTokens.toString()) - bought0)} FOMO on DAMM v2`);

  const s = g.data.stats;
  console.log(`\n✓ All checks passed.
  Total harvested: ${fmt(s.harvestedLamports, 9)} SOL · spent: ${fmt(s.spentLamports, 9)} SOL
  Total bought back: ${fmt(s.boughtTokens)} FOMO · burned: ${fmt(s.burnedTokens)} FOMO
  Round 1 jackpot: ${fmt(r1.jackpot)} FOMO · next-round seed: ${fmt(r1.nextRoundPot)} FOMO`);
}

main().catch((e) => {
  console.error('\n✗', e?.message ?? e);
  if (e?.logs) console.error(e.logs.join('\n'));
  process.exit(1);
});
