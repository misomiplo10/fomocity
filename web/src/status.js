// Where the game stands. 'live': normal. 'final': the current round is the last one (shown
// on the site). 'ended': the game is over; the site shows only the result below.
export const STATUS = {
  phase: 'live',
  winner: null,   // 'ended': winning wallet
  prizeSol: null, // 'ended': jackpot paid, in SOL
  sig: null,      // 'ended': settle transaction signature
};
