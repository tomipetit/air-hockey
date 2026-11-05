// ネット対戦のホスト（P1）：GameHost を回し、STATE/EVENT を送り、P2 の INPUT を検証して適用する
import type { Side } from '../shared/constants';
import { GameHost, type GameEvent, type Phase } from '../shared/game-host';
import { clampToHalf, type Vec2, type World } from '../shared/physics';
import { phaseToCode, seqNewer, toWireEvent, type GameMsg, type StateMsg } from '../shared/protocol';
import type { NetSession } from '../net/session';
import type { DriverHooks, MatchDriver } from './driver';

/** 受け付ける入力座標の絶対値の上限（テーブルは ±0.5 × ±1.0） */
const INPUT_LIMIT = 2;

export class NetHostDriver implements MatchDriver {
  readonly kind = 'host' as const;
  readonly localSide: Side = 1;
  readonly host = new GameHost();
  private lastSentTick = -1;
  private lastSeq = -1;
  private localRematch = false;
  private peerRematch = false;
  private disposed = false;

  constructor(
    private session: NetSession,
    private hooks: DriverHooks,
  ) {
    session.onMessage = (m) => this.onMessage(m);
    this.startMatch();
  }

  get world(): World {
    return this.host.world;
  }

  get score(): [number, number] {
    return this.host.score;
  }

  get phase(): Phase {
    return this.host.phase;
  }

  private startMatch(): void {
    this.host.reset();
    this.localRematch = this.peerRematch = false;
    this.session.send({ type: 'match_start', startTick: this.host.tickCount });
    this.hooks.matchStarted();
  }

  private onMessage(m: GameMsg): void {
    if (this.disposed) return;
    switch (m.type) {
      case 'input': {
        // SPEC 10: NaN・範囲外を拒否
        if (!Number.isFinite(m.x) || !Number.isFinite(m.z)) return;
        if (Math.abs(m.x) > INPUT_LIMIT || Math.abs(m.z) > INPUT_LIMIT) return;
        // 順不同到着の古いものは捨てる
        if (this.lastSeq >= 0 && !seqNewer(m.seq, this.lastSeq)) return;
        this.lastSeq = m.seq;
        const c = clampToHalf(2, m);
        this.host.setInput(2, c.x, c.z);
        break;
      }
      case 'rematch':
        this.peerRematch = true;
        if (this.localRematch) this.startMatch();
        else this.hooks.peerWantsRematch();
        break;
      default:
        break;
    }
  }

  update(dt: number, localTarget: Vec2 | null): GameEvent[] {
    if (localTarget) this.host.setInput(1, localTarget.x, localTarget.z);
    const evs = this.host.update(dt);
    for (const ev of evs) {
      const w = toWireEvent(ev);
      if (w) this.session.send({ type: 'event', tick: ev.tick, ev: w });
    }
    if (this.host.tickCount !== this.lastSentTick) {
      this.session.send(this.stateMsg());
      this.lastSentTick = this.host.tickCount;
    }
    return evs;
  }

  requestRematch(): void {
    this.localRematch = true;
    this.session.send({ type: 'rematch' });
    if (this.peerRematch) this.startMatch();
  }

  dispose(): void {
    this.disposed = true;
    if (this.session.onMessage) this.session.onMessage = null;
  }

  private stateMsg(): StateMsg {
    const w = this.host.world;
    const [m1, m2] = w.mallets;
    return {
      type: 'state',
      tick: this.host.tickCount,
      phase: phaseToCode(this.host.phase),
      puckActive: w.puckActive,
      ackSeq: this.lastSeq < 0 ? 0 : this.lastSeq,
      puck: { x: w.puck.x, z: w.puck.z, vx: w.puck.vx, vz: w.puck.vz },
      m1: { x: m1.x, z: m1.z },
      m2: { x: m2.x, z: m2.z },
      score: [this.host.score[0], this.host.score[1]],
    };
  }
}
