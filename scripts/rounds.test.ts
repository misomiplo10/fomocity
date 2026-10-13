// On-chain game rules on a local validator (./localnet.sh). Players buy FOMO on the real
// Meteora bonding curve; the tracker sees those swaps and the keeper reports them with
// record_buy. Checks every guard, the countdown math, the jackpot being paid automatically
// to the last buyer at settle, the winners list, carry-over, and admin hand-off.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { utils } from '@coral-xyz/anchor';
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { buybackDbc, fomocity, harvestDbc, launch, readGame, recordBuy, send, settle, type GameState } from './lib.ts';
import { track, type Trade } from './tracker.ts';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`▸ ${s}`);
const big = (v: BN | bigint | number) => BigInt(v.toString());
const P = { minBuy: 0.05 * LAMPORTS_PER_SOL, timeAdd: 5, maxTimer: 15, initial: 10, grace: 3 };
// A made-up 64-byte transaction signature, for guard checks that never reach the real swaps.
const fakeSig = () => utils.bytes.bs58.encode(randomBytes(64));

async function funded(n: number) {
  const kp = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, n * LAMPORTS_PER_SOL), 'confirmed');
  return kp;
}

async function expectError(p: Promise<unknown>, name: string) {
  try { await p; } catch (e: any) {
    const text = `${e?.message ?? ''} ${(e?.logs ?? []).join(' ')}`;
    assert.ok(text.includes(name), `expected ${name}, got: ${text.slice(0, 300)}`);
    return;
  }
  assert.fail(`expected ${name}, but it succeeded`);
}

const chainNow = async () => (await connection.getBlockTime(await connection.getSlot('confirmed')))!;
async function waitUntil(ts: number) { while ((await chainNow()) < ts) await sleep(500); }

