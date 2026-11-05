import { describe, expect, it, vi } from 'vitest';
import {
  GOAL_W,
  HALF_L,
  HALF_W,
  MALLET_MAX_SPEED,
  MALLET_R,
  PUCK_MAX_SPEED,
  PUCK_R,
  SERVE_Z,
  STALL_SEC,
  TICK_DT,
  WIN_SCORE,
  type Side,
} from './constants';
import { GameHost, type TickedEvent } from './game-host';
import { clampToHalf, createWorld, moveMallet, placePuck, stepWorld, type PhysicsEvent } from './physics';

/** n tick ぶん 1 tick ずつ進めてイベントを集める */
function run(h: GameHost, ticks: number): TickedEvent[] {
  const out: TickedEvent[] = [];
  for (let i = 0; i < ticks; i++) out.push(...h.update(TICK_DT + 1e-9));
  return out;
}

function toPlaying(h: GameHost): TickedEvent[] {
  const evs: TickedEvent[] = [];
  for (let i = 0; i < 400 && h.phase !== 'playing'; i++) evs.push(...h.update(TICK_DT + 1e-9));
  expect(h.phase).toBe('playing');
  return evs;
}

/** forceGoal と同じ置き方で scorer に得点させる */
function shoot(h: GameHost, scorer: Side): TickedEvent[] {
  const w = h.world;
  if (scorer === 1) {
    placePuck(w, 0, -HALF_L + 0.06);
    w.puck.vz = -3;
  } else {
    placePuck(w, 0, HALF_L - 0.06);
    w.puck.vz = 3;
  }
  const evs: TickedEvent[] = [];
  for (let i = 0; i < 60 && h.phase === 'playing'; i++) evs.push(...h.update(TICK_DT + 1e-9));
  return evs;
}

