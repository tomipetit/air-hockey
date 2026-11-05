/** Web Audio によるシンセ効果音（音声ファイル不要） */
export class Sfx {
  enabled = true;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastHit = 0;
  private lastWall = 0;

  /** iOS では最初のタップ内で呼ぶ必要がある */
  unlock(): void {
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.45;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number, delay = 0): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  hit(speed: number): void {
    const now = performance.now();
    if (now - this.lastHit < 40) return;
    this.lastHit = now;
    const v = Math.min(1, speed / 4);
    const f = 260 + v * 520;
    this.tone(f, 0.1, 'square', 0.08 + 0.22 * v, f * 0.45);
    this.tone(f * 2, 0.05, 'sine', 0.05 + 0.1 * v);
  }

  wall(speed: number): void {
    const now = performance.now();
    if (now - this.lastWall < 40) return;
    this.lastWall = now;
    const v = Math.min(1, speed / 4);
    this.tone(150 + v * 160, 0.07, 'triangle', 0.06 + 0.25 * v, 90);
  }

  count(n: number): void {
    if (n > 0) this.tone(660, 0.12, 'sine', 0.3);
    else this.tone(1320, 0.35, 'sawtooth', 0.18, 1320);
  }

  goal(good: boolean): void {
    const notes = good ? [523, 659, 784, 1047] : [392, 330, 262, 196];
    notes.forEach((f, i) => this.tone(f, 0.18, 'sawtooth', 0.14, undefined, i * 0.08));
  }
}
