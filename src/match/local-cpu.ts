// CPU 練習（M1 と同じ挙動）
import { CpuPlayer, type CpuLevel } from '../ai/cpu';
import type { Side } from '../shared/constants';
import { GameHost, type GameEvent, type Phase } from '../shared/game-host';
import type { Vec2, World } from '../shared/physics';
import type { DriverHooks, MatchDriver } from './driver';

const LOCAL: Side = 1;
const CPU_SIDE: Side = 2;

export class LocalCpuDriver implements MatchDriver {
  readonly kind = 'cpu' as const;
  readonly localSide = LOCAL;
  readonly host = new GameHost();
  readonly cpu: CpuPlayer;

  constructor(
    level: CpuLevel,
    private hooks: DriverHooks,
  ) {
    this.cpu = new CpuPlayer(CPU_SIDE, level);
    this.hooks.matchStarted();
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

  update(dt: number, localTarget: Vec2 | null): GameEvent[] {
    if (localTarget) this.host.setInput(LOCAL, localTarget.x, localTarget.z);
    const t = this.cpu.update(this.host.world, dt);
    this.host.setInput(CPU_SIDE, t.x, t.z);
    return this.host.update(dt);
  }

  /** やり直し・もう一度 */
  requestRematch(): void {
    this.host.reset();
    this.hooks.matchStarted();
  }

  dispose(): void {
    /* 解放するものはない */
  }
}
