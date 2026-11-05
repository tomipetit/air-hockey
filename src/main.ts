import * as THREE from 'three';
import './style.css';
import { Sfx } from './audio';
import { TouchInput } from './input';
import type { MatchDriver, DriverHooks } from './match/driver';
import { LocalCpuDriver } from './match/local-cpu';
import type { NetHostDriver } from './match/net-host';
import type { NetGuestDriver } from './match/net-guest';
import { DEFAULT_ICE_SERVERS, readFlags, signalUrl } from './net/config';
import type { CloseReason, NetOptions, NetSession, SessionPhase, SessionStatus } from './net/session';
import type { TransportKind } from './net/transport';
import { CameraRig } from './render/camera';
import { COLORS } from './render/colors';
import { PuckTrail, Sparks } from './render/effects';
import { NeonRenderer } from './render/neon';
import { TableView } from './render/scene';
import { loadSettings, renderSettings, type Settings } from './settings';
import { HALF_L, otherSide, type Side } from './shared/constants';
import type { GameEvent, Phase } from './shared/game-host';
import { createWorld, placePuck } from './shared/physics';
import { Hud } from './ui/hud';
import {
  closeMessage,
  lobbyEls,
  resetHostWait,
  sanitizeCodeInput,
  setHostStatus,
  setJoinStatus,
  showNetMessage,
  showRoom,
} from './ui/lobby';

/** Artifact 版ではネット対戦のコードをビルドから外す（ビルド時に定数化される） */
const ONLINE = import.meta.env.MODE !== 'artifact';
/** ネット対戦が使えるか（Artifact 版では評価自体が消える） */
const NET_OK = ONLINE && typeof RTCPeerConnection !== 'undefined';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('stage');
const ui = {
  hud: $('hud'),
  title: $('title'),
  pause: $('pause'),
  result: $('result'),
  resultTitle: $('result-title'),
  resultScore: $('result-score'),
  resultNote: $('result-note'),
  againBtn: $<HTMLButtonElement>('again-btn'),
  restartBtn: $<HTMLButtonElement>('restart-btn'),
  createBtn: $<HTMLButtonElement>('create-btn'),
  joinBtn: $<HTMLButtonElement>('join-btn'),
  startBtn: $<HTMLButtonElement>('start-btn'),
  titleNote: $('title-note'),
  fps: $('fps'),
};

const flags = readFlags();
const settings = loadSettings();
// E2E では描画負荷を下げる（保存はしない）
if (flags.e2e) settings.quality = 'low';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const debug = flags.debug;

// ---------- シーン ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.bg);
scene.fog = new THREE.Fog(COLORS.bg, 3.5, 10);

const rig = new CameraRig(1, settings.view);
let view = new TableView(1);
const trail = new PuckTrail();
const sparks = new Sparks();
scene.add(view.root, trail.root, sparks.points);

const neon = new NeonRenderer(canvas, scene, rig.camera, settings.quality);
const input = new TouchInput(canvas, rig.camera, 1);
const sfx = new Sfx();
sfx.enabled = settings.sound;
const hud = new Hud(reducedMotion);

type Mode = 'title' | 'hostWait' | 'join' | 'netMsg' | 'playing' | 'paused' | 'result';
let mode: Mode = 'title';
/** 試合の世代番号（matchStarted・タイトルへ戻るたびに増やす。遅延処理の無効化に使う） */
let matchGen = 0;
let driver: MatchDriver | null = null;
let session: NetSession | null = null;
/** タイトル等で背景に描く */
const idleWorld = createWorld();

const localSide = (): Side => driver?.localSide ?? 1;
const isNet = () => driver !== null && driver.kind !== 'cpu';

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  neon.setSize(w, h);
  rig.fit(w / h);
}
window.addEventListener('resize', resize);
resize();

