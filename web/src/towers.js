// The plaza at the center of the city: every player gets a tower that grows
// a floor per floor bought. The jackpot obelisk sits in the middle; the last
// buyer's tower gets a sky beam. Everything resets when a round settles.
// Meteora buybacks drop a cyan column into the obelisk; migration sends shockwaves out.
import * as THREE from 'three/webgpu';
import { Fn, float, vec3, step, fract, positionWorld, positionLocal, normalWorld, abs, uniform, time, sin, smoothstep, mix } from 'three/tsl';
import { BLOCK, STREET, PLAZA_RADIUS } from './city.js';
import { UNIT } from './game.js';

const PLAZA_HALF = (PLAZA_RADIUS + 0.5) * BLOCK - STREET / 2;
const PLOT = 13;
const FLOOR_H = 2.4;

export const towerHeight = (floors) => 6 + 24 * Math.log2(1 + floors);

function plotPositions() {
  const out = [];
  const n = Math.floor(PLAZA_HALF / PLOT);
  for (let i = -n; i <= n; i++)
    for (let j = -n; j <= n; j++) {
      const x = i * PLOT, z = j * PLOT;
      if (Math.hypot(x, z) < 26) continue; // obelisk clearance
      out.push(new THREE.Vector3(x, 0, z));
    }
  // inner plots first so early buyers sit next to the jackpot
  return out.sort((a, b) => a.length() - b.length());
}

const METEORA = vec3(0.26, 0.9, 1.0);
const METEORA_COLOR = new THREE.Color(0.26, 0.9, 1.0);

const nameHue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 360) / 360; };

export class Plaza {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.plots = plotPositions();
    this.towers = new Map(); // who -> tower
    this.fx = [];
    this.tension = uniform(0);

