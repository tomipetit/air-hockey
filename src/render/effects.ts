import * as THREE from 'three';
import { PUCK_R } from '../shared/constants';
import type { World } from '../shared/physics';
import { COLORS } from './colors';

/** パックの残光トレイル */
export class PuckTrail {
  readonly root = new THREE.Group();
  private discs: THREE.Mesh[] = [];
  private history: { x: number; z: number; s: number }[] = [];

  constructor(private length = 22) {
    const geo = new THREE.CircleGeometry(PUCK_R, 20);
    for (let i = 0; i < length; i++) {
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: COLORS.puck,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.003;
      this.discs.push(m);
      this.root.add(m);
    }
  }

  update(world: World): void {
    const p = world.puck;
    if (!world.puckActive) {
      this.history.length = 0;
    } else {
      const speed = Math.hypot(p.vx, p.vz);
      this.history.unshift({ x: p.x, z: p.z, s: Math.min(1, speed / 3.5) });
      if (this.history.length > this.length) this.history.pop();
    }
    this.discs.forEach((d, i) => {
      const h = this.history[i];
      const mat = d.material as THREE.MeshBasicMaterial;
      if (!h || i === 0) {
        mat.opacity = 0;
        return;
      }
      const f = 1 - i / this.length;
      d.position.x = h.x;
      d.position.z = h.z;
      d.scale.setScalar(0.35 + 0.65 * f);
      mat.opacity = 0.42 * f * h.s;
    });
  }
}

/** 衝突時の火花 */
export class Sparks {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private next = 0;

  constructor(private count = 160) {
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.022,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.points.frustumCulled = false;
  }

  burst(x: number, z: number, color: number, n: number, power: number): void {
    const c = new THREE.Color(color);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.count;
      const a = Math.random() * Math.PI * 2;
      const sp = (0.3 + Math.random()) * power;
      this.pos.set([x, 0.02, z], i * 3);
      this.vel.set([Math.cos(a) * sp, 0.2 + Math.random() * 0.8 * power, Math.sin(a) * sp], i * 3);
      this.col.set([c.r, c.g, c.b], i * 3);
      this.life[i] = 0.35 + Math.random() * 0.3;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = -10;
        continue;
      }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 3 * dt;
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      const fade = Math.max(0, Math.min(1, this.life[i] * 3));
      this.col[i * 3] *= 0.97 + 0.03 * fade;
      this.col[i * 3 + 1] *= 0.97 + 0.03 * fade;
      this.col[i * 3 + 2] *= 0.97 + 0.03 * fade;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}
