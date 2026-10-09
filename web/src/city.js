// Endless procedural night city. The world is an infinite grid of blocks,
// generated deterministically per chunk from a hash, streamed around the camera.
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, hash, select, positionWorld, normalWorld, instanceIndex,
  time, step, fract, floor, mix, abs, smoothstep, sin, max, uniform,
} from 'three/tsl';

export const BLOCK = 44;       // block pitch (lot + street)
export const STREET = 12;
export const CHUNK_BLOCKS = 6;
export const CHUNK = BLOCK * CHUNK_BLOCKS;
export const PLAZA_RADIUS = 2; // blocks around origin reserved for player towers

// Deterministic integer hash -> [0,1)
function rnd(...xs) {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 16777619);
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}

// Smooth value noise for the downtown density field.
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const s = (t) => t * t * (3 - 2 * t);
  const a = rnd(xi, zi, 7), b = rnd(xi + 1, zi, 7), c = rnd(xi, zi + 1, 7), d = rnd(xi + 1, zi + 1, 7);
  return a + (b - a) * s(xf) + (c - a) * s(zf) + (a - b - c + d) * s(xf) * s(zf);
}
const density = (x, z) => {
  const n = vnoise(x / 700, z / 700) * 0.65 + vnoise(x / 230, z / 230) * 0.35;
  return Math.pow(n, 2.2) * 1.8 + 0.08;
};

export const windowIntensity = uniform(1.25);

function makeBuildingMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.4 });
  m.emissiveNode = Fn(() => {
    const p = positionWorld, n = normalWorld;
    const side = float(1).sub(step(0.5, abs(n.y)));
    const along = select(abs(n.x).greaterThan(0.5), p.z, p.x);
    const w = vec2(along.div(2.6), p.y.div(3.4));
    const cell = floor(w);
    const f = fract(w);
    const pane = step(0.18, f.x).mul(step(f.x, 0.82)).mul(step(0.22, f.y)).mul(step(f.y, 0.78));
    const seed = float(instanceIndex).mul(13.17);
    const bldg = hash(seed);
    // slow random toggling so the city feels inhabited
    const epoch = floor(time.mul(0.04).add(hash(cell.x.mul(3.1).add(cell.y.mul(7.7)).add(seed)).mul(30)));
    const r = hash(cell.x.mul(127.1).add(cell.y.mul(311.7)).add(seed).add(epoch.mul(0.37)));
    const lit = step(mix(0.35, 0.8, bldg), r);
    const warm = vec3(1.0, 0.72, 0.42), cool = vec3(0.45, 0.75, 1.0), pink = vec3(1.0, 0.35, 0.75);
    const tint = mix(mix(warm, cool, step(0.6, bldg)), pink, step(0.93, hash(seed.add(5.0))));
    const groundFade = smoothstep(0.5, 4.0, p.y);
    return tint.mul(pane.mul(side).mul(lit).mul(groundFade).mul(windowIntensity).mul(r.mul(0.6).add(0.4)));
  })();
  return m;
}

function makeBeaconMaterial() {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const blink = step(0.0, sin(time.mul(2.4).add(float(instanceIndex).mul(1.7))));
    return vec3(4.0, 0.15, 0.1).mul(blink.mul(0.9).add(0.1));
  })();
  return m;
}

function makeGroundMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0.0 });
  const half = float(BLOCK / 2), st = float(STREET / 2);
  // distance from nearest street centerline on each axis
  const dx = abs(fract(positionWorld.x.add(half).div(BLOCK)).sub(0.5)).mul(BLOCK);
  const dz = abs(fract(positionWorld.z.add(half).div(BLOCK)).sub(0.5)).mul(BLOCK);
  const lot = float(BLOCK / 2).sub(st); // half-width of lot
  const onRoadX = step(lot, dx), onRoadZ = step(lot, dz);
  const road = max(onRoadX, onRoadZ);
  const lane = Fn(() => {
    // dashed yellow center lines
    const cx = step(BLOCK / 2 - 0.25, dx).mul(step(0.5, fract(positionWorld.z.div(6)))).mul(onRoadX).mul(float(1).sub(onRoadZ));
    const cz = step(BLOCK / 2 - 0.25, dz).mul(step(0.5, fract(positionWorld.x.div(6)))).mul(onRoadZ).mul(float(1).sub(onRoadX));
    return max(cx, cz);
  })();
  m.colorNode = mix(vec3(0.05, 0.055, 0.07), vec3(0.018, 0.02, 0.028), road);
  // sodium glow along curbs + lane markings
  const curb = max(
    float(1).sub(smoothstep(0.0, 2.5, abs(dx.sub(lot)))),
    float(1).sub(smoothstep(0.0, 2.5, abs(dz.sub(lot)))),
  );
  m.emissiveNode = vec3(1.0, 0.55, 0.2).mul(curb.mul(0.07)).add(vec3(0.9, 0.7, 0.2).mul(lane.mul(0.2)));
  return m;
}

