// 通信プロトコル（シグナリング JSON とゲームのバイナリパケット）。
// DOM・Node 非依存（サーバーからも import する）。
import type { Side } from './constants';
import type { GameEvent } from './game-host';

export const PROTO_VERSION = 1;
export const ROOM_CODE_RE = /^\d{4}$/;

// ---------- シグナリング（WebSocket テキストフレーム = JSON） ----------
export type SignalData =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } }
  | { kind: 'relay' }; // ホスト → ゲスト：「中継モードに切り替える」

export type SignalErrorCode =
  | 'bad_request'
  | 'room_not_found'
  | 'room_full'
  | 'server_full'
  | 'version_mismatch'
  | 'already_in_room';

const ERROR_CODES: readonly SignalErrorCode[] = [
  'bad_request',
  'room_not_found',
  'room_full',
  'server_full',
  'version_mismatch',
  'already_in_room',
];

/** クライアント → サーバー */
export type ClientMsg =
  | { type: 'create_room'; v: number }
  | { type: 'join_room'; v: number; code: string; forceRelay?: boolean }
  | { type: 'signal'; data: SignalData }
  | { type: 'leave' };

/** サーバー → クライアント */
export type ServerMsg =
  | { type: 'room_created'; code: string }
  | { type: 'joined'; code: string }
  | { type: 'peer_joined'; forceRelay: boolean }
  | { type: 'peer_left' }
  | { type: 'signal'; data: SignalData }
  | { type: 'error'; code: SignalErrorCode };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
/** SDP / candidate 文字列の上限（maxPayload 64KiB 内に収まる値） */
const MAX_SDP = 32 * 1024;

function parseJson(text: string): Obj | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

function parseSignalData(v: unknown): SignalData | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case 'offer':
    case 'answer':
      return isStr(v.sdp) && v.sdp.length <= MAX_SDP ? { kind: v.kind, sdp: v.sdp } : null;
    case 'candidate': {
      const c = v.candidate;
      if (!isObj(c) || !isStr(c.candidate) || c.candidate.length > MAX_SDP) return null;
      const out: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } = {
        candidate: c.candidate,
      };
      if (c.sdpMid !== undefined) {
        if (c.sdpMid !== null && !isStr(c.sdpMid)) return null;
        out.sdpMid = c.sdpMid;
      }
      if (c.sdpMLineIndex !== undefined) {
        if (c.sdpMLineIndex !== null && !isInt(c.sdpMLineIndex)) return null;
        out.sdpMLineIndex = c.sdpMLineIndex;
      }
      return { kind: 'candidate', candidate: out };
    }
    case 'relay':
      return { kind: 'relay' };
    default:
      return null;
  }
}

/** JSON 文字列を検証して ClientMsg に。不正なら null（サーバーで使用） */
export function parseClientMsg(text: string): ClientMsg | null {
  const o = parseJson(text);
  if (!o) return null;
  switch (o.type) {
    case 'create_room':
      return isInt(o.v) ? { type: 'create_room', v: o.v } : null;
    case 'join_room': {
      if (!isInt(o.v) || !isStr(o.code)) return null;
      if (o.forceRelay !== undefined && typeof o.forceRelay !== 'boolean') return null;
      const m: ClientMsg = { type: 'join_room', v: o.v, code: o.code };
      if (o.forceRelay !== undefined) m.forceRelay = o.forceRelay;
      return m;
    }
    case 'signal': {
      const data = parseSignalData(o.data);
      return data ? { type: 'signal', data } : null;
    }
    case 'leave':
      return { type: 'leave' };
    default:
      return null;
  }
}

/** 同上 ServerMsg（クライアントで使用） */
export function parseServerMsg(text: string): ServerMsg | null {
  const o = parseJson(text);
  if (!o) return null;
  switch (o.type) {
    case 'room_created':
    case 'joined':
      return isStr(o.code) && ROOM_CODE_RE.test(o.code) ? { type: o.type, code: o.code } : null;
    case 'peer_joined':
      return typeof o.forceRelay === 'boolean' ? { type: 'peer_joined', forceRelay: o.forceRelay } : null;
    case 'peer_left':
      return { type: 'peer_left' };
    case 'signal': {
      const data = parseSignalData(o.data);
      return data ? { type: 'signal', data } : null;
    }
    case 'error':
      return ERROR_CODES.includes(o.code as SignalErrorCode)
        ? { type: 'error', code: o.code as SignalErrorCode }
        : null;
    default:
      return null;
  }
}

