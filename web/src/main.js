import * as THREE from 'three/webgpu';
import { pass, mrt, output, emissive } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { City } from './city.js';
import { Plaza } from './towers.js';
import { createSim } from './sim.js';
import { chainConfig } from './config.js';
import { createUI } from './ui.js';
import { STATUS } from './status.js';
import './style.css';

// The game is over: show the result and nothing else (the program no longer exists).
if (STATUS.phase === 'ended') {
  const sol = STATUS.prizeSol != null ? `${STATUS.prizeSol.toFixed(3)} SOL` : 'the jackpot';
  const who = STATUS.winner ? `<a style="color:#7cf" href="https://solscan.io/account/${STATUS.winner}" target="_blank" rel="noopener">${STATUS.winner.slice(0, 4)}…${STATUS.winner.slice(-4)}</a>` : 'nobody';
  const tx = STATUS.sig ? ` (<a style="color:#7cf" href="https://solscan.io/tx/${STATUS.sig}" target="_blank" rel="noopener">payout</a>)` : '';
  document.getElementById('app').innerHTML =
    '<div style="color:#cdd3ff;font:16px/1.6 system-ui;text-align:center;margin-top:35vh;padding:0 16px">' +
    '<h1 style="font-size:28px;margin:0 0 8px;color:#fff">FOMO City has ended</h1>' +
    `<p style="margin:0">The final round was won by ${who}, who was paid ${sol}${tx}.<br>Thanks to everyone who played. No new rounds will start.</p></div>`;
  await new Promise(() => {}); // stop here: don't start the 3D city or the game
}

const params = new URLSearchParams(location.search);

// If anything below fails, say so instead of leaving a black page.
const fail = (e) => {
  console.error('[fomocity]', e);
  if (document.getElementById('hud')) return; // the game is already up
  document.getElementById('app').innerHTML =
    '<p style="color:#cdd3ff;font:16px/1.5 system-ui;text-align:center;margin-top:40vh;padding:0 16px">' +
    'FOMO City could not start in this browser. Try the latest Chrome, Edge or Brave, or ' +
    '<a style="color:#7cf" href="?webgl">open the simple version</a>.</p>';
};
addEventListener('error', (e) => fail(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => fail(e.reason));

// WebGPU where it works, WebGL2 otherwise (some browsers expose WebGPU but fail to start it).
async function makeRenderer(forceWebGL) {
  const r = new THREE.WebGPURenderer({ antialias: true, forceWebGL });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.setSize(innerWidth, innerHeight);
  r.toneMapping = THREE.ACESFilmicToneMapping;
  await r.init();
  return r;
}
let renderer;
try {
  renderer = await makeRenderer(params.has('webgl'));
} catch (e) {
  console.warn('[fomocity] WebGPU failed, using WebGL2', e);
  renderer = await makeRenderer(true);
}
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sky = new THREE.Color(0x05060f);
scene.background = sky;
scene.fog = new THREE.FogExp2(0x0a0c22, 0.0021);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 4000);
camera.position.set(250, 140, 290);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 30, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 40;
controls.maxDistance = 1200;
controls.screenSpacePanning = false;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.addEventListener('start', () => (controls.autoRotate = false));

scene.add(new THREE.HemisphereLight(0x5a70ff, 0x201010, 1.4));
const moon = new THREE.DirectionalLight(0x9ab0ff, 1.6);
moon.position.set(-300, 500, 200);
scene.add(moon);

const city = new City(scene);
const plaza = new Plaza(scene);

// Post: bloom only on emissive output, so lit windows glow but walls don't.
const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, emissive }));
const col = scenePass.getTextureNode('output');
const em = scenePass.getTextureNode('emissive');
const glow = bloom(em, 0.6, 0.35, 0.05);
pipeline.outputNode = col.add(glow);

// ?cluster=localnet|devnet (+ &mint=) or VITE_CLUSTER switches to the chain backend; the
// Solana libraries are only loaded in that case, so sim mode stays light.
const cfg = chainConfig();
const backend = cfg ? await (await import('./solana.js')).createChain(cfg) : createSim();
const ui = createUI({ backend, camera, renderer, plaza, controls });
ui.setRenderer(renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2');

backend.on((e) => {
  if (e.type === 'buy') plaza.onBuy(e.who, e.total);
  if (e.type === 'round') plaza.reset();
  if (e.type === 'buyback') plaza.onBuyback(e.out);
  if (e.type === 'curveComplete' || e.type === 'migrated') plaza.onMigration();
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  controls.update();
  city.update(controls.target);
  const r = backend.round;
  const left = Math.max(0, r.endTs - backend.now());
  plaza.setTension(r.buyCount > 0 ? Math.max(0, 1 - left / 30) : 0);
  plaza.setJackpot(r.jackpot);
  plaza.update(dt);
  ui.frame();
  pipeline.render();
});

if (import.meta.env.DEV) window.__fomo = { scene, camera, controls, plaza, backend, renderer };