describe('GameHost：試合進行', () => {
  it('カウントダウン 3,2,1 → start、start でサーブ側の陣地にパック', () => {
    const h = new GameHost();
    const evs = toPlaying(h);
    expect(evs.filter((e) => e.type === 'countdown').map((e) => (e as { n: number }).n)).toEqual([3, 2, 1]);
    expect(evs.filter((e) => e.type === 'start')).toHaveLength(1);
    expect(h.world.puckActive).toBe(true);
    expect(Math.abs(h.world.puck.z)).toBeCloseTo(SERVE_Z, 1);
    expect(h.world.puck.x).toBeCloseTo(0, 6);
  });

  it('カウントダウンは約 3 秒（180 tick）', () => {
    const h = new GameHost();
    const t0 = h.tickCount;
    toPlaying(h);
    expect(h.tickCount - t0).toBeGreaterThanOrEqual(179);
    expect(h.tickCount - t0).toBeLessThanOrEqual(181);
  });

  it('得点で score イベント、7 点で over（winner・最終スコア）', () => {
    const h = new GameHost();
    toPlaying(h);
    const all: TickedEvent[] = [];
    for (let i = 0; i < WIN_SCORE; i++) {
      if (h.phase !== 'playing') all.push(...toPlaying(h));
      all.push(...shoot(h, 1));
    }
    const scores = all.filter((e) => e.type === 'score');
    expect(scores).toHaveLength(7);
    expect(scores.map((e) => (e as { score: [number, number] }).score[0])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const over = all.filter((e) => e.type === 'over');
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ type: 'over', winner: 1, score: [7, 0] });
    expect(h.phase).toBe('over');
    expect(h.winner).toBe(1);
    expect(h.score).toEqual([7, 0]);
  });

  it('6 点では over にならない／P2 も 7 点で勝つ', () => {
    const h = new GameHost();
    toPlaying(h);
    for (let i = 0; i < 6; i++) {
      if (h.phase !== 'playing') toPlaying(h);
      shoot(h, 2);
    }
    expect(h.phase).toBe('goal');
    expect(h.score).toEqual([0, 6]);
    toPlaying(h);
    shoot(h, 1);
    toPlaying(h);
    const evs = shoot(h, 2);
    expect(h.phase).toBe('over');
    expect(h.winner).toBe(2);
    expect(evs.find((e) => e.type === 'over')).toMatchObject({ winner: 2, score: [1, 7] });
  });

  it('over 後は時間が進んでもサーブ・得点しない', () => {
    const h = new GameHost();
    for (let i = 0; i < WIN_SCORE; i++) {
      toPlaying(h);
      shoot(h, 1);
    }
    expect(h.phase).toBe('over');
    const evs = run(h, 600);
    expect(evs.filter((e) => e.type === 'score' || e.type === 'start' || e.type === 'stall')).toHaveLength(0);
    expect(h.phase).toBe('over');
    expect(h.score).toEqual([7, 0]);
  });

  it.each([1, 2] as const)('失点した側の陣地から再開（scorer=%i）', (scorer) => {
    const h = new GameHost();
    toPlaying(h);
    shoot(h, scorer);
    expect(h.phase).toBe('goal');
    expect(h.world.puckActive).toBe(false);
    // 1 秒（GOAL_PAUSE_SEC）後に再開
    run(h, 59);
    expect(h.phase).toBe('goal');
    run(h, 2);
    expect(h.phase).toBe('playing');
    const loser: Side = scorer === 1 ? 2 : 1;
    // P1 の陣地は z>0、P2 は z<0
    expect(h.world.puckActive).toBe(true);
    expect(h.world.puck.z).toBeCloseTo(loser === 1 ? SERVE_Z : -SERVE_Z, 1);
  });

  it('tickCount は単調増加し reset() で戻らない。イベントの tick は発生 tick', () => {
    const h = new GameHost();
    toPlaying(h);
    const before = h.tickCount;
    expect(before).toBeGreaterThan(0);
    h.reset();
    expect(h.tickCount).toBe(before);
    expect(h.score).toEqual([0, 0]);
    expect(h.phase).toBe('countdown');
    const evs = run(h, 1);
    expect(h.tickCount).toBe(before + 1);
    expect(evs[0]).toMatchObject({ type: 'countdown', n: 3, tick: before + 1 });
    const more = toPlaying(h);
    for (const e of more) expect(e.tick).toBeGreaterThan(before);
    const start = more.find((e) => e.type === 'start')!;
    expect(start.tick).toBe(h.tickCount);
  });

  it('1 回の update で複数 tick 進むと各イベントに別々の tick が付く', () => {
    const h = new GameHost();
    const t0 = h.tickCount;
    const evs = h.update(0.25); // 15 tick
    expect(h.tickCount - t0).toBe(15);
    expect(evs[0].tick).toBe(t0 + 1);
  });

  it('dt は 0.25 秒で頭打ち（長い停止の後に暴走しない）', () => {
    const h = new GameHost();
    const t0 = h.tickCount;
    h.update(10);
    expect(h.tickCount - t0).toBe(15);
  });

  it('膠着：同じ陣地で 7 秒ほぼ停止 → 相手側から再開（stall）', () => {
    const h = new GameHost();
    toPlaying(h);
    // マレットをパックから離しておく
    h.setInput(1, -0.4, 0.9);
    h.setInput(2, -0.4, -0.9);
    placePuck(h.world, 0.3, 0.5); // P1 陣地で停止
    const evs = run(h, Math.round(STALL_SEC * 60) - 5);
    expect(evs.filter((e) => e.type === 'stall')).toHaveLength(0);
    const evs2 = run(h, 10);
    const st = evs2.filter((e) => e.type === 'stall');
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ serveTo: 2 });
    expect(h.world.puck.z).toBeCloseTo(-SERVE_Z, 6);
    expect(h.world.puck.x).toBeCloseTo(0, 6);
    expect(h.score).toEqual([0, 0]);
  });

  it('膠着（P2 陣地）→ P1 側から再開', () => {
    const h = new GameHost();
    toPlaying(h);
    h.setInput(1, -0.4, 0.9);
    h.setInput(2, -0.4, -0.9);
    placePuck(h.world, 0.3, -0.5);
    const evs = run(h, Math.round(STALL_SEC * 60) + 5);
    expect(evs.find((e) => e.type === 'stall')).toMatchObject({ serveTo: 1 });
    expect(h.world.puck.z).toBeCloseTo(SERVE_Z, 6);
  });

  it('ゆっくりでも動き続けていれば・陣地をまたげば膠着扱いしない', () => {
    const h = new GameHost();
    toPlaying(h);
    h.setInput(1, -0.4, 0.9);
    h.setInput(2, -0.4, -0.9);
    placePuck(h.world, 0.3, 0.5);
    h.world.puck.vz = 0.3; // 0.15 以上
    h.world.puck.vx = 0;
    // 壁の間を往復させる（摩擦 0.98/s なので 8 秒でもほぼ 0.25 以上）
    const evs = run(h, Math.round((STALL_SEC + 1) * 60));
    expect(evs.filter((e) => e.type === 'stall')).toHaveLength(0);
  });

  it('reset() のサーブ側はランダム（両側があり得る）', () => {
    const spy = vi.spyOn(Math, 'random');
    spy.mockReturnValue(0.1);
    const a = new GameHost();
    toPlaying(a);
    spy.mockReturnValue(0.9);
    const b = new GameHost();
    toPlaying(b);
    spy.mockRestore();
    expect(Math.sign(a.world.puck.z)).not.toBe(Math.sign(b.world.puck.z));
  });
});

