// NetSession：部屋作成/参加、P2P 試行、5 秒で中継フォールバック、READY ハンドシェイク、
// ping/RTT、生存監視、切断理由の確定。経路の決定権はホストのみ。
import {
  PROTO_VERSION,
  channelOf,
  decode,
  encode,
  type GameMsg,
  type ServerMsg,
  type SignalData,
  type SignalErrorCode,
} from '../shared/protocol';
import {
  GUEST_CONNECT_TIMEOUT_MS,
  LOST_MS,
  P2P_TIMEOUT_MS,
  PING_INTERVAL_MS,
  RELAY_READY_TIMEOUT_MS,
  SIGNAL_REPLY_TIMEOUT_MS,
  UNSTABLE_MS,
  WATCH_INTERVAL_MS,
} from './config';
import { RelayTransport } from './relay';
import { SignalingClient } from './signaling-client';
import type { Transport, TransportKind } from './transport';
import { WebRtcTransport } from './webrtc';

export type SessionPhase =
  | 'connecting' // シグナリング WS 接続中
  | 'waiting' // ホスト：相手待ち（code 確定）
  | 'joining' // ゲスト：join_room 送信済み
  | 'negotiating' // P2P 試行中、または中継の READY 待ち
  | 'ready' // 経路確定（ホストは READY 受信済み）
  | 'closed';

export type CloseReason =
  | 'user'
  | 'bye'
  | 'peer_left'
  | 'lost'
  | 'connect_timeout'
  | 'server_unreachable'
  | 'server_lost'
  | SignalErrorCode;

/** ホストの待機画面に出す補足（negotiating から waiting に戻った理由） */
export type SessionNotice = 'relay_failed' | 'peer_left' | null;

export interface SessionStatus {
  phase: SessionPhase;
  role: 'host' | 'guest';
  code: string | null;
  kind: TransportKind | null;
  forcedRelay: boolean;
  rttMs: number | null;
  unstable: boolean;
  closeReason: CloseReason | null;
  notice: SessionNotice;
}

export interface NetOptions {
  signalUrl: string;
  iceServers: RTCIceServer[];
  forceRelay: boolean;
  blockIce: boolean;
}

const RTT_ALPHA = 0.2;
/** BYE を送ってから P2P 経路を閉じるまでの猶予（pc.close() で BYE が落ちないように） */
const BYE_FLUSH_MS = 300;

export class NetSession {
  onStatus: ((s: SessionStatus) => void) | null = null;
  /** ゲームメッセージ（ping/pong/ready は内部で処理し渡さない。bye は close('bye') に変換） */
  onMessage: ((m: GameMsg) => void) | null = null;

  private st: SessionStatus;
  private sig: SignalingClient;
  private transport: Transport | null = null;
  private rtc: WebRtcTransport | null = null;
  private replyTimer: ReturnType<typeof setTimeout> | null = null;
  private routeTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private lastRecvMs = 0;
  private sawOffer = false;

  static host(opts: NetOptions): NetSession {
    const s = new NetSession('host', opts, null);
    void s.start();
    return s;
  }

  static join(code: string, opts: NetOptions): NetSession {
    const s = new NetSession('guest', opts, code);
    void s.start();
    return s;
  }

  private constructor(
    readonly role: 'host' | 'guest',
    private opts: NetOptions,
    code: string | null,
  ) {
    this.st = {
      phase: 'connecting',
      role,
      code,
      kind: null,
      forcedRelay: false,
      rttMs: null,
      unstable: false,
      closeReason: null,
      notice: null,
    };
    this.sig = new SignalingClient(opts.signalUrl);
  }

  get status(): SessionStatus {
    return this.st;
  }

  get isClosed(): boolean {
    return this.st.phase === 'closed';
  }

  /** ready 前は捨てる */
  send(m: GameMsg): void {
    if (this.st.phase !== 'ready') return;
    this.sendRaw(m);
  }

  close(reason: CloseReason = 'user'): void {
    if (this.st.phase === 'closed') return;
    const t = this.transport;
    const wasReady = this.st.phase === 'ready';
    this.clearTimers();
    this.transport = null;
    if (t) {
      t.onMessage = null;
      t.onClose = null;
      if (wasReady && reason !== 'bye') {
        t.send(encode({ type: 'bye' }), 'reliable');
        if (t.kind === 'p2p') setTimeout(() => t.close(), BYE_FLUSH_MS);
        else t.close();
      } else {
        t.close();
      }
    }
    if (this.rtc && this.rtc !== t) this.rtc.close();
    this.rtc = null;
    this.sig.onJson = null;
    this.sig.onClose = null;
    this.sig.close();
    this.update({ phase: 'closed', closeReason: reason, unstable: false });
  }

  // ---------- 内部 ----------

