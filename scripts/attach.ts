// Attach the game to a token that was already launched on Meteora DBC by someone else.
//
//   AUTHORITY=~/.config/solana/id.json KEEPER_PUBKEY=<keeper> MINT=<token CA> npm run attach
//
// The token must be a plain SPL token paired with SOL. Its trading fees keep going to
// whoever launched it, so the jackpot is funded with `npm run fund` (SOL or FOMO) instead
// of automatic fee buybacks. Anything other than a local validator is treated as mainnet:
// the script prints the plan and stops unless CONFIRM_MAINNET=yes is set.
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { attach, findLaunch, loadKeypair, redactUrl, rpcUrl } from './lib.ts';

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const RPC_URL = rpcUrl();
const connection = new Connection(RPC_URL, 'confirmed');
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC_URL);
const authority = loadKeypair(env('AUTHORITY', '~/.config/solana/id.json').replace(/^~/, process.env.HOME!));
const mint = new PublicKey(env('MINT'));

const launch = await findLaunch(connection, mint);
const minBuySol = Number(env('MIN_BUY_SOL', '0.05'));
const secsPerBuy = Number(env('SECS_PER_BUY', '30'));
const maxTimer = Number(env('MAX_TIMER_SECS', '1800'));
const graceSecs = Number(env('SETTLE_GRACE_SECS', '60'));
const keeperKey = new PublicKey(env('KEEPER_PUBKEY'));
const maxBuybackSol = Number(env('MAX_BUYBACK_SOL', '1'));

console.error('\nAttach plan:');
console.error({
  network: local ? 'localnet' : 'MAINNET',
  rpc: redactUrl(RPC_URL),
  token: mint.toBase58(),
  meteoraPool: launch.pool.toBase58(),
  alreadyGraduated: launch.migrated,
  feesGoTo: `${launch.feeClaimer.toBase58()} (partner) / ${launch.creator.toBase58()} (creator), not the game`,
  authority: authority.publicKey.toBase58(),
  minBuySol, secsPerBuy, maxTimerSecs: maxTimer, settleGraceSecs: graceSecs,
  keeper: keeperKey.toBase58(),
  buybackOfFundedSol: `≤ ${maxBuybackSol} SOL every ≥ ${env('BUYBACK_GAP_SECS', '300')}s`,
});
if (!local && process.env.CONFIRM_MAINNET !== 'yes') {
  console.error('\nNot sent. This is irreversible. Re-run with CONFIRM_MAINNET=yes once the plan above is right.');
  process.exit(1);
}

const res = await attach(connection, authority, {
  mint,
  params: {
    minBuyLamports: new BN(Math.round(minBuySol * LAMPORTS_PER_SOL)),
    timeAddPerBuy: new BN(secsPerBuy),
    maxTimer: new BN(maxTimer),
    initialTimer: new BN(maxTimer),
    settleGraceSecs: new BN(graceSecs),
  },
  keeper: keeperKey,
  maxBuybackLamports: new BN(maxBuybackSol * LAMPORTS_PER_SOL),
  buybackGapSecs: new BN(env('BUYBACK_GAP_SECS', '300')),
});

console.log(JSON.stringify({
  mint: res.mint.toBase58(), dbcPool: res.pool.toBase58(), game: res.game.toBase58(),
  fundSolTo: res.wsolVault.toBase58(),
}, null, 2));
