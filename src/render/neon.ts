import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { setHaloStrength } from './scene';

export type Quality = 'high' | 'low';

/** 発光表現。high = Bloom 後処理, low = 直接描画（偽グローのみ） */
export class NeonRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;

  constructor(
    canvas: HTMLCanvasElement,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    public quality: Quality,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.3, 0.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  setSize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.composer.setSize(w, h);
    // Bloom は半解像度で十分
    const pr = Math.min(window.devicePixelRatio, 2);
    this.bloom.setSize((w * pr) / 2, (h * pr) / 2);
  }

  render(): void {
    setHaloStrength(this.quality === 'high' ? 0.3 : 1);
    if (this.quality === 'high') this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