  private async start(): Promise<void> {
    this.sig.onJson = (m) => this.onServer(m);
    this.sig.onClose = () => this.onSignalClosed();
    try {
      await this.sig.connect();
    } catch {
      this.close('server_unreachable');
      return;
    }
    if (this.isClosed) return;
    if (this.role === 'host') {
      this.sig.sendJson({ type: 'create_room', v: PROTO_VERSION });
    } else {
      this.sig.sendJson({
        type: 'join_room',
        v: PROTO_VERSION,
        code: this.st.code ?? '',
        forceRelay: this.opts.forceRelay,
      });
      this.update({ phase: 'joining' });
    }
    this.replyTimer = setTimeout(() => this.close('server_unreachable'), SIGNAL_REPLY_TIMEOUT_MS);
  }

  private onServer(m: ServerMsg): void {
    if (this.isClosed) return;
    switch (m.type) {
      case 'error':
        this.close(m.code);
        return;
      case 'room_created':
        if (this.role !== 'host' || this.st.phase !== 'connecting') return;
        this.clearReply();
        this.update({ phase: 'waiting', code: m.code });
        return;
      case 'joined':
        if (this.role !== 'guest' || this.st.phase !== 'joining') return;
        this.clearReply();
        this.guestNegotiate();
        return;
      case 'peer_joined':
        if (this.role !== 'host' || this.st.phase !== 'waiting') return;
        this.hostNegotiate(m.forceRelay);
        return;
      case 'peer_left':
        this.onPeerLeft();
        return;
      case 'signal':
        this.onSignal(m.data);
        return;
    }
  }

  private onSignalClosed(): void {
    if (this.isClosed) return;
    // ready 後の P2P は DC で試合継続
    if (this.st.phase === 'ready' && this.st.kind === 'p2p') return;
    this.close(this.st.phase === 'connecting' ? 'server_unreachable' : 'server_lost');
  }

  private onPeerLeft(): void {
    const phase = this.st.phase;
    if (this.role === 'host') {
      if (phase === 'negotiating') {
        this.dropRoute();
        this.update({ phase: 'waiting', kind: null, forcedRelay: false, notice: 'peer_left' });
      } else if (phase === 'ready' && this.st.kind === 'relay') {
        this.close('lost');
      }
      // waiting 中・P2P 対戦中は無視（P2P は生存監視に任せる）
    } else {
      if (phase === 'ready') {
        if (this.st.kind === 'relay') this.close('lost');
      } else {
        this.close('peer_left');
      }
    }
  }

  private onSignal(d: SignalData): void {
    if (this.st.phase !== 'negotiating') return;
    if (d.kind === 'relay') {
      if (this.role === 'guest') this.guestSwitchToRelay();
      return;
    }
    if (d.kind === 'offer') this.sawOffer = true;
    void this.rtc?.handleSignal(d);
  }

  // ---- ホスト ----

  private hostNegotiate(peerForceRelay: boolean): void {
    this.update({ phase: 'negotiating', notice: null });
    if (this.opts.forceRelay || peerForceRelay) {
      this.update({ forcedRelay: true });
      this.hostSwitchToRelay();
      return;
    }
    const rtc = this.createRtc();
    this.update({ kind: 'p2p', forcedRelay: false });
    rtc.start().catch((e) => {
      console.debug('[session] offer failed', e);
      if (this.rtc === rtc) this.hostSwitchToRelay();
    });
    this.setRouteTimer(P2P_TIMEOUT_MS, () => this.hostSwitchToRelay());
  }

  private hostSwitchToRelay(): void {
    if (this.st.phase !== 'negotiating') return;
    this.dropRoute();
    this.sig.sendJson({ type: 'signal', data: { kind: 'relay' } });
    this.useRelay();
    this.setRouteTimer(RELAY_READY_TIMEOUT_MS, () => {
      // 中継でも READY が来ない → 待機に戻す
      this.dropRoute();
      this.update({ phase: 'waiting', kind: null, forcedRelay: false, notice: 'relay_failed' });
    });
  }

  // ---- ゲスト ----

  private guestNegotiate(): void {
    const rtc = this.createRtc();
    rtc.onOpen = () => {
      if (this.transport === rtc && this.st.phase === 'negotiating') {
        rtc.send(encode({ type: 'ready', v: PROTO_VERSION }), 'reliable');
      }
    };
    this.update({ phase: 'negotiating', kind: 'p2p' });
    this.setRouteTimer(GUEST_CONNECT_TIMEOUT_MS, () => this.close('connect_timeout'));
  }

  private guestSwitchToRelay(): void {
    if (this.transport?.kind === 'relay') return;
    // offer より先に relay が来た = ホストが P2P を試さず中継を選んだ（forceRelay）
    const forced = this.opts.forceRelay || !this.sawOffer;
    if (this.rtc) {
      this.rtc.onClose = null;
      this.rtc.close();
    }
    this.rtc = null;
    this.transport = null;
    this.update({ forcedRelay: forced });
    const relay = this.useRelay();
    relay.send(encode({ type: 'ready', v: PROTO_VERSION }), 'reliable');
  }

  // ---- 共通 ----

