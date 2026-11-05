import * as THREE from 'three';
import { HALF_L, HALF_W, type Side } from '../shared/constants';

export type ViewMode = 'perspective' | 'top';

const MARGIN = 0.06;
// テーブル外周（枠込み）の点。これが全部画面に入るようにカメラ距離を決める
const FIT_POINTS = [-1, 1].flatMap((sx) =>
  [-1, 1].flatMap((sz) =>
    [0, 0.06].map((y) => new THREE.Vector3(sx * (HALF_W + MARGIN), y, sz * (HALF_L + MARGIN))),
  ),
);

/** P1/P2 それぞれ「自分のゴールが手前」になるカメラ。画面比に合わせて距離を自動調整 */
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 60);
  private base = new THREE.Vector3();
  private look = new THREE.Vector3();
  private shakeAmt = 0;

  constructor(
    public side: Side,
    public mode: ViewMode,
  ) {}

  fit(aspect: number): void {
    const s = this.side === 1 ? 1 : -1;
    const cam = this.camera;
    cam.aspect = aspect;
    cam.fov = aspect < 1 ? 50 : 38;
    cam.updateProjectionMatrix();

    let dir: THREE.Vector3;
    if (this.mode === 'perspective') {
      this.look.set(0, 0, 0.14 * s);
      dir = new THREE.Vector3(0, 1.55, 1.45 * s).normalize();
      cam.up.set(0, 1, 0);
    } else {
      this.look.set(0, 0, 0);
      dir = new THREE.Vector3(0, 1, 0);
      cam.up.set(0, 0, -s);
    }

    // 上部はスコア表示用に少し余白を残す
    const fits = (k: number) => {
      cam.position.copy(this.look).addScaledVector(dir, k);
      cam.lookAt(this.look);
      cam.updateMatrixWorld(true);
      return FIT_POINTS.every((p) => {
        const v = p.clone().project(cam);
        return Math.abs(v.x) <= 0.96 && v.y >= -0.94 && v.y <= 0.86 && v.z < 1;
      });
    };
    let lo = 0.5;
    let hi = 12;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    fits(hi);
    this.base.copy(cam.position);
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