// ---------- ゲームメッセージ（DataChannel / 中継共通、バイナリ、リトルエンディアン） ----------
export const MsgType = {
  State: 0x01,
  Input: 0x02,
  Event: 0x03,
  MatchStart: 0x04,
  Ready: 0x05,
  Rematch: 0x06,
  Bye: 0x07,
  Ping: 0x08,
  Pong: 0x09,
} as const;
export type MsgType = (typeof MsgType)[keyof typeof MsgType];

export type PhaseCode = 0 | 1 | 2 | 3; // countdown | playing | goal | over（GameHost の Phase と同順）

export interface StateMsg {
  type: 'state';
  tick: number;
  phase: PhaseCode;
  puckActive: boolean;
  ackSeq: number;
  puck: { x: number; z: number; vx: number; vz: number };
  m1: { x: number; z: number };
  m2: { x: number; z: number };
  score: [number, number];
}
export interface InputMsg {
  type: 'input';
  seq: number;
  x: number;
  z: number;
}
export type WireEvent =
  | { kind: 'countdown'; n: number }
  | { kind: 'start' }
  | { kind: 'score'; scorer: Side; score: [number, number] }
  | { kind: 'stall'; serveTo: Side }
  | { kind: 'over'; winner: Side; score: [number, number] }
  | { kind: 'wall'; x: number; z: number; speed: number }
  | { kind: 'mallet'; side: Side; x: number; z: number; speed: number };
export interface EventMsg {
  type: 'event';
  tick: number;
  ev: WireEvent;
}
export type GameMsg =
  | StateMsg
  | InputMsg
  | EventMsg
  | { type: 'match_start'; startTick: number }
  | { type: 'ready'; v: number }
  | { type: 'rematch' }
  | { type: 'bye' }
  | { type: 'ping'; t: number }
  | { type: 'pong'; t: number };

export type Channel = 'unreliable' | 'reliable';

/** state/input/ping/pong → unreliable、それ以外 → reliable */
export function channelOf(m: GameMsg): Channel {
  switch (m.type) {
    case 'state':
    case 'input':
    case 'ping':
    case 'pong':
      return 'unreliable';
    default:
      return 'reliable';
  }
}

const EventKind = { countdown: 1, start: 2, score: 3, stall: 4, over: 5, wall: 6, mallet: 7 } as const;
const EVENT_LEN: Record<number, number> = { 1: 7, 2: 6, 3: 9, 4: 7, 5: 9, 6: 18, 7: 19 };

export const STATE_LEN = 42;
export const INPUT_LEN = 11;

const u8 = (v: number) => v & 0xff;

function eventLength(ev: WireEvent): number {
  return EVENT_LEN[EventKind[ev.kind]];
}

