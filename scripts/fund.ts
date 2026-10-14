// Add SOL straight to the jackpot (all of it goes to the jackpot; no team share). Anyone can.
//
//   FUNDER=~/.config/solana/id.json MINT=<token CA> FUND_SOL=1 npm run fund
//
// On mainnet it prints what it will send and stops unless CONFIRM_MAINNET=yes is set.
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { fomocity, fundSol, loadKeypair, readGame, redactUrl, rpcUrl } from './lib.ts';

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const RPC_URL = rpcUrl();
const connection = new Connection(RPC_URL, 'confirmed');
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC_URL);
const funder = loadKeypair(env('FUNDER', '~/.config/solana/id.json').replace(/^~/, process.env.HOME!));
const mint = new PublicKey(env('MINT'));
const sol = Number(env('FUND_SOL'));
if (!(sol > 0)) throw new Error('FUND_SOL must be > 0');

const program = fomocity(connection, funder);
const g = await readGame(program, mint);
console.error({ network: local ? 'localnet' : 'MAINNET', rpc: redactUrl(RPC_URL), funder: funder.publicKey.toBase58(), send: `${sol} SOL → jackpot` });
if (!local && process.env.CONFIRM_MAINNET !== 'yes') {
  console.error('\nNot sent. Re-run with CONFIRM_MAINNET=yes.');
  process.exit(1);
}
console.log(await fundSol(program, funder, g, new BN(Math.round(sol * LAMPORTS_PER_SOL))));
