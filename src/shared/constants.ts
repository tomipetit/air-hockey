// テーブル・物理パラメータ（ワールド単位 ≒ メートル）
// 座標系: x = 左右, z = 縦方向。P1 は z=+HALF_L のゴールを守り、P2 は z=-HALF_L を守る。

export type Side = 1 | 2;

export const TABLE_W = 1.0;
export const TABLE_L = 2.0;
export const HALF_W = TABLE_W / 2;
export const HALF_L = TABLE_L / 2;
export const GOAL_W = 0.3;

export const PUCK_R = 0.04;
export const MALLET_R = 0.065;

export const PUCK_MAX_SPEED = 5.0;
export const MALLET_MAX_SPEED = 6.0;

export const WALL_RESTITUTION = 0.9;
export const MALLET_RESTITUTION = 0.95;
/** 1秒あたりの速度残存率（エアテーブルなのでほぼ減速しない） */
export const FRICTION_PER_SEC = 0.98;

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
export const SUBSTEPS = 4;

export const WIN_SCORE = 7;
export const COUNTDOWN_SEC = 3;
export const GOAL_PAUSE_SEC = 1.0;
/** パックがこの速度未満のまま同じ陣地に STALL_SEC 留まったらリスタート */
export const STALL_SPEED = 0.15;
export const STALL_SEC = 7;
/** サーブ位置（陣地中央付近） */
export const SERVE_Z = 0.45;

/** 自陣のゴール方向の符号（P1: +1, P2: -1） */
export const goalSign = (side: Side): 1 | -1 => (side === 1 ? 1 : -1);
export const otherSide = (side: Side): Side => (side === 1 ? 2 : 1);
