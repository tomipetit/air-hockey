import * as THREE from 'three';
import { HALF_L, HALF_W, type Side } from '../shared/constants';

export type ViewMode = 'perspective' | 'top';

const MARGIN = 0.06;
/**
 * 3D 視点で、手前（自陣のゴールライン）で必ず画面内に収める幅。盤面の半幅に対する割合。
 * 1 未満にすると手前の両サイドが画面外にはみ出し、そのぶん自陣が大きく映る。
 */
export const NEAR_VISIBLE = 0.8;

type FitRule = { p: THREE.Vector3; maxAbsX?: number; minY?: number; maxY?: number };

/** 横画面 3D 視点の仰角の下限（度） */
const LANDSCAPE_MIN_ELEVATION = 10;

/** 横画面: 手前の枠が画面幅に収まり、奥の枠まで見えること */
function landscapeRules(s: number): FitRule[] {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const rules: FitRule[] = [];
  for (const sx of [-1, 1]) {
    rules.push({ p: v(sx * (HALF_W + MARGIN), 0.06, -s * (HALF_L + MARGIN)), maxAbsX: 0.96, maxY: 0.84 });
    rules.push({ p: v(sx * (HALF_W + MARGIN), 0.05, s * (HALF_L + MARGIN)), maxAbsX: 1, minY: -0.97 });
  }
  return rules;
}

/** カメラ距離を決めるための条件。s は自陣ゴール方向の符号 */
function fitRules(mode: ViewMode, s: number): FitRule[] {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const rules: FitRule[] = [];
  if (mode === 'top') {
    // 真上視点は従来どおり枠ごと全部を収める
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        rules.push({ p: v(sx * (HALF_W + MARGIN), 0.06, sz * (HALF_L + MARGIN)), maxAbsX: 0.96, minY: -0.94, maxY: 0.86 });
    return rules;
  }
  // 奥（相手側）は枠まで全部見せる。上部はスコア表示用に余白を残す
  for (const sx of [-1, 1]) rules.push({ p: v(sx * (HALF_W + MARGIN), 0.06, -s * (HALF_L + MARGIN)), maxAbsX: 0.96, maxY: 0.86 });
  // 手前は自分のゴールまで縦に収める
  rules.push({ p: v(0, 0, s * (HALF_L + MARGIN)), minY: -0.94 });
  // 手前の横幅は NEAR_VISIBLE の範囲だけ収め、外側ははみ出してよい
  for (const sx of [-1, 1]) rules.push({ p: v(sx * HALF_W * NEAR_VISIBLE, 0, s * HALF_L), maxAbsX: 1 });
  return rules;
}

/** P1/P2 それぞれ「自分のゴールが手前」になるカメラ。画面比に合わせて距離を自動調整 */
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 60);
  private base = new THREE.Vector3();
  private look = new THREE.Vector3();
  private shakeAmt = 0;
  /** 横画面で選んだ仰角（確認用） */
  elevation = 0;

  constructor(
    public side: Side,
    public mode: ViewMode,
  ) {}

  fit(aspect: number): void {
    const s = this.side === 1 ? 1 : -1;
    const cam = this.camera;
    const landscape = aspect >= 1;
    cam.aspect = aspect;
    cam.fov = landscape ? 38 : 50;
    cam.updateProjectionMatrix();

    if (this.mode === 'top') {
      this.look.set(0, 0, 0);
      cam.up.set(0, 0, -s);
      this.place(new THREE.Vector3(0, 1, 0), fitRules('top', s));
    } else if (!landscape) {
      this.look.set(0, 0, 0.14 * s);
      cam.up.set(0, 1, 0);
      this.place(new THREE.Vector3(0, 1.55, 1.45 * s).normalize(), fitRules('perspective', s));
    } else {
      // 横画面: 視点を低くして手前の台（枠込み）を画面幅いっぱいに広げる。
      // 画面幅いっぱいにできる角度のうち最も高いもの（奥が潰れにくい）を選ぶ。
      this.look.set(0, 0, 0.05 * s);
      cam.up.set(0, 1, 0);
      const rules = landscapeRules(s);
      const nearEdge = new THREE.Vector3(HALF_W + MARGIN, 0.05, s * (HALF_L + MARGIN));
      let chosen: THREE.Vector3 | null = null;
      for (let deg = 70; deg >= LANDSCAPE_MIN_ELEVATION; deg -= 1) {
        const r = THREE.MathUtils.degToRad(deg);
        const dir = new THREE.Vector3(0, Math.sin(r), Math.cos(r) * s);
        this.place(dir, rules);
        if (Math.abs(nearEdge.clone().project(cam).x) >= 0.97) {
          chosen = dir;
          this.elevation = deg;
          break;
        }
      }
      if (!chosen) {
        const r = THREE.MathUtils.degToRad(LANDSCAPE_MIN_ELEVATION);
        this.place(new THREE.Vector3(0, Math.sin(r), Math.cos(r) * s), rules);
      }
    }
    this.base.copy(cam.position);
  }

  /** dir 方向に、rules を満たす最も近い距離でカメラを置く */
  private place(dir: THREE.Vector3, rules: FitRule[]): void {
    const cam = this.camera;
    const fits = (k: number) => {
      cam.position.copy(this.look).addScaledVector(dir, k);
      cam.lookAt(this.look);
      cam.updateMatrixWorld(true);
      return rules.every(({ p, maxAbsX, minY, maxY }) => {
        const v = p.clone().project(cam);
        return (
          v.z < 1 &&
          (maxAbsX === undefined || Math.abs(v.x) <= maxAbsX) &&
          (minY === undefined || v.y >= minY) &&
          (maxY === undefined || v.y <= maxY)
        );
      });
    };
    let lo = 0.3;
    let hi = 12;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    fits(hi);
  }

  shake(amount: number): void {
    this.shakeAmt = Math.max(this.shakeAmt, amount);
  }

  update(dt: number, reducedMotion: boolean): void {
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 0.12);
    const a = reducedMotion ? 0 : this.shakeAmt;
    this.camera.position.set(
      this.base.x + (Math.random() - 0.5) * a,
      this.base.y + (Math.random() - 0.5) * a,
      this.base.z + (Math.random() - 0.5) * a,
    );
    this.camera.lookAt(this.look);
  }
}
