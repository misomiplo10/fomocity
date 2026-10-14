// A token launched by someone else on Meteora DBC (./localnet.sh), with the fees routed to
// the game's fee address the two ways a launcher can:
//  A. the fee address is the config's fee claimer (set at launch);
//  B. the launcher keeps the fee claimer but hands the pool's creator rights to the fee
//     address right after launch.
// Plus the two launches the game must refuse: fees going elsewhere, and fees not in SOL.
// For A and B: buys recorded, fees split 80% jackpot / 20% team, winner paid in SOL.
import assert from 'node:assert/strict';
import { CollectFeeMode, DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';
import {
  DEFAULT_LAUNCH, attach, feeAddress, fomocity, harvestDbc, launchCurve, readGame, recordBuy, send, settle,
} from './lib.ts';
import { track, type Trade } from './tracker.ts';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`▸ ${s}`);
const big = (v: BN | bigint | number) => BigInt(v.toString());
const P = { minBuy: 0.05 * LAMPORTS_PER_SOL, timeAdd: 5, maxTimer: 15, initial: 15, grace: 2 };
const params = {
  minBuyLamports: new BN(P.minBuy), timeAddPerBuy: new BN(P.timeAdd), maxTimer: new BN(P.maxTimer),
  initialTimer: new BN(P.initial), settleGraceSecs: new BN(P.grace),
};

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
const chainNow = async () => Number((await connection.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'), 'confirmed'))!.data.readBigInt64LE(32));
async function waitUntil(ts: number) { while ((await chainNow()) < ts) await sleep(500); }

/** A launch the way a launcher would do it, outside our launch script. */
async function friendLaunch(friend: Keypair, opts: { feeClaimer: PublicKey; collectFeeMode?: CollectFeeMode }) {
  const mint = Keypair.generate(), config = Keypair.generate();
  const curve = launchCurve({ ...DEFAULT_LAUNCH, migrationQuoteThresholdSol: 50 });
  if (opts.collectFeeMode !== undefined) curve.collectFeeMode = opts.collectFeeMode;
  await send(connection, await dbc.partner.createConfig({
    config: config.publicKey, feeClaimer: opts.feeClaimer, leftoverReceiver: friend.publicKey,
    quoteMint: NATIVE_MINT, payer: friend.publicKey, ...curve,
  }), [friend, config]);
  await send(connection, await dbc.creator.createPool({
    name: 'FOMO', symbol: 'FOMO', uri: 'https://example.com/fomo.json', payer: friend.publicKey,
    poolCreator: friend.publicKey, config: config.publicKey, baseMint: mint.publicKey,
  }), [friend, mint]);
  return { mint: mint.publicKey, pool: (await dbc.state.getPoolByBaseMint(mint.publicKey))!.publicKey };
}

async function playRound(label: string, operator: Keypair, keeper: Keypair, team: Keypair, launched: { mint: PublicKey; pool: PublicKey }) {
  step(`${label}: attach by CA`);
  await attach(connection, operator, { mint: launched.mint, params, roles: { keeper: keeper.publicKey, team: team.publicKey } });
  const program = fomocity(connection, operator);
  let g = await readGame(program, launched.mint);

  step(`${label}: players buy on Meteora; the keeper records them`);
  const [alice, bob] = await Promise.all([funded(5), funded(5)]);
  for (const [kp, sol] of [[alice, 0.4], [bob, 0.3]] as const) {
    await send(connection, await dbc.pool.swap2({
      owner: kp.publicKey, pool: launched.pool, swapBaseForQuote: false, referralTokenAccount: null,
      swapMode: SwapMode.ExactIn, amountIn: new BN(sol * LAMPORTS_PER_SOL), minimumAmountOut: new BN(0),
    }), [kp]);
    await sleep(1_200);
  }
  const trades: Trade[] = [];
  await track(connection, launched.mint, (t) => trades.push(t));
  for (const t of trades.filter((t) => t.side === 'buy')) await recordBuy(fomocity(connection, keeper), keeper, g, t);

  step(`${label}: fees claimed automatically, 80% jackpot / 20% team`);
  await harvestDbc(program, g);
  g = await readGame(program, launched.mint);
  const harvested = big(g.data.stats.harvestedLamports);
  assert.ok(harvested > 0n, 'fees reached the game');
  const r1: any = await (program.account as any).round.fetch(g.round(1));
  assert.equal(big(r1.jackpot), harvested - (harvested * 2000n) / 10000n);
  assert.equal(big(g.data.teamOwed), (harvested * 2000n) / 10000n);

  step(`${label}: bob wins the jackpot in SOL`);
  await waitUntil(r1.endTs.toNumber() + P.grace);
  const bob0 = BigInt(await connection.getBalance(bob.publicKey, 'confirmed'));
  await settle(program, g, operator.publicKey);
  const rent = BigInt(await connection.getMinimumBalanceForRentExemption(165));
  assert.equal(BigInt(await connection.getBalance(bob.publicKey, 'confirmed')) - bob0, big(r1.jackpot) + rent);
  return harvested;
}

async function main() {
  const [friend, operator, keeper] = await Promise.all([funded(40), funded(20), funded(5)]);
  const team = Keypair.generate();
  const fee = feeAddress();

  step('refused: fees going to the launcher only');
  const elsewhere = await friendLaunch(friend, { feeClaimer: friend.publicKey });
  await expectError(attach(connection, operator, { mint: elsewhere.mint, params, roles: { keeper: keeper.publicKey, team: team.publicKey } }), 'neither');

  step('refused: fees not collected in SOL');
  const notSol = await friendLaunch(friend, { feeClaimer: fee, collectFeeMode: CollectFeeMode.OutputToken });
  await expectError(fomocity(connection, operator).methods.initialize(params, { keeper: keeper.publicKey, team: team.publicKey, dammConfig: PublicKey.default })
    .accountsPartial({ authority: operator.publicKey, mint: notSol.mint, quoteMint: NATIVE_MINT, dbcPool: notSol.pool, dbcConfig: (await dbc.state.getPool(notSol.pool))!.poolState.config, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .rpc(), 'FeesNotInSol');

  // A: fee claimer set to the game's fee address at launch.
  const a = await friendLaunch(friend, { feeClaimer: fee });
  const harvestedA = await playRound('A (fee claimer)', operator, keeper, team, a);

  // B: launcher keeps the fee claimer, hands creator rights to the fee address right after
  // launching. (Each game has its own vault, so two games can share the fee address.)
  const b = await friendLaunch(friend, { feeClaimer: friend.publicKey });
  await send(connection, await dbc.creator.transferPoolCreator({ pool: b.pool, creator: friend.publicKey, newCreator: fee }), [friend]);
  const { findLaunch } = await import('./lib.ts');
  const infoB = await findLaunch(connection, b.mint);
  assert.ok(infoB.isCreator && !infoB.isFeeClaimer && infoB.feesToGame, 'creator transfer routes the creator share to the game');
  const harvestedB = await playRound('B (creator transfer)', operator, keeper, team, b);

  console.log(`\n✓ Attach checks passed (fees A: ${harvestedA} lamports, B: ${harvestedB} lamports).`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗', e?.message ?? e);
  if (e?.logs) console.error(e.logs.join('\n'));
  process.exit(1);
});
