// 待機（コード/QR/URL）、コード入力、通信メッセージ画面の DOM 操作
import type { CloseReason } from '../net/session';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const lobbyEls = {
  hostWait: $('host-wait'),
  roomCode: $('room-code'),
  roomQr: $<HTMLCanvasElement>('room-qr'),
  roomUrl: $('room-url'),
  shareBtn: $<HTMLButtonElement>('share-btn'),
  hostStatus: $('host-status'),
  localhostWarning: $('localhost-warning'),
  join: $('join'),
  codeInput: $<HTMLInputElement>('code-input'),
  joinGo: $<HTMLButtonElement>('join-go-btn'),
  joinStatus: $('join-status'),
  netMsg: $('net-msg'),
  netMsgTitle: $('net-msg-title'),
  netMsgText: $('net-msg-text'),
};

export const LOCALHOST_WARNING =
  'この URL は他の端末から開けません。PC の LAN の IP アドレス（例: https://192.168.x.x:5173）で開き直してください';

export function inviteUrl(code: string): string {
  return `${location.origin}${location.pathname}?room=${code}`;
}

export function isLocalhost(): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
}

// ---------- 待機画面（ホスト） ----------
export function resetHostWait(): void {
  const e = lobbyEls;
  e.roomCode.textContent = '----';
  e.roomUrl.textContent = '';
  e.shareBtn.hidden = true;
  e.localhostWarning.hidden = true;
  const g = e.roomQr.getContext('2d');
  g?.clearRect(0, 0, e.roomQr.width, e.roomQr.height);
  e.roomQr.classList.remove('ready');
  setHostStatus('サーバーに接続しています…');
}

export function showRoom(code: string): string {
  const e = lobbyEls;
  const url = inviteUrl(code);
  e.roomCode.textContent = code;
  e.roomUrl.textContent = url;
  e.shareBtn.hidden = typeof navigator.share !== 'function';
  if (isLocalhost()) {
    e.localhostWarning.textContent = LOCALHOST_WARNING;
    e.localhostWarning.hidden = false;
  }
  return url;
}

export function setHostStatus(text: string, tone: '' | 'error' = ''): void {
  lobbyEls.hostStatus.textContent = text;
  lobbyEls.hostStatus.className = `status ${tone}`;
}

// ---------- コード入力（ゲスト） ----------
export function setJoinStatus(text: string, tone: '' | 'error' = ''): void {
  lobbyEls.joinStatus.textContent = text;
  lobbyEls.joinStatus.className = `status ${tone}`;
}

/** 数字以外を取り除き、4 桁に切り詰めて返す */
export function sanitizeCodeInput(): string {
  const el = lobbyEls.codeInput;
  const v = el.value.replace(/\D/g, '').slice(0, 4);
  if (v !== el.value) el.value = v;
  return v;
}

// ---------- 通信メッセージ画面 ----------
export interface CloseContext {
  role: 'host' | 'guest';
  code: string | null;
  /** 試合中に切れたなら [自分, 相手] のスコア */
  interruptedScore: [number, number] | null;
}

export function closeMessage(reason: CloseReason, ctx: CloseContext): { title: string; text: string } {
  const err = (text: string) => ({ title: '接続エラー', text });
  const code = ctx.code ?? '----';
  switch (reason) {
    case 'server_unreachable':
    case 'server_lost':
      return err('サーバーに接続できませんでした。通信環境を確認して、もう一度お試しください。');
    case 'room_not_found':
      return err(`部屋 ${code} が見つかりません。コードを確かめてください。`);
    case 'room_full':
      return err(`部屋 ${code} はすでに対戦中です。`);
    case 'server_full':
      return err('ただいま混み合っています。しばらくしてからお試しください。');
    case 'version_mismatch':
      return err('相手とアプリのバージョンが異なります。両方の画面を再読み込みしてください。');
    case 'bad_request':
    case 'already_in_room':
      return err('通信エラーが発生しました。もう一度お試しください。');
    case 'connect_timeout':
      return err('相手と接続できませんでした。同じ Wi-Fi につながっているか確認して、もう一度お試しください。');
    case 'bye':
      return { title: '対戦終了', text: '相手が退出しました。' };
    case 'peer_left':
      if (ctx.role === 'guest') return { title: '対戦終了', text: 'ホストが部屋を閉じました。' };
      return lostMessage(ctx);
    case 'lost':
      return lostMessage(ctx);
    case 'user':
      return { title: '対戦終了', text: '' };
  }
}

function lostMessage(ctx: CloseContext): { title: string; text: string } {
  const s = ctx.interruptedScore;
  const suffix = s ? `（${s[0]} – ${s[1]} で中断）` : '';
  return { title: '対戦終了', text: `相手との接続が切れました。${suffix}` };
}

export function showNetMessage(title: string, text: string): void {
  lobbyEls.netMsgTitle.textContent = title;
  lobbyEls.netMsgText.textContent = text;
}