export class City {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();
    this.radius = 3;
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.beaconGeo = new THREE.SphereGeometry(0.6, 8, 6);
    this.mat = makeBuildingMaterial();
    this.beaconMat = makeBeaconMaterial();

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(CHUNK * 9, CHUNK * 9), makeGroundMaterial());
    this.ground.rotation.x = -Math.PI / 2;
    scene.add(this.ground);
  }

  update(center) {
    const cx = Math.round(center.x / CHUNK), cz = Math.round(center.z / CHUNK);
    this.ground.position.set(Math.round(center.x / BLOCK) * BLOCK, 0, Math.round(center.z / BLOCK) * BLOCK);
    const want = new Set();
    for (let dz = -this.radius; dz <= this.radius; dz++)
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        const key = `${cx + dx},${cz + dz}`;
        want.add(key);
        if (!this.chunks.has(key)) this.chunks.set(key, this.build(cx + dx, cz + dz));
      }
    for (const [key, g] of this.chunks)
      if (!want.has(key)) {
        this.scene.remove(g);
        for (const m of g.children) m.dispose();
        this.chunks.delete(key);
      }
  }

  build(cx, cz) {
    const boxes = [], beacons = [];
    const b0x = cx * CHUNK_BLOCKS - CHUNK_BLOCKS / 2, b0z = cz * CHUNK_BLOCKS - CHUNK_BLOCKS / 2;
    for (let i = 0; i < CHUNK_BLOCKS; i++)
      for (let j = 0; j < CHUNK_BLOCKS; j++) {
        const bx = b0x + i, bz = b0z + j;
        if (Math.abs(bx) <= PLAZA_RADIUS && Math.abs(bz) <= PLAZA_RADIUS) continue;
        this.fillBlock(bx, bz, boxes, beacons);
      }

    const g = new THREE.Group();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    const mesh = new THREE.InstancedMesh(this.boxGeo, this.mat, boxes.length);
    boxes.forEach((b, k) => {
      mesh.setMatrixAt(k, m4.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.w, b.h, b.d)));
      mesh.setColorAt(k, c.setHSL(0.6 + b.hue * 0.08, 0.18, 0.09 + b.hue * 0.12));
    });
    mesh.frustumCulled = false;
    g.add(mesh);
    if (beacons.length) {
      const bm = new THREE.InstancedMesh(this.beaconGeo, this.beaconMat, beacons.length);
      beacons.forEach((p, k) => bm.setMatrixAt(k, m4.makeTranslation(p.x, p.y, p.z)));
      bm.frustumCulled = false;
      g.add(bm);
    }
    this.scene.add(g);
    return g;
  }

  fillBlock(bx, bz, boxes, beacons) {
    const lot = BLOCK - STREET;
    const ox = bx * BLOCK - lot / 2, oz = bz * BLOCK - lot / 2;
    const dens = density(bx * BLOCK, bz * BLOCK);
    const r0 = rnd(bx, bz, 1);
    // park blocks for breathing room
    if (r0 < 0.04) return;
    const k = r0 < 0.3 ? 1 : r0 < 0.75 ? 2 : 3;
    const cell = lot / k, gap = 1.6;
    for (let i = 0; i < k; i++)
      for (let j = 0; j < k; j++) {
        const r = rnd(bx, bz, i, j, 2);
        const w = cell - gap - rnd(bx, bz, i, j, 3) * 3;
        const d = cell - gap - rnd(bx, bz, i, j, 4) * 3;
        const tall = Math.pow(r, 3) * 260 * dens / k ** 0.5;
        // keep the skyline low around the plaza so player towers dominate
        const near = Math.min(1, Math.max(0.12, (Math.hypot(bx, bz) - PLAZA_RADIUS - 1) / 7));
        const h = 6 + rnd(bx, bz, i, j, 5) * 14 + tall * near;
        const x = ox + (i + 0.5) * cell, z = oz + (j + 0.5) * cell;
        const hue = rnd(bx, bz, i, j, 6);
        boxes.push({ x, y: 0, z, w, h, d, hue });
        // setback tiers on tall towers
        if (h > 60) {
          const h2 = h * (0.15 + rnd(bx, bz, i, j, 7) * 0.35);
          boxes.push({ x, y: h, z, w: w * 0.7, h: h2, d: d * 0.7, hue });
          let top = h + h2;
          if (h > 120) {
            const h3 = h2 * 0.6;
            boxes.push({ x, y: top, z, w: w * 0.4, h: h3, d: d * 0.4, hue });
            top += h3;
          }
          boxes.push({ x, y: top, z, w: 0.4, h: 8 + r * 12, d: 0.4, hue }); // antenna
          beacons.push({ x, y: top + 8 + r * 12, z });
        }
      }
  }
}