  private createRtc(): WebRtcTransport {
    const rtc = new WebRtcTransport(this.role, (d) => this.sig.sendJson({ type: 'signal', data: d }), {
      iceServers: this.opts.iceServers,
      blockIce: this.opts.blockIce,
    });
    this.rtc = rtc;
    this.transport = rtc;
    rtc.onMessage = (d) => this.onPacket(rtc, d);
    rtc.onClose = () => {
      if (this.transport !== rtc) return;
      if (this.st.phase === 'ready') this.close('lost');
      else if (this.role === 'host' && this.st.phase === 'negotiating') this.hostSwitchToRelay();
      // ゲストはホストの判断（relay 指示 or タイムアウト）を待つ
    };
    return rtc;
  }

  private useRelay(): RelayTransport {
    const relay = new RelayTransport(this.sig);
    this.transport = relay;
    relay.onMessage = (d) => this.onPacket(relay, d);
    relay.onClose = () => {
      if (this.transport === relay) this.close('server_lost');
    };
    this.update({ kind: 'relay' });
    return relay;
  }

  /** 現在の経路を破棄（ホストが待機に戻るとき・中継に切り替えるとき） */
  private dropRoute(): void {
    this.clearRouteTimer();
    const t = this.transport;
    this.transport = null;
    if (t) {
      t.onMessage = null;
      t.onClose = null;
      t.close();
    }
    if (this.rtc && this.rtc !== t) this.rtc.close();
    this.rtc = null;
  }

  private onPacket(from: Transport, data: Uint8Array): void {
    if (this.isClosed || from !== this.transport) return;
    const m = decode(data);
    if (!m) return;
    this.lastRecvMs = performance.now();
    if (this.st.unstable) this.update({ unstable: false });

    switch (m.type) {
      case 'ping':
        from.send(encode({ type: 'pong', t: m.t }), 'unreliable');
        return;
      case 'pong': {
        const rtt = performance.now() - m.t;
        if (rtt >= 0 && rtt < 60_000) {
          this.st.rttMs = this.st.rttMs === null ? rtt : this.st.rttMs + (rtt - this.st.rttMs) * RTT_ALPHA;
        }
        return;
      }
      case 'ready':
        if (this.role !== 'host' || this.st.phase !== 'negotiating') return;
        if (m.v !== PROTO_VERSION) {
          this.close('version_mismatch');
          return;
        }
        this.clearRouteTimer();
        this.becomeReady(from.kind);
        return;
      case 'bye':
        this.close('bye');
        return;
      case 'match_start':
        if (this.role === 'guest' && this.st.phase === 'negotiating') {
          this.clearRouteTimer();
          this.becomeReady(from.kind);
        }
        break;
    }
    if (this.st.phase === 'ready') this.onMessage?.(m);
  }

  private becomeReady(kind: TransportKind): void {
    this.lastRecvMs = performance.now();
    // 使わなかった経路を片付ける
    if (kind === 'relay' && this.rtc) {
      this.rtc.onClose = null;
      this.rtc.close();
      this.rtc = null;
    }
    this.update({ phase: 'ready', kind, notice: null });
    this.pingTimer = setInterval(() => this.sendRaw({ type: 'ping', t: performance.now() }), PING_INTERVAL_MS);
    this.watchTimer = setInterval(() => this.watch(), WATCH_INTERVAL_MS);
    this.sendRaw({ type: 'ping', t: performance.now() });
  }

  private watch(): void {
    if (this.st.phase !== 'ready') return;
    const idle = performance.now() - this.lastRecvMs;
    if (idle > LOST_MS) {
      this.close('lost');
      return;
    }
    const unstable = idle > UNSTABLE_MS;
    if (unstable !== this.st.unstable) this.update({ unstable });
  }

  private sendRaw(m: GameMsg): void {
    this.transport?.send(encode(m), channelOf(m));
  }

  private setRouteTimer(ms: number, fn: () => void): void {
    this.clearRouteTimer();
    this.routeTimer = setTimeout(() => {
      this.routeTimer = null;
      if (!this.isClosed) fn();
    }, ms);
  }

  private clearRouteTimer(): void {
    if (this.routeTimer !== null) clearTimeout(this.routeTimer);
    this.routeTimer = null;
  }

  private clearReply(): void {
    if (this.replyTimer !== null) clearTimeout(this.replyTimer);
    this.replyTimer = null;
  }

  private clearTimers(): void {
    this.clearReply();
    this.clearRouteTimer();
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.watchTimer !== null) clearInterval(this.watchTimer);
    this.pingTimer = this.watchTimer = null;
  }

  private update(patch: Partial<SessionStatus>): void {
    const prev = this.st;
    const next = { ...prev, ...patch };
    this.st = next;
    const changed =
      prev.phase !== next.phase ||
      prev.kind !== next.kind ||
      prev.unstable !== next.unstable ||
      prev.closeReason !== next.closeReason ||
      prev.code !== next.code ||
      prev.notice !== next.notice ||
      prev.forcedRelay !== next.forcedRelay;
    if (changed) this.onStatus?.(next);
  }
}
