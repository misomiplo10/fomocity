// Top up the jackpot. Anyone can do this; it's how an attached game (a token launched
// elsewhere) gets its prize money, e.g. the creator sending their trading fees.
//
//   FUNDER=~/.config/solana/id.json MINT=<token CA> FUND_SOL=1 npm run fund
//     → SOL to the game's buyback wallet; the keeper buys FOMO with it: 70% jackpot,
//       20% next round, 10% burned.
//   FUNDER=... MINT=... FUND_TOKENS=5000000 npm run fund
//     → FOMO (whole tokens) straight into the current round's jackpot.
//
// On mainnet it prints what it will send and stops unless CONFIRM_MAINNET=yes is set.
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { fomocity, fundJackpot, fundSol, loadKeypair, readGame, redactUrl, rpcUrl } from './lib.ts';

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const RPC_URL = rpcUrl();
const connection = new Connection(RPC_URL, 'confirmed');
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC_URL);
const funder = loadKeypair(env('FUNDER', '~/.config/solana/id.json').replace(/^~/, process.env.HOME!));
const mint = new PublicKey(env('MINT'));
const sol = process.env.FUND_SOL ? Number(process.env.FUND_SOL) : 0;
const tokens = process.env.FUND_TOKENS ? Number(process.env.FUND_TOKENS) : 0;
if (!(sol > 0) === !(tokens > 0)) throw new Error('set exactly one of FUND_SOL or FUND_TOKENS');

const program = fomocity(connection, funder);
const g = await readGame(program, mint);
console.error({
  network: local ? 'localnet' : 'MAINNET', rpc: redactUrl(RPC_URL), funder: funder.publicKey.toBase58(),
  send: sol ? `${sol} SOL → buyback wallet (70% jackpot · 20% next round · 10% burned)` : `${tokens} FOMO → current jackpot`,
});
if (!local && process.env.CONFIRM_MAINNET !== 'yes') {
  console.error('\nNot sent. Re-run with CONFIRM_MAINNET=yes.');
  process.exit(1);
}
const sig = sol
  ? await fundSol(program, funder, g, new BN(Math.round(sol * LAMPORTS_PER_SOL)))
  : await fundJackpot(program, funder, g, new BN(Math.round(tokens * 1e6)));
console.log(sig);
