import * as THREE from 'three';
import { GOAL_W, HALF_L, HALF_W, MALLET_R, PUCK_R, TABLE_L, TABLE_W, type Side } from '../shared/constants';
import type { World } from '../shared/physics';
import { COLORS } from './colors';

const RAIL_T = 0.045;
const RAIL_H = 0.05;

let haloTex: THREE.Texture | null = null;
/** 加算合成用の放射グラデーション（偽グロー） */
export function haloTexture(): THREE.Texture {
  if (haloTex) return haloTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  haloTex = new THREE.CanvasTexture(c);
  haloTex.colorSpace = THREE.SRGBColorSpace;
  return haloTex;
}

const halos: THREE.Mesh[] = [];

/** Bloom 有効時は偽グローを弱め、白っぽくかすむのを防ぐ */
export function setHaloStrength(k: number): void {
  for (const h of halos) (h.material as THREE.MeshBasicMaterial).opacity = (h.userData.baseOpacity as number) * k;
}

export function makeHalo(color: number, size: number, opacity = 0.5): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      map: haloTexture(),
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.userData.baseOpacity = opacity;
  halos.push(mesh);
  return mesh;
}

const flat = (geo: THREE.BufferGeometry, color: number, y: number) => {
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  return m;
};

/** エアホールのドット柄を描いた盤面テクスチャ */
function tableTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = `#${COLORS.table.toString(16).padStart(6, '0')}`;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = `#${COLORS.hole.toString(16).padStart(6, '0')}`;
  const step = 16;
  for (let y = step / 2; y < c.height; y += step) {
    for (let x = step / 2; x < c.width; x += step) {
      g.beginPath();
      g.arc(x, y, 1.6, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class TableView {
  readonly root = new THREE.Group();
  readonly mallets: THREE.Group[] = [];
  readonly puck = new THREE.Group();
  private railGlow = new THREE.MeshBasicMaterial({ color: COLORS.frame });
  private railFlash = 0;
  private baseFrame = new THREE.Color(COLORS.frame);

  constructor(readonly localSide: Side) {
    this.buildEnvironment();
    this.buildTable();
    for (const side of [1, 2] as Side[]) {
      const m = this.buildMallet(this.sideColor(side));
      this.mallets.push(m);
      this.root.add(m);
    }
    this.buildPuck();
  }

  sideColor(side: Side): number {
    return side === this.localSide ? COLORS.me : COLORS.opp;
  }

  sync(world: World): void {
    world.mallets.forEach((m, i) => this.mallets[i].position.set(m.x, 0, m.z));
    this.puck.visible = world.puckActive;
    this.puck.position.set(world.puck.x, 0, world.puck.z);
  }

  /** side 切替で作り直すときに呼ぶ。halo の登録解除と GPU リソースの解放 */
  dispose(): void {
    const haloTex = haloTexture();
    this.root.traverse((o) => {
      const i = halos.indexOf(o as THREE.Mesh);
      if (i >= 0) halos.splice(i, 1);
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
      for (const m of mats) {
        const map = (m as THREE.MeshBasicMaterial).map;
        // 共有の halo テクスチャは残す
        if (map && map !== haloTex) map.dispose();
        m.dispose();
      }
    });
    this.railGlow.dispose();
  }

  flashRails(amount = 1): void {
    this.railFlash = Math.max(this.railFlash, amount);
  }

  update(dt: number): void {
    this.railFlash = Math.max(0, this.railFlash - dt * 4);
    this.railGlow.color.copy(this.baseFrame).lerp(new THREE.Color(0xffffff), this.railFlash * 0.7);
  }

  private buildEnvironment(): void {
    const grid = new THREE.GridHelper(24, 48, COLORS.grid, COLORS.gridDim);
    grid.position.y = -0.45;
    this.root.add(grid);

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE_W + RAIL_T * 2 + 0.06, 0.4, TABLE_L + RAIL_T * 2 + 0.06),
      new THREE.MeshBasicMaterial({ color: 0x07020f }),
    );
    base.position.y = -0.205;
    this.root.add(base);
    // 台の下からうっすら漏れる光
    const under = makeHalo(COLORS.frame, 3.2, 0.25);
    under.scale.set(0.75, 1.1, 1);
    under.position.y = -0.44;
    this.root.add(under);
  }

  private buildTable(): void {
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE_W, TABLE_L),
      new THREE.MeshBasicMaterial({ map: tableTexture() }),
    );
    surface.rotation.x = -Math.PI / 2;
    this.root.add(surface);

    // ライン
    const y = 0.0015;
    this.root.add(flat(new THREE.PlaneGeometry(TABLE_W, 0.008), COLORS.line, y));
    this.root.add(flat(new THREE.RingGeometry(0.15, 0.158, 64), COLORS.line, y));
    this.root.add(flat(new THREE.CircleGeometry(0.018, 24), COLORS.line, y));
    for (const side of [1, 2] as Side[]) {
      const s = side === 1 ? 1 : -1;
      // ゴールエリアの半円（RingGeometry は XY 平面。-90° 回転で y → -z になる）
      const arc = flat(
        new THREE.RingGeometry(0.22, 0.228, 48, 1, s === 1 ? 0 : Math.PI, Math.PI),
        this.sideColor(side),
        y,
      );
      arc.position.z = s * HALF_L;
      this.root.add(arc);

      const mouth = new THREE.Mesh(
        new THREE.BoxGeometry(GOAL_W, 0.012, 0.012),
        new THREE.MeshBasicMaterial({ color: this.sideColor(side) }),
      );
      mouth.position.set(0, 0.006, s * (HALF_L + RAIL_T * 0.5));
      this.root.add(mouth);
      const glow = makeHalo(this.sideColor(side), 0.6, 0.45);
      glow.scale.set(1, 0.35, 1);
      glow.position.set(0, 0.003, s * HALF_L);
      this.root.add(glow);
    }

    // 枠（暗い本体＋上面の発光ライン）
    const body = new THREE.MeshBasicMaterial({ color: COLORS.railBody });
    const addRail = (w: number, d: number, x: number, z: number) => {
      const r = new THREE.Mesh(new THREE.BoxGeometry(w, RAIL_H, d), body);
      r.position.set(x, RAIL_H / 2, z);
      this.root.add(r);
      // 上面の発光ライン（短辺方向に細く）
      const top = new THREE.Mesh(
        new THREE.BoxGeometry(d > w ? w * 0.35 : w, 0.008, d > w ? d : d * 0.35),
        this.railGlow,
      );
      top.position.set(x, RAIL_H + 0.004, z);
      this.root.add(top);
    };
    const sideLen = TABLE_L + RAIL_T * 2;
    addRail(RAIL_T, sideLen, -HALF_W - RAIL_T / 2, 0);
    addRail(RAIL_T, sideLen, HALF_W + RAIL_T / 2, 0);
    const endLen = (TABLE_W - GOAL_W) / 2;
    for (const s of [1, -1]) {
      for (const sx of [1, -1]) {
        addRail(endLen, RAIL_T, sx * (GOAL_W / 2 + endLen / 2), s * (HALF_L + RAIL_T / 2));
      }
    }
  }

  private buildMallet(color: number): THREE.Group {
    const g = new THREE.Group();
    const dark = new THREE.MeshBasicMaterial({ color: 0x0a0818 });
    const glow = new THREE.MeshBasicMaterial({ color });

    const base = new THREE.Mesh(new THREE.CylinderGeometry(MALLET_R, MALLET_R, 0.02, 40), dark);
    base.position.y = 0.01;
    g.add(base);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(MALLET_R * 0.88, 0.009, 10, 48), glow);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.022;
    g.add(ring);
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.03, 0.05, 24), dark);
    knob.position.y = 0.045;
    g.add(knob);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.025, 20, 12), glow);
    cap.position.y = 0.072;
    g.add(cap);
    const halo = makeHalo(color, MALLET_R * 5, 0.55);
    halo.position.y = 0.002;
    g.add(halo);
    return g;
  }

  private buildPuck(): void {
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(PUCK_R, PUCK_R, 0.012, 32),
      new THREE.MeshBasicMaterial({ color: COLORS.puck }),
    );
    disc.position.y = 0.006;
    this.puck.add(disc);
    const halo = makeHalo(COLORS.puck, PUCK_R * 6, 0.6);
    halo.position.y = 0.002;
    this.puck.add(halo);
    this.puck.visible = false;
    this.root.add(this.puck);
  }
}