describe('physics：自陣制限・速度上限・ゴール判定', () => {
  it.each([
    [1, { x: 0, z: -0.8 }, { x: 0, z: MALLET_R }],
    [1, { x: 2, z: 2 }, { x: HALF_W - MALLET_R, z: HALF_L - MALLET_R }],
    [2, { x: 0, z: 0.8 }, { x: 0, z: -MALLET_R }],
    [2, { x: -2, z: -2 }, { x: -(HALF_W - MALLET_R), z: -(HALF_L - MALLET_R) }],
  ] as const)('clampToHalf(side=%i, %o)', (side, p, want) => {
    const c = clampToHalf(side, p);
    expect(c.x).toBeCloseTo(want.x, 9);
    expect(c.z).toBeCloseTo(want.z, 9);
  });

  it('マレットは相手陣地の目標を与えてもセンターラインを越えない', () => {
    const h = new GameHost();
    h.setInput(1, 0, -0.9);
    h.setInput(2, 0, 0.9);
    run(h, 120);
    expect(h.world.mallets[0].z).toBeGreaterThanOrEqual(MALLET_R - 1e-9);
    expect(h.world.mallets[1].z).toBeLessThanOrEqual(-MALLET_R + 1e-9);
  });

  it('マレットの 1 tick の移動量は最大速度で制限される', () => {
    const m = { x: 0, z: 0.75, vx: 0, vz: 0 };
    moveMallet(m, { x: 0.4, z: 0.1 }, TICK_DT);
    const moved = Math.hypot(m.x, m.z - 0.75);
    expect(moved).toBeCloseTo(MALLET_MAX_SPEED * TICK_DT, 9);
    expect(Math.hypot(m.vx, m.vz)).toBeCloseTo(MALLET_MAX_SPEED, 6);
  });

  it('パックはマレットに打たれても最大速度を超えない', () => {
    const w = createWorld();
    placePuck(w, 0, 0.5);
    w.mallets[0].x = 0;
    w.mallets[0].z = 0.62;
    w.targets[0] = { x: 0, z: 0.1 }; // 全速で突っ込む
    let maxSp = 0;
    const evs: PhysicsEvent[] = [];
    for (let i = 0; i < 30; i++) {
      stepWorld(w, TICK_DT, evs);
      maxSp = Math.max(maxSp, Math.hypot(w.puck.vx, w.puck.vz));
    }
    expect(evs.some((e) => e.type === 'mallet' && e.side === 1)).toBe(true);
    expect(maxSp).toBeLessThanOrEqual(PUCK_MAX_SPEED + 1e-6);
  });

  it('ゴール口に入ったパックは得点（P2 ゴール z<-L → scorer=1）', () => {
    const w = createWorld();
    w.targets[1] = { x: 0.4, z: -0.9 };
    w.mallets[1].x = 0.4;
    placePuck(w, 0, -0.8);
    w.puck.vz = -3;
    const evs: PhysicsEvent[] = [];
    for (let i = 0; i < 30; i++) stepWorld(w, TICK_DT, evs);
    expect(evs.filter((e) => e.type === 'goal')).toEqual([{ type: 'goal', scorer: 1 }]);
    expect(w.puckActive).toBe(false);
  });

  it('ゴール口の外ではエンドの壁で跳ね返り得点しない', () => {
    const w = createWorld();
    w.targets[0] = { x: -0.4, z: 0.9 };
    w.mallets[0].x = -0.4;
    placePuck(w, GOAL_W / 2 + PUCK_R + 0.05, 0.8);
    w.puck.vz = 3;
    const evs: PhysicsEvent[] = [];
    for (let i = 0; i < 30; i++) stepWorld(w, TICK_DT, evs);
    expect(evs.some((e) => e.type === 'goal')).toBe(false);
    expect(evs.some((e) => e.type === 'wall')).toBe(true);
    expect(w.puck.vz).toBeLessThan(0);
    expect(w.puck.z).toBeLessThanOrEqual(HALF_L - PUCK_R + 1e-9);
  });

  it('ゴールラインを「完全に」越えるまで得点しない', () => {
    const w = createWorld();
    placePuck(w, 0, HALF_L + PUCK_R - 0.001);
    const evs: PhysicsEvent[] = [];
    stepWorld(w, TICK_DT, evs);
    expect(evs.some((e) => e.type === 'goal')).toBe(false);
    w.puck.vz = 1;
    stepWorld(w, TICK_DT, evs);
    expect(evs).toContainEqual({ type: 'goal', scorer: 2 });
  });

  it('サイドの壁を越えない', () => {
    const w = createWorld();
    placePuck(w, 0, 0.3);
    w.puck.vx = 5;
    const evs: PhysicsEvent[] = [];
    for (let i = 0; i < 60; i++) {
      stepWorld(w, TICK_DT, evs);
      expect(Math.abs(w.puck.x)).toBeLessThanOrEqual(HALF_W - PUCK_R + 1e-9);
    }
    expect(evs.some((e) => e.type === 'wall')).toBe(true);
  });
});
