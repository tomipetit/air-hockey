import { describe, expect, it } from 'vitest';
import { HALF_L, HALF_W, PUCK_R } from './shared/constants';
import {
  DELAY_TICKS_P2P,
  DELAY_TICKS_RELAY,
  Interpolator,
  MAX_EXTRAP_TICKS,
  SNAP_TICKS,
  createSampled,
  type Snapshot,
} from './sync';

const FRAME = 1000 / 60;

/** puck.x = tick×0.01（vx = 0.6/s）の直線運動 */
function snap(tick: number, over: Partial<Snapshot> = {}): Snapshot {
  return {
    tick,
    phase: 1,
    puckActive: true,
    puck: { x: tick * 0.01, z: 0.1, vx: 0.6, vz: 0 },
    m1: { x: tick * 0.001, z: 0.7 },
    m2: { x: 0, z: -0.7 },
    score: [0, 0],
    ...over,
  };
}

/** start から n tick を 60Hz で投入し、各投入直後に sample（描画フレーム相当） */
function feed(ip: Interpolator, start: number, n: number, t0: number, mk = snap) {
  const out = createSampled();
  let now = t0;
  for (let k = 0; k < n; k++) {
    now = t0 + k * FRAME;
    ip.push(mk(start + k), now);
    ip.sample(now, out);
  }
  return { out, now, newest: start + n - 1 };
}

