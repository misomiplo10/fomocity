// "How it works" page: fills in the rule numbers from the same defaults the game uses
// (keep G.DEFAULT_PARAMS in sync with the launch settings in scripts/launch.ts).
import * as G from './game.js';
import './how.css';

const P = G.DEFAULT_PARAMS;
const mins = (s) => (s % 60 ? `${s} seconds` : `${s / 60} minutes`);
const values = {
  minBuy: G.fmtSol(P.minBuyLamports, 2),
  timeAdd: `${P.timeAddPerBuy} seconds`,
  maxTimer: mins(P.maxTimer),
  grace: `${P.settleGraceSecs}-second`,
};
for (const el of document.querySelectorAll('[data-p]')) el.textContent = values[el.dataset.p];
for (const el of document.querySelectorAll('[data-s]')) el.textContent = `${G.FEE_SPLIT[el.dataset.s] / 100}%`;