/** 自分の側（カメラ・色・入力）を切り替える。CPU・ホストは 1、ゲストは 2 */
function setLocalSide(side: Side): void {
  if (view.localSide !== side) {
    scene.remove(view.root);
    view.dispose();
    view = new TableView(side);
    scene.add(view.root);
  }
  if (rig.side !== side) {
    rig.side = side;
    resize();
  }
  input.side = side;
}

// ---------- 設定 ----------
function applySettings(s: Settings): void {
  if (driver instanceof LocalCpuDriver) driver.cpu.level = s.cpu;
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
  lobbyEls.hostWait.hidden = next !== 'hostWait';
  lobbyEls.join.hidden = next !== 'join';
  lobbyEls.netMsg.hidden = next !== 'netMsg';
  ui.hud.hidden = !(next === 'playing' || next === 'paused' || next === 'result');
  input.enabled = next === 'playing';
  if (next === 'paused') {
    ui.restartBtn.hidden = isNet();
    renderSettings($('pause-settings'), settings, applySettings);
  }
  if (next === 'title') renderSettings($('title-settings'), settings, applySettings);
}

function resetResultButtons(): void {
  ui.againBtn.disabled = false;
  ui.againBtn.textContent = 'もう一度';
  ui.resultNote.hidden = true;
  ui.resultNote.textContent = '';
}

const hooks: DriverHooks = {
  matchStarted() {
    input.target = null;
    hud.setOpponentLabel(isNet() || session ? 'RIVAL' : 'CPU');
    hud.updateScore([0, 0], null, localSide());
    resetResultButtons();
    show('playing');
    warmup = 2;
    matchGen++;
    void requestWakeLock();
  },
  peerWantsRematch() {
    ui.resultNote.textContent = '相手は再戦を希望しています';
    ui.resultNote.hidden = false;
  },
};

/** タイトルへ戻る（ネット対戦なら BYE を送って退出） */
function goTitle(): void {
  matchGen++;
  driver?.dispose();
  driver = null;
  if (session) {
    const s = session;
    session = null;
    s.onStatus = null;
    s.onMessage = null;
    s.close('user');
  }
  setLocalSide(1);
  show('title');
}

function startCpu(): void {
  sfx.unlock();
  goTitle();
  setLocalSide(1);
  driver = new LocalCpuDriver(settings.cpu, hooks);
}

