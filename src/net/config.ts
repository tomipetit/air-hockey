// 通信の設定値と URL フラグ
export const SIGNAL_CONNECT_TIMEOUT_MS = 5000;
export const SIGNAL_REPLY_TIMEOUT_MS = 5000;
/** ホスト：peer_joined から READY（DC 経由）受信まで */
export const P2P_TIMEOUT_MS = 5000;
/** ホスト：中継切替から READY（中継経由）受信まで */
export const RELAY_READY_TIMEOUT_MS = 5000;
/** ゲスト：joined から MATCH_START 受信まで */
export const GUEST_CONNECT_TIMEOUT_MS = 15000;
export const PING_INTERVAL_MS = 1000;
export const UNSTABLE_MS = 1500;
export const LOST_MS = 8000;
/** 生存監視の周期 */
export const WATCH_INTERVAL_MS = 250;

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** シグナリング URL（既定は同一オリジンの /ws） */
export function signalUrl(): string {
  const env = import.meta.env.VITE_SIGNAL_URL as string | undefined;
  if (env) return env;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export interface UrlFlags {
  forceRelay: boolean;
  blockIce: boolean;
  e2e: boolean;
  debug: boolean;
  /** 招待コード（?room=XXXX）。無ければ null */
  room: string | null;
}

/** URL のクエリを解釈する（値なしで有効） */
export function readFlags(search: string = location.search): UrlFlags {
  const q = new URLSearchParams(search);
  return {
    forceRelay: q.has('forceRelay'),
    blockIce: q.has('blockIce'),
    e2e: q.has('e2e'),
    debug: q.has('debug'),
    room: q.get('room'),
  };
}
