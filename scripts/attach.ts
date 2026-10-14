// Attach the game to a token that was launched on Meteora DBC by someone else.
//
//   KEEPER_PUBKEY=<keeper> TEAM_WALLET=<team> MINT=<token CA> npm run attach   (RPC from scripts/.env)
//
// Requirements on the token's launch (checked before anything is sent):
//  - plain SPL token, paired with SOL, collecting trading fees in SOL;
//  - the game's fee address (`npm run fee-address`) is the pool's fee claimer, or the
//    pool's creator rights were handed to it. Its fees then go 80% jackpot, 20% team.
// Anything other than a local validator is treated as mainnet: the script prints the plan
// and stops unless CONFIRM_MAINNET=yes is set. Only buys made after attaching count.
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { attach, feeAddress, findLaunch, loadKeypair, redactUrl, rpcUrl } from './lib.ts';

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
const teamKey = new PublicKey(env('TEAM_WALLET'));

const fee = feeAddress().toBase58();
const feeRole = launch.isFeeClaimer && launch.isCreator ? 'fee claimer + creator (all trading fees)'
  : launch.isFeeClaimer ? `fee claimer (partner share; creator keeps ${launch.creatorFeePercent}% of the 80% left after Meteora)`
  : launch.isCreator ? 'creator (creator share of fees)'
  : 'NONE';

console.error('\nAttach plan:');
console.error({
  network: local ? 'localnet' : 'MAINNET',
  rpc: redactUrl(RPC_URL),
  token: mint.toBase58(),
  meteoraPool: launch.pool.toBase58(),
  alreadyGraduated: launch.migrated,
  feesInSol: launch.feesInSol,
  gameFeeAddress: fee,
  gameFeeRole: feeRole,
  split: '80% jackpot (SOL) · 20% team',
  authority: authority.publicKey.toBase58(),
  minBuySol, secsPerBuy, maxTimerSecs: maxTimer, settleGraceSecs: graceSecs,
  keeper: keeperKey.toBase58(),
  team: teamKey.toBase58(),
});
const problems = [
  !launch.feesInSol && 'the pool does not collect its fees in SOL',
  !launch.feesToGame && `the game's fee address ${fee} is neither the pool's fee claimer nor its creator`,
].filter(Boolean);
if (problems.length) {
  console.error(`\nCan't attach: ${problems.join('; ')}.`);
  process.exit(1);
}
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
  roles: { keeper: keeperKey, team: teamKey },
});

console.log(JSON.stringify({ mint: res.mint.toBase58(), dbcPool: res.pool.toBase58(), game: res.game.toBase58(), feeAddress: fee }, null, 2));
