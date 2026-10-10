import * as THREE from 'three/webgpu';
import { pass, mrt, output, emissive } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { City } from './city.js';
import { Plaza } from './towers.js';
import { createSim } from './sim.js';
import { chainConfig } from './config.js';
import { createUI } from './ui.js';
import './style.css';

const params = new URLSearchParams(location.search);
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
await renderer.init();

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
  if (e.type === 'buy') plaza.onBuy(e.who, e.floors, e.who === backend.you);
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
  plaza.setTension(r.totalFloors > 0 ? Math.max(0, 1 - left / 30) : 0);
  plaza.setJackpot(r.jackpot);
  plaza.update(dt);
  ui.frame();
  pipeline.render();
});

if (import.meta.env.DEV) window.__fomo = { scene, camera, controls, plaza, backend, renderer };
