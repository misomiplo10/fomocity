// On-chain game rules on a local validator (./localnet.sh). Players buy FOMO on the real
// Meteora bonding curve; the tracker sees those swaps and the keeper reports them with
// record_buy. Checks every guard, the countdown math, the jackpot being paid automatically
// to the last buyer at settle, the winners list, carry-over, and admin hand-off.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { utils } from '@coral-xyz/anchor';
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAccount } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { fomocity, harvestDbc, launch, readGame, recordBuy, send, setFinalRound, settle, withdrawTeam, type GameState } from './lib.ts';
import { track, type Trade } from './tracker.ts';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`▸ ${s}`);
const big = (v: BN | bigint | number) => BigInt(v.toString());
const P = { minBuy: 0.05 * LAMPORTS_PER_SOL, timeAdd: 5, maxTimer: 25, initial: 20, grace: 3 };
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

// The program's own clock (Clock sysvar). Block times can lag it by seconds on localnet.
const chainNow = async () => Number((await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed'))!.data.readBigInt64LE(32));
async function waitUntil(ts: number) { while ((await chainNow()) < ts) await sleep(500); }

async function main() {
  const [authority, keeper, alice, bob, carol] = await Promise.all([funded(30), funded(5), funded(10), funded(10), funded(5)]);
  const team = Keypair.generate();
  // Settling or paying the team passes SOL through a temporary account whose rent also goes
  // to the recipient (paid by whoever cranks).
  const payoutRent = BigInt(await connection.getMinimumBalanceForRentExemption(165));
  const lamportsOf = async (k: PublicKey) => BigInt(await connection.getBalance(k, 'confirmed'));

  step('launch: 0.05 SOL minimum, +5s per buy, 25s cap, 20s start, 3s grace');
  const g0 = await launch(connection, authority, {
    launch: { migrationQuoteThresholdSol: 50 },
    params: {
      minBuyLamports: new BN(P.minBuy), timeAddPerBuy: new BN(P.timeAdd), maxTimer: new BN(P.maxTimer),
      initialTimer: new BN(P.initial), settleGraceSecs: new BN(P.grace),
    },
    roles: { keeper: keeper.publicKey, team: team.publicKey },
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
  await sleep(2_500); // keep the two buys in different seconds for the ordering checks
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
  // A buy dated before the latest recorded one (but still inside the round) is out of order.
  await expectError(recordBuy(keeperProgram, keeper, g, { ...tb, time: tb.time! - 1, sig: fakeSig() }), 'BuyOutOfOrder');
  g = await readGame(program, g0.mint);
  const recent = g.data.recent.filter((b: any) => !b.wallet.equals(PublicKey.default));
  assert.deepEqual(recent.map((b: any) => b.wallet.toBase58()), [ta.wallet, tb.wallet], 'recent buys list');

  step('trading fees: 80% to the jackpot, 20% to the team');
  const fees = BigInt((await new DynamicBondingCurveClient(connection, 'confirmed').state.getPool(g0.pool))!.poolState.partnerQuoteFee
    .add((await new DynamicBondingCurveClient(connection, 'confirmed').state.getPool(g0.pool))!.poolState.creatorQuoteFee).toString());
  assert.ok(fees > 0n, 'the buys paid trading fees');
  await harvestDbc(program, g);
  r1 = await fetchRound(1);
  g = await readGame(program, g0.mint);
  const toTeam = (fees * 2000n) / 10000n;
  assert.equal(big(r1.jackpot), fees - toTeam, '80% to the jackpot');
  assert.equal(big(g.data.teamOwed), toTeam, '20% owed to the team');
  const jackpot = big(r1.jackpot);

  step('a buy after the deadline is rejected; settle waits for the grace period');
  await waitUntil(r1.endTs.toNumber());
  await expectError(recordBuy(keeperProgram, keeper, g, { ...tb, time: r1.endTs.toNumber(), sig: fakeSig() }), 'BuyAfterDeadline');
  if ((await chainNow()) < r1.endTs.toNumber() + P.grace) await expectError(settle(program, g, authority.publicKey), 'TimerRunning');
  await waitUntil(r1.endTs.toNumber() + P.grace);

  step('settle must pay the last buyer, not anyone else');
  const settleWith = (winner: PublicKey | null) => fomocity(connection, carol).methods.settle().accountsStrict({
    cranker: carol.publicKey, game: g.game, round: g.round(1), nextRound: g.round(2), treasury: g.treasury,
    wsolVault: g.wsolVault, quoteMint: NATIVE_MINT, payout: g.payout, winner: winner as any,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc();
  await expectError(settleWith(alice.publicKey), 'WinnerAccountMismatch');
  await expectError(settleWith(null), 'WinnerAccountMismatch');

  step('settle by anyone pays bob the jackpot, in SOL, automatically');
  const bob0 = await lamportsOf(bob.publicKey);
  await settle(fomocity(connection, carol), g, carol.publicKey);
  assert.equal(await lamportsOf(bob.publicKey) - bob0, jackpot + payoutRent, 'bob received the jackpot as SOL');
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

  step('the SOL vault holds exactly what is still owed');
  const vault = (await getAccount(connection, g.wsolVault)).amount;
  assert.equal(vault, big(r3.jackpot) + big(r3.nextRoundPot) + big(g.data.teamOwed));

  step("team share goes to the team wallet as SOL (anyone can trigger it)");
  const owed = big(g.data.teamOwed);
  await withdrawTeam(fomocity(connection, carol), g, carol.publicKey);
  assert.equal(await lamportsOf(team.publicKey), owed + payoutRent);
  g = await readGame(program, g0.mint);
  assert.equal(big(g.data.teamOwed), 0n);
  await expectError(withdrawTeam(program, g, authority.publicKey), 'NothingToClaim');

  step('final round: announced by the admin only, once; it plays out and pays its winner');
  await expectError(setFinalRound(fomocity(connection, carol), carol.publicKey, g), 'ConstraintHasOne');
  await setFinalRound(program, authority.publicKey, g);
  g = await readGame(program, g0.mint);
  assert.equal(g.data.finalRound.toNumber(), 3);
  await expectError(setFinalRound(program, authority.publicKey, g), 'GameEnded');
  const tFinal = { wallet: alice.publicKey.toBase58(), lamports: String(P.minBuy), time: await chainNow(), sig: fakeSig() };
  await recordBuy(keeperProgram, keeper, g, tFinal);
  await swap(carol, 0.2); // trading fees during the final round still feed its jackpot
  await harvestDbc(program, g);
  const r3f = await fetchRound(3);
  assert.ok(big(r3f.jackpot) > big(r3.jackpot), 'fees reached the final jackpot');
  await waitUntil(r3f.endTs.toNumber() + P.grace);
  const owedBefore = big((await readGame(program, g0.mint)).data.teamOwed);
  const alice0 = await lamportsOf(alice.publicKey);
  await settle(fomocity(connection, carol), g, carol.publicKey);
  assert.equal(await lamportsOf(alice.publicKey) - alice0, big(r3f.jackpot) + payoutRent, 'final winner paid in full');

  step('after the final round: game over, no buys, no settles, fees go to the team');
  g = await readGame(program, g0.mint);
  assert.ok(g.data.ended);
  const r4 = await fetchRound(4);
  assert.ok(r4.settled && big(r4.jackpot) === 0n, 'no round 4 is played');
  assert.equal(big(g.data.teamOwed), owedBefore + big(r3f.nextRoundPot), 'money set aside for a next round went to the team');
  await expectError(recordBuy(keeperProgram, keeper, g, { ...tFinal, time: await chainNow(), sig: fakeSig() }), 'GameEnded');
  await expectError(settle(program, g, authority.publicKey), 'GameEnded');
  const harvested0 = big(g.data.stats.harvestedLamports), owed0 = big(g.data.teamOwed);
  await swap(carol, 0.2);
  await harvestDbc(program, g);
  g = await readGame(program, g0.mint);
  const extra = big(g.data.stats.harvestedLamports) - harvested0;
  assert.ok(extra > 0n);
  assert.equal(big(g.data.teamOwed), owed0 + extra, '100% of later fees to the team');
  await withdrawTeam(program, g, authority.publicKey);
  g = await readGame(program, g0.mint);
  assert.equal((await getAccount(connection, g.wsolVault)).amount, 0n, 'nothing left behind in the vault');

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
