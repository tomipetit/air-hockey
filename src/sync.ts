// ゲスト側：ホストから届くスナップショットを tick 基準で補間する
import { GOAL_W, HALF_L, HALF_W, PUCK_MAX_SPEED, PUCK_R, TICK_RATE } from './shared/constants';
import type { PhaseCode } from './shared/protocol';

export const DELAY_TICKS_P2P = 2;
export const DELAY_TICKS_RELAY = 4;
export const MAX_EXTRAP_TICKS = 6;
export const SNAP_TICKS = 8;
export const TIME_WARP = 0.08;
export const BUFFER_MAX = 32;

export interface Snapshot {
  tick: number;
  phase: PhaseCode;
  puckActive: boolean;
  puck: { x: number; z: number; vx: number; vz: number };
  m1: { x: number; z: number };
  m2: { x: number; z: number };
  score: [number, number];
}

export interface Sampled {
  puckActive: boolean;
  puck: { x: number; z: number; vx: number; vz: number };
  m1: { x: number; z: number };
  renderTick: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const TICKS_PER_MS = TICK_RATE / 1000;

export class Interpolator {
  /** 最後に push を受け付けた時刻 */
  lastArrivalMs = -Infinity;
  private buf: Snapshot[] = [];
  private minTick = 0;
  private renderTick: number | null = null;
  private lastSampleMs = 0;

  constructor(public delayTicks: number) {}

  get newest(): Snapshot | null {
    return this.buf.length ? this.buf[this.buf.length - 1] : null;
  }

  /** 新しい試合の開始（MATCH_START）。minTick 未満のスナップショットは以後無視 */
  reset(minTick: number): void {
    this.buf = [];
    this.minTick = minTick;
    this.renderTick = null;
    this.lastArrivalMs = -Infinity;
  }

  push(s: Snapshot, nowMs: number): void {
    if (s.tick < this.minTick) return; // 前の試合の遅延パケット
    const newest = this.newest;
    if (newest && s.tick <= newest.tick) return; // 重複・順不同
    this.buf.push(s);
    if (this.buf.length > BUFFER_MAX) this.buf.shift();
    this.lastArrivalMs = nowMs;
    if (this.renderTick === null) {
      this.renderTick = s.tick - this.delayTicks;
      this.lastSampleMs = nowMs;
    }
  }

  /** データが 1 つも無ければ false */
  sample(nowMs: number, out: Sampled): boolean {
    const newest = this.newest;
    if (!newest || this.renderTick === null) return false;

    const dtTicks = Math.max(0, (nowMs - this.lastSampleMs) * TICKS_PER_MS);
    this.lastSampleMs = nowMs;
    // 最新 tick の「今の推定値」（パケットが来なくても時間で進むが、外挿上限まで）
    const newestEst = newest.tick + Math.min(Math.max(0, (nowMs - this.lastArrivalMs) * TICKS_PER_MS), MAX_EXTRAP_TICKS);
    const target = newestEst - this.delayTicks;
    let rt = this.renderTick + dtTicks;
    const err = target - rt;
    if (Math.abs(err) > SNAP_TICKS) rt = target;
    else rt += clamp(err, -TIME_WARP * dtTicks, TIME_WARP * dtTicks);
    rt = Math.min(rt, newest.tick + MAX_EXTRAP_TICKS);
    this.renderTick = rt;

    // 古いスナップショットの掃除：rt 以下のものは直前の 1 つだけ残す
    while (this.buf.length >= 2 && this.buf[1].tick <= rt) this.buf.shift();

    const buf = this.buf;
    const first = buf[0];
    if (rt <= first.tick) {
      copySnap(out, first);
    } else if (rt >= newest.tick) {
      // 外挿
      const e = Math.min(rt - newest.tick, MAX_EXTRAP_TICKS) / TICK_RATE;
      const p = newest.puck;
      let x = p.x;
      let z = p.z;
      if (newest.puckActive) {
        x += p.vx * e;
        z += p.vz * e;
      }
      const limX = HALF_W - PUCK_R;
      x = clamp(x, -limX, limX);
      if (Math.abs(x) > GOAL_W / 2 - PUCK_R) z = clamp(z, -(HALF_L - PUCK_R), HALF_L - PUCK_R);
      out.puckActive = newest.puckActive;
      out.puck.x = x;
      out.puck.z = z;
      out.puck.vx = p.vx;
      out.puck.vz = p.vz;
      out.m1.x = newest.m1.x;
      out.m1.z = newest.m1.z;
    } else {
      // 補間：a = rt 以下で最大 tick、b = その次
      let i = 0;
      while (i + 1 < buf.length && buf[i + 1].tick <= rt) i++;
      const a = buf[i];
      const b = buf[i + 1];
      const alpha = (rt - a.tick) / (b.tick - a.tick);
      const span = b.tick - a.tick;
      const dist = Math.hypot(b.puck.x - a.puck.x, b.puck.z - a.puck.z);
      const teleport = a.puckActive !== b.puckActive || dist > (span * PUCK_MAX_SPEED) / TICK_RATE + 0.05;
      if (teleport) {
        out.puck.x = a.puck.x;
        out.puck.z = a.puck.z;
        out.puck.vx = a.puck.vx;
        out.puck.vz = a.puck.vz;
        out.puckActive = a.puckActive;
      } else {
        out.puck.x = lerp(a.puck.x, b.puck.x, alpha);
        out.puck.z = lerp(a.puck.z, b.puck.z, alpha);
        out.puck.vx = lerp(a.puck.vx, b.puck.vx, alpha);
        out.puck.vz = lerp(a.puck.vz, b.puck.vz, alpha);
        out.puckActive = b.puckActive && a.puckActive;
      }
      out.m1.x = lerp(a.m1.x, b.m1.x, alpha);
      out.m1.z = lerp(a.m1.z, b.m1.z, alpha);
    }
    out.renderTick = rt;
    return true;
  }
}

function copySnap(out: Sampled, s: Snapshot): void {
  out.puckActive = s.puckActive;
  out.puck.x = s.puck.x;
  out.puck.z = s.puck.z;
  out.puck.vx = s.puck.vx;
  out.puck.vz = s.puck.vz;
  out.m1.x = s.m1.x;
  out.m1.z = s.m1.z;
}

/** Sampled の初期値 */
export function createSampled(): Sampled {
  return { puckActive: false, puck: { x: 0, z: 0, vx: 0, vz: 0 }, m1: { x: 0, z: 0 }, renderTick: 0 };
}
