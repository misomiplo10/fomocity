import * as THREE from 'three/webgpu';
import * as G from './game.js';
import { MARKET } from './sim.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (who) => (who.length > 14 ? `${who.slice(0, 4)}…${who.slice(-4)}` : who);

function clock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

export function createUI({ backend, camera, plaza }) {
  const P = backend.params;
  document.body.insertAdjacentHTML('beforeend', `
  <div id="hud">
    <div id="top">
      <div class="round">ROUND <span id="round"></span></div>
      <div id="timer">--:--:--</div>
      <div class="pot">JACKPOT <span id="jackpot"></span></div>
      <div class="sub"><span id="floors"></span> floors · last buyer <b id="last">—</b></div>
    </div>
    <div id="feed" class="panel"><h3>Live</h3><ul id="feedlist"></ul></div>
    <div id="market" class="panel">
      <h3>Meteora <span id="phase"></span></h3>
      <div class="bar"><i id="curvebar"></i></div>
      <div class="hint" id="curvetxt"></div>
      <div class="row"><span>Token price</span><b id="mprice"></b></div>
      <div class="row"><span>Swap fee</span><b id="mfee"></b></div>
      <div class="row"><span>Treasury fees</span><b id="mtreasury"></b></div>
      <div class="row"><span>Bought back</span><b id="mbought"></b></div>
      <div class="row"><span>Burned</span><b id="mburned"></b></div>
    </div>
    <div id="side" class="panel">
      <div class="row"><span>Wallet</span><b id="bal"></b></div>
      <div class="row"><span>Next floor</span><b id="price"></b></div>
      <div class="buy">
        <button data-d="-1">−</button><input id="n" type="number" min="1" max="${P.maxFloorsPerBuy}" value="1"><button data-d="1">+</button>
      </div>
      <button id="buybtn" class="primary">BUY</button>
      <div class="hint" id="cost"></div>
      <hr>
      <div class="row"><span>Your floors</span><b id="mine">0</b></div>
      <div class="row"><span>Dividends</span><b id="div">0</b></div>
      <button id="claimbtn">CLAIM</button>
      <hr>
      <h3>Tallest towers</h3><ol id="lead"></ol>
    </div>
    <div id="labels"></div>
    <div id="badges"><span id="mode"></span><span id="gfx"></span><button id="rulesbtn">How it works</button></div>
    <div id="banner" hidden></div>
    <div id="toast" hidden></div>
  </div>
  <dialog id="rules">
    <h2>FOMO CITY: the rules</h2>
    <p>This is a <b>last-buyer-wins</b> game. Read this before playing. <b>Most players lose money.</b> Only buy what you can afford to lose entirely.</p>
    <ul>
      <li>Each floor costs <b>${G.fmt(P.basePrice)}</b> + <b>${G.fmt(P.priceStep)}</b> × floors already sold this round.</li>
      <li>Every floor bought adds <b>${P.timeAddPerFloor}s</b> to the timer (capped at ${clock(P.maxTimer)} from now).</li>
      <li>When the timer hits zero, the <b>last buyer wins the jackpot</b>. Everyone else's floors are worth nothing; they only earned dividends.</li>
      <li>Every buy is split: <b>${G.SPLIT.jackpot / 100}%</b> jackpot · <b>${G.SPLIT.dividends / 100}%</b> dividends to earlier floor holders · <b>${G.SPLIT.nextRound / 100}%</b> seeds next round · <b>${G.SPLIT.dev / 100}%</b> protocol fee.</li>
      <li>Dividends only come from <i>later</i> buyers. Once buying stops, they stop. Late buyers earn the least.</li>
      <li>The token trades on <b>Meteora</b>: first on a bonding curve, then, once the curve fills, in a regular pool whose liquidity is <b>locked forever</b>.</li>
      <li>The game's treasury collects <b>80% of all Meteora trading fees</b> in SOL (Meteora keeps 20%). A keeper buys the token back with it: <b>${G.BUYBACK_SPLIT.jackpot / 100}%</b> to this round's jackpot · <b>${G.BUYBACK_SPLIT.nextRound / 100}%</b> to the next round · <b>${G.BUYBACK_SPLIT.burn / 100}%</b> burned.</li>
      <li>Launch fees start at <b>${MARKET.sniperFeeBps / 100}%</b> and fall to <b>${MARKET.baseFeeBps / 100}%</b>, so early snipers pay into the pot. Buybacks wait until the fee has dropped.</li>
      <li>Buybacks can't create a winner: if the timer already hit zero, that buyback goes to the next round.</li>
      <li>All rules run in an open-source on-chain program. Nobody, including the devs, can move the pot.</li>
    </ul>
    <p class="hint">${backend.mode === 'sim' ? 'SIM MODE: fake tokens, bots, 2-minute rounds. Nothing here is real money.' : ''}</p>
    <form method="dialog"><button class="primary">Got it</button></form>
  </dialog>`);

  $('#mode').textContent = backend.mode === 'sim' ? 'SIM MODE' : 'MAINNET';
  const n = $('#n');
  document.querySelectorAll('.buy button').forEach((b) =>
    b.addEventListener('click', () => (n.value = Math.max(1, Math.min(P.maxFloorsPerBuy, (+n.value || 1) + +b.dataset.d)))));

  let toastT;
  const toast = (msg, bad) => {
    const t = $('#toast');
    t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2500);
  };

  $('#buybtn').addEventListener('click', async () => {
    try { const r = await backend.buy(Math.floor(+n.value)); toast(`Bought ${r.n} floor${r.n > 1 ? 's' : ''} for ${G.fmt(r.cost)}`); }
    catch (e) { toast(e.message, true); }
  });
  $('#claimbtn').addEventListener('click', async () => {
    const amt = await backend.claim();
    toast(amt > 0 ? `Claimed ${G.fmt(amt)}` : 'Nothing to claim', amt <= 0);
  });
  $('#rulesbtn').addEventListener('click', () => $('#rules').showModal());
  try { if (!localStorage.getItem('fomocity.rules')) { $('#rules').showModal(); localStorage.setItem('fomocity.rules', '1'); } }
  catch { $('#rules').showModal(); }

  const feed = $('#feedlist');
  backend.on((e) => {
    if (e.type === 'buy') {
      feed.insertAdjacentHTML('afterbegin',
        `<li class="${e.who === backend.you ? 'me' : ''}"><b>${esc(short(e.who))}</b> +${e.n} floor${e.n > 1 ? 's' : ''} <span>${G.fmt(e.cost)}</span></li>`);
      while (feed.children.length > 14) feed.lastChild.remove();
    }
    if (e.type === 'buyback') {
      feed.insertAdjacentHTML('afterbegin',
        `<li class="bb"><b>◆ Buyback</b> ${e.sol.toFixed(3)} SOL <span>+${G.fmt(e.toJackpot)}</span></li>`);
      while (feed.children.length > 14) feed.lastChild.remove();
    }
    if (e.type === 'curveComplete' || e.type === 'migrated') {
      const done = e.type === 'migrated';
      feed.insertAdjacentHTML('afterbegin', `<li class="bb"><b>◆ ${done ? 'Migrated to DAMM v2' : 'Bonding curve complete'}</b></li>`);
      const b = $('#banner');
      b.innerHTML = done
        ? `<div>GRADUATED</div><big>DAMM v2</big><div>Liquidity locked forever. Its fees keep feeding the pot.</div>`
        : `<div>BONDING CURVE COMPLETE</div><big>${MARKET.thresholdSol} SOL</big><div>Migrating to a Meteora pool…</div>`;
      b.className = 'meteora';
      b.hidden = false;
      setTimeout(() => (b.hidden = true), 4500);
    }
    if (e.type === 'settled') {
      const b = $('#banner');
      b.innerHTML = e.winner
        ? `<div>ROUND ${e.round} OVER</div><big>${esc(short(e.winner))}</big><div>wins ${G.fmt(e.payout)}</div>`
        : `<div>ROUND ${e.round} OVER</div><div>No buyers. Jackpot carries over.</div>`;
      b.className = e.winner === backend.you ? 'win' : '';
      b.hidden = false;
      setTimeout(() => (b.hidden = true), 5500);
    }
  });

  const labels = $('#labels');
  const v = new THREE.Vector3();
  let lastLead = '';

  return {
    setRenderer(name) { $('#gfx').textContent = name; },
    frame() {
      const r = backend.round, now = backend.now();
      const pre = now < r.startTs;
      const left = pre ? r.startTs - now : r.endTs - now;
      const timer = $('#timer');
      timer.textContent = pre ? `NEXT ${clock(left)}` : clock(left);
      timer.classList.toggle('hot', !pre && r.totalFloors > 0 && left < 30);
      $('#round').textContent = r.id;
      $('#jackpot').textContent = G.fmt(r.jackpot);
      $('#floors').textContent = r.totalFloors.toLocaleString();
      $('#last').textContent = r.lastBuyer ? short(r.lastBuyer) : '—';
      $('#bal').textContent = G.fmt(backend.balance());
      $('#price').textContent = G.fmt(G.priceOfNext(P, r.totalFloors));
      const k = Math.max(1, Math.min(P.maxFloorsPerBuy, Math.floor(+n.value) || 1));
      $('#cost').textContent = `${k} floor${k > 1 ? 's' : ''} = ${G.fmt(G.costOf(P, r.totalFloors, k))} · +${k * P.timeAddPerFloor}s`;
      $('#buybtn').disabled = pre;
      const me = r.players[backend.you];
      $('#mine').textContent = me ? me.floors : 0;
      $('#div').textContent = G.fmt(G.pendingDividends(r, backend.you));

      const m = backend.market;
      if (m) {
        const pct = m.phase === 'curve' ? Math.min(100, (m.raisedSol / MARKET.thresholdSol) * 100) : 100;
        $('#phase').textContent = { curve: 'bonding curve', migrating: 'migrating…', damm: 'DAMM v2' }[m.phase];
        $('#phase').className = m.phase;
        $('#curvebar').style.width = `${pct}%`;
        $('#curvetxt').textContent = m.phase === 'curve'
          ? `${m.raisedSol.toFixed(2)} / ${MARKET.thresholdSol} SOL raised`
          : `Graduated · ${m.volumeSol.toFixed(1)} SOL traded`;
        $('#mprice').textContent = `${m.price.toFixed(5)} SOL`;
        const fee = $('#mfee');
        fee.textContent = `${(m.feeBps / 100).toFixed(m.feeBps < 1000 ? 2 : 1)}%`;
        fee.className = m.feeBps > MARKET.keeperMaxFeeBps ? 'hot' : '';
        $('#mtreasury').textContent = `${(m.unclaimedSol + m.wsolSol).toFixed(4)} SOL`;
        $('#mbought').textContent = G.fmt(m.boughtTokens);
        $('#mburned').textContent = G.fmt(m.burnedTokens);
      }

      const anchors = plaza.labelAnchors();
      const lead = anchors.slice(0, 5).map((a) => `<li class="${a.who === backend.you ? 'me' : ''}">${esc(short(a.who))} <span>${a.floors}</span></li>`).join('');
      if (lead !== lastLead) { $('#lead').innerHTML = lead; lastLead = lead; }

      // name tags over towers
      while (labels.children.length < anchors.length) labels.appendChild(document.createElement('div'));
      [...labels.children].forEach((el, i) => {
        const a = anchors[i];
        if (!a) { el.style.display = 'none'; return; }
        v.copy(a.pos).project(camera);
        if (v.z > 1) { el.style.display = 'none'; return; }
        el.style.display = '';
        el.className = a.who === backend.you ? 'me' : a.who === r.lastBuyer ? 'last' : '';
        el.textContent = short(a.who);
        el.style.transform = `translate(-50%,-100%) translate(${(v.x * 0.5 + 0.5) * innerWidth}px,${(-v.y * 0.5 + 0.5) * innerHeight}px)`;
      });
    },
  };
}
