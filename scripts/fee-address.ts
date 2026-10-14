// Prints the game's fee address: give it to whoever launches the token on Meteora, to set as
// the pool's fee claimer (or to hand the pool's creator rights to). It depends only on the
// program ID, so it's the same before and after the token exists. Needs no RPC.
//
//   npm run fee-address
import { PROGRAM_ID, feeAddress } from './lib.ts';

console.log(feeAddress().toBase58());
console.error(`(game fee address for program ${PROGRAM_ID.toBase58()}; fees sent here go 80% to the jackpot, 20% to the team)`);
