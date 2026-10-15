// Announce that the current round is the last one. It plays out normally and its winner is
// paid in full by the keeper; after it settles the game is over (no new rounds, later fees
// go to the team). Can't be undone.
//
//   MINT=<token CA> npm run final-round   (AUTHORITY defaults to ~/.config/solana/id.json)
//
// Off localnet it prints the plan and stops unless CONFIRM_MAINNET=yes is set.
import { Connection, PublicKey } from '@solana/web3.js';
import { fomocity, loadKeypair, readGame, redactUrl, rpcUrl, setFinalRound } from './lib.ts';

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const RPC_URL = rpcUrl();
const connection = new Connection(RPC_URL, 'confirmed');
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC_URL);
const authority = loadKeypair(env('AUTHORITY', '~/.config/solana/id.json').replace(/^~/, process.env.HOME!));
const program = fomocity(connection, authority);
const g = await readGame(program, new PublicKey(env('MINT')));
const round: any = await (program.account as any).round.fetch(g.round(BigInt(g.data.currentRound.toString())));

console.error('\nFinal round plan:');
console.error({
  network: local ? 'localnet' : 'MAINNET',
  rpc: redactUrl(RPC_URL),
  token: g.mint.toBase58(),
  finalRound: round.id.toString(),
  secondsLeft: round.endTs.toNumber() - Math.floor(Date.now() / 1000),
  jackpotSol: round.jackpot.toNumber() / 1e9,
  lastBuyer: round.buyCount > 0 ? round.lastBuyer.toBase58() : null,
  after: 'winner paid in full, no new rounds, later fees go to the team',
});
if (g.data.finalRound.toNumber() !== 0 || g.data.ended) throw new Error('a final round was already announced');
if (!g.data.authority.equals(authority.publicKey)) throw new Error(`AUTHORITY is not the game admin (${g.data.authority.toBase58()})`);
if (!local && process.env.CONFIRM_MAINNET !== 'yes') {
  console.error('\nNot sent. This is irreversible. Re-run with CONFIRM_MAINNET=yes once the plan above is right.');
  process.exit(1);
}
console.log(await setFinalRound(program, authority.publicKey, g));
