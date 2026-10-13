// Attaching to a token someone else launched (./localnet.sh). A "friend" launches FOMO on
// Meteora DBC with their own fee wallet; the normal initialize must refuse it, attach must
// work, and the game then runs on it: buys tracked and recorded, jackpot funded with FOMO
// (fund_jackpot) and SOL (fund_sol → keeper buyback 70/20/10), and the winner paid.
import assert from 'node:assert/strict';
import { DynamicBondingCurveClient, SwapMode, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';
import {
  DEFAULT_LAUNCH, DAMM_V2_CONFIGS, attach, buybackDbc, fomocity, fundJackpot, fundSol, gameAddresses, harvestDbc,
  launchCurve, readGame, recordBuy, send, settle,
} from './lib.ts';
import { track, type Trade } from './tracker.ts';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`▸ ${s}`);
const big = (v: BN | bigint | number) => BigInt(v.toString());
const P = { minBuy: 0.05 * LAMPORTS_PER_SOL, timeAdd: 5, maxTimer: 15, initial: 15, grace: 2 };

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
  const [friend, operator, keeper, alice, bob] = await Promise.all([funded(30), funded(10), funded(5), funded(10), funded(10)]);

  step("friend launches FOMO on Meteora DBC the usual way (fees go to the friend)");
  const mint = Keypair.generate();
  const config = Keypair.generate();
  const curve = launchCurve({ ...DEFAULT_LAUNCH, migrationQuoteThresholdSol: 50, antiSniper: { startingFeeBps: 1_000, endingFeeBps: 100, numberOfPeriod: 2, totalDurationSecs: 2 } });
  await send(connection, await dbc.partner.createConfig({
    config: config.publicKey, feeClaimer: friend.publicKey, leftoverReceiver: friend.publicKey,
    quoteMint: NATIVE_MINT, payer: friend.publicKey, ...curve,
  }), [friend, config]);
  await send(connection, await dbc.creator.createPool({
    name: 'FOMO', symbol: 'FOMO', uri: 'https://example.com/fomo.json',
    payer: friend.publicKey, poolCreator: friend.publicKey, config: config.publicKey, baseMint: mint.publicKey,
  }), [friend, mint]);
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config.publicKey);
  await sleep(3_000); // let the short launch fee window pass

  const params = {
    minBuyLamports: new BN(P.minBuy), timeAddPerBuy: new BN(P.timeAdd), maxTimer: new BN(P.maxTimer),
    initialTimer: new BN(P.initial), settleGraceSecs: new BN(P.grace),
  };
  const buyback = { keeper: keeper.publicKey, maxLamports: new BN(LAMPORTS_PER_SOL), minGapSecs: new BN(0), dammConfig: DAMM_V2_CONFIGS[DEFAULT_LAUNCH.migrationFeeOption] };
  const a = gameAddresses(mint.publicKey);
  const program = fomocity(connection, operator);

  step('the normal setup refuses it: the game does not get this pool\'s fees');
  await expectError(program.methods.initialize(params, buyback).accountsStrict({
    authority: operator.publicKey, mint: mint.publicKey, quoteMint: NATIVE_MINT, game: a.game, treasury: a.treasury,
    vault: a.vault, wsolVault: a.wsolVault, stash: a.stash, round: a.round(1), dbcPool: pool, dbcConfig: config.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc(), 'TreasuryNotCreator');

  step('attach by CA works');
  const attached = await attach(connection, operator, {
    mint: mint.publicKey, params, keeper: keeper.publicKey, maxBuybackLamports: new BN(LAMPORTS_PER_SOL), buybackGapSecs: new BN(0),
  });
  assert.equal(attached.pool.toBase58(), pool.toBase58(), 'found the pool from the CA');
  let g = await readGame(program, mint.publicKey);
  assert.equal(g.data.external, true);
  assert.equal(g.data.dbcPool.toBase58(), pool.toBase58());
  const fetchRound = async (id: number) => (program.account as any).round.fetch(g.round(id));

  step('players buy on Meteora; the keeper records them');
  const swap = async (kp: Keypair, sol: number) => send(connection, await dbc.pool.swap2({
    owner: kp.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.ExactIn, amountIn: new BN(sol * LAMPORTS_PER_SOL), minimumAmountOut: new BN(0),
  }), [kp]);
  await swap(alice, 0.3);
  await swap(bob, 0.2);
  await swap(friend, 1); // the friend buys FOMO too, to fund the jackpot with tokens
  const trades: Trade[] = [];
  await track(connection, mint.publicKey, (t) => trades.push(t));
  const kp = fomocity(connection, keeper);
  for (const t of trades.filter((t) => t.side === 'buy' && t.wallet !== friend.publicKey.toBase58())) await recordBuy(kp, keeper, g, t);
  let r1 = await fetchRound(1);
  assert.equal(r1.buyCount, 2);
  assert.equal(r1.lastBuyer.toBase58(), bob.publicKey.toBase58());

  step('fee harvests are refused (the fees belong to the friend)');
  await expectError(harvestDbc(program, g), 'Error');

  step('fund_jackpot: friend adds FOMO straight to the jackpot');
  const friendAta = getAssociatedTokenAddressSync(mint.publicKey, friend.publicKey);
  const addTokens = new BN((await getAccount(connection, friendAta)).amount.toString()).divn(4);
  const jp0 = big(r1.jackpot);
  await fundJackpot(fomocity(connection, friend), friend, g, addTokens);
  r1 = await fetchRound(1);
  assert.equal(big(r1.jackpot) - jp0, big(addTokens), 'jackpot += exactly the tokens sent');

  step('fund_sol: friend sends SOL; the keeper buys back 70/20/10');
  const wsol0 = big((await getAccount(connection, g.wsolVault)).amount);
  await fundSol(fomocity(connection, friend), friend, g, new BN(0.5 * LAMPORTS_PER_SOL));
  assert.equal(big((await getAccount(connection, g.wsolVault)).amount) - wsol0, BigInt(0.5 * LAMPORTS_PER_SOL));
  const jp1 = big(r1.jackpot);
  await buybackDbc(program, keeper, g, new BN(0.5 * LAMPORTS_PER_SOL));
  g = await readGame(program, mint.publicKey);
  const out = big(g.data.stats.boughtTokens);
  r1 = await fetchRound(1);
  assert.equal(big(r1.jackpot) - jp1, out - (out * 2000n) / 10000n - (out * 1000n) / 10000n, '70% of the buyback');

  step('round ends: the last buyer is paid the whole jackpot');
  const jackpot = big(r1.jackpot);
  await waitUntil(r1.endTs.toNumber() + P.grace);
  const bobAta = getAssociatedTokenAddressSync(mint.publicKey, bob.publicKey);
  const bob0 = (await getAccount(connection, bobAta)).amount;
  await settle(program, g, operator.publicKey);
  assert.equal((await getAccount(connection, bobAta)).amount - bob0, jackpot);
  g = await readGame(program, mint.publicKey);
  assert.equal(g.data.winners.find((w: any) => big(w.round) === 1n).wallet.toBase58(), bob.publicKey.toBase58());

  console.log('\n✓ Attach mode checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗', e?.message ?? e);
  if (e?.logs) console.error(e.logs.join('\n'));
  process.exit(1);
});
