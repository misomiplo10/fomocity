// Shared client code for the launch script, the keeper and the localnet test.
// Talks to three programs: fomocity (ours), Meteora DBC and Meteora DAMM v2.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import {
  ActivationType, BaseFeeMode, CollectFeeMode, DynamicBondingCurveClient, MigrationFeeOption,
  MigrationOption, SwapMode, TokenAuthorityOption, TokenDecimal, TokenType, buildCurve,
  deriveDammV2EventAuthority, deriveDammV2PoolAuthority, deriveDbcEventAuthority,
  deriveDbcPoolAddress, deriveDbcPoolAuthority, getCurrentPoint,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, SwapMode as DammSwapMode } from '@meteora-ag/cp-amm-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, type Signer,
} from '@solana/web3.js';
import BN from 'bn.js';

export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
export const DAMM_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

// DAMM v2 config keys DBC migrates into, by MigrationFeeOption (METEORA.md §1).
export const DAMM_V2_CONFIGS: Record<number, PublicKey> = {
  [MigrationFeeOption.FixedBps25]: new PublicKey('7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd'),
  [MigrationFeeOption.FixedBps30]: new PublicKey('2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k'),
  [MigrationFeeOption.FixedBps100]: new PublicKey('Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp'),
  [MigrationFeeOption.FixedBps200]: new PublicKey('2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq'),
  [MigrationFeeOption.FixedBps400]: new PublicKey('AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD'),
  [MigrationFeeOption.FixedBps600]: new PublicKey('DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u'),
};

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
export const IDL = JSON.parse(readFileSync(root('idls/fomocity.json'), 'utf8')) as Idl;
export const PROGRAM_ID = new PublicKey(IDL.address);

// Secrets and endpoints live in scripts/.env (gitignored; see .env.example).
try { process.loadEnvFile(root('scripts/.env')); } catch {}

/** RPC to use: RPC_URL if set, else Helius mainnet from HELIUS_API_KEY. */
export function rpcUrl(): string {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  if (process.env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  throw new Error('set HELIUS_API_KEY (or RPC_URL) in scripts/.env');
}

/** For logs: never print API keys. */
export const redactUrl = (u: string) => u.replace(/(api[-_]?key=)[^&]+/i, '$1***');

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

export function fomocity(connection: Connection, payer: Keypair): Program {
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: 'confirmed' });
  return new Program(IDL, provider);
}

// ---------- addresses ----------

const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const u64le = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

export function gameAddresses(mint: PublicKey) {
  const game = pda([Buffer.from('game'), mint.toBuffer()]);
  return {
    game,
    treasury: pda([Buffer.from('treasury'), game.toBuffer()]),
    vault: pda([Buffer.from('vault'), mint.toBuffer()]),
    wsolVault: pda([Buffer.from('wsol'), game.toBuffer()]),
    stash: pda([Buffer.from('stash'), game.toBuffer()]),
    round: (id: number | bigint) => pda([Buffer.from('round'), game.toBuffer(), u64le(id)]),
    player: (round: PublicKey, owner: PublicKey) => pda([Buffer.from('player'), round.toBuffer(), owner.toBuffer()]),
  };
}

// ---------- launch config ----------

export type LaunchOptions = {
  name: string;
  symbol: string;
  uri: string;
  totalSupply: number;               // whole tokens
  migrationQuoteThresholdSol: number;
  percentageSupplyOnMigration: number;
  antiSniper: { startingFeeBps: number; endingFeeBps: number; numberOfPeriod: number; totalDurationSecs: number };
  migrationFeeOption: MigrationFeeOption;
};

