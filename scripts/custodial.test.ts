// No-program setup on a local validator (./localnet.sh): a "friend" launches FOMO on
// Meteora DBC with their own fee wallet; the game server tracks buys, holds the jackpot in
// an ordinary wallet, takes FOMO and SOL top-ups (SOL → buyback 70/20/10), serves the API,
// pays the winner with a round memo, and never pays twice after a crash.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAccount,
  getAssociatedTokenAddressSync, getMint,
} from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { startGame, type GameConfig } from './game-server.ts';
import { DEFAULT_LAUNCH, launchCurve, send } from './lib.ts';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`▸ ${s}`);
const until = async (what: string, f: () => boolean | Promise<boolean>, ms = 30_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(300)) if (await f()) return;
  assert.fail(`timed out waiting for: ${what}`);
};

async function funded(n: number) {
  const kp = Keypair.generate();
  if (n) await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, n * LAMPORTS_PER_SOL), 'confirmed');
  return kp;
}

async function main() {
  const [friend, keeper, alice, bob] = await Promise.all([funded(30), funded(5), funded(10), funded(10)]);
  const jackpot = Keypair.generate(); // starts empty: everything in it is prize money

  step("friend launches FOMO on Meteora DBC (fees go to the friend)");
  const mint = Keypair.generate(), config = Keypair.generate();
  await send(connection, await dbc.partner.createConfig({
    config: config.publicKey, feeClaimer: friend.publicKey, leftoverReceiver: friend.publicKey, quoteMint: NATIVE_MINT,
    payer: friend.publicKey,
    ...launchCurve({ ...DEFAULT_LAUNCH, migrationQuoteThresholdSol: 50, antiSniper: { startingFeeBps: 1_000, endingFeeBps: 100, numberOfPeriod: 2, totalDurationSecs: 2 } }),
  }), [friend, config]);
  await send(connection, await dbc.creator.createPool({
    name: 'FOMO', symbol: 'FOMO', uri: 'https://example.com/fomo.json', payer: friend.publicKey,
    poolCreator: friend.publicKey, config: config.publicKey, baseMint: mint.publicKey,
  }), [friend, mint]);
  const found = (await dbc.state.getPoolByBaseMint(mint.publicKey))!;
  await sleep(3_000); // launch fee window
  const swap = async (kp: Keypair, sol: number) => send(connection, await dbc.pool.swap2({
    owner: kp.publicKey, pool: found.publicKey, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.ExactIn, amountIn: new BN(sol * LAMPORTS_PER_SOL), minimumAmountOut: new BN(0),
  }), [kp]);
  // The friend buys FOMO (for a top-up later) before the game starts, so it isn't a game move.
  await swap(friend, 1);
  await sleep(1_500);

  step('game server starts on the CA (no program)');
  const dataDir = mkdtempSync(join(tmpdir(), 'fomocity-'));
  const cfg: GameConfig = {
    connection, mint: mint.publicKey, jackpot, keeper,
    params: { minBuyLamports: 0.05 * LAMPORTS_PER_SOL, timeAddPerBuy: 5, maxTimer: 20, initialTimer: 20, settleGraceSecs: 2 },
    dataDir, port: 8799, maxBuybackLamports: LAMPORTS_PER_SOL, minBuybackLamports: 0.01 * LAMPORTS_PER_SOL,
    buybackGapSecs: 0, maxFeeBps: 200, slippageBps: 300, solReserveLamports: 0.003 * LAMPORTS_PER_SOL, tickMs: 1_000,
    log: process.env.DEBUG ? undefined : () => {},
  };
  let game = await startGame(cfg);
  const st = () => game.state;

  step('players buy on Meteora; the server counts them (the earlier buy is ignored)');
  await swap(alice, 0.3);
  await sleep(1_500);
  await swap(bob, 0.2);
  await until('two buys counted', () => st().round.buyCount === 2);
  assert.equal(st().round.lastBuyer, bob.publicKey.toBase58());

  step('FOMO top-up: friend sends FOMO to the jackpot wallet');
  const friendAta = getAssociatedTokenAddressSync(mint.publicKey, friend.publicKey);
  const jackpotAta = getAssociatedTokenAddressSync(mint.publicKey, jackpot.publicKey);
  const topUp = (await getAccount(connection, friendAta)).amount / 4n;
  await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(friend.publicKey, jackpotAta, jackpot.publicKey, mint.publicKey),
    createTransferCheckedInstruction(friendAta, mint.publicKey, jackpotAta, friend.publicKey, topUp, 6),
  ), [friend]);
  await until('FOMO top-up credited', () => st().stats.fundedTokens > 0);
  assert.equal(BigInt(st().round.jackpot), topUp);

  step('SOL top-up: friend sends SOL; the server buys back 70/20/10');
  const supply0 = (await getMint(connection, mint.publicKey)).supply;
  const jp0 = BigInt(st().round.jackpot);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: friend.publicKey, toPubkey: jackpot.publicKey, lamports: 0.3 * LAMPORTS_PER_SOL }),
  ), [friend]);
  await until('buyback done', () => st().stats.boughtTokens > 0);
  const out = BigInt(st().stats.boughtTokens);
  const burned = BigInt(st().stats.burnedTokens);
  assert.equal(burned, (out * 1000n) / 10000n, '10% burned');
  assert.equal(BigInt(st().round.jackpot) - jp0, out - (out * 2000n) / 10000n - burned, '70% to the jackpot');
  assert.equal(supply0 - (await getMint(connection, mint.publicKey)).supply, burned);
  assert.equal((await getAccount(connection, jackpotAta)).amount, BigInt(st().round.jackpot) + BigInt(st().round.nextRoundPot), 'wallet holds exactly what is owed');

  step('public API serves the game');
  const api: any = await (await fetch('http://127.0.0.1:8799/api/state')).json();
  assert.equal(api.mode, 'custodial');
  assert.equal(api.jackpotWallet, jackpot.publicKey.toBase58());
  assert.equal(api.round.lastBuyer, bob.publicKey.toBase58());
  assert.equal(api.round.jackpot, st().round.jackpot);

  step('round ends: bob is paid the jackpot, with a round memo');
  const jackpotAmt = BigInt(st().round.jackpot);
  const bobAta = getAssociatedTokenAddressSync(mint.publicKey, bob.publicKey);
  const bob0 = (await getAccount(connection, bobAta)).amount;
  await until('round 1 paid', () => st().history[0]?.round === 1 && !!st().history[0]?.payoutSig, 60_000);
  assert.equal((await getAccount(connection, bobAta)).amount - bob0, jackpotAmt);
  const paySig = st().history[0].payoutSig!;
  const payTx = await connection.getTransaction(paySig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  assert.ok(payTx!.meta!.logMessages!.join(' ').includes('FOMO City round 1 payout'), 'memo on the payout');
  assert.equal(st().round.id, 2);

  step('crash right after paying: restart must not pay twice');
  game.stop();
  const statePath = join(dataDir, 'state.json');
  const s = JSON.parse(readFileSync(statePath, 'utf8'));
  s.pendingPayout = { round: 1, winner: bob.publicKey.toBase58(), amount: Number(jackpotAmt) };
  s.history[0].payoutSig = null;
  writeFileSync(statePath, JSON.stringify(s));
  const bob1 = (await getAccount(connection, bobAta)).amount;
  game = await startGame({ ...cfg, port: 8800 });
  await until('recovered the payout', () => game.state.pendingPayout === null && game.state.history[0].payoutSig === paySig);
  await sleep(2_000);
  assert.equal((await getAccount(connection, bobAta)).amount, bob1, 'bob was not paid a second time');
  assert.equal(game.state.round.buyCount, 0, 'old buys were not counted again after the restart');
  game.stop();

  console.log('\n✓ No-program game checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗', e?.message ?? e);
  if (e?.logs) console.error(e.logs.join('\n'));
  process.exit(1);
});
