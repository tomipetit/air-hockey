// ネット対戦のゲスト（P2）：INPUT を送り、自マレットはローカルで即時移動、
// パックと相手マレットは補間して描画、EVENT は補間表示の tick に合わせて発火する
import { TICK_DT, type Side } from '../shared/constants';
import type { GameEvent, Phase } from '../shared/game-host';
import { clampToHalf, createWorld, moveMallet, type Body, type Vec2, type World } from '../shared/physics';
import { codeToPhase, fromWireEvent, type EventMsg, type GameMsg, type StateMsg } from '../shared/protocol';
import type { NetSession } from '../net/session';
import { DELAY_TICKS_P2P, DELAY_TICKS_RELAY, Interpolator, createSampled, type Snapshot } from '../sync';
import type { DriverHooks, MatchDriver } from './driver';

/** 補間が追いつかなくてもこれ以上は待たずにイベントを出す */
const EVENT_MAX_WAIT_MS = 250;

type QueuedEvent = EventMsg & { recvAt: number };

export class NetGuestDriver implements MatchDriver {
  readonly kind = 'guest' as const;
  readonly localSide: Side = 2;
  world: World = createWorld();
  score: [number, number] = [0, 0];
  readonly interp: Interpolator;
  private local: Body;
  private seq = 0;
  private sendAcc = 0;
  private queue: QueuedEvent[] = [];
  private sampled = createSampled();
  private disposed = false;
  /** 最新 STATE の tick（E2E 用） */
  lastStateTick: number | null = null;
  /** 直近の補間表示 tick（E2E 用） */
  renderTick: number | null = null;
  private lastPhase: Phase | null = null;

  constructor(
    private session: NetSession,
    private hooks: DriverHooks,
    matchStart: { startTick: number },
  ) {
    this.interp = new Interpolator(this.delay());
    this.local = this.world.mallets[1];
    session.onMessage = (m) => this.onMessage(m);
    this.onMatchStart(matchStart.startTick);
  }

  get phase(): Phase | null {
    return this.lastPhase;
  }

  private delay(): number {
    return this.session.status.kind === 'relay' ? DELAY_TICKS_RELAY : DELAY_TICKS_P2P;
  }

  private onMatchStart(startTick: number): void {
    this.interp.reset(startTick);
    this.queue = [];
    this.world = createWorld();
    this.local = this.world.mallets[1];
    this.score = [0, 0];
    this.lastPhase = null;
    this.renderTick = null;
    this.hooks.matchStarted();
  }

  private onMessage(m: GameMsg): void {
    if (this.disposed) return;
    switch (m.type) {
      case 'state':
        this.interp.push(snapshotOf(m), performance.now());
        if (this.interp.newest?.tick === m.tick) {
          this.score = [m.score[0], m.score[1]];
          this.lastStateTick = m.tick;
          this.lastPhase = codeToPhase(m.phase);
        }
        break;
      case 'event':
        this.queue.push({ ...m, recvAt: performance.now() });
        break;
      case 'match_start':
        this.onMatchStart(m.startTick);
        break;
      case 'rematch':
        this.hooks.peerWantsRematch();
        break;
      default:
        break;
    }
  }

  update(dt: number, target: Vec2 | null): GameEvent[] {
    const now = performance.now();
    // 1) 自マレット：ホスト応答を待たずに即時移動（ホストと同じ速度上限で）
    if (target) {
      const c = clampToHalf(2, target);
      this.world.targets[1].x = c.x;
      this.world.targets[1].z = c.z;
      moveMallet(this.local, c, dt);
    }
    // 2) 入力送信：最大 60Hz。target が null（一度も触っていない）なら送らない
    this.sendAcc = Math.min(this.sendAcc + dt, 0.1);
    if (target && this.sendAcc >= TICK_DT) {
      this.sendAcc %= TICK_DT;
      this.seq = (this.seq + 1) & 0xffff;
      this.session.send({ type: 'input', seq: this.seq, x: target.x, z: target.z });
    }
    // 3) 補間
    this.interp.delayTicks = this.delay();
    const s = this.sampled;
    const has = this.interp.sample(now, s);
    if (has) {
      const p = this.world.puck;
      p.x = s.puck.x;
      p.z = s.puck.z;
      p.vx = s.puck.vx;
      p.vz = s.puck.vz;
      this.world.puckActive = s.puckActive;
      const m1 = this.world.mallets[0];
      m1.x = s.m1.x;
      m1.z = s.m1.z;
      this.renderTick = s.renderTick;
    }
    // 4) イベント：補間表示が追いついたものだけ発火
    const out: GameEvent[] = [];
    while (this.queue.length) {
      const q = this.queue[0];
      const due = (has && q.tick <= s.renderTick) || now - q.recvAt > EVENT_MAX_WAIT_MS;
      if (!due) break;
      this.queue.shift();
      out.push(fromWireEvent(q.ev));
    }
    return out;
  }

  requestRematch(): void {
    this.session.send({ type: 'rematch' });
  }

  dispose(): void {
    this.disposed = true;
    this.session.onMessage = null;
  }
}

function snapshotOf(m: StateMsg): Snapshot {
  return {
    tick: m.tick,
    phase: m.phase,
    puckActive: m.puckActive,
    puck: { ...m.puck },
    m1: { ...m.m1 },
    m2: { ...m.m2 },
    score: [m.score[0], m.score[1]],
  };
}