export const DEFAULT_LAUNCH: LaunchOptions = {
  name: 'FOMO City',
  symbol: 'FOMO',
  uri: 'https://fomocity.example/token.json',
  totalSupply: 1_000_000_000,
  migrationQuoteThresholdSol: 85,
  percentageSupplyOnMigration: 20,
  // 50% fee at launch, decaying exponentially to 1% over 2 minutes. Snipers fund the pot.
  antiSniper: { startingFeeBps: 5_000, endingFeeBps: 100, numberOfPeriod: 60, totalDurationSecs: 120 },
  migrationFeeOption: MigrationFeeOption.FixedBps100,
};

export function launchCurve(o: LaunchOptions) {
  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken, // fomocity only accepts plain 82-byte SPL mints
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: o.totalSupply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: o.antiSniper.startingFeeBps,
          endingFeeBps: o.antiSniper.endingFeeBps,
          numberOfPeriod: o.antiSniper.numberOfPeriod,
          totalDuration: o.antiSniper.totalDurationSecs,
        },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken, // every fee in SOL
      creatorTradingFeePercentage: 50,           // irrelevant: treasury is both partner and creator
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,          // keeps CPI swaps simple
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: o.migrationFeeOption,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    // All migrated liquidity is locked forever. The position NFTs land in the treasury
    // PDA, which keeps claiming their trading fees for the jackpot.
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: o.percentageSupplyOnMigration,
    migrationQuoteThreshold: o.migrationQuoteThresholdSol,
  });
}

export async function send(connection: Connection, tx: Transaction, signers: Signer[], cu = 400_000) {
  const hasBudget = tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId));
  if (!hasBudget) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
}

/**
 * Full launch: DBC config (fee claimer = treasury PDA) → pool → hand pool creator to the
 * treasury → initialize the game. The mint keypair is generated up front because every
 * game PDA, including the treasury, is derived from the mint address.
 */
