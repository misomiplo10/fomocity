// On-chain game rules on a local validator (./localnet.sh): floor pricing and splits,
// dividends, a buyback after the timer ran out, settle, jackpot claims, a round with no
// buyers carrying over, and renouncing the admin key. Amounts are checked exactly against
// BigInt versions of the formulas in lib.rs.
import assert from 'node:assert/strict';
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { TOKEN_PROGRAM_ID, getAccount, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { buybackDbc, fomocity, harvestDbc, launch, readGame, send, settle, type GameState } from './lib.ts';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`▸ ${s}`);
const big = (v: BN | bigint | number) => BigInt(v.toString());

const P = { base: 1_000_000n, step: 10_000n, timeAdd: 2, maxTimer: 20, initialTimer: 10 };
const ACC = 1_000_000_000_000n;
const bp = (a: bigint, bps: bigint) => (a * bps) / 10_000n;
const costOf = (sold: bigint, n: bigint) => n * P.base + P.step * (n * sold + (n * (n - 1n)) / 2n);

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
async function waitUntil(ts: number) {
  while ((await chainNow()) < ts) await sleep(1000);
}

async function main() {
  const [authority, keeper, alice, bob, carol] = await Promise.all([funded(50), funded(5), funded(20), funded(20), funded(5)]);

  step('launch with 10s rounds');
  const g0 = await launch(connection, authority, {
    launch: { migrationQuoteThresholdSol: 50, antiSniper: { startingFeeBps: 1_000, endingFeeBps: 100, numberOfPeriod: 2, totalDurationSecs: 2 } },
    params: {
      basePrice: new BN(P.base.toString()), priceStep: new BN(P.step.toString()), timeAddPerFloor: new BN(P.timeAdd),
      maxTimer: new BN(P.maxTimer), initialTimer: new BN(P.initialTimer), maxFloorsPerBuy: 100,
    },
    keeper: keeper.publicKey,
    maxBuybackLamports: new BN(LAMPORTS_PER_SOL),
    buybackGapSecs: new BN(0),
    devTokenAccount: async (mint) => (await getOrCreateAssociatedTokenAccount(connection, authority, mint, authority.publicKey)).address,
  });
  const program = fomocity(connection, authority);
  let g: GameState = await readGame(program, g0.mint);
  const fetchRound = async (id: number) => (program.account as any).round.fetch(g.round(id));

  step('players buy FOMO on the bonding curve');
  await sleep(3_000);
  const ata: Record<string, PublicKey> = {};
  for (const [name, kp] of Object.entries({ alice, bob, carol })) {
    const tx = await dbc.pool.swap2({
      owner: kp.publicKey, pool: g0.pool, swapBaseForQuote: false, referralTokenAccount: null,
      swapMode: SwapMode.ExactIn, amountIn: new BN(LAMPORTS_PER_SOL), minimumAmountOut: new BN(0),
    });
    await send(connection, tx, [kp]);
    ata[name] = (await getOrCreateAssociatedTokenAccount(connection, kp, g.mint, kp.publicKey)).address;
  }
  const bal = async (a: PublicKey) => (await getAccount(connection, a)).amount;

  const buy = (kp: Keypair, n: number, roundId = 1, maxCost = 1_000_000_000) => {
    const round = g.round(roundId);
    return fomocity(connection, kp).methods.buy(n, new BN(maxCost)).accountsStrict({
      buyer: kp.publicKey, game: g.game, mint: g.mint, round, playerRound: g.player(round, kp.publicKey),
      buyerTokenAccount: ata[kp === alice ? 'alice' : kp === bob ? 'bob' : 'carol'], vault: g.vault,
      devTokenAccount: g.data.devTokenAccount, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
  };

  step('slippage guard and floor-count guard');
  await expectError(buy(alice, 4, 1, Number(costOf(0n, 4n)) - 1), 'SlippageExceeded');
  await expectError(buy(alice, 101), 'BadFloorCount');

  step('alice buys 4, bob buys 2: splits and dividends are exact');
  const devBefore = await bal(g.data.devTokenAccount);
  await buy(alice, 4);
  const c1 = costOf(0n, 4n);
  await buy(bob, 2);
  const c2 = costOf(4n, 2n);
  // First buy has no earlier holders, so its dividend slice joins the jackpot.
  const jackpot1 = c1 - bp(c1, 1_000n) - bp(c1, 500n);
  const div2 = bp(c2, 3_500n);
  const jackpot2 = c2 - div2 - bp(c2, 1_000n) - bp(c2, 500n);
  const acc = (div2 * ACC) / 4n;
  let r1 = await fetchRound(1);
  assert.equal(big(r1.totalFloors), 6n);
  assert.equal(big(r1.jackpot), jackpot1 + jackpot2);
  assert.equal(big(r1.nextRoundPot), bp(c1, 1_000n) + bp(c2, 1_000n));
  assert.equal(big(r1.accPerFloor), acc);
  assert.equal(r1.lastBuyer.toBase58(), bob.publicKey.toBase58());
  assert.equal((await bal(g.data.devTokenAccount)) - devBefore, bp(c1, 500n) + bp(c2, 500n), '5% dev');

  step('alice claims dividends; bob has none (his floors came after)');
  const owed = (4n * acc) / ACC;
  const a0 = await bal(ata.alice);
  const claim = (kp: Keypair, tokenAccount: PublicKey, roundId = 1) => fomocity(connection, kp).methods.claimDividends().accountsStrict({
    owner: kp.publicKey, game: g.game, mint: g.mint, round: g.round(roundId), playerRound: g.player(g.round(roundId), kp.publicKey),
    ownerTokenAccount: tokenAccount, vault: g.vault, tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
  await claim(alice, ata.alice);
  assert.equal((await bal(ata.alice)) - a0, owed);
  await expectError(claim(alice, ata.alice), 'NothingToClaim');
  await expectError(claim(bob, ata.bob), 'NothingToClaim');

  step('timer: each floor adds 2s, capped at 20s from the buy');
  r1 = await fetchRound(1);
  assert.ok(r1.endTs.toNumber() <= r1.startTs.toNumber() + P.initialTimer + 6 * P.timeAdd);

  step('round expires: buys are rejected');
  await waitUntil(r1.endTs.toNumber());
  await expectError(buy(carol, 1), 'RoundOver');

  step('buyback after expiry goes to the next round, not the decided jackpot');
  await harvestDbc(program, g);
  g = await readGame(program, g0.mint);
  const wsol = big((await getAccount(connection, g.wsolVault)).amount);
  assert.ok(wsol > 0n);
  const jackpotBefore = big((await fetchRound(1)).jackpot);
  const nextBefore = big((await fetchRound(1)).nextRoundPot);
  await buybackDbc(program, keeper, g, new BN(wsol.toString()));
  g = await readGame(program, g0.mint);
  const out = big(g.data.stats.boughtTokens);
  r1 = await fetchRound(1);
  assert.equal(big(r1.jackpot), jackpotBefore, 'jackpot untouched');
  assert.equal(big(r1.nextRoundPot) - nextBefore, out - bp(out, 1_000n), '90% to next round');

  step('settle (anyone) opens round 2 seeded with the next-round pot');
  await settle(fomocity(connection, carol), g, carol.publicKey);
  await expectError(settle(fomocity(connection, carol), await readGame(program, g0.mint), carol.publicKey), 'TimerRunning');
  g = await readGame(program, g0.mint);
  assert.equal(big(g.data.currentRound), 2n);
  const r2 = await fetchRound(2);
  assert.equal(big(r2.jackpot), big(r1.nextRoundPot));

  step('jackpot only pays the last buyer, once');
  const claimJackpot = (winnerAta: PublicKey) => program.methods.claimJackpot().accountsStrict({
    game: g.game, mint: g.mint, round: g.round(1), winnerTokenAccount: winnerAta, vault: g.vault, tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
  await expectError(claimJackpot(ata.alice), 'ConstraintTokenOwner');
  const b0 = await bal(ata.bob);
  await claimJackpot(ata.bob);
  assert.equal((await bal(ata.bob)) - b0, big(r1.jackpot));
  await expectError(claimJackpot(ata.bob), 'NothingToClaim');

  step('round 2 with no buyers carries everything into round 3');
  await waitUntil(r2.endTs.toNumber());
  await settle(program, g, authority.publicKey);
  g = await readGame(program, g0.mint);
  const r3 = await fetchRound(3);
  assert.equal(big(r3.jackpot), big(r2.jackpot) + big(r2.nextRoundPot));

  step('vault holds exactly what is still owed');
  // Owed: round 3 jackpot + any unclaimed round-1/2 dividends (none) + rounding dust.
  const vault = await bal(g.vault);
  assert.ok(vault >= big(r3.jackpot), `vault ${vault} covers round 3 jackpot ${r3.jackpot}`);
  assert.ok(vault - big(r3.jackpot) < 10n, `dust only (${vault - big(r3.jackpot)})`);

  step('admin hands off and renounces');
  const ms = Keypair.generate();
  await program.methods.setAuthority(ms.publicKey).accountsStrict({ authority: authority.publicKey, game: g.game }).rpc();
  await expectError(program.methods.setKeeper(authority.publicKey).accountsStrict({ authority: authority.publicKey, game: g.game }).rpc(), 'ConstraintHasOne');
  await connection.confirmTransaction(await connection.requestAirdrop(ms.publicKey, LAMPORTS_PER_SOL), 'confirmed');
  await fomocity(connection, ms).methods.setAuthority(PublicKey.default).accountsStrict({ authority: ms.publicKey, game: g.game }).rpc();
  g = await readGame(program, g0.mint);
  assert.ok(g.data.authority.equals(PublicKey.default));

  console.log('\n✓ All round-rule checks passed.');
}

main().catch((e) => {
  console.error('\n✗', e?.message ?? e);
  if (e?.logs) console.error(e.logs.join('\n'));
  process.exit(1);
});
