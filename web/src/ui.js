// HUD: watch-only. Playing happens by buying the token anywhere (Jupiter, Meteora, any
// wallet); the site shows the countdown, the last buyer, live buys, the jackpot, the
// Meteora flywheel and recent winners. There is no buy button and no wallet connection.
import * as THREE from 'three/webgpu';
import * as G from './game.js';
import { MARKET } from './sim.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (who) => (who && who.length > 14 ? `${who.slice(0, 4)}…${who.slice(-4)}` : who ?? '—');

function clock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? [h, m, s] : [m, s]).map((v) => String(v).padStart(2, '0')).join(':');
}

const ago = (ts) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

export function createUI({ backend, camera, plaza }) {
  const P = backend.params;
  const MI = backend.marketInfo ?? MARKET;
  const chain = backend.mode !== 'sim';
  // Attached to a token launched elsewhere: its trading fees go to its creator, so the
  // jackpot is funded by top-ups (SOL is bought back 70/20/10, FOMO goes straight in).
  const external = !!MI.external;
  // No-program setup: the jackpot sits in an ordinary wallet run by the game operator.
  const custodial = !!MI.custodial;
  const jackpotWallet = backend.jackpotWallet ?? null;
  const txLink = (sig) => (chain && sig ? `https://solscan.io/tx/${sig}` : null);
  const mint = backend.mint ?? null;
  // Links out to explorers and a swap page. The site itself never moves funds.
  const walletLink = (w) => (chain && w ? `https://solscan.io/account/${w}` : null);
  const nameHtml = (w) => {
    const href = walletLink(w);
    return href ? `<a href="${href}" target="_blank" rel="noopener">${esc(short(w))}</a>` : esc(short(w));
  };

  document.body.insertAdjacentHTML('beforeend', `
  <div id="hud">
    <div id="top">
      <div class="round">ROUND <span id="round"></span></div>
      <div id="timer">--:--</div>
      <div class="pot">JACKPOT <span id="jackpot"></span></div>
      <div class="sub">last buyer <b id="last">—</b> · <span id="buys">0</span> buys</div>
    </div>
    <div id="feed" class="panel"><h3>Live buys</h3><ul id="feedlist"></ul></div>
    <div id="market" class="panel">
      <h3>Meteora <span id="phase"></span></h3>
      <div class="bar"><i id="curvebar"></i></div>
      <div class="hint" id="curvetxt"></div>
      <div class="row"><span>Token price</span><b id="mprice"></b></div>
      <div class="row"><span>Swap fee</span><b id="mfee"></b></div>
      <div class="row"><span>${external ? 'Jackpot funding' : 'Treasury fees'}</span><b id="mtreasury"></b></div>
      <div class="row"><span>Bought back</span><b id="mbought"></b></div>
      <div class="row"><span>Burned</span><b id="mburned"></b></div>
    </div>
    <div id="side" class="panel">
      <h3>How to play</h3>
      <p class="how">Buy <b>${G.fmtSol(P.minBuyLamports, 2)}</b> or more of FOMO anywhere: Jupiter, Meteora, any wallet. Each buy adds <b>${P.timeAddPerBuy}s</b>. Last buyer when the clock hits zero wins the jackpot, <b>paid automatically</b>.</p>
      <hr>
      <div class="row"><span>SOL bought this round</span><b id="vol">0</b></div>
      <div class="row"><span>Next round seed</span><b id="seed">0</b></div>
      <hr>
      <h3>Biggest buyers</h3><ol id="lead"></ol>
      <hr>
      <h3>Recent winners</h3><ol id="winners"><li class="dim">No winners yet</li></ol>
    </div>
    <div id="cabox" class="panel">
      <h3>Token CA</h3>
      ${mint
        ? `<div class="ca"><code id="ca" title="${esc(mint)}">${esc(mint)}</code><button id="copyca" title="Copy token address">COPY</button></div>
           <a class="ext" href="https://jup.ag/swap/SOL-${esc(mint)}" target="_blank" rel="noopener">Trade on Jupiter ↗</a>
           ${custodial && jackpotWallet ? `<a class="jw" href="${walletLink(jackpotWallet) ?? '#'}" target="_blank" rel="noopener">Jackpot wallet: ${esc(short(jackpotWallet))} ↗</a>` : ''}`
        : `<div class="ca soon"><code>Launching soon</code></div>`}
    </div>
    <div id="labels"></div>
    <div id="badges"><span id="mode"></span><span id="gfx"></span><button id="rulesbtn">Rules</button><a class="guide" href="/how.html">How it works</a></div>
    <div id="banner" hidden></div>
    <div id="toast" hidden></div>
  </div>
  <dialog id="rules">
    <h2>FOMO CITY: the rules</h2>
    <p>This is a <b>last-buyer-wins</b> game. Read this before playing. <b>Most players lose money.</b> Only buy what you can afford to lose entirely.</p>
    <ul>
      <li>You play by <b>buying FOMO</b> on any app (Jupiter, Meteora, any wallet or bot). There is nothing to buy on this website.</li>
      <li>A buy counts when it puts at least <b>${G.fmtSol(P.minBuyLamports, 2)}</b> into the token's Meteora pool. Sells never count.</li>
      <li>Every counted buy adds <b>${P.timeAddPerBuy}s</b> to the countdown, which never shows more than <b>${clock(P.maxTimer)}</b>.</li>
      <li>When it hits zero, the <b>last buyer wins the whole jackpot</b>. It's sent to their wallet automatically; no claiming. Everyone else gets nothing from the round.</li>
      ${custodial
        ? `<li><b>The jackpot is held in the game's jackpot wallet${jackpotWallet ? ` (${walletLink(jackpotWallet) ? `<a href="${walletLink(jackpotWallet)}" target="_blank" rel="noopener">${esc(short(jackpotWallet))}</a>` : esc(short(jackpotWallet))})` : ''}</b> and paid out by the game operator's software, <b>not by a smart contract</b>. You are trusting the operator to pay winners. The wallet's balance and every payout are public on Solscan.</li>
      <li>The jackpot is <b>funded by the token's creator and the community</b>, not automatically by trading fees. Anyone can top it up by sending SOL or FOMO to the jackpot wallet: SOL is used to buy FOMO back (<b>${G.BUYBACK_SPLIT.jackpot / 100}%</b> to this round's jackpot · <b>${G.BUYBACK_SPLIT.nextRound / 100}%</b> to the next round · <b>${G.BUYBACK_SPLIT.burn / 100}%</b> burned), and FOMO goes straight into the jackpot.</li>`
        : external
        ? `<li>The jackpot is <b>funded by the token's creator and the community</b>, not automatically by trading fees. Anyone can top it up: SOL sent to the game is used to buy FOMO back (<b>${G.BUYBACK_SPLIT.jackpot / 100}%</b> to this round's jackpot · <b>${G.BUYBACK_SPLIT.nextRound / 100}%</b> to the next round · <b>${G.BUYBACK_SPLIT.burn / 100}%</b> burned), and FOMO sent to the game goes straight into the jackpot.</li>`
        : `<li>The jackpot comes from <b>Meteora trading fees</b>: the game collects 80% of them in SOL (Meteora keeps 20%) and buys FOMO back: <b>${G.BUYBACK_SPLIT.jackpot / 100}%</b> to this round's jackpot · <b>${G.BUYBACK_SPLIT.nextRound / 100}%</b> to the next round · <b>${G.BUYBACK_SPLIT.burn / 100}%</b> burned.</li>
      <li>Launch fees start at <b>${MI.sniperFeeBps / 100}%</b>${MI.baseFeeBps ? ` and fall to <b>${MI.baseFeeBps / 100}%</b>` : ' and fall over the first minutes'}, so early snipers pay into the pot.</li>`}
      ${external
        ? `<li>The token trades on Meteora: first on a bonding curve, then in a regular Meteora pool.</li>`
        : `<li>The token trades on a Meteora bonding curve, then in a regular pool whose liquidity is <b>locked forever</b>.</li>`}
      ${custodial
        ? `<li>The game's software spots buys on-chain and lists every counted buy and every payout with its transaction, so anyone can check them.</li>`
        : `<li>Buys are spotted on-chain by the game's keeper and recorded in an open-source program together with their transaction signature, so anyone can check every recorded buy and every payout.</li>`}
      <li>A round with no buys carries its jackpot into the next one.</li>
    </ul>
    <p class="hint">${backend.mode === 'sim' ? 'SIM MODE: bots and fake tokens, 90-second rounds. Nothing here is real money.'
      : backend.mode === 'mainnet' ? 'MAINNET: real SOL and real tokens.' : `${backend.mode.toUpperCase()}: test network, tokens have no value.`}</p>
    <p><a href="/how.html">Read the full guide: how the game, the token and the jackpot work →</a></p>
    <form method="dialog"><button class="primary">Got it</button></form>
  </dialog>`);

  $('#mode').textContent = backend.mode === 'sim' ? 'SIM MODE' : backend.mode.toUpperCase();

  let toastT;
  const toast = (msg) => {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2000);
  };
  $('#copyca')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(mint); toast('Token address copied'); } catch { toast(mint); }
  });
  $('#rulesbtn').addEventListener('click', () => $('#rules').showModal());
  // The rules pop up every time the site opens: nobody should play without seeing them.
  $('#rules').showModal();

  const feed = $('#feedlist');
  const push = (html) => { feed.insertAdjacentHTML('afterbegin', html); while (feed.children.length > 14) feed.lastChild.remove(); };
  backend.on((e) => {
    if (e.type === 'buy') push(`<li><b>${nameHtml(e.who)}</b><span>${G.fmtSol(e.lamports)}</span></li>`);
    if (e.type === 'funded') push(`<li class="bb"><b>◆ Jackpot top-up</b><span>${e.tokens ? `+${G.fmt(e.tokens)}` : G.fmtSol(e.lamports)}</span></li>`);
    if (e.type === 'buyback') push(`<li class="bb"><b>◆ Buyback</b> ${e.sol.toFixed(3)} SOL <span>+${G.fmt(e.toJackpot)}</span></li>`);
    if (e.type === 'curveComplete' || e.type === 'migrated') {
      const done = e.type === 'migrated';
      push(`<li class="bb"><b>◆ ${done ? 'Migrated to DAMM v2' : 'Bonding curve complete'}</b></li>`);
      showBanner(done
        ? `<div>GRADUATED</div><big>DAMM v2</big><div>Liquidity locked forever. Its fees keep feeding the pot.</div>`
        : `<div>BONDING CURVE COMPLETE</div><big>${MI.thresholdSol} SOL</big><div>Migrating to a Meteora pool…</div>`, 'meteora', 4500);
    }
    if (e.type === 'settled') {
      if (e.winner) push(`<li class="win"><b>🏆 #${e.round} ${nameHtml(e.winner)}</b><span>${G.fmt(e.payout)}</span></li>`);
      showBanner(e.winner
        ? `<div>ROUND ${e.round} WINNER</div><big>${nameHtml(e.winner)}</big><div>won ${G.fmt(e.payout)} FOMO · paid automatically</div>`
        : `<div>ROUND ${e.round} OVER</div><div>No buys. Jackpot carries over.</div>`, 'win', 6500);
    }
  });

  function showBanner(html, cls, ms) {
    const b = $('#banner');
    b.innerHTML = html; b.className = cls; b.hidden = false;
    clearTimeout(showBanner.t); showBanner.t = setTimeout(() => (b.hidden = true), ms);
  }

  const labels = $('#labels');
  const v = new THREE.Vector3();
  let lastLead = '', lastWinners = '';

  return {
    setRenderer(name) { $('#gfx').textContent = name; },
    frame() {
      const r = backend.round, now = backend.now();
      const left = r.endTs - now;
      const timer = $('#timer');
      const settling = !r.settled && left <= 0;
      timer.textContent = settling ? (r.buyCount ? 'PAYING OUT…' : 'NEXT ROUND…') : clock(left);
      timer.classList.toggle('hot', !settling && r.buyCount > 0 && left < 30);
      timer.classList.toggle('settling', settling);
      $('#round').textContent = r.id;
      $('#jackpot').textContent = G.fmt(r.jackpot);
      $('#buys').textContent = r.buyCount.toLocaleString();
      $('#last').innerHTML = r.lastBuyer ? nameHtml(r.lastBuyer) : '—';
      $('#vol').textContent = G.fmtSol(r.totalLamports, 2);
      $('#seed').textContent = G.fmt(r.nextRoundPot);

      const winners = (backend.winners ?? []).slice(0, 6);
      const wHtml = winners.length
        ? winners.map((w) => `<li><span class="r">#${w.round}</span> ${nameHtml(w.wallet)} <span>${txLink(w.sig) ? `<a href="${txLink(w.sig)}" target="_blank" rel="noopener" title="Payout transaction">${G.fmt(w.amount)}</a>` : G.fmt(w.amount)}</span><small>${ago(w.ts)}${custodial && !w.sig && w.amount > 0 ? ' · paying…' : ''}</small></li>`).join('')
        : '<li class="dim">No winners yet</li>';
      if (wHtml !== lastWinners) { $('#winners').innerHTML = wHtml; lastWinners = wHtml; }

      const m = backend.market;
      if (m) {
        const pct = m.phase === 'curve' ? Math.min(100, (m.raisedSol / MI.thresholdSol) * 100) : 100;
        $('#phase').textContent = { curve: 'bonding curve', migrating: 'migrating…', damm: 'DAMM v2' }[m.phase];
        $('#phase').className = m.phase;
        $('#curvebar').style.width = `${pct}%`;
        $('#curvetxt').textContent = m.phase === 'curve'
          ? `${m.raisedSol.toFixed(2)} / ${MI.thresholdSol} SOL raised`
          : m.volumeSol ? `Graduated · ${m.volumeSol.toFixed(1)} SOL traded` : 'Graduated';
        $('#mprice').textContent = m.price >= 1e-6 ? `${m.price.toPrecision(3)} SOL` : `${(m.price * 1e6).toPrecision(3)} SOL / 1M`;
        const fee = $('#mfee');
        fee.textContent = `${(m.feeBps / 100).toFixed(m.feeBps < 1000 ? 2 : 1)}%`;
        fee.className = m.feeBps > MI.keeperMaxFeeBps ? 'hot' : '';
        $('#mtreasury').textContent = `${(m.unclaimedSol + m.wsolSol).toFixed(4)} SOL`;
        $('#mbought').textContent = G.fmt(m.boughtTokens);
        $('#mburned').textContent = G.fmt(m.burnedTokens);
      }

      const anchors = plaza.labelAnchors();
      const lead = anchors.slice(0, 5).map((a) => `<li>${nameHtml(a.who)} <span>${G.fmtSol(a.lamports, 2)}</span></li>`).join('');
      if (lead !== lastLead) { $('#lead').innerHTML = lead || '<li class="dim">No buys yet</li>'; lastLead = lead; }

      // name tags over towers
      while (labels.children.length < anchors.length) labels.appendChild(document.createElement('div'));
      [...labels.children].forEach((el, i) => {
        const a = anchors[i];
        if (!a) { el.style.display = 'none'; return; }
        v.copy(a.pos).project(camera);
        if (v.z > 1) { el.style.display = 'none'; return; }
        el.style.display = '';
        el.className = a.who === r.lastBuyer ? 'last' : '';
        el.textContent = short(a.who);
        el.style.transform = `translate(-50%,-100%) translate(${(v.x * 0.5 + 0.5) * innerWidth}px,${(-v.y * 0.5 + 0.5) * innerHeight}px)`;
      });
    },
  };
}
