import {
  FRICTION_PER_SEC,
  GOAL_W,
  HALF_L,
  HALF_W,
  MALLET_MAX_SPEED,
  MALLET_R,
  MALLET_RESTITUTION,
  PUCK_MAX_SPEED,
  PUCK_R,
  SUBSTEPS,
  WALL_RESTITUTION,
  type Side,
} from './constants';

export interface Vec2 {
  x: number;
  z: number;
}

export interface Body extends Vec2 {
  vx: number;
  vz: number;
}

export interface World {
  puck: Body;
  mallets: [Body, Body];
  /** 各マレットの目標座標（入力） */
  targets: [Vec2, Vec2];
  /** false の間パックは盤上に存在しない（得点直後など） */
  puckActive: boolean;
}

export type PhysicsEvent =
  | { type: 'wall'; x: number; z: number; speed: number }
  | { type: 'mallet'; side: Side; x: number; z: number; speed: number }
  | { type: 'goal'; scorer: Side };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function createWorld(): World {
  return {
    puck: { x: 0, z: 0, vx: 0, vz: 0 },
    mallets: [
      { x: 0, z: HALF_L - 0.25, vx: 0, vz: 0 },
      { x: 0, z: -HALF_L + 0.25, vx: 0, vz: 0 },
    ],
    targets: [
      { x: 0, z: HALF_L - 0.25 },
      { x: 0, z: -HALF_L + 0.25 },
    ],
    puckActive: false,
  };
}

/** マレットの可動範囲（自陣のみ・壁の内側）に収める */
export function clampToHalf(side: Side, p: Vec2): Vec2 {
  const x = clamp(p.x, -HALF_W + MALLET_R, HALF_W - MALLET_R);
  const z =
    side === 1
      ? clamp(p.z, MALLET_R, HALF_L - MALLET_R)
      : clamp(p.z, -HALF_L + MALLET_R, -MALLET_R);
  return { x, z };
}

export function placePuck(w: World, x: number, z: number): void {
  w.puck.x = x;
  w.puck.z = z;
  w.puck.vx = 0;
  w.puck.vz = 0;
  w.puckActive = true;
}

/** dt 秒ぶん世界を進める（内部で SUBSTEPS 分割） */
export function stepWorld(w: World, dt: number, events: PhysicsEvent[]): void {
  const h = dt / SUBSTEPS;
  const friction = Math.pow(FRICTION_PER_SEC, h);
  for (let s = 0; s < SUBSTEPS; s++) {
    for (let i = 0; i < 2; i++) {
      const side = (i + 1) as Side;
      moveMallet(w.mallets[i], clampToHalf(side, w.targets[i]), h);
    }
    if (!w.puckActive) continue;

    const p = w.puck;
    p.x += p.vx * h;
    p.z += p.vz * h;
    p.vx *= friction;
    p.vz *= friction;

    for (let i = 0; i < 2; i++) collideMallet(p, w.mallets[i], (i + 1) as Side, events);
    collideWalls(p, events);

    if (p.z > HALF_L + PUCK_R) {
      events.push({ type: 'goal', scorer: 2 });
      w.puckActive = false;
    } else if (p.z < -HALF_L - PUCK_R) {
      events.push({ type: 'goal', scorer: 1 });
      w.puckActive = false;
    }
  }
}

function moveMallet(m: Body, target: Vec2, h: number): void {
  let dx = target.x - m.x;
  let dz = target.z - m.z;
  const dist = Math.hypot(dx, dz);
  const maxDist = MALLET_MAX_SPEED * h;
  if (dist > maxDist) {
    dx *= maxDist / dist;
    dz *= maxDist / dist;
  }
  m.x += dx;
  m.z += dz;
  m.vx = dx / h;
  m.vz = dz / h;
}

function collideMallet(p: Body, m: Body, side: Side, events: PhysicsEvent[]): void {
  const dx = p.x - m.x;
  const dz = p.z - m.z;
  const minDist = PUCK_R + MALLET_R;
  const d2 = dx * dx + dz * dz;
  if (d2 >= minDist * minDist) return;

  const d = Math.sqrt(d2) || 1e-6;
  const nx = d2 > 0 ? dx / d : 0;
  const nz = d2 > 0 ? dz / d : side === 1 ? -1 : 1;
  // めり込みを解消（マレットは無限質量扱い）
  p.x = m.x + nx * minDist;
  p.z = m.z + nz * minDist;

  const vn = (p.vx - m.vx) * nx + (p.vz - m.vz) * nz;
  if (vn < 0) {
    p.vx -= (1 + MALLET_RESTITUTION) * vn * nx;
    p.vz -= (1 + MALLET_RESTITUTION) * vn * nz;
    clampSpeed(p);
    events.push({ type: 'mallet', side, x: p.x - nx * PUCK_R, z: p.z - nz * PUCK_R, speed: -vn });
  }
}

function collideWalls(p: Body, events: PhysicsEvent[]): void {
  const r = PUCK_R;
  const e = WALL_RESTITUTION;
  const halfGoal = GOAL_W / 2;

  // ゴールの中（エンドラインより奥）では左右をゴール幅に制限
  if (Math.abs(p.z) > HALF_L) {
    const lim = halfGoal - r;
    if (p.x < -lim) {
      p.x = -lim;
      if (p.vx < 0) p.vx = -p.vx * e;
    } else if (p.x > lim) {
      p.x = lim;
      if (p.vx > 0) p.vx = -p.vx * e;
    }
    return;
  }

  // サイドの壁
  if (p.x < -HALF_W + r) {
    p.x = -HALF_W + r;
    if (p.vx < 0) {
      events.push({ type: 'wall', x: -HALF_W, z: p.z, speed: -p.vx });
      p.vx = -p.vx * e;
    }
  } else if (p.x > HALF_W - r) {
    p.x = HALF_W - r;
    if (p.vx > 0) {
      events.push({ type: 'wall', x: HALF_W, z: p.z, speed: p.vx });
      p.vx = -p.vx * e;
    }
  }

  // エンドの壁（ゴール開口部は除く）
  if (Math.abs(p.x) > halfGoal) {
    if (p.z > HALF_L - r) {
      p.z = HALF_L - r;
      if (p.vz > 0) {
        events.push({ type: 'wall', x: p.x, z: HALF_L, speed: p.vz });
        p.vz = -p.vz * e;
      }
    } else if (p.z < -HALF_L + r) {
      p.z = -HALF_L + r;
      if (p.vz < 0) {
        events.push({ type: 'wall', x: p.x, z: -HALF_L, speed: -p.vz });
        p.vz = -p.vz * e;
      }
    }
  }

  // ゴールポスト（開口部の角）は半径0の円として衝突
  for (const px of [-halfGoal, halfGoal]) {
    for (const pz of [-HALF_L, HALF_L]) {
      const dx = p.x - px;
      const dz = p.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const nz = dz / d;
      p.x = px + nx * r;
      p.z = pz + nz * r;
      const vn = p.vx * nx + p.vz * nz;
      if (vn < 0) {
        p.vx -= (1 + e) * vn * nx;
        p.vz -= (1 + e) * vn * nz;
        events.push({ type: 'wall', x: px, z: pz, speed: -vn });
      }
    }
  }
}

function clampSpeed(b: Body): void {
  const sp = Math.hypot(b.vx, b.vz);
  if (sp > PUCK_MAX_SPEED) {
    b.vx *= PUCK_MAX_SPEED / sp;
    b.vz *= PUCK_MAX_SPEED / sp;
  }
}