async function main() {
  const [authority, keeper, alice, bob, carol] = await Promise.all([funded(30), funded(5), funded(10), funded(10), funded(5)]);

  step('launch: 0.05 SOL minimum, +5s per buy, 15s cap, 10s start, 3s grace');
  const g0 = await launch(connection, authority, {
    launch: { migrationQuoteThresholdSol: 50, antiSniper: { startingFeeBps: 1_000, endingFeeBps: 100, numberOfPeriod: 2, totalDurationSecs: 2 } },
    params: {
      minBuyLamports: new BN(P.minBuy), timeAddPerBuy: new BN(P.timeAdd), maxTimer: new BN(P.maxTimer),
      initialTimer: new BN(P.initial), settleGraceSecs: new BN(P.grace),
    },
    keeper: keeper.publicKey, maxBuybackLamports: new BN(LAMPORTS_PER_SOL), buybackGapSecs: new BN(0),
  });
  const program = fomocity(connection, authority);
  let g: GameState = await readGame(program, g0.mint);
  const fetchRound = async (id: number) => (program.account as any).round.fetch(g.round(id));
  const keeperProgram = fomocity(connection, keeper);

  step('alice then bob buy FOMO on Meteora; the tracker sees both');
  const swap = async (kp: Keypair, sol: number) => {
    const tx = await dbc.pool.swap2({
      owner: kp.publicKey, pool: g0.pool, swapBaseForQuote: false, referralTokenAccount: null,
      swapMode: SwapMode.ExactIn, amountIn: new BN(sol * LAMPORTS_PER_SOL), minimumAmountOut: new BN(0),
    });
    await send(connection, tx, [kp]);
  };
  await swap(alice, 0.3);
  await swap(bob, 0.2);
  const trades: Trade[] = [];
  await track(connection, g0.mint, (t) => trades.push(t));
  const [ta, tb] = trades.filter((t) => t.side === 'buy' && !t.game);
  assert.equal(ta.wallet, alice.publicKey.toBase58());
  assert.equal(tb.wallet, bob.publicKey.toBase58());

  step('guards: keeper only, minimum size, before round, future, order, duplicates');
  await expectError(recordBuy(fomocity(connection, carol), carol, g, ta), 'NotKeeper');
  await expectError(recordBuy(keeperProgram, keeper, g, { ...ta, lamports: String(P.minBuy - 1), sig: fakeSig() }), 'BuyTooSmall');
  const r0 = await fetchRound(1);
  await expectError(recordBuy(keeperProgram, keeper, g, { ...ta, time: r0.startTs.toNumber() - 1, sig: fakeSig() }), 'BuyBeforeRound');
  await expectError(recordBuy(keeperProgram, keeper, g, { ...ta, time: (await chainNow()) + 5, sig: fakeSig() }), 'BuyOutOfOrder');

  step('record alice, then bob: countdown math and last buyer');
  await recordBuy(keeperProgram, keeper, g, ta);
  let r1 = await fetchRound(1);
  const end0 = r0.endTs.toNumber();
  const endA = Math.min(end0 + P.timeAdd, ta.time! + P.maxTimer);
  assert.equal(r1.endTs.toNumber(), endA);
  assert.equal(r1.lastBuyer.toBase58(), ta.wallet);
  await expectError(recordBuy(keeperProgram, keeper, g, ta), 'BuyOutOfOrder'); // same signature again
  await recordBuy(keeperProgram, keeper, g, tb);
  r1 = await fetchRound(1);
  assert.equal(r1.endTs.toNumber(), Math.min(endA + P.timeAdd, tb.time! + P.maxTimer));
  assert.equal(r1.lastBuyer.toBase58(), tb.wallet);
  assert.equal(r1.buyCount, 2);
  assert.equal(big(r1.totalLamports), BigInt(ta.lamports) + BigInt(tb.lamports));
  await expectError(recordBuy(keeperProgram, keeper, g, { ...tb, time: ta.time! - 1, sig: fakeSig() }), 'BuyOutOfOrder');
  g = await readGame(program, g0.mint);
  const recent = g.data.recent.filter((b: any) => !b.wallet.equals(PublicKey.default));
  assert.deepEqual(recent.map((b: any) => b.wallet.toBase58()), [ta.wallet, tb.wallet], 'recent buys list');

  step('trading fees → buyback → jackpot');
  await harvestDbc(program, g);
  g = await readGame(program, g0.mint);
  await buybackDbc(program, keeper, g, new BN((await getAccount(connection, g.wsolVault)).amount.toString()));
  r1 = await fetchRound(1);
  const jackpot = big(r1.jackpot);
  assert.ok(jackpot > 0n, 'jackpot funded');

  step('a buy after the deadline is rejected; settle waits for the grace period');
  await waitUntil(r1.endTs.toNumber());
  await expectError(recordBuy(keeperProgram, keeper, g, { ...tb, time: r1.endTs.toNumber(), sig: fakeSig() }), 'BuyAfterDeadline');
  if ((await chainNow()) < r1.endTs.toNumber() + P.grace) await expectError(settle(program, g, authority.publicKey), 'TimerRunning');
  await waitUntil(r1.endTs.toNumber() + P.grace);

  step('settle must pay the last buyer, not anyone else');
  const settleWith = (winnerTokenAccount: PublicKey | null) => fomocity(connection, carol).methods.settle().accountsStrict({
    cranker: carol.publicKey, game: g.game, mint: g.mint, round: g.round(1), nextRound: g.round(2), vault: g.vault,
    winnerTokenAccount: winnerTokenAccount as any, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc();
  const ataOf = (kp: Keypair) => getAssociatedTokenAddressSync(g.mint, kp.publicKey);
  await expectError(settleWith(ataOf(alice)), 'ConstraintTokenOwner');
  await expectError(settleWith(null), 'WinnerAccountMismatch');

  step('settle by anyone pays bob the jackpot automatically');
  const bob0 = (await getAccount(connection, ataOf(bob))).amount;
  await settle(fomocity(connection, carol), g, carol.publicKey);
  assert.equal((await getAccount(connection, ataOf(bob))).amount - bob0, jackpot, 'bob received the jackpot');
  r1 = await fetchRound(1);
  assert.ok(r1.settled && r1.jackpotPaid);
  g = await readGame(program, g0.mint);
  const winners = g.data.winners.filter((w: any) => !w.wallet.equals(PublicKey.default));
  assert.equal(winners.length, 1);
  assert.equal(winners[0].wallet.toBase58(), bob.publicKey.toBase58());
  assert.equal(big(winners[0].amount), jackpot);
  assert.equal(big(winners[0].round), 1n);
  const r2 = await fetchRound(2);
  assert.equal(big(r2.jackpot), big(r1.nextRoundPot), 'round 2 seeded with the next-round pot');

  step('a round with no buys carries its jackpot over');
  await waitUntil(r2.endTs.toNumber() + P.grace);
  await settle(program, g, authority.publicKey);
  g = await readGame(program, g0.mint);
  const r3 = await fetchRound(3);
  assert.equal(big(r3.jackpot), big(r2.jackpot) + big(r2.nextRoundPot));
  assert.equal(g.data.winners.filter((w: any) => !w.wallet.equals(PublicKey.default)).length, 1, 'no new winner');

  step('vault holds exactly what is still owed');
  const vault = (await getAccount(connection, g.vault)).amount;
  assert.ok(vault >= big(r3.jackpot) && vault - big(r3.jackpot) < 10n, `vault ${vault} vs owed ${r3.jackpot}`);

  step('admin hands off and renounces');
  const ms = Keypair.generate();
  await program.methods.setAuthority(ms.publicKey).accountsStrict({ authority: authority.publicKey, game: g.game }).rpc();
  await expectError(program.methods.setKeeper(authority.publicKey).accountsStrict({ authority: authority.publicKey, game: g.game }).rpc(), 'ConstraintHasOne');
  await connection.confirmTransaction(await connection.requestAirdrop(ms.publicKey, LAMPORTS_PER_SOL), 'confirmed');
  await fomocity(connection, ms).methods.setAuthority(PublicKey.default).accountsStrict({ authority: ms.publicKey, game: g.game }).rpc();
  g = await readGame(program, g0.mint);
  assert.ok(g.data.authority.equals(PublicKey.default));

  console.log('\n✓ All round-rule checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗', e?.message ?? e);
  if (e?.logs) console.error(e.logs.join('\n'));
  process.exit(1);
});
