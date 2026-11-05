import type { Side } from '../shared/constants';
import type { GameEvent, Phase } from '../shared/game-host';
import type { Vec2, World } from '../shared/physics';

export interface DriverHooks {
  /** カウントダウン開始（試合開始・再戦開始）。HUD を 0-0 にし playing 画面へ */
  matchStarted(): void;
  /** 相手が再戦を希望（結果画面に「相手は再戦を希望しています」） */
  peerWantsRematch(): void;
}

export interface MatchDriver {
  readonly kind: 'cpu' | 'host' | 'guest';
  readonly localSide: Side;
  /** 描画用の世界（ゲストは毎フレーム補間結果で上書き） */
  readonly world: World;
  readonly score: [number, number];
  /** 試合の段階（ホスト/CPU: GameHost.phase、ゲスト: 最新 STATE の phase。未受信は null） */
  readonly phase: Phase | null;
  /** 1 フレーム進め、このフレームで演出すべきイベントを返す */
  update(dt: number, localTarget: Vec2 | null): GameEvent[];
  requestRematch(): void;
  dispose(): void;
}
