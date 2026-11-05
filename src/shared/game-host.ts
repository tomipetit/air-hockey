import {
  COUNTDOWN_SEC,
  GOAL_PAUSE_SEC,
  SERVE_Z,
  STALL_SEC,
  STALL_SPEED,
  TICK_DT,
  WIN_SCORE,
  goalSign,
  otherSide,
  type Side,
} from './constants';
import { createWorld, placePuck, stepWorld, type PhysicsEvent, type World } from './physics';

export type Phase = 'countdown' | 'playing' | 'goal' | 'over';

export type GameEvent =
  | PhysicsEvent
  | { type: 'countdown'; n: number }
  | { type: 'start' }
  | { type: 'score'; scorer: Side; score: [number, number] }
  | { type: 'stall'; serveTo: Side }
  | { type: 'over'; winner: Side; score: [number, number] };

/** 発生した tick（GameHost.tickCount）付きのイベント */
export type TickedEvent = GameEvent & { tick: number };

/**
 * 試合の進行と物理を持つ「正」のゲーム状態。
 * M1 では 1 台の中で動かし、M2 以降はホスト（P1）の端末で動かす。
 */
export class GameHost {
  world: World = createWorld();
  score: [number, number] = [0, 0];
  phase: Phase = 'countdown';
  winner: Side | null = null;
  /** 進めた tick の累計。reset() でも戻さない（旧試合の遅延パケットを tick で弾くため） */
  tickCount = 0;

  private acc = 0;
  private timer = 0;
  private lastCount = 0;
  private serveTo: Side = 1;
  private stallTime = 0;
  private stallHalf: Side = 1;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.world = createWorld();
    this.score = [0, 0];
    this.winner = null;
    this.acc = 0;
    this.serveTo = Math.random() < 0.5 ? 1 : 2;
    this.phase = 'countdown';
    this.timer = COUNTDOWN_SEC;
    this.lastCount = COUNTDOWN_SEC + 1;
  }

  setInput(side: Side, x: number, z: number): void {
    const t = this.world.targets[side - 1];
    t.x = x;
    t.z = z;
  }

  /** 経過時間を渡すと固定ティックで進め、その間に起きたイベントを返す */
  update(dt: number): TickedEvent[] {
    const out: TickedEvent[] = [];
    const events: GameEvent[] = [];
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= TICK_DT) {
      this.acc -= TICK_DT;
      this.tick(events);
      for (const ev of events) out.push({ ...ev, tick: this.tickCount });
      events.length = 0;
    }
    return out;
  }

  private tick(events: GameEvent[]): void {
    this.tickCount++;
    const physics: PhysicsEvent[] = [];
    stepWorld(this.world, TICK_DT, physics);

    switch (this.phase) {
      case 'countdown': {
        const n = Math.ceil(this.timer);
        if (n !== this.lastCount && n > 0) {
          this.lastCount = n;
          events.push({ type: 'countdown', n });
        }
        this.timer -= TICK_DT;
        if (this.timer <= 0) {
          this.serve(this.serveTo);
          this.phase = 'playing';
          events.push({ type: 'start' });
        }
        break;
      }
      case 'playing': {
        for (const ev of physics) {
          events.push(ev);
          if (ev.type === 'goal') this.onGoal(ev.scorer, events);
        }
        if (this.phase === 'playing') this.checkStall(events);
        break;
      }
      case 'goal': {
        this.timer -= TICK_DT;
        if (this.timer <= 0) {
          this.serve(this.serveTo);
          this.phase = 'playing';
        }
        break;
      }
      case 'over':
        break;
    }
  }

  private onGoal(scorer: Side, events: GameEvent[]): void {
    this.score[scorer - 1]++;
    events.push({ type: 'score', scorer, score: [...this.score] as [number, number] });
    if (this.score[scorer - 1] >= WIN_SCORE) {
      this.phase = 'over';
      this.winner = scorer;
      events.push({ type: 'over', winner: scorer, score: [...this.score] as [number, number] });
    } else {
      // 失点した側の陣地から再開
      this.serveTo = otherSide(scorer);
      this.phase = 'goal';
      this.timer = GOAL_PAUSE_SEC;
    }
  }

  private serve(side: Side): void {
    placePuck(this.world, 0, goalSign(side) * SERVE_Z);
    this.stallTime = 0;
  }

  private checkStall(events: GameEvent[]): void {
    const p = this.world.puck;
    const half: Side = p.z > 0 ? 1 : 2;
    const slow = Math.hypot(p.vx, p.vz) < STALL_SPEED;
    if (!slow || half !== this.stallHalf) {
      this.stallHalf = half;
      this.stallTime = 0;
      return;
    }
    this.stallTime += TICK_DT;
    if (this.stallTime >= STALL_SEC) {
      const to = otherSide(half);
      this.serve(to);
      events.push({ type: 'stall', serveTo: to });
    }
  }
}
