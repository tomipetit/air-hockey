// NetSession の単体テスト：WebSocket / RTCPeerConnection を偽物に差し替え、フェイクタイマーで時間を進める
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTO_VERSION, decode, encode, type ClientMsg, type GameMsg, type ServerMsg } from '../shared/protocol';
import { LOST_MS, PEER_LEFT_GRACE_MS, RELAY_READY_TIMEOUT_MS } from './config';
import { NetSession, type NetOptions } from './session';

// ---------- 偽 WebSocket ----------
class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = 0;
  binaryType = 'blob';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  json: ClientMsg[] = [];
  bins: GameMsg[] = [];
  constructor(public url: string) {
    FakeWS.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(d: unknown) {
    if (typeof d === 'string') this.json.push(JSON.parse(d) as ClientMsg);
    else this.bins.push(decode(d as Uint8Array)!);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  /** サーバー → クライアント */
  server(m: ServerMsg) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  serverBin(m: GameMsg) {
    const b = encode(m);
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  }
}

// ---------- 偽 RTCPeerConnection ----------
class FakeDC {
  readyState = 'connecting';
  binaryType = 'blob';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  sent: GameMsg[] = [];
  constructor(public label: string) {}
  send(d: Uint8Array) {
    this.sent.push(decode(d)!);
  }
  close() {
    this.readyState = 'closed';
  }
  open() {
    this.readyState = 'open';
    this.onopen?.();
  }
  recv(m: GameMsg) {
    const b = encode(m);
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  }
}
class FakePC {
  static all: FakePC[] = [];
  dcs: FakeDC[] = [];
  connectionState = 'new';
  remoteDescription: unknown = null;
  localDescription: { sdp: string } | null = null;
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  constructor() {
    FakePC.all.push(this);
  }
  createDataChannel(label: string) {
    const d = new FakeDC(label);
    this.dcs.push(d);
    return d;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'o' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'a' };
  }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: unknown) {
    this.remoteDescription = d;
  }
  async addIceCandidate() {}
  close() {
    this.connectionState = 'closed';
  }
}

const opts = (o: Partial<NetOptions> = {}): NetOptions => ({
  signalUrl: 'ws://test/ws',
  iceServers: [],
  forceRelay: false,
  blockIce: false,
  ...o,
});

beforeEach(() => {
  FakeWS.all = [];
  FakePC.all = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** ゲストを P2P で ready まで進める */
async function guestReadyP2P() {
  const s = NetSession.join('1234', opts());
  const got: GameMsg[] = [];
  s.onMessage = (m) => got.push(m);
  await vi.advanceTimersByTimeAsync(1);
  const ws = FakeWS.all[0];
  expect(ws.json[0]).toEqual({ type: 'join_room', v: PROTO_VERSION, code: '1234', forceRelay: false });
  ws.server({ type: 'joined', code: '1234' });
  expect(s.status.phase).toBe('negotiating');
  const pc = FakePC.all[0];
  const [stateCh, eventCh] = pc.dcs;
  stateCh.open();
  eventCh.open();
  expect(eventCh.sent).toContainEqual({ type: 'ready', v: PROTO_VERSION });
  eventCh.recv({ type: 'match_start', startTick: 10 });
  expect(s.status.phase).toBe('ready');
  expect(s.status.kind).toBe('p2p');
  expect(got).toEqual([{ type: 'match_start', startTick: 10 }]);
  return { s, ws, stateCh, eventCh, got };
}

/** ホストを P2P で ready まで進める */
async function hostReadyP2P() {
  const s = NetSession.host(opts());
  await vi.advanceTimersByTimeAsync(1);
  const ws = FakeWS.all[0];
  ws.server({ type: 'room_created', code: '4321' });
  ws.server({ type: 'peer_joined', forceRelay: false });
  await vi.advanceTimersByTimeAsync(1);
  const pc = FakePC.all[0];
  const [stateCh, eventCh] = pc.dcs;
  stateCh.open();
  eventCh.open();
  eventCh.recv({ type: 'ready', v: PROTO_VERSION });
  expect(s.status.phase).toBe('ready');
  expect(s.status.kind).toBe('p2p');
  return { s, ws, stateCh, eventCh };
}

describe('NetSession：P2P 中の peer_left（相手がタブを閉じた）', () => {
  it('ゲスト：peer_left 後に DC が途絶えると約 1.5 秒で close(peer_left)', async () => {
    const { s, ws } = await guestReadyP2P();
    ws.server({ type: 'peer_left' });
    expect(s.status.phase).toBe('ready'); // 即座には閉じない
    await vi.advanceTimersByTimeAsync(PEER_LEFT_GRACE_MS - 300);
    expect(s.status.phase).toBe('ready');
    await vi.advanceTimersByTimeAsync(600);
    expect(s.status.phase).toBe('closed');
    expect(s.status.closeReason).toBe('peer_left');
  });

  it('ホスト：同様に close(peer_left)（LOST_MS の 8 秒を待たない）', async () => {
    const { s, ws } = await hostReadyP2P();
    ws.server({ type: 'peer_left' });
    await vi.advanceTimersByTimeAsync(PEER_LEFT_GRACE_MS + 300);
    expect(s.status.phase).toBe('closed');
    expect(s.status.closeReason).toBe('peer_left');
  });

  it('peer_left 後も DC で ping 等が届き続ける間は閉じない（WS だけ切れた場合）', async () => {
    const { s, ws, stateCh } = await guestReadyP2P();
    ws.server({ type: 'peer_left' });
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(500);
      stateCh.recv({ type: 'ping', t: performance.now() });
    }
    expect(s.status.phase).toBe('ready');
    // その後に途絶えると閉じる
    await vi.advanceTimersByTimeAsync(PEER_LEFT_GRACE_MS + 300);
    expect(s.status.phase).toBe('closed');
    expect(s.status.closeReason).toBe('peer_left');
  });

  it('peer_left 直後に BYE が届けば bye（「相手が退出しました」）が優先される', async () => {
    const { s, ws, eventCh } = await guestReadyP2P();
    ws.server({ type: 'peer_left' });
    await vi.advanceTimersByTimeAsync(200);
    eventCh.recv({ type: 'bye' });
    expect(s.status.closeReason).toBe('bye');
  });

  it('peer_left が無ければ 1.5 秒途絶は「通信不安定」のみ、LOST_MS で lost', async () => {
    const { s } = await guestReadyP2P();
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.status.phase).toBe('ready');
    expect(s.status.unstable).toBe(true);
    await vi.advanceTimersByTimeAsync(LOST_MS - 2000 + 300);
    expect(s.status.closeReason).toBe('lost');
  });

  it('ping を受けると pong を返し、RTT を計測する', async () => {
    const { s, stateCh } = await guestReadyP2P();
    stateCh.recv({ type: 'ping', t: 1.5 });
    expect(stateCh.sent).toContainEqual({ type: 'pong', t: 1.5 });
    const t = performance.now();
    await vi.advanceTimersByTimeAsync(40);
    stateCh.recv({ type: 'pong', t });
    expect(s.status.rttMs).toBeCloseTo(40, 0);
  });
});