export async function launch(connection: Connection, authority: Keypair, opts: {
  launch?: Partial<LaunchOptions>;
  params: { basePrice: BN; priceStep: BN; timeAddPerFloor: BN; maxTimer: BN; initialTimer: BN; maxFloorsPerBuy: number };
  keeper: PublicKey;
  maxBuybackLamports: BN;
  buybackGapSecs: BN;
  devTokenAccount: (mint: PublicKey) => Promise<PublicKey>;
  mint?: Keypair;
}) {
  const o = { ...DEFAULT_LAUNCH, ...opts.launch };
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const mint = opts.mint ?? Keypair.generate();
  const config = Keypair.generate();
  const a = gameAddresses(mint.publicKey);

  const configTx = await dbc.partner.createConfig({
    config: config.publicKey,
    feeClaimer: a.treasury,
    leftoverReceiver: authority.publicKey,
    quoteMint: NATIVE_MINT,
    payer: authority.publicKey,
    ...launchCurve(o),
  });
  await send(connection, configTx, [authority, config]);

  const poolTx = await dbc.creator.createPool({
    name: o.name, symbol: o.symbol, uri: o.uri,
    payer: authority.publicKey,
    poolCreator: authority.publicKey,
    config: config.publicKey,
    baseMint: mint.publicKey,
  });
  await send(connection, poolTx, [authority, mint]);
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config.publicKey);

  const transferTx = await dbc.creator.transferPoolCreator({ pool, creator: authority.publicKey, newCreator: a.treasury });
  await send(connection, transferTx, [authority]);

  const dev = await opts.devTokenAccount(mint.publicKey);
  const program = fomocity(connection, authority);
  await program.methods
    .initialize(opts.params, {
      keeper: opts.keeper,
      maxLamports: opts.maxBuybackLamports,
      minGapSecs: opts.buybackGapSecs,
      dammConfig: DAMM_V2_CONFIGS[o.migrationFeeOption],
    })
    .accountsStrict({
      authority: authority.publicKey,
      mint: mint.publicKey,
      quoteMint: NATIVE_MINT,
      devTokenAccount: dev,
      game: a.game,
      treasury: a.treasury,
      vault: a.vault,
      wsolVault: a.wsolVault,
      stash: a.stash,
      round: a.round(1),
      dbcPool: pool,
      dbcConfig: config.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return { mint: mint.publicKey, config: config.publicKey, pool, ...a };
}

// ---------- keeper actions ----------

export type GameState = Awaited<ReturnType<typeof readGame>>;

export async function readGame(program: Program, mint: PublicKey) {
  const a = gameAddresses(mint);
  const game: any = await (program.account as any).game.fetch(a.game);
  return { ...a, mint, data: game };
}

function dbcAccounts(g: GameState, pool: { baseVault: PublicKey; quoteVault: PublicKey }) {
  return {
    game: g.game,
    treasury: g.treasury,
    wsolVault: g.wsolVault,
    stash: g.stash,
    mint: g.mint,
    quoteMint: NATIVE_MINT,
    dbcPool: g.data.dbcPool,
    dbcConfig: g.data.dbcConfig,
    baseVault: pool.baseVault,
    quoteVault: pool.quoteVault,
    poolAuthority: deriveDbcPoolAuthority(),
    eventAuthority: deriveDbcEventAuthority(),
    dbcProgram: DBC_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

export async function harvestDbc(program: Program, g: GameState) {
  const dbc = new DynamicBondingCurveClient(program.provider.connection, 'confirmed');
  const pool = await dbc.state.getPool(g.data.dbcPool);
  if (!pool) throw new Error('DBC pool not found');
  return program.methods.harvestDbc().accountsStrict(dbcAccounts(g, pool.poolState)).rpc();
}

export async function harvestDbcSurplus(program: Program, g: GameState) {
  const dbc = new DynamicBondingCurveClient(program.provider.connection, 'confirmed');
  const pool = await dbc.state.getPool(g.data.dbcPool);
  if (!pool) throw new Error('DBC pool not found');
  const { baseVault, stash, mint, ...rest } = dbcAccounts(g, pool.poolState);
  return program.methods.harvestDbcSurplus().accountsStrict(rest).rpc();
}

/**
 * Quote off-chain, then swap `lamports` of harvested SOL on the bonding curve. Refuses
 * while the swap fee is above `maxFeeBps`, so the keeper doesn't buy back during the
 * anti-sniper window and hand 20% of a 50% fee to the protocol.
 */
export async function buybackDbc(program: Program, keeper: Keypair, g: GameState, lamports: BN, slippageBps = 100, maxFeeBps = 200, sender?: Sender) {
  const connection = program.provider.connection;
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const pool = await dbc.state.getPool(g.data.dbcPool);
  const config = await dbc.state.getPoolConfig(g.data.dbcConfig);
  if (!pool || !config) throw new Error('DBC pool not found');
  const quote = dbc.pool.swapQuote2({
    virtualPool: pool, config, swapBaseForQuote: false, hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: await getCurrentPoint(connection, config.activationType),
    slippageBps, swapMode: SwapMode.ExactIn, amountIn: lamports,
  });
  const feeBps = quote.tradingFee.add(quote.protocolFee).add(quote.referralFee).muln(10_000).div(lamports).toNumber();
  if (feeBps > maxFeeBps) throw new Error(`swap fee ${feeBps} bps is above ${maxFeeBps}; waiting for it to decay`);
  const minOut = quote.minimumAmountOut!;
  const builder = program.methods
    .buybackDbc(lamports, minOut)
    .accountsStrict({
      keeper: keeper.publicKey,
      round: g.round(BigInt(g.data.currentRound.toString())),
      vault: g.vault,
      ...dbcAccounts(g, pool.poolState),
    })
    .signers([keeper]);
  const sig = sender ? await sender(await builder.transaction()) : await builder.rpc();
  return { sig, minOut, expectedOut: quote.outputAmount };
}

function dammAccounts(g: GameState, pool: { tokenAVault: PublicKey; tokenBVault: PublicKey }) {
  return {
    game: g.game,
    treasury: g.treasury,
    wsolVault: g.wsolVault,
    stash: g.stash,
    mint: g.mint,
    quoteMint: NATIVE_MINT,
    dammPool: g.data.dammPool,
    tokenAVault: pool.tokenAVault,
    tokenBVault: pool.tokenBVault,
    poolAuthority: deriveDammV2PoolAuthority(),
    eventAuthority: deriveDammV2EventAuthority(),
    dammProgram: DAMM_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

/** Claims fees on every DAMM v2 position the treasury holds in the game's pool. */
export async function harvestDamm(program: Program, g: GameState) {
  const cp = new CpAmm(program.provider.connection);
  const pool = await cp.fetchPoolState(g.data.dammPool);
  const positions = await cp.getUserPositionByPool(g.data.dammPool, g.treasury);
  const sigs = [];
  for (const p of positions) {
    sigs.push(await program.methods.harvestDamm()
      .accountsStrict({ ...dammAccounts(g, pool), position: p.position, positionNftAccount: p.positionNftAccount })
      .rpc());
  }
  return sigs;
}

export async function buybackDamm(program: Program, keeper: Keypair, g: GameState, lamports: BN, slippageBps = 100, sender?: Sender) {
  const connection = program.provider.connection;
  const cp = new CpAmm(connection);
  const pool = await cp.fetchPoolState(g.data.dammPool);
  const slot = await connection.getSlot();
  const currentPoint = pool.activationType === 0 ? new BN(slot) : new BN((await connection.getBlockTime(slot))!);
  const quote = cp.getQuote2({
    inputTokenMint: NATIVE_MINT, slippage: slippageBps / 100, currentPoint, poolState: pool,
    tokenADecimal: 6, tokenBDecimal: 9, hasReferral: false,
    swapMode: DammSwapMode.ExactIn, amountIn: lamports,
  });
  const minOut = quote.minimumAmountOut!;
  const builder = program.methods
    .buybackDamm(lamports, minOut)
    .accountsStrict({
      keeper: keeper.publicKey,
      round: g.round(BigInt(g.data.currentRound.toString())),
      vault: g.vault,
      ...dammAccounts(g, pool),
    })
    .signers([keeper]);
  const sig = sender ? await sender(await builder.transaction()) : await builder.rpc();
  return { sig, minOut, expectedOut: quote.outputAmount };
}

// ---------- private sending (Jito) ----------

export type Sender = (tx: Transaction) => Promise<string>;

/**
 * Sends a transaction through a Jito block engine instead of the public mempool, so
 * searchers can't see a buyback before it lands and sandwich it. Adds a tip transfer to
 * one of Jito's tip accounts (fetched from the block engine). NOT yet tested against a
 * live block engine; localnet has none.
 *   baseUrl e.g. https://mainnet.block-engine.jito.wtf
 */
export function jitoSender(connection: Connection, payer: Keypair, baseUrl: string, tipLamports: number): Sender {
  const rpc = async (path: string, method: string, params: unknown[]) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body: any = await res.json();
    if (body.error) throw new Error(`jito ${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  };
  return async (tx) => {
    const tips: string[] = await rpc('/api/v1/getTipAccounts', 'getTipAccounts', []);
    const tipTo = new PublicKey(tips[Math.floor(Math.random() * tips.length)]);
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: tipTo, lamports: tipLamports }));
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    const sig: string = await rpc('/api/v1/transactions', 'sendTransaction', [tx.serialize().toString('base64'), { encoding: 'base64' }]);
    const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (conf.value.err) throw new Error(`buyback failed: ${JSON.stringify(conf.value.err)}`);
    return sig;
  };
}

export async function settle(program: Program, g: GameState, cranker: PublicKey) {
  const id = BigInt(g.data.currentRound.toString());
  return program.methods.settle().accountsStrict({
    cranker, game: g.game, round: g.round(id), nextRound: g.round(id + 1n), systemProgram: SystemProgram.programId,
  }).rpc();
}
