// One-shot launch: creates the DBC config + pool and binds the game to it.
//
//   RPC_URL=<mainnet RPC> AUTHORITY=~/.config/solana/id.json KEEPER_PUBKEY=<keeper> npm run launch
//
// Anything other than a local validator is treated as mainnet: the script prints the full
// launch plan and stops unless CONFIRM_MAINNET=yes is set. A launch can't be undone.
//
// Prints the addresses to put in the web client and the keeper's MINT env var.
import { getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { DEFAULT_LAUNCH, launch, launchCurve, loadKeypair } from './lib.ts';

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const RPC_URL = env('RPC_URL');
const connection = new Connection(RPC_URL, 'confirmed');
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC_URL);
const authority = loadKeypair(env('AUTHORITY', '~/.config/solana/id.json').replace(/^~/, process.env.HOME!));

const launchOpts = {
  name: env('TOKEN_NAME', DEFAULT_LAUNCH.name),
  symbol: env('TOKEN_SYMBOL', DEFAULT_LAUNCH.symbol),
  uri: env('TOKEN_URI', DEFAULT_LAUNCH.uri),
  migrationQuoteThresholdSol: Number(env('MIGRATION_SOL', String(DEFAULT_LAUNCH.migrationQuoteThresholdSol))),
};

// Floor prices are in FOMO, but players think in SOL. Price the first floor at
// FLOOR_PRICE_SOL using the curve's starting token price; each floor sold adds 1%.
// As FOMO's price rises on the curve, floors get pricier in SOL too.
const startPrice = Number(getPriceFromSqrtPrice(launchCurve({ ...DEFAULT_LAUNCH, ...launchOpts }).sqrtStartPrice, 6, 9)); // SOL per FOMO
const floorPriceSol = Number(env('FLOOR_PRICE_SOL', '0.01'));
const basePrice = Math.round((floorPriceSol / startPrice) * 1e6); // FOMO base units
console.error(`start price ${startPrice.toExponential(3)} SOL/FOMO → first floor ${(basePrice / 1e6).toLocaleString()} FOMO (${floorPriceSol} SOL)`);

const keeperKey = new PublicKey(env('KEEPER_PUBKEY'));
const devWallet = new PublicKey(env('DEV_WALLET', authority.publicKey.toBase58()));
const maxBuybackSol = Number(env('MAX_BUYBACK_SOL', '1'));
const plan = {
  network: local ? 'localnet' : 'MAINNET',
  rpc: RPC_URL,
  authority: authority.publicKey.toBase58(),
  authoritySol: (await connection.getBalance(authority.publicKey)) / LAMPORTS_PER_SOL,
  token: `${launchOpts.name} (${launchOpts.symbol}) ${launchOpts.uri}`,
  migrationSol: launchOpts.migrationQuoteThresholdSol,
  firstFloor: `${floorPriceSol} SOL = ${(basePrice / 1e6).toLocaleString()} FOMO`,
  secsPerFloor: Number(env('SECS_PER_FLOOR', '30')),
  maxTimerSecs: Number(env('MAX_TIMER_SECS', '1800')),
  keeper: keeperKey.toBase58(),
  buyback: `≤ ${maxBuybackSol} SOL every ≥ ${env('BUYBACK_GAP_SECS', '300')}s`,
  devWallet: devWallet.toBase58(),
};
console.error('\nLaunch plan:'); console.error(plan);
if (!local && process.env.CONFIRM_MAINNET !== 'yes') {
  console.error('\nNot sent. This is irreversible. Re-run with CONFIRM_MAINNET=yes once the plan above is right.');
  process.exit(1);
}

const res = await launch(connection, authority, {
  launch: launchOpts,
  // Rounds start at 30 min; each floor adds 30s, never above 30 min remaining.
  params: {
    basePrice: new BN(basePrice), priceStep: new BN(Math.max(1, Math.round(basePrice / 100))),
    timeAddPerFloor: new BN(env('SECS_PER_FLOOR', '30')),
    maxTimer: new BN(env('MAX_TIMER_SECS', '1800')), initialTimer: new BN(env('MAX_TIMER_SECS', '1800')),
    maxFloorsPerBuy: 100,
  },
  keeper: keeperKey,
  maxBuybackLamports: new BN(maxBuybackSol * LAMPORTS_PER_SOL),
  buybackGapSecs: new BN(env('BUYBACK_GAP_SECS', '300')),
  devTokenAccount: async (mint) =>
    (await getOrCreateAssociatedTokenAccount(connection, authority, mint, devWallet)).address,
});

console.log(JSON.stringify({
  mint: res.mint.toBase58(), dbcConfig: res.config.toBase58(), dbcPool: res.pool.toBase58(),
  game: res.game.toBase58(), treasury: res.treasury.toBase58(),
}, null, 2));
