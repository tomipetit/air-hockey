import * as THREE from 'three';
import { goalSign, type Side } from './shared/constants';
import type { Vec2 } from './shared/physics';

/** タッチ位置 → テーブル上の座標。最初の 1 本の指だけを追う */
export class TouchInput {
  /** 最後に指していたテーブル座標（指を離しても保持） */
  target: Vec2 | null = null;
  enabled = true;
  private pointerId: number | null = null;
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ndc = new THREE.Vector2();
  private hit = new THREE.Vector3();

  constructor(
    private el: HTMLElement,
    private camera: THREE.Camera,
    public side: Side,
    /** 指で隠れないよう、マレットを指より奥（相手側）にずらす量 */
    public touchOffset = 0.07,
  ) {
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled || this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    this.el.setPointerCapture?.(e.pointerId);
    this.update(e);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.enabled) return;
    // マウスはボタンを押していなくても追従（PC での確認用）
    if (e.pointerId === this.pointerId || e.pointerType === 'mouse') this.update(e);
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId === this.pointerId) this.pointerId = null;
  };

  private update(e: PointerEvent): void {
    const r = this.el.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.plane, this.hit)) return;
    const offset = e.pointerType === 'mouse' ? 0 : this.touchOffset;
    this.target = { x: this.hit.x, z: this.hit.z - goalSign(this.side) * offset };
  }
}