export function encode(m: GameMsg): Uint8Array {
  let buf: Uint8Array;
  let dv: DataView;
  const alloc = (n: number) => {
    buf = new Uint8Array(n);
    dv = new DataView(buf.buffer);
  };
  switch (m.type) {
    case 'state': {
      alloc(STATE_LEN);
      dv!.setUint8(0, MsgType.State);
      dv!.setUint8(1, (m.puckActive ? 1 : 0) | ((m.phase & 3) << 1));
      dv!.setUint32(2, m.tick >>> 0, true);
      dv!.setUint16(6, m.ackSeq & 0xffff, true);
      dv!.setFloat32(8, m.puck.x, true);
      dv!.setFloat32(12, m.puck.z, true);
      dv!.setFloat32(16, m.puck.vx, true);
      dv!.setFloat32(20, m.puck.vz, true);
      dv!.setFloat32(24, m.m1.x, true);
      dv!.setFloat32(28, m.m1.z, true);
      dv!.setFloat32(32, m.m2.x, true);
      dv!.setFloat32(36, m.m2.z, true);
      dv!.setUint8(40, u8(m.score[0]));
      dv!.setUint8(41, u8(m.score[1]));
      break;
    }
    case 'input':
      alloc(INPUT_LEN);
      dv!.setUint8(0, MsgType.Input);
      dv!.setUint16(1, m.seq & 0xffff, true);
      dv!.setFloat32(3, m.x, true);
      dv!.setFloat32(7, m.z, true);
      break;
    case 'event': {
      const ev = m.ev;
      alloc(eventLength(ev));
      dv!.setUint8(0, MsgType.Event);
      dv!.setUint32(1, m.tick >>> 0, true);
      dv!.setUint8(5, EventKind[ev.kind]);
      switch (ev.kind) {
        case 'countdown':
          dv!.setUint8(6, u8(ev.n));
          break;
        case 'start':
          break;
        case 'score':
          dv!.setUint8(6, ev.scorer);
          dv!.setUint8(7, u8(ev.score[0]));
          dv!.setUint8(8, u8(ev.score[1]));
          break;
        case 'stall':
          dv!.setUint8(6, ev.serveTo);
          break;
        case 'over':
          dv!.setUint8(6, ev.winner);
          dv!.setUint8(7, u8(ev.score[0]));
          dv!.setUint8(8, u8(ev.score[1]));
          break;
        case 'wall':
          dv!.setFloat32(6, ev.x, true);
          dv!.setFloat32(10, ev.z, true);
          dv!.setFloat32(14, ev.speed, true);
          break;
        case 'mallet':
          dv!.setUint8(6, ev.side);
          dv!.setFloat32(7, ev.x, true);
          dv!.setFloat32(11, ev.z, true);
          dv!.setFloat32(15, ev.speed, true);
          break;
      }
      break;
    }
    case 'match_start':
      alloc(5);
      dv!.setUint8(0, MsgType.MatchStart);
      dv!.setUint32(1, m.startTick >>> 0, true);
      break;
    case 'ready':
      alloc(2);
      dv!.setUint8(0, MsgType.Ready);
      dv!.setUint8(1, u8(m.v));
      break;
    case 'rematch':
      alloc(1);
      dv!.setUint8(0, MsgType.Rematch);
      break;
    case 'bye':
      alloc(1);
      dv!.setUint8(0, MsgType.Bye);
      break;
    case 'ping':
    case 'pong':
      alloc(9);
      dv!.setUint8(0, m.type === 'ping' ? MsgType.Ping : MsgType.Pong);
      dv!.setFloat64(1, m.t, true);
      break;
  }
  return buf!;
}

const isSide = (v: number): v is Side => v === 1 || v === 2;