describe('Interpolator', () => {
  it('データが無ければ sample は false', () => {
    const ip = new Interpolator(2);
    expect(ip.sample(0, createSampled())).toBe(false);
    expect(ip.newest).toBeNull();
  });

  it('60Hz 投入で 1 秒後：renderTick ≈ newest−2、puck.x ≈ renderTick×0.01', () => {
    const ip = new Interpolator(DELAY_TICKS_P2P);
    const { out, newest } = feed(ip, 100, 61, 0);
    expect(Math.abs(out.renderTick - (newest - 2))).toBeLessThanOrEqual(0.5);
    expect(out.puck.x).toBeCloseTo(out.renderTick * 0.01, 6);
    expect(out.m1.x).toBeCloseTo(out.renderTick * 0.001, 6);
    expect(out.puckActive).toBe(true);
  });

  it('フレームと tick がずれても（30fps 描画・半端な時刻）tick 基準で補間する', () => {
    const ip = new Interpolator(2);
    const out = createSampled();
    for (let k = 0; k < 120; k++) ip.push(snap(k), k * FRAME), k % 2 === 1 && ip.sample(k * FRAME + 3, out);
    expect(out.puck.x).toBeCloseTo(out.renderTick * 0.01, 6);
    expect(Math.abs(out.renderTick - (119 - 2))).toBeLessThan(1);
  });

  it('delayTicks=4（中継）で renderTick ≈ newest−4', () => {
    const ip = new Interpolator(DELAY_TICKS_RELAY);
    const { out, newest } = feed(ip, 0, 61, 0);
    expect(Math.abs(out.renderTick - (newest - 4))).toBeLessThanOrEqual(0.5);
    expect(out.puck.x).toBeCloseTo(out.renderTick * 0.01, 6);
  });

  it('重複 tick・古い tick は無視される（newest も結果も変わらない）', () => {
    const ipA = new Interpolator(2);
    const ipB = new Interpolator(2);
    const a = feed(ipA, 0, 30, 0);
    feed(ipB, 0, 30, 0);
    const junk = (t: number) => snap(t, { puck: { x: 9, z: 9, vx: 9, vz: 9 }, m1: { x: 9, z: 9 } });
    ipB.push(junk(29), a.now); // 重複
    ipB.push(junk(10), a.now); // 古い
    expect(ipB.newest!.tick).toBe(29);
    expect(ipB.newest!.puck.x).toBeCloseTo(0.29, 9);
    const oa = createSampled();
    const ob = createSampled();
    ipA.sample(a.now + 5, oa);
    ipB.sample(a.now + 5, ob);
    expect(ob).toEqual(oa);
  });

  it('重複・古い push は lastArrivalMs を更新しない', () => {
    const ip = new Interpolator(2);
    ip.push(snap(10), 100);
    ip.push(snap(10), 200);
    ip.push(snap(5), 300);
    expect(ip.lastArrivalMs).toBe(100);
  });

  describe('ロス（外挿）', () => {
    it('投入停止後 500ms：renderTick ≤ newest+6、パックは外挿位置で止まる', () => {
      const ip = new Interpolator(2);
      const mk = (t: number) => snap(t, { puck: { x: 0.1, z: 0.1, vx: 1.2, vz: 0 } });
      const f = feed(ip, 0, 60, 0, mk);
      const out = createSampled();
      const xs: number[] = [];
      for (let t = f.now + FRAME; t <= f.now + 500; t += FRAME) {
        ip.sample(t, out);
        expect(out.renderTick).toBeLessThanOrEqual(f.newest + MAX_EXTRAP_TICKS + 1e-9);
        xs.push(out.puck.x);
      }
      const newest = ip.newest!;
      const e = (out.renderTick - newest.tick) / 60;
      expect(e).toBeGreaterThan(0);
      expect(e).toBeLessThanOrEqual(MAX_EXTRAP_TICKS / 60 + 1e-9);
      expect(out.puck.x).toBeCloseTo(newest.puck.x + newest.puck.vx * e, 6);
      // 後半は止まっている
      expect(xs[xs.length - 1]).toBe(xs[xs.length - 10]);
      // 相手マレットは外挿しない
      expect(out.m1.x).toBeCloseTo(newest.m1.x, 9);
    });

    it('delayTicks=0 なら外挿はちょうど 0.1 秒（MAX_EXTRAP_TICKS）分で止まる', () => {
      const ip = new Interpolator(0);
      const mk = (t: number) => snap(t, { puck: { x: 0.1, z: 0.1, vx: 1.2, vz: 0 } });
      const f = feed(ip, 0, 60, 0, mk);
      const out = createSampled();
      for (let t = f.now + FRAME; t <= f.now + 500; t += FRAME) ip.sample(t, out);
      const n = ip.newest!;
      expect(out.renderTick).toBeCloseTo(n.tick + MAX_EXTRAP_TICKS, 6);
      expect(out.puck.x).toBeCloseTo(n.puck.x + n.puck.vx * 0.1, 6);
    });

    it('壁方向の速度なら ±(HALF_W−PUCK_R) でクランプ', () => {
      const lim = HALF_W - PUCK_R;
      for (const sgn of [1, -1]) {
        const ip = new Interpolator(0);
        const mk = (t: number) => snap(t, { puck: { x: sgn * (lim - 0.01), z: 0.3, vx: sgn * 5, vz: 0 } });
        const f = feed(ip, 0, 10, 0, mk);
        const out = createSampled();
        for (let t = f.now + FRAME; t <= f.now + 300; t += FRAME) ip.sample(t, out);
        expect(out.puck.x).toBeCloseTo(sgn * lim, 9);
      }
    });

    it('ゴール口以外ではエンドの壁を越えない／ゴール口なら越えて外挿する', () => {
      const zlim = HALF_L - PUCK_R;
      const side = new Interpolator(0);
      const mk1 = (t: number) => snap(t, { puck: { x: 0.3, z: zlim - 0.01, vx: 0, vz: 5 } });
      const f1 = feed(side, 0, 10, 0, mk1);
      const o1 = createSampled();
      for (let t = f1.now + FRAME; t <= f1.now + 300; t += FRAME) side.sample(t, o1);
      expect(o1.puck.z).toBeCloseTo(zlim, 9);

      const mouth = new Interpolator(0);
      const mk2 = (t: number) => snap(t, { puck: { x: 0, z: zlim - 0.01, vx: 0, vz: 5 } });
      const f2 = feed(mouth, 0, 10, 0, mk2);
      const o2 = createSampled();
      for (let t = f2.now + FRAME; t <= f2.now + 300; t += FRAME) mouth.sample(t, o2);
      expect(o2.puck.z).toBeGreaterThan(zlim);
    });

    it('puckActive=false のパックは外挿しない', () => {
      const ip = new Interpolator(0);
      const mk = (t: number) => snap(t, { puckActive: false, puck: { x: 0, z: 0.45, vx: 3, vz: 0 } });
      const f = feed(ip, 0, 10, 0, mk);
      const out = createSampled();
      for (let t = f.now + FRAME; t <= f.now + 300; t += FRAME) ip.sample(t, out);
      expect(out.puck.x).toBe(0);
      expect(out.puckActive).toBe(false);
    });
  });

  describe('teleport（ワープ）', () => {
    it('a(z=0.45, inactive) → b(active, 別位置) の間で中間位置を出さない', () => {
      const ip = new Interpolator(2);
      ip.push(snap(10, { puckActive: false, puck: { x: 0, z: 0.45, vx: 0, vz: 0 } }), 0);
      ip.push(snap(12, { puckActive: true, puck: { x: 0, z: -0.45, vx: 0, vz: 0 } }), 2 * FRAME);
      const out = createSampled();
      // renderTick = 8 から始まり、時間とともに 10→12 の間を通る
      const seen: number[] = [];
      for (let t = 0; t <= 6 * FRAME; t += FRAME / 4) {
        ip.sample(t, out);
        if (out.renderTick > 10 && out.renderTick < 12) {
          seen.push(out.puck.z);
          expect(out.puck.z).toBe(0.45);
          expect(out.puckActive).toBe(false);
        }
      }
      expect(seen.length).toBeGreaterThan(0);
    });

    it('両方 active でも移動距離が速度上限を超えるなら補間しない（サーブ・スタール）', () => {
      const ip = new Interpolator(2);
      ip.push(snap(10, { puck: { x: 0.4, z: 0.9, vx: 0, vz: 0 } }), 0);
      ip.push(snap(11, { puck: { x: 0, z: -0.45, vx: 0, vz: 0 } }), FRAME);
      const out = createSampled();
      let hit = false;
      for (let t = 0; t <= 4 * FRAME; t += FRAME / 4) {
        ip.sample(t, out);
        if (out.renderTick > 10 && out.renderTick < 11) {
          hit = true;
          expect(out.puck.x).toBe(0.4);
          expect(out.puck.z).toBe(0.9);
        }
      }
      expect(hit).toBe(true);
    });

    it('速度上限内の移動は補間する（ジャンプ扱いしない）', () => {
      const ip = new Interpolator(2);
      ip.push(snap(10, { puck: { x: 0, z: 0, vx: 0, vz: 0 } }), 0);
      ip.push(snap(12, { puck: { x: 0.16, z: 0, vx: 0, vz: 0 } }), 2 * FRAME); // 2 tick で 0.16 < 2×5/60+0.05
      const out = createSampled();
      let hit = false;
      for (let t = 0; t <= 6 * FRAME; t += FRAME / 4) {
        ip.sample(t, out);
        if (out.renderTick > 10.2 && out.renderTick < 11.8) {
          hit = true;
          expect(out.puck.x).toBeCloseTo((out.renderTick - 10) * 0.08, 6);
        }
      }
      expect(hit).toBe(true);
    });
  });

  describe('復帰（ジャンプ）と時間補正', () => {
    it('500ms 途絶後に再投入：ずれ > 8 tick なら 1 回の sample で target に一致', () => {
      const ip = new Interpolator(2);
      const f = feed(ip, 0, 60, 0);
      const out = createSampled();
      let t = f.now;
      for (; t <= f.now + 500; t += FRAME) ip.sample(t, out);
      const before = out.renderTick;
      // 途絶中もホストは進んでいた：今の tick は newest + 30
      const resumed = f.newest + 30;
      ip.push(snap(resumed), t);
      ip.sample(t, out);
      expect(resumed - 2 - before).toBeGreaterThan(SNAP_TICKS);
      expect(out.renderTick).toBeCloseTo(resumed - 2, 6);
      expect(out.puck.x).toBeCloseTo(out.renderTick * 0.01, 6);
    });

    it('200ms 途絶後の復帰（ずれが小さい）は ±8% で追いつき、ジャンプしない', () => {
      const ip = new Interpolator(2);
      const f = feed(ip, 0, 60, 0);
      const out = createSampled();
      let t = f.now;
      let prev = out.renderTick;
      for (let k = 1; k <= 12; k++) {
        t = f.now + k * FRAME;
        ip.sample(t, out);
      }
      prev = out.renderTick;
      // 再開
      for (let k = 1; k <= 30; k++) {
        const tt = t + k * FRAME;
        ip.push(snap(f.newest + 12 + k), tt);
        ip.sample(tt, out);
        const inc = out.renderTick - prev;
        expect(inc).toBeGreaterThanOrEqual(0.92 - 1e-9);
        expect(inc).toBeLessThanOrEqual(1.08 + 1e-9);
        prev = out.renderTick;
      }
    });

    it('|err| < 8 のとき 1 サンプルあたりの renderTick 増分は dtTicks×[0.92, 1.08]', () => {
      // ホストが 3 tick 先行し始めた（target が少し前にずれた）状況
      const ip = new Interpolator(2);
      const f = feed(ip, 0, 30, 0);
      const out = f.out;
      let prev = out.renderTick;
      const dtMs = 20; // 描画は 50fps
      let t = f.now;
      let tick = f.newest + 3;
      for (let k = 0; k < 40; k++) {
        t += dtMs;
        ip.push(snap(tick), t);
        tick += 1.2; // 60Hz より少し速い（target が先へ逃げる）
        tick = Math.round(tick * 10) / 10;
        ip.sample(t, out);
        const dtTicks = (dtMs * 60) / 1000;
        const inc = out.renderTick - prev;
        expect(inc / dtTicks).toBeGreaterThanOrEqual(0.92 - 1e-9);
        expect(inc / dtTicks).toBeLessThanOrEqual(1.08 + 1e-9);
        prev = out.renderTick;
      }
    });

    it('target より進みすぎた場合は減速（増分 ≥ 0.92×dtTicks）で待つ', () => {
      const ip = new Interpolator(2);
      ip.push(snap(100), 0);
      const out = createSampled();
      ip.sample(0, out); // rt = 98
      ip.delayTicks = 6; // target が 4 tick 後ろへ
      let prev = out.renderTick;
      ip.push(snap(101), FRAME);
      ip.sample(FRAME, out);
      const inc = out.renderTick - prev;
      expect(inc).toBeCloseTo(0.92, 6);
      prev = out.renderTick;
    });
  });

  describe('reset', () => {
    it('reset(minTick) 後、minTick 未満の push が無視される', () => {
      const ip = new Interpolator(2);
      feed(ip, 0, 30, 0);
      ip.reset(1000);
      expect(ip.newest).toBeNull();
      expect(ip.lastArrivalMs).toBe(-Infinity);
      ip.push(snap(999), 1000);
      expect(ip.newest).toBeNull();
      expect(ip.sample(1000, createSampled())).toBe(false);
      ip.push(snap(1000), 1001);
      expect(ip.newest!.tick).toBe(1000);
      const out = createSampled();
      expect(ip.sample(1001, out)).toBe(true);
      expect(out.renderTick).toBeCloseTo(998, 6);
    });

    it('reset 後に古い試合の大きな tick を参照し続けない（新しい試合の tick から再開）', () => {
      const ip = new Interpolator(2);
      const f = feed(ip, 5000, 30, 0);
      ip.reset(f.newest + 1);
      const g = feed(ip, f.newest + 1, 30, f.now + 1000);
      expect(Math.abs(g.out.renderTick - (g.newest - 2))).toBeLessThanOrEqual(0.5);
    });
  });
});
