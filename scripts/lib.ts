// Shared client code for the launch script, the keeper and the localnet test.
// Talks to three programs: fomocity (ours), Meteora DBC and Meteora DAMM v2.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AnchorProvider, Program, Wallet, utils, type Idl } from '@coral-xyz/anchor';
import {
  ActivationType, BaseFeeMode, CollectFeeMode, DynamicBondingCurveClient, MigrationFeeOption,
  MigrationOption, SwapMode, TokenAuthorityOption, TokenDecimal, TokenType, buildCurve,
  deriveDammV2EventAuthority, deriveDammV2PoolAuthority, deriveDbcEventAuthority,
  deriveDbcPoolAddress, deriveDbcPoolAuthority, getCurrentPoint,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, SwapMode as DammSwapMode } from '@meteora-ag/cp-amm-sdk';
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, type Signer,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import BN from 'bn.js';

const bs58 = utils.bytes.bs58;

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
  [MigrationFeeOption.Customizable]: new PublicKey('A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck'),
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

/**
 * The game's fee address: the treasury PDA. It depends only on the program, not on the token,
 * so the launcher can set it as the pool's fee claimer (or hand it the pool's creator rights)
 * before or right after launching.
 */
export const feeAddress = () => pda([Buffer.from('treasury')]);

export function gameAddresses(mint: PublicKey) {
  const game = pda([Buffer.from('game'), mint.toBuffer()]);
  return {
    game,
    treasury: feeAddress(),
    wsolVault: pda([Buffer.from('wsol'), game.toBuffer()]),
    stash: pda([Buffer.from('stash'), game.toBuffer()]),
    payout: pda([Buffer.from('payout'), game.toBuffer()]),
    round: (id: number | bigint) => pda([Buffer.from('round'), game.toBuffer(), u64le(id)]),
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
  /** Trading fee schedule. Equal start and end = a flat fee. */
  fee: { startingFeeBps: number; endingFeeBps: number; numberOfPeriod: number; totalDurationSecs: number };
  migrationFeeOption: MigrationFeeOption;
};

export const DEFAULT_LAUNCH: LaunchOptions = {
  name: 'Fomo City',
  symbol: 'FOMO',
  uri: 'https://www.fomocity.net/token.json',
  totalSupply: 1_000_000_000,
  migrationQuoteThresholdSol: 85,
  percentageSupplyOnMigration: 20,
  // Flat 3% trading fee, no launch sniper fee.
  fee: { startingFeeBps: 300, endingFeeBps: 300, numberOfPeriod: 0, totalDurationSecs: 0 },
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
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: o.fee.startingFeeBps,
          endingFeeBps: o.fee.endingFeeBps,
          numberOfPeriod: o.fee.numberOfPeriod,
          totalDuration: o.fee.totalDurationSecs,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken, // every fee in SOL (the game requires it)
      creatorTradingFeePercentage: 50,           // irrelevant: treasury is both partner and creator
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
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

/** Round rules, as stored on-chain (see Params in lib.rs). */
export type GameParams = {
  minBuyLamports: BN;     // smallest buy that counts
  timeAddPerBuy: BN;      // seconds each counted buy adds
  maxTimer: BN;           // countdown cap after the latest buy
  initialTimer: BN;       // countdown when a round opens
  settleGraceSecs: BN;    // wait after zero before settling, for late-reported buys
};

/** keeper reports buys; team receives 20% of fees. */
export type GameRoles = { keeper: PublicKey; team: PublicKey };

async function initializeGame(connection: Connection, authority: Keypair, mint: PublicKey, pool: PublicKey, config: PublicKey, dammConfig: PublicKey, params: GameParams, roles: GameRoles) {
  const a = gameAddresses(mint);
  await fomocity(connection, authority).methods
    .initialize(params, { keeper: roles.keeper, team: roles.team, dammConfig })
    .accountsStrict({
      authority: authority.publicKey, mint, quoteMint: NATIVE_MINT, game: a.game, treasury: a.treasury,
      wsolVault: a.wsolVault, stash: a.stash, round: a.round(1), dbcPool: pool, dbcConfig: config,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
  return a;
}

/**
 * Our own full launch: DBC config with the fee address as fee claimer → pool → hand the
 * pool's creator rights to the fee address → initialize the game.
 */
export async function launch(connection: Connection, authority: Keypair, opts: {
  launch?: Partial<LaunchOptions>;
  params: GameParams;
  roles: GameRoles;
  mint?: Keypair;
  /** Optional dev buy by the launching wallet, in the same transaction that creates the pool
   *  (so it's the token's very first trade). It comes before the game exists, so it doesn't
   *  count as a game buy. */
  firstBuySol?: number;
}) {
  const o = { ...DEFAULT_LAUNCH, ...opts.launch };
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const mint = opts.mint ?? Keypair.generate();
  const config = Keypair.generate();

  await send(connection, await dbc.partner.createConfig({
    config: config.publicKey, feeClaimer: feeAddress(), leftoverReceiver: authority.publicKey,
    quoteMint: NATIVE_MINT, payer: authority.publicKey, ...launchCurve(o),
  }), [authority, config]);
  const createPoolParam = {
    name: o.name, symbol: o.symbol, uri: o.uri, payer: authority.publicKey,
    poolCreator: authority.publicKey, config: config.publicKey, baseMint: mint.publicKey,
  };
  const firstBuy = opts.firstBuySol ? new BN(Math.round(opts.firstBuySol * LAMPORTS_PER_SOL)) : null;
  await send(connection, firstBuy
    ? await dbc.creator.createPoolWithFirstBuy({
      createPoolParam,
      firstBuyParam: { buyer: authority.publicKey, receiver: authority.publicKey, buyAmount: firstBuy, minimumAmountOut: new BN(0), referralTokenAccount: null },
    })
    : await dbc.creator.createPool(createPoolParam), [authority, mint]);
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config.publicKey);
  await send(connection, await dbc.creator.transferPoolCreator({ pool, creator: authority.publicKey, newCreator: feeAddress() }), [authority]);

  const a = await initializeGame(connection, authority, mint.publicKey, pool, config.publicKey, DAMM_V2_CONFIGS[o.migrationFeeOption], opts.params, opts.roles);
  return { mint: mint.publicKey, config: config.publicKey, pool, ...a };
}

/**
 * Attach the game to a token someone else launched on Meteora DBC (paired with SOL, fees in
 * SOL, plain SPL token), whose fee claimer and/or creator is the game's fee address.
 */
export async function attach(connection: Connection, authority: Keypair, opts: { mint: PublicKey; params: GameParams; roles: GameRoles }) {
  const info = await findLaunch(connection, opts.mint);
  if (!info.feesToGame) throw new Error(`the game's fee address ${feeAddress().toBase58()} is neither this pool's fee claimer nor its creator`);
  const a = await initializeGame(connection, authority, opts.mint, info.pool, info.config, info.dammConfig, opts.params, opts.roles);
  return { mint: opts.mint, pool: info.pool, config: info.config, ...a };
}

/** Finds a token's Meteora DBC pool and checks whether the game can attach to it. */
export async function findLaunch(connection: Connection, mint: PublicKey) {
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error(`no token at ${mint.toBase58()}`);
  if (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) || mintInfo.data.length !== 82) {
    throw new Error('token is not a plain SPL token (Token-2022 tokens are not supported); launch with Token type: SPL Token');
  }
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const found = await dbc.state.getPoolByBaseMint(mint);
  if (!found) throw new Error('no Meteora DBC pool found for this token');
  const config = await dbc.state.getPoolConfig(found.account.poolState.config);
  if (!config) throw new Error('DBC pool config not found');
  if (!config.quoteMint.equals(NATIVE_MINT)) throw new Error('pool is not paired with SOL');
  const dammConfig = DAMM_V2_CONFIGS[config.migrationFeeOption];
  if (!dammConfig) throw new Error(`unsupported migration fee option ${config.migrationFeeOption}`);
  const fee = feeAddress();
  const isFeeClaimer = config.feeClaimer.equals(fee);
  const isCreator = found.account.poolState.creator.equals(fee);
  return {
    pool: found.publicKey,
    config: found.account.poolState.config,
    dammConfig,
    migrated: found.account.poolState.isMigrated === 1,
    feeClaimer: config.feeClaimer,
    creator: found.account.poolState.creator,
    feesInSol: config.collectFeeMode === 0,
    creatorFeePercent: config.creatorTradingFeePercentage,
    isFeeClaimer, isCreator, feesToGame: isFeeClaimer || isCreator,
  };
}

// ---------- game actions ----------

export type GameState = Awaited<ReturnType<typeof readGame>>;

export async function readGame(program: Program, mint: PublicKey) {
  const a = gameAddresses(mint);
  const game: any = await (program.account as any).game.fetch(a.game);
  return { ...a, mint, data: game };
}

const currentRound = (g: GameState) => g.round(BigInt(g.data.currentRound.toString()));

/** Anyone: add SOL straight to the jackpot (100%, no team share). */
export async function fundSol(program: Program, funder: Keypair, g: GameState, lamports: BN) {
  return program.methods.fundSol(lamports)
    .accountsStrict({ funder: funder.publicKey, game: g.game, round: currentRound(g), wsolVault: g.wsolVault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .signers([funder])
    .rpc();
}

function dbcAccounts(g: GameState, pool: { baseVault: PublicKey; quoteVault: PublicKey }) {
  return {
    game: g.game,
    round: currentRound(g),
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

/** Anyone: claim the fee address's DBC trading fees; 80% jackpot, 20% team. */
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

/** SOL fees the fee address can claim right now on the DBC pool (lamports). */
export async function claimableDbcFees(connection: Connection, g: GameState) {
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const s = (await dbc.state.getPool(g.data.dbcPool))!.poolState;
  const cfg = (await dbc.state.getPoolConfig(g.data.dbcConfig))!;
  let owed = new BN(0);
  if (cfg.feeClaimer.equals(g.treasury)) owed = owed.add(s.partnerQuoteFee);
  if (s.creator.equals(g.treasury)) owed = owed.add(s.creatorQuoteFee);
  return owed;
}

/** Claims fees on every DAMM v2 position the fee address holds in the game's pool. */
export async function harvestDamm(program: Program, g: GameState) {
  const cp = new CpAmm(program.provider.connection);
  const pool = await cp.fetchPoolState(g.data.dammPool);
  const positions = await cp.getUserPositionByPool(g.data.dammPool, g.treasury);
  const sigs = [];
  for (const p of positions) {
    sigs.push(await program.methods.harvestDamm().accountsStrict({
      game: g.game, round: currentRound(g), treasury: g.treasury, wsolVault: g.wsolVault, stash: g.stash,
      mint: g.mint, quoteMint: NATIVE_MINT, dammPool: g.data.dammPool, position: p.position,
      positionNftAccount: p.positionNftAccount, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault,
      poolAuthority: deriveDammV2PoolAuthority(), eventAuthority: deriveDammV2EventAuthority(),
      dammProgram: DAMM_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc());
  }
  return sigs;
}

/**
 * Settles the current round once its countdown (plus grace) has run out. If it has a
 * winner, the jackpot is sent to their wallet as SOL in the same transaction.
 */
export async function settle(program: Program, g: GameState, cranker: PublicKey) {
  const id = BigInt(g.data.currentRound.toString());
  const round: any = await (program.account as any).round.fetch(g.round(id));
  return program.methods.settle().accountsStrict({
    cranker, game: g.game, round: g.round(id), nextRound: g.round(id + 1n), treasury: g.treasury,
    wsolVault: g.wsolVault, quoteMint: NATIVE_MINT, payout: g.payout,
    // null = no winner: Anchor passes the optional account as absent.
    winner: (round.buyCount > 0 ? round.lastBuyer : null) as any,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc();
}

/** Anyone: send the team's accumulated 20% to the team wallet as SOL. */
export async function withdrawTeam(program: Program, g: GameState, cranker: PublicKey) {
  return program.methods.withdrawTeam().accountsStrict({
    cranker, game: g.game, treasury: g.treasury, wsolVault: g.wsolVault, quoteMint: NATIVE_MINT,
    payout: g.payout, team: g.data.cfg.team, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc();
}

/** Admin: announce that the current round is the last one (can't be undone). */
export async function setFinalRound(program: Program, authority: PublicKey, g: GameState) {
  return program.methods.setFinalRound().accountsStrict({ authority, game: g.game }).rpc();
}

/** Keeper: report one qualifying buy (from the tracker) to the program. */
export async function recordBuy(program: Program, keeper: Keypair, g: GameState, t: { wallet: string; lamports: string; time: number | null; sig: string }) {
  return program.methods
    .recordBuy(new PublicKey(t.wallet), new BN(t.lamports), new BN(t.time ?? 0), [...bs58.decode(t.sig)])
    .accountsStrict({ keeper: keeper.publicKey, game: g.game, round: currentRound(g) })
    .signers([keeper])
    .rpc();
}
