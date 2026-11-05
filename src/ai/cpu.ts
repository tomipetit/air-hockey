import { HALF_L, HALF_W, MALLET_R, PUCK_R, goalSign, type Side } from '../shared/constants';
import type { Vec2, World } from '../shared/physics';

export type CpuLevel = 'easy' | 'normal' | 'hard';

const LEVELS: Record<CpuLevel, { speed: number; reaction: number; error: number }> = {
  easy: { speed: 1.8, reaction: 0.2, error: 0.08 },
  normal: { speed: 2.9, reaction: 0.1, error: 0.04 },
  hard: { speed: 4.4, reaction: 0.05, error: 0.012 },
};

/** 簡易 CPU（M1 の練習相手。本格版は M6） */
export class CpuPlayer {
  private target: Vec2;
  private aim: Vec2;
  private thinkTimer = 0;

  constructor(
    readonly side: Side,
    public level: CpuLevel = 'normal',
  ) {
    const z = goalSign(side) * (HALF_L - 0.25);
    this.target = { x: 0, z };
    this.aim = { x: 0, z };
  }

  update(world: World, dt: number): Vec2 {
    const cfg = LEVELS[this.level];
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = cfg.reaction;
      this.aim = this.decide(world);
      this.aim.x += (Math.random() - 0.5) * 2 * cfg.error;
      this.aim.z += (Math.random() - 0.5) * 2 * cfg.error;
    }
    const dx = this.aim.x - this.target.x;
    const dz = this.aim.z - this.target.z;
    const d = Math.hypot(dx, dz);
    const step = cfg.speed * dt;
    if (d <= step) {
      this.target = { ...this.aim };
    } else {
      this.target.x += (dx / d) * step;
      this.target.z += (dz / d) * step;
    }
    return this.target;
  }

  private decide(world: World): Vec2 {
    const g = goalSign(this.side);
    const homeZ = g * (HALF_L - 0.2);
    const p = world.puck;
    const m = world.mallets[this.side - 1];
    if (!world.puckActive) return { x: 0, z: homeZ };

    const inMyHalf = p.z * g > 0;
    if (inMyHalf) {
      const malletBehindPuck = (m.z - p.z) * g > PUCK_R * 0.5;
      if (malletBehindPuck) {
        // 相手ゴールに向かってパックを打ち抜く
        const gx = (Math.random() - 0.5) * 0.2;
        const gz = -g * HALF_L;
        const dx = gx - p.x;
        const dz = gz - p.z;
        const d = Math.hypot(dx, dz) || 1;
        return { x: p.x + (dx / d) * 0.18, z: p.z + (dz / d) * 0.18 };
      }
      // パックが自分より後ろ → 横に避けながら回り込む
      const sideOff = p.x > m.x ? -1 : 1;
      return { x: p.x + sideOff * (MALLET_R + PUCK_R + 0.04), z: p.z + g * 0.2 };
    }

    // 相手陣にパック → ゴール前で守る。向かってくるなら到達位置を予測
    let x = p.x * 0.4;
    if (p.vz * g > 0.2) {
      const t = (homeZ - p.z) / p.vz;
      x = reflectX(p.x + p.vx * t);
    }
    return { x: x * 0.8, z: homeZ };
  }
}

/** 左右の壁で反射した位置を求める */
function reflectX(x: number): number {
  const lim = HALF_W - PUCK_R;
  const span = lim * 2;
  let v = (x + lim) % (span * 2);
  if (v < 0) v += span * 2;
  return v <= span ? v - lim : span * 2 - v - lim;
}
