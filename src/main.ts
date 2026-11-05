import * as THREE from 'three';
import './style.css';
import { CpuPlayer } from './ai/cpu';
import { Sfx } from './audio';
import { TouchInput } from './input';
import { CameraRig } from './render/camera';
import { COLORS } from './render/colors';
import { PuckTrail, Sparks } from './render/effects';
import { NeonRenderer } from './render/neon';
import { TableView } from './render/scene';
import { loadSettings, renderSettings, type Settings } from './settings';
import { GameHost, type GameEvent } from './shared/game-host';
import type { Side } from './shared/constants';

const LOCAL: Side = 1;
const CPU_SIDE: Side = 2;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('stage');
const ui = {
  hud: $('hud'),
  title: $('title'),
  pause: $('pause'),
  result: $('result'),
  resultTitle: $('result-title'),
  resultScore: $('result-score'),
  scoreMe: $('score-me'),
  scoreOpp: $('score-opp'),
  center: $('center-text'),
  flash: $('flash'),
  toast: $('toast'),
  fps: $('fps'),
};

const settings = loadSettings();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const debug = new URLSearchParams(location.search).has('debug');

// ---------- シーン ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.bg);
scene.fog = new THREE.Fog(COLORS.bg, 3.5, 10);

const rig = new CameraRig(LOCAL, settings.view);
const view = new TableView(LOCAL);
const trail = new PuckTrail();
const sparks = new Sparks();
scene.add(view.root, trail.root, sparks.points);

const neon = new NeonRenderer(canvas, scene, rig.camera, settings.quality);
const input = new TouchInput(canvas, rig.camera, LOCAL);
const sfx = new Sfx();
sfx.enabled = settings.sound;

const host = new GameHost();
const cpu = new CpuPlayer(CPU_SIDE, settings.cpu);

type Mode = 'title' | 'playing' | 'paused' | 'result';
let mode: Mode = 'title';

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  neon.setSize(w, h);
  rig.fit(w / h);
}
window.addEventListener('resize', resize);
resize();

// ---------- 設定 ----------
function applySettings(s: Settings): void {
  cpu.level = s.cpu;
  sfx.enabled = s.sound;
  neon.quality = s.quality;
  if (rig.mode !== s.view) {
    rig.mode = s.view;
    resize();
  }
  lowFpsSeconds = 0;
}
renderSettings($('title-settings'), settings, applySettings);
renderSettings($('pause-settings'), settings, applySettings);

// ---------- 画面遷移 ----------
function show(next: Mode): void {
  mode = next;
  ui.title.hidden = next !== 'title';
  ui.pause.hidden = next !== 'paused';
  ui.result.hidden = next !== 'result';
  ui.hud.hidden = next === 'title';
  input.enabled = next === 'playing';
  if (next === 'paused') renderSettings($('pause-settings'), settings, applySettings);
  if (next === 'title') renderSettings($('title-settings'), settings, applySettings);
}

function startMatch(): void {
  sfx.unlock();
  void requestWakeLock();
  host.reset();
  input.target = null;
  updateScore([0, 0], null);
  show('playing');
  warmup = 2;
}

$('start-btn').addEventListener('click', startMatch);
$('again-btn').addEventListener('click', startMatch);
$('restart-btn').addEventListener('click', startMatch);
$('resume-btn').addEventListener('click', () => show('playing'));
$('quit-btn').addEventListener('click', () => show('title'));
$('result-quit-btn').addEventListener('click', () => show('title'));
$('pause-btn').addEventListener('click', () => mode === 'playing' && show('paused'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'playing') show('paused');
});
canvas.addEventListener('pointerdown', () => sfx.unlock());

let wakeLock: { release(): Promise<void> } | null = null;
async function requestWakeLock(): Promise<void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
    if (!wakeLock && nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
  } catch {
    /* 許可されない環境もある */
  }
}

// ---------- HUD 演出 ----------
function updateScore(score: [number, number], scorer: Side | null): void {
  ui.scoreMe.textContent = String(score[LOCAL - 1]);
  ui.scoreOpp.textContent = String(score[CPU_SIDE - 1]);
  const el = scorer === LOCAL ? ui.scoreMe : scorer ? ui.scoreOpp : null;
  if (el) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }
}

