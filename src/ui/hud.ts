// HUD 演出（スコア・中央文字・フラッシュ・トースト）と通信状態表示
import type { Side } from '../shared/constants';
import { otherSide } from '../shared/constants';

/** #net-status に出すための最小限の通信状態（net/session の SessionStatus と互換） */
export interface NetStatusView {
  phase: string;
  kind: 'p2p' | 'relay' | null;
  rttMs: number | null;
  unstable: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  readonly root = $('hud');
  private scoreMe = $('score-me');
  private scoreOpp = $('score-opp');
  private whoOpp = $('who-opp');
  private center = $('center-text');
  private flashEl = $('flash');
  private toastEl = $('toast');
  private net = $('net-status');
  private flashLevel = 0;
  private toastTimer = 0;
  private netText = '';
  private netWarn = false;

  constructor(private reducedMotion: boolean) {}

  /** 相手ラベル（CPU / RIVAL） */
  setOpponentLabel(label: string): void {
    this.whoOpp.textContent = label;
  }

  updateScore(score: [number, number], scorer: Side | null, local: Side): void {
    const opp = otherSide(local);
    this.scoreMe.textContent = String(score[local - 1]);
    this.scoreOpp.textContent = String(score[opp - 1]);
    const el = scorer === local ? this.scoreMe : scorer ? this.scoreOpp : null;
    if (el) {
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
  }

  centerText(text: string, tone: '' | 'me' | 'opp' = ''): void {
    const c = this.center;
    c.textContent = text;
    c.className = `center-text ${tone}`;
    void c.offsetWidth;
    c.classList.add('show');
  }

  flash(color: string, strength: number): void {
    this.flashEl.style.background = color;
    this.flashLevel = this.reducedMotion ? strength * 0.3 : strength;
  }

  toast(msg: string, seconds = 2.6): void {
    this.toastEl.textContent = msg;
    this.toastEl.hidden = false;
    this.toastTimer = seconds;
  }

  /** 通信状態（null で非表示）。値が変わったときだけ DOM を更新 */
  setNet(s: NetStatusView | null): void {
    let text = '';
    let warn = false;
    if (s && s.phase === 'ready') {
      if (s.unstable) {
        text = '通信不安定';
        warn = true;
      } else {
        const label = s.kind === 'relay' ? '中継' : 'P2P';
        text = `${label} ${s.rttMs === null ? '--' : Math.round(s.rttMs)}ms`;
      }
    }
    if (text === this.netText && warn === this.netWarn) return;
    this.netText = text;
    this.netWarn = warn;
    this.net.hidden = text === '';
    this.net.textContent = text;
    this.net.classList.toggle('warn', warn);
  }

  /** 毎フレーム：フラッシュの減衰とトーストの寿命 */
  update(dt: number): void {
    this.flashLevel = Math.max(0, this.flashLevel - dt * 2.2);
    this.flashEl.style.opacity = String(this.flashLevel);
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.hidden = true;
    }
  }
}