    // platform
    const pm = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.6 });
    pm.colorNode = vec3(0.03, 0.03, 0.05);
    const gx = step(0.94, fract(positionWorld.x.div(PLOT).add(0.5)));
    const gz = step(0.94, fract(positionWorld.z.div(PLOT).add(0.5)));
    pm.emissiveNode = mix(vec3(0.1, 0.35, 1.0), vec3(1.0, 0.1, 0.15), this.tension).mul(gx.max(gz).mul(0.5));
    const platform = new THREE.Mesh(new THREE.BoxGeometry(PLAZA_HALF * 2, 0.6, PLAZA_HALF * 2), pm);
    platform.position.y = 0.3;
    scene.add(platform);

    // jackpot obelisk
    this.potLevel = uniform(0);
    const om = new THREE.MeshStandardNodeMaterial({ roughness: 0.2, metalness: 0.9 });
    om.colorNode = vec3(0.12, 0.09, 0.02);
    om.emissiveNode = Fn(() => {
      const band = step(0.7, fract(positionWorld.y.div(4).sub(time.mul(0.6))));
      const pulse = sin(time.mul(mix(2.0, 12.0, this.tension))).mul(0.5).add(0.5);
      const gold = vec3(1.0, 0.7, 0.15), red = vec3(1.0, 0.12, 0.08);
      return mix(gold, red, this.tension).mul(band.mul(1.5).add(0.25).add(pulse.mul(this.tension).mul(1.5)));
    })();
    this.obelisk = new THREE.Mesh(new THREE.CylinderGeometry(5, 13, 1, 4, 1).translate(0, 0.5, 0), om);
    this.obelisk.rotation.y = Math.PI / 4;
    this.obelisk.position.y = 0.6;
    scene.add(this.obelisk);
    this.obeliskH = 50;

    // last-buyer beam
    const bm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    bm.colorNode = vec3(1.0, 0.85, 0.3).mul(2.0);
    bm.opacityNode = float(1).sub(smoothstep(0.0, 1.0, positionLocal.y)).mul(0.55);
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 1, 16, 1, true).translate(0, 0.5, 0), bm);
    this.beam.scale.y = 900;
    this.beam.visible = false;
    scene.add(this.beam);

    // Meteora buyback column over the obelisk
    this.bb = uniform(0);
    const cm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    cm.colorNode = METEORA.mul(2.5);
    cm.opacityNode = smoothstep(0.0, 0.08, positionLocal.y).mul(float(1).sub(positionLocal.y)).mul(this.bb).mul(0.8);
    this.bbBeam = new THREE.Mesh(new THREE.CylinderGeometry(6, 9, 1, 24, 1, true).translate(0, 0.5, 0), cm);
    this.bbBeam.scale.y = 700;
    this.bbBeam.visible = false;
    scene.add(this.bbBeam);

    this.boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
  }

  makeTower(who, color) {
    const plot = this.plots[this.towers.size % this.plots.length];
    const glow = uniform(0);
    const c = uniform(color);
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.7 });
    m.colorNode = c.mul(0.3);
    m.emissiveNode = Fn(() => {
      const side = float(1).sub(step(0.5, abs(normalWorld.y)));
      const floorLine = step(0.82, fract(positionWorld.y.div(FLOOR_H)));
      return c.mul(floorLine.mul(side).mul(1.6).add(0.3).add(glow.mul(3)));
    })();
    const mesh = new THREE.Mesh(this.boxGeo, m);
    mesh.position.copy(plot).setY(0.6);
    mesh.scale.set(8, 0.01, 8);
    this.group.add(mesh);
    const t = { who, mesh, glow, color, floors: 0, h: 0.01, target: 0.01 };
    this.towers.set(who, t);
    return t;
  }

  onBuy(who, floors, isYou) {
    let t = this.towers.get(who);
    if (!t) t = this.makeTower(who, isYou ? new THREE.Color(0.2, 1.0, 0.6) : new THREE.Color().setHSL(nameHue(who), 0.85, 0.55));
    t.floors = floors;
    t.target = towerHeight(floors);
    t.glow.value = 1;
    this.lastBuyer = t;
    this.spawnRing(t.mesh.position, t.color);
  }

  // Bigger buybacks flash brighter. `out` is in token base units.
  onBuyback(out) {
    this.bb.value = Math.min(1, 0.45 + 0.2 * Math.log10(1 + out / UNIT));
    this.spawnRing(new THREE.Vector3(), METEORA_COLOR, { speed: 60 });
  }

  // Curve complete / migrated to DAMM v2: shockwaves across the whole city.
  onMigration() {
    this.bb.value = 1;
    for (let i = 0; i < 4; i++) setTimeout(() => this.spawnRing(new THREE.Vector3(), METEORA_COLOR, { speed: 260, life: 3 }), i * 350);
  }

  spawnRing(pos, color, { speed = 40, life = 1.2 } = {}) {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const o = uniform(1);
    m.colorNode = vec3(color.r, color.g, color.b).mul(3);
    m.opacityNode = o;
    const ring = new THREE.Mesh(this.ringGeo, m);
    ring.position.copy(pos).setY(1);
    this.scene.add(ring);
    this.fx.push({ ring, o, age: 0, speed, life });
  }

  setJackpot(base) {
    this.obeliskH = 50 + 45 * Math.log10(1 + base / UNIT);
  }

  setTension(t) { this.tension.value = t; }

  reset() {
    for (const t of this.towers.values()) t.collapsing = true;
    this.lastBuyer = null;
  }

  update(dt) {
    for (const [who, t] of this.towers) {
      if (t.collapsing) {
        t.h *= Math.pow(0.02, dt);
        if (t.h < 0.05) { this.group.remove(t.mesh); t.mesh.material.dispose(); this.towers.delete(who); continue; }
      } else {
        t.h += (t.target - t.h) * (1 - Math.pow(0.02, dt));
      }
      t.mesh.scale.y = t.h;
      t.glow.value *= Math.pow(0.15, dt);
    }
    const lb = this.lastBuyer;
    this.beam.visible = !!lb && !lb.collapsing;
    if (lb) this.beam.position.copy(lb.mesh.position).setY(lb.h + 0.6);

    this.obelisk.scale.y += (this.obeliskH - this.obelisk.scale.y) * (1 - Math.pow(0.05, dt));
    this.bb.value *= Math.pow(0.3, dt);
    this.bbBeam.visible = this.bb.value > 0.01;

    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.age += dt;
      const s = 4 + f.age * f.speed;
      f.ring.scale.set(s, 1, s);
      f.o.value = Math.max(0, 1 - f.age / f.life);
      if (f.age > f.life) { this.scene.remove(f.ring); f.ring.material.dispose(); this.fx.splice(i, 1); }
    }
  }

  // Top towers by floors, for HTML name labels.
  labelAnchors(n = 12) {
    return [...this.towers.values()]
      .filter((t) => !t.collapsing)
      .sort((a, b) => b.floors - a.floors)
      .slice(0, n)
      .map((t) => ({ who: t.who, floors: t.floors, pos: t.mesh.position.clone().setY(t.h + 4) }));
  }
}