/** 長さ不一致・未知 type・未知 kind・非有限の float を含む場合は null */
export function decode(input: ArrayBuffer | Uint8Array): GameMsg | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 1) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  let bad = false;
  const f32 = (off: number) => {
    const v = dv.getFloat32(off, true);
    if (!Number.isFinite(v)) bad = true;
    return v;
  };
  switch (dv.getUint8(0)) {
    case MsgType.State: {
      if (len !== STATE_LEN) return null;
      const flags = dv.getUint8(1);
      const m: StateMsg = {
        type: 'state',
        puckActive: (flags & 1) === 1,
        phase: ((flags >> 1) & 3) as PhaseCode,
        tick: dv.getUint32(2, true),
        ackSeq: dv.getUint16(6, true),
        puck: { x: f32(8), z: f32(12), vx: f32(16), vz: f32(20) },
        m1: { x: f32(24), z: f32(28) },
        m2: { x: f32(32), z: f32(36) },
        score: [dv.getUint8(40), dv.getUint8(41)],
      };
      return bad ? null : m;
    }
    case MsgType.Input: {
      if (len !== INPUT_LEN) return null;
      const m: InputMsg = { type: 'input', seq: dv.getUint16(1, true), x: f32(3), z: f32(7) };
      return bad ? null : m;
    }
    case MsgType.Event: {
      if (len < 6) return null;
      const kind = dv.getUint8(5);
      const want = EVENT_LEN[kind];
      if (want === undefined || len !== want) return null;
      const tick = dv.getUint32(1, true);
      let ev: WireEvent;
      switch (kind) {
        case EventKind.countdown:
          ev = { kind: 'countdown', n: dv.getUint8(6) };
          break;
        case EventKind.start:
          ev = { kind: 'start' };
          break;
        case EventKind.score: {
          const scorer = dv.getUint8(6);
          if (!isSide(scorer)) return null;
          ev = { kind: 'score', scorer, score: [dv.getUint8(7), dv.getUint8(8)] };
          break;
        }
        case EventKind.stall: {
          const serveTo = dv.getUint8(6);
          if (!isSide(serveTo)) return null;
          ev = { kind: 'stall', serveTo };
          break;
        }
        case EventKind.over: {
          const winner = dv.getUint8(6);
          if (!isSide(winner)) return null;
          ev = { kind: 'over', winner, score: [dv.getUint8(7), dv.getUint8(8)] };
          break;
        }
        case EventKind.wall:
          ev = { kind: 'wall', x: f32(6), z: f32(10), speed: f32(14) };
          break;
        case EventKind.mallet: {
          const side = dv.getUint8(6);
          if (!isSide(side)) return null;
          ev = { kind: 'mallet', side, x: f32(7), z: f32(11), speed: f32(15) };
          break;
        }
        default:
          return null;
      }
      return bad ? null : { type: 'event', tick, ev };
    }
    case MsgType.MatchStart:
      return len === 5 ? { type: 'match_start', startTick: dv.getUint32(1, true) } : null;
    case MsgType.Ready:
      return len === 2 ? { type: 'ready', v: dv.getUint8(1) } : null;
    case MsgType.Rematch:
      return len === 1 ? { type: 'rematch' } : null;
    case MsgType.Bye:
      return len === 1 ? { type: 'bye' } : null;
    case MsgType.Ping:
    case MsgType.Pong: {
      if (len !== 9) return null;
      const t = dv.getFloat64(1, true);
      if (!Number.isFinite(t)) return null;
      return { type: dv.getUint8(0) === MsgType.Ping ? 'ping' : 'pong', t };
    }
    default:
      return null;
  }
}

/** u16 シーケンスの比較（ラップアラウンド対応）。a が b より新しければ true */
export function seqNewer(a: number, b: number): boolean {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

/** GameHost の GameEvent → WireEvent（'goal' は送らないので null） */
export function toWireEvent(ev: GameEvent): WireEvent | null {
  switch (ev.type) {
    case 'countdown':
      return { kind: 'countdown', n: ev.n };
    case 'start':
      return { kind: 'start' };
    case 'score':
      return { kind: 'score', scorer: ev.scorer, score: [ev.score[0], ev.score[1]] };
    case 'stall':
      return { kind: 'stall', serveTo: ev.serveTo };
    case 'over':
      return { kind: 'over', winner: ev.winner, score: [ev.score[0], ev.score[1]] };
    case 'wall':
      return { kind: 'wall', x: ev.x, z: ev.z, speed: ev.speed };
    case 'mallet':
      return { kind: 'mallet', side: ev.side, x: ev.x, z: ev.z, speed: ev.speed };
    case 'goal':
      return null;
  }
}

/** WireEvent → GameEvent */
export function fromWireEvent(ev: WireEvent): GameEvent {
  switch (ev.kind) {
    case 'countdown':
      return { type: 'countdown', n: ev.n };
    case 'start':
      return { type: 'start' };
    case 'score':
      return { type: 'score', scorer: ev.scorer, score: [ev.score[0], ev.score[1]] };
    case 'stall':
      return { type: 'stall', serveTo: ev.serveTo };
    case 'over':
      return { type: 'over', winner: ev.winner, score: [ev.score[0], ev.score[1]] };
    case 'wall':
      return { type: 'wall', x: ev.x, z: ev.z, speed: ev.speed };
    case 'mallet':
      return { type: 'mallet', side: ev.side, x: ev.x, z: ev.z, speed: ev.speed };
  }
}

const PHASES = ['countdown', 'playing', 'goal', 'over'] as const;
/** GameHost の Phase ⇄ PhaseCode */
export const phaseToCode = (p: (typeof PHASES)[number]): PhaseCode => PHASES.indexOf(p) as PhaseCode;
export const codeToPhase = (c: PhaseCode): (typeof PHASES)[number] => PHASES[c];