function centerText(text: string, tone: '' | 'me' | 'opp' = ''): void {
  ui.center.textContent = text;
  ui.center.className = `center-text ${tone}`;
  void ui.center.offsetWidth;
  ui.center.classList.add('show');
}

let flashLevel = 0;
function flash(color: string, strength: number): void {
  ui.flash.style.background = color;
  flashLevel = reducedMotion ? strength * 0.3 : strength;
}

let toastTimer = 0;
function toast(msg: string): void {
  ui.toast.textContent = msg;
  ui.toast.hidden = false;
  toastTimer = 2.6;
}

const css = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

function handle(ev: GameEvent): void {
  switch (ev.type) {
    case 'mallet': {
      const color = view.sideColor(ev.side);
      sparks.burst(ev.x, ev.z, color, Math.round(6 + ev.speed * 4), 0.4 + ev.speed * 0.25);
      sfx.hit(ev.speed);
      if (ev.side === LOCAL && ev.speed > 0.5) navigator.vibrate?.(12);
      break;
    }
    case 'wall':
      if (ev.speed > 0.3) {
        sparks.burst(ev.x, ev.z, COLORS.puck, Math.round(3 + ev.speed * 2), 0.3 + ev.speed * 0.15);
        view.flashRails(Math.min(1, ev.speed / 3));
      }
      sfx.wall(ev.speed);
      break;
    case 'countdown':
      centerText(String(ev.n));
      sfx.count(ev.n);
      break;
    case 'start':
      centerText('GO!');
      sfx.count(0);
      break;
    case 'score': {
      const mine = ev.scorer === LOCAL;
      updateScore(ev.score, ev.scorer);
      centerText('GOAL', mine ? 'me' : 'opp');
      flash(css(mine ? COLORS.me : COLORS.opp), 0.55);
      rig.shake(0.035);
      sfx.goal(mine);
      navigator.vibrate?.(mine ? [30, 40, 30] : 80);
      break;
    }
    case 'stall':
      toast('パックが止まったので相手側から再開します');
      break;
    case 'over': {
      const win = ev.winner === LOCAL;
      ui.resultTitle.textContent = win ? 'YOU WIN' : 'YOU LOSE';
      ui.resultTitle.className = `panel-title result-title ${win ? 'win' : 'lose'}`;
      ui.resultScore.textContent = `${ev.score[LOCAL - 1]} – ${ev.score[CPU_SIDE - 1]}`;
      setTimeout(() => mode === 'playing' && show('result'), 1100);
      break;
    }
    case 'goal':
      break;
  }
}

// ---------- 性能監視（重ければエフェクトを自動で下げる） ----------
let warmup = 2;
let fpsFrames = 0;
let fpsTime = 0;
let lowFpsSeconds = 0;
ui.fps.hidden = !debug;

function monitor(dt: number): void {
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime < 1) return;
  const fps = fpsFrames / fpsTime;
  fpsFrames = 0;
  fpsTime = 0;
  if (debug) ui.fps.textContent = `${fps.toFixed(0)} fps · ${neon.quality}`;
  if (warmup > 0) {
    warmup--;
    return;
  }
  if (mode === 'playing' && settings.quality === 'high' && fps < 45) {
    if (++lowFpsSeconds >= 3) {
      settings.quality = 'low';
      applySettings(settings);
      toast('動作を軽くするためエフェクトを「低」にしました');
    }
  } else {
    lowFpsSeconds = 0;
  }
}

// ---------- メインループ ----------
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (mode === 'playing') {
    if (input.target) host.setInput(LOCAL, input.target.x, input.target.z);
    const t = cpu.update(host.world, dt);
    host.setInput(CPU_SIDE, t.x, t.z);
    for (const ev of host.update(dt)) handle(ev);
  }

  view.sync(host.world);
  view.update(dt);
  trail.update(host.world);
  sparks.update(dt);
  rig.update(dt, reducedMotion);

  flashLevel = Math.max(0, flashLevel - dt * 2.2);
  ui.flash.style.opacity = String(flashLevel);
  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) ui.toast.hidden = true;
  }

  neon.render();
  monitor(dt);
  requestAnimationFrame(frame);
}

show('title');
requestAnimationFrame(frame);