$('start-btn').addEventListener('click', startCpu);
$('again-btn').addEventListener('click', () => {
  if (!driver) return;
  if (isNet()) {
    ui.againBtn.disabled = true;
    ui.againBtn.textContent = '相手を待っています…';
  }
  driver.requestRematch();
});
$('restart-btn').addEventListener('click', () => {
  sfx.unlock();
  if (driver?.kind === 'cpu') driver.requestRematch();
});
$('resume-btn').addEventListener('click', () => show('playing'));
$('quit-btn').addEventListener('click', goTitle);
$('result-quit-btn').addEventListener('click', goTitle);
$('pause-btn').addEventListener('click', () => mode === 'playing' && show('paused'));
document.addEventListener('visibilitychange', () => {
  // ネット対戦は止めない（片方だけ止めると不公平なため）
  if (document.hidden && mode === 'playing' && !isNet()) show('paused');
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

// ---------- ネット対戦 ----------
const netOptions = (): NetOptions => ({
  signalUrl: signalUrl(),
  iceServers: DEFAULT_ICE_SERVERS,
  forceRelay: flags.forceRelay,
  blockIce: flags.blockIce,
});

let netModules: Promise<{
  NetSession: typeof NetSession;
  NetHostDriver: typeof NetHostDriver;
  NetGuestDriver: typeof NetGuestDriver;
  drawQr: (canvas: HTMLCanvasElement, text: string) => Promise<void>;
}> | null = null;

function loadNet() {
  if (!netModules) {
    netModules = Promise.all([
      import('./net/session'),
      import('./match/net-host'),
      import('./match/net-guest'),
      import('./ui/qr'),
    ]).then(([s, h, g, q]) => ({
      NetSession: s.NetSession,
      NetHostDriver: h.NetHostDriver,
      NetGuestDriver: g.NetGuestDriver,
      drawQr: q.drawQr,
    }));
  }
  return netModules;
}

function relayToast(st: SessionStatus): void {
  if (st.kind !== 'relay') return;
  hud.toast(st.forcedRelay ? 'サーバー経由で接続しました' : '直接つながらなかったため、サーバー経由で接続しました', 4);
}

/** セッションが閉じた（自分の goTitle 以外）→ 試合を止めてメッセージ画面へ */
function onSessionClosed(st: SessionStatus, reason: CloseReason): void {
  const d = driver;
  const inMatch = d !== null && d.kind !== 'cpu' && d.phase !== null && d.phase !== 'over';
  const me = localSide();
  const interruptedScore: [number, number] | null =
    inMatch && d ? [d.score[me - 1], d.score[otherSide(me) - 1]] : null;
  const msg = closeMessage(reason, { role: st.role, code: st.code, interruptedScore });
  matchGen++;
  driver?.dispose();
  driver = null;
  session = null;
  setLocalSide(1);
  showNetMessage(msg.title, msg.text);
  show('netMsg');
}

function hostStatusText(st: SessionStatus): void {
  switch (st.phase) {
    case 'connecting':
      setHostStatus('サーバーに接続しています…');
      break;
    case 'waiting':
      if (st.notice === 'relay_failed') setHostStatus('接続に失敗しました。もう一度参加してもらってください', 'error');
      else setHostStatus('相手の参加を待っています');
      break;
    case 'negotiating':
      setHostStatus('相手が参加しました。接続しています…');
      break;
    default:
      break;
  }
}

async function startHost(): Promise<void> {
  if (!ONLINE) return;
  sfx.unlock();
  goTitle();
  setLocalSide(1);
  resetHostWait();
  show('hostWait');
  const net = await loadNet();
  if (mode !== 'hostWait' || session) return;
  const s = net.NetSession.host(netOptions());
  session = s;
  let shownCode: string | null = null;
  let lastPhase: SessionPhase = s.status.phase;
  s.onStatus = (st) => {
    if (session !== s) return;
    if (st.phase === 'closed') {
      onSessionClosed(st, st.closeReason ?? 'lost');
      return;
    }
    if (st.code && st.code !== shownCode) {
      shownCode = st.code;
      const url = showRoom(st.code);
      void net.drawQr(lobbyEls.roomQr, url).then(
        () => lobbyEls.roomQr.classList.add('ready'),
        (e) => console.warn('[qr] failed', e),
      );
    }
    if (lastPhase === 'negotiating' && st.phase === 'waiting' && st.notice === 'peer_left') {
      hud.toast('相手が退出しました');
    }
    lastPhase = st.phase;
    hostStatusText(st);
    if (st.phase === 'ready' && !driver) {
      setLocalSide(1);
      driver = new net.NetHostDriver(s, hooks);
      relayToast(st);
    }
  };
  hostStatusText(s.status);
}

async function startJoin(code: string): Promise<void> {
  if (!ONLINE) return;
  if (session) return; // 接続中
  if (!/^\d{4}$/.test(code)) {
    setJoinStatus('4 桁の数字を入力してください', 'error');
    return;
  }
  sfx.unlock();
  setJoinStatus(`部屋 ${code} に接続しています…`);
  lobbyEls.joinGo.disabled = true;
  const net = await loadNet();
  if (mode !== 'join' || session) {
    lobbyEls.joinGo.disabled = false;
    return;
  }
  const s = net.NetSession.join(code, netOptions());
  session = s;
  s.onMessage = (m) => {
    if (session !== s || driver || m.type !== 'match_start') return;
    setLocalSide(2);
    driver = new net.NetGuestDriver(s, hooks, m);
  };
  s.onStatus = (st) => {
    if (session !== s) return;
    if (st.phase === 'closed') {
      lobbyEls.joinGo.disabled = false;
      onSessionClosed(st, st.closeReason ?? 'lost');
      return;
    }
    if (st.phase === 'negotiating') setJoinStatus('ホストと接続しています…');
    if (st.phase === 'ready') {
      lobbyEls.joinGo.disabled = false;
      relayToast(st);
    }
  };
}

function openJoin(prefill = ''): void {
  goTitle();
  lobbyEls.codeInput.value = prefill;
  lobbyEls.joinGo.disabled = false;
  setJoinStatus('');
  show('join');
  if (!prefill) lobbyEls.codeInput.focus();
}

if (NET_OK) {
  ui.createBtn.addEventListener('click', () => void startHost());
  ui.joinBtn.addEventListener('click', () => openJoin());
  $('host-cancel-btn').addEventListener('click', goTitle);
  $('join-cancel-btn').addEventListener('click', goTitle);
  $('net-msg-ok').addEventListener('click', goTitle);
  lobbyEls.shareBtn.addEventListener('click', () => {
    const code = session?.status.code;
    if (!code) return;
    navigator.share?.({ title: 'Neon Air Hockey', text: `部屋 ${code} で対戦しよう`, url: lobbyEls.roomUrl.textContent ?? '' }).catch(() => {
      /* キャンセル */
    });
  });
  lobbyEls.codeInput.addEventListener('input', () => {
    const v = sanitizeCodeInput();
    if (v.length === 4) void startJoin(v);
    else if (!session) setJoinStatus('');
  });
  lobbyEls.codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void startJoin(sanitizeCodeInput());
  });
  lobbyEls.joinGo.addEventListener('click', () => void startJoin(sanitizeCodeInput()));
} else {
  ui.createBtn.hidden = true;
  ui.joinBtn.hidden = true;
  ui.startBtn.classList.add('primary');
  ui.titleNote.textContent = ONLINE
    ? 'このブラウザは 2 台対戦に対応していません。CPU と練習できます。'
    : 'この版は CPU 練習モードです。2 台対戦はアプリ版（npm run dev / 本番 URL）で遊べます。';
}

