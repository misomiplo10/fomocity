// One-shot launch: creates the DBC config + pool and binds the game to it.
//
//   RPC_URL=https://api.devnet.solana.com AUTHORITY=~/.config/solana/id.json \
//   KEEPER_PUBKEY=<keeper> npm run launch
//
// Prints the addresses to put in the web client and the keeper's MINT env var.
import { getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { DEFAULT_LAUNCH, launch, loadKeypair } from './lib.ts';

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const connection = new Connection(env('RPC_URL', 'https://api.devnet.solana.com'), 'confirmed');
const authority = loadKeypair(env('AUTHORITY', '~/.config/solana/id.json').replace(/^~/, process.env.HOME!));

const res = await launch(connection, authority, {
  launch: {
    name: env('TOKEN_NAME', DEFAULT_LAUNCH.name),
    symbol: env('TOKEN_SYMBOL', DEFAULT_LAUNCH.symbol),
    uri: env('TOKEN_URI', DEFAULT_LAUNCH.uri),
    migrationQuoteThresholdSol: Number(env('MIGRATION_SOL', String(DEFAULT_LAUNCH.migrationQuoteThresholdSol))),
  },
  // Floor price 1 FOMO + 0.01 per floor sold; 30s per floor, 24h cap (same as game.js).
  params: {
    basePrice: new BN(1_000_000), priceStep: new BN(10_000), timeAddPerFloor: new BN(30),
    maxTimer: new BN(86_400), initialTimer: new BN(86_400), maxFloorsPerBuy: 100,
  },
  keeper: new PublicKey(env('KEEPER_PUBKEY')),
  maxBuybackLamports: new BN(Number(env('MAX_BUYBACK_SOL', '1')) * LAMPORTS_PER_SOL),
  buybackGapSecs: new BN(env('BUYBACK_GAP_SECS', '300')),
  devTokenAccount: async (mint) =>
    (await getOrCreateAssociatedTokenAccount(connection, authority, mint, new PublicKey(env('DEV_WALLET', authority.publicKey.toBase58())))).address,
});

console.log(JSON.stringify({
  mint: res.mint.toBase58(), dbcConfig: res.config.toBase58(), dbcPool: res.pool.toBase58(),
  game: res.game.toBase58(), treasury: res.treasury.toBase58(),
}, null, 2));