describe('NetSession：中継の READY が来ない（kick_guest / kicked）', () => {
  it('ホスト：中継 READY 待ちタイムアウトで kick_guest を送り waiting(relay_failed) に戻る', async () => {
    const s = NetSession.host(opts());
    await vi.advanceTimersByTimeAsync(1);
    const ws = FakeWS.all[0];
    ws.server({ type: 'room_created', code: '4321' });
    ws.server({ type: 'peer_joined', forceRelay: true });
    expect(s.status.kind).toBe('relay');
    expect(ws.json).toContainEqual({ type: 'signal', data: { kind: 'relay' } });
    expect(ws.json.some((m) => m.type === 'kick_guest')).toBe(false);
    await vi.advanceTimersByTimeAsync(RELAY_READY_TIMEOUT_MS + 10);
    expect(ws.json).toContainEqual({ type: 'kick_guest' });
    expect(s.status.phase).toBe('waiting');
    expect(s.status.notice).toBe('relay_failed');
    expect(s.status.kind).toBeNull();
    // 次のゲストで改めて接続できる
    ws.server({ type: 'peer_joined', forceRelay: true });
    expect(s.status.phase).toBe('negotiating');
    ws.serverBin({ type: 'ready', v: PROTO_VERSION });
    expect(s.status.phase).toBe('ready');
    expect(s.status.kind).toBe('relay');
  });

  it('ホスト：READY が届けば kick_guest は送らない', async () => {
    const s = NetSession.host(opts({ forceRelay: true }));
    await vi.advanceTimersByTimeAsync(1);
    const ws = FakeWS.all[0];
    ws.server({ type: 'room_created', code: '4321' });
    ws.server({ type: 'peer_joined', forceRelay: false });
    ws.serverBin({ type: 'ready', v: PROTO_VERSION });
    await vi.advanceTimersByTimeAsync(RELAY_READY_TIMEOUT_MS + 500); // LOST_MS(8s) より前に確認
    expect(ws.json.some((m) => m.type === 'kick_guest')).toBe(false);
    expect(s.status.phase).toBe('ready');
  });

  it('ゲスト：ready 前に kicked → close(connect_timeout)', async () => {
    const s = NetSession.join('1234', opts({ forceRelay: true }));
    await vi.advanceTimersByTimeAsync(1);
    const ws = FakeWS.all[0];
    ws.server({ type: 'joined', code: '1234' });
    ws.server({ type: 'signal', data: { kind: 'relay' } });
    expect(ws.bins).toContainEqual({ type: 'ready', v: PROTO_VERSION });
    ws.server({ type: 'kicked' });
    expect(s.status.phase).toBe('closed');
    expect(s.status.closeReason).toBe('connect_timeout');
  });

  it('ゲスト：ready 後の kicked は無視', async () => {
    const { s, ws } = await guestReadyP2P();
    ws.server({ type: 'kicked' });
    expect(s.status.phase).toBe('ready');
  });

  it('ホスト宛の kicked は無視', async () => {
    const s = NetSession.host(opts());
    await vi.advanceTimersByTimeAsync(1);
    const ws = FakeWS.all[0];
    ws.server({ type: 'room_created', code: '4321' });
    ws.server({ type: 'kicked' });
    expect(s.status.phase).toBe('waiting');
  });
});
