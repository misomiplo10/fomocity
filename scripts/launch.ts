// One-shot launch: creates the DBC config + pool and binds the game to it.
//
//   AUTHORITY=~/.config/solana/id.json KEEPER_PUBKEY=<keeper> npm run launch   (RPC from scripts/.env)
//
// Anything other than a local validator is treated as mainnet: the script prints the full
// launch plan and stops unless CONFIRM_MAINNET=yes is set. A launch can't be undone.
//
// Prints the addresses to put in the web client and the keeper's MINT env var.
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { DEFAULT_LAUNCH, feeAddress, launch, loadKeypair, redactUrl, rpcUrl } from './lib.ts';

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const RPC_URL = rpcUrl();
const connection = new Connection(RPC_URL, 'confirmed');
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC_URL);
const authority = loadKeypair(env('AUTHORITY', '~/.config/solana/id.json').replace(/^~/, process.env.HOME!));

const launchOpts = {
  name: env('TOKEN_NAME', DEFAULT_LAUNCH.name),
  symbol: env('TOKEN_SYMBOL', DEFAULT_LAUNCH.symbol),
  uri: env('TOKEN_URI', DEFAULT_LAUNCH.uri),
  migrationQuoteThresholdSol: Number(env('MIGRATION_SOL', String(DEFAULT_LAUNCH.migrationQuoteThresholdSol))),
};

// Round rules. A buy of FOMO anywhere (Jupiter, Meteora, any wallet) counts when it puts at
// least MIN_BUY_SOL into the pool; each counted buy adds SECS_PER_BUY to the countdown, which
// never shows more than MAX_TIMER_SECS. The last counted buyer is paid the jackpot.
const minBuySol = Number(env('MIN_BUY_SOL', '0.05'));
const secsPerBuy = Number(env('SECS_PER_BUY', '30'));
const maxTimer = Number(env('MAX_TIMER_SECS', '1800'));
const graceSecs = Number(env('SETTLE_GRACE_SECS', '60'));

const keeperKey = new PublicKey(env('KEEPER_PUBKEY'));
const teamKey = new PublicKey(env('TEAM_WALLET'));
const plan = {
  network: local ? 'localnet' : 'MAINNET',
  rpc: redactUrl(RPC_URL),
  authority: authority.publicKey.toBase58(),
  authoritySol: (await connection.getBalance(authority.publicKey)) / LAMPORTS_PER_SOL,
  token: `${launchOpts.name} (${launchOpts.symbol}) ${launchOpts.uri}`,
  tradingFee: '3% flat',
  migrationSol: launchOpts.migrationQuoteThresholdSol,
  fees: `game fee address ${feeAddress().toBase58()} → 80% jackpot (SOL) · 20% team`,
  minBuySol, secsPerBuy, maxTimerSecs: maxTimer, settleGraceSecs: graceSecs,
  keeper: keeperKey.toBase58(),
  team: teamKey.toBase58(),
};
console.error('\nLaunch plan:'); console.error(plan);
if (!local && process.env.CONFIRM_MAINNET !== 'yes') {
  console.error('\nNot sent. This is irreversible. Re-run with CONFIRM_MAINNET=yes once the plan above is right.');
  process.exit(1);
}

const res = await launch(connection, authority, {
  launch: launchOpts,
  params: {
    minBuyLamports: new BN(Math.round(minBuySol * LAMPORTS_PER_SOL)),
    timeAddPerBuy: new BN(secsPerBuy),
    maxTimer: new BN(maxTimer),
    initialTimer: new BN(maxTimer),
    settleGraceSecs: new BN(graceSecs),
  },
  roles: { keeper: keeperKey, team: teamKey },
});

console.log(JSON.stringify({
  mint: res.mint.toBase58(), dbcConfig: res.config.toBase58(), dbcPool: res.pool.toBase58(),
  game: res.game.toBase58(), feeAddress: res.treasury.toBase58(),
}, null, 2));