// ---------- 演出 ----------
const css = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

function handle(ev: GameEvent): void {
  const local = localSide();
  const opp = otherSide(local);
  switch (ev.type) {
    case 'mallet': {
      const color = view.sideColor(ev.side);
      sparks.burst(ev.x, ev.z, color, Math.round(6 + ev.speed * 4), 0.4 + ev.speed * 0.25);
      sfx.hit(ev.speed);
      if (ev.side === local && ev.speed > 0.5) navigator.vibrate?.(12);
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
      hud.centerText(String(ev.n));
      sfx.count(ev.n);
      break;
    case 'start':
      hud.centerText('GO!');
      sfx.count(0);
      break;
    case 'score': {
      const mine = ev.scorer === local;
      hud.updateScore(ev.score, ev.scorer, local);
      hud.centerText('GOAL', mine ? 'me' : 'opp');
      hud.flash(css(mine ? COLORS.me : COLORS.opp), 0.55);
      rig.shake(0.035);
      sfx.goal(mine);
      navigator.vibrate?.(mine ? [30, 40, 30] : 80);
      break;
    }
    case 'stall':
      hud.toast(
        ev.serveTo === local
          ? 'パックが止まったのであなたの陣地から再開します'
          : 'パックが止まったので相手の陣地から再開します',
      );
      break;
    case 'over': {
      const win = ev.winner === local;
      ui.resultTitle.textContent = win ? 'YOU WIN' : 'YOU LOSE';
      ui.resultTitle.className = `panel-title result-title ${win ? 'win' : 'lose'}`;
      ui.resultScore.textContent = `${ev.score[local - 1]} – ${ev.score[opp - 1]}`;
      // 試合単位で無効化（その間にやり直し・再戦・退出があれば出さない）
      const gen = matchGen;
      setTimeout(() => {
        if (gen !== matchGen) return;
        if (mode === 'playing' || (isNet() && mode === 'paused')) show('result');
      }, 1100);
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
      hud.toast('動作を軽くするためエフェクトを「低」にしました');
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

  // ネット対戦は画面（ポーズ・結果）に関係なく進める。CPU 練習は playing のときだけ
  const d = driver;
  if (d && (d.kind !== 'cpu' || mode === 'playing')) {
    for (const ev of d.update(dt, mode === 'playing' ? input.target : null)) handle(ev);
  }

  const w = driver?.world ?? idleWorld;
  view.sync(w);
  view.update(dt);
  trail.update(w);
  sparks.update(dt);
  rig.update(dt, reducedMotion);
  hud.update(dt);
  hud.setNet(session?.status ?? null);

  neon.render();
  monitor(dt);
  requestAnimationFrame(frame);
}

show('title');

// 招待リンク（?room=XXXX）：コード入力を飛ばして参加
if (NET_OK && flags.room !== null) {
  const code = flags.room;
  // 値なしフラグ（?e2e 等）の形を保つため、文字列から room=… だけを取り除く
  const qs = location.search
    .slice(1)
    .split('&')
    .filter((kv) => kv !== '' && !/^room(=|$)/.test(kv))
    .join('&');
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
  openJoin(/^\d{4}$/.test(code) ? code : '');
  if (/^\d{4}$/.test(code)) void startJoin(code);
  else setJoinStatus('4 桁の数字を入力してください', 'error');
}

// ---------- E2E 用フック（?e2e のときだけ） ----------
interface AhSnapshot {
  mode: Mode;
  localSide: Side;
  driverKind: 'cpu' | 'host' | 'guest' | null;
  phase: Phase | null;
  score: [number, number] | null;
  net: { phase: SessionPhase; kind: TransportKind | null; rttMs: number | null; closeReason: CloseReason | null } | null;
  puck: { x: number; z: number; active: boolean };
  mallets: [{ x: number; z: number }, { x: number; z: number }];
  lastStateTick: number | null;
  renderTick: number | null;
}
declare global {
  interface Window {
    __ah?: { snapshot(): AhSnapshot; forceGoal(scorer: Side): boolean };
  }
}

if (flags.e2e) {
  window.__ah = {
    snapshot(): AhSnapshot {
      const d = driver;
      const w = d?.world ?? idleWorld;
      const st = session?.status ?? null;
      const guest = d?.kind === 'guest' ? (d as NetGuestDriver) : null;
      return {
        mode,
        localSide: localSide(),
        driverKind: d?.kind ?? null,
        phase: d?.phase ?? null,
        score: d ? [d.score[0], d.score[1]] : null,
        net: st ? { phase: st.phase, kind: st.kind, rttMs: st.rttMs, closeReason: st.closeReason } : null,
        puck: { x: w.puck.x, z: w.puck.z, active: w.puckActive },
        mallets: [
          { x: w.mallets[0].x, z: w.mallets[0].z },
          { x: w.mallets[1].x, z: w.mallets[1].z },
        ],
        lastStateTick: guest ? guest.lastStateTick : null,
        renderTick: guest ? guest.renderTick : null,
      };
    },
    forceGoal(scorer: Side): boolean {
      const d = driver;
      if (!d || d.kind !== 'host' || d.phase !== 'playing') return false;
      const w = d.world;
      if (scorer === 1) {
        placePuck(w, 0, -HALF_L + 0.06);
        w.puck.vz = -3;
      } else {
        placePuck(w, 0, HALF_L - 0.06);
        w.puck.vz = 3;
      }
      return true;
    },
  };
}

requestAnimationFrame(frame);
