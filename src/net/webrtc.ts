// P2P 経路：RTCPeerConnection + negotiated DataChannel 2 本
import type { SignalData } from '../shared/protocol';
import type { Channel, Transport } from './transport';

export interface WebRtcOptions {
  iceServers: RTCIceServer[];
  blockIce: boolean;
}

const P2P_UNRELIABLE_MAX_BUFFER = 64 * 1024;

export class WebRtcTransport implements Transport {
  readonly kind = 'p2p' as const;
  onMessage: ((data: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;
  /** 両 DataChannel が open になったら呼ばれる */
  onOpen: (() => void) | null = null;

  private pc: RTCPeerConnection;
  private stateCh: RTCDataChannel;
  private eventCh: RTCDataChannel;
  private pending: RTCIceCandidateInit[] = [];
  private closed = false;
  private opened = false;

  constructor(
    private role: 'host' | 'guest',
    private sendSignal: (d: SignalData) => void,
    private opts: WebRtcOptions,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers });
    this.stateCh = this.pc.createDataChannel('state', {
      negotiated: true,
      id: 0,
      ordered: false,
      maxRetransmits: 0,
    });
    this.eventCh = this.pc.createDataChannel('event', { negotiated: true, id: 1, ordered: true });
    for (const ch of [this.stateCh, this.eventCh]) {
      ch.binaryType = 'arraybuffer';
      ch.onopen = () => this.checkOpen();
      ch.onclose = () => this.fail();
      ch.onmessage = (e: MessageEvent) => {
        if (this.closed) return;
        if (e.data instanceof ArrayBuffer) this.onMessage?.(new Uint8Array(e.data));
      };
    }
    this.pc.onicecandidate = (e) => {
      if (this.closed || !e.candidate || this.opts.blockIce) return;
      const c = e.candidate.toJSON();
      if (!c.candidate) return;
      this.sendSignal({
        kind: 'candidate',
        candidate: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null },
      });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.fail();
    };
  }

  get isOpen(): boolean {
    return !this.closed && this.stateCh.readyState === 'open' && this.eventCh.readyState === 'open';
  }

  /** ホストのみ：offer を作って送る */
  async start(): Promise<void> {
    if (this.role !== 'host') return;
    await this.pc.setLocalDescription(await this.pc.createOffer());
    if (this.closed) return;
    this.sendSignal({ kind: 'offer', sdp: this.pc.localDescription!.sdp });
  }

  /** 相手からの signal（offer/answer/candidate）を渡す */
  async handleSignal(d: SignalData): Promise<void> {
    if (this.closed) return;
    try {
      switch (d.kind) {
        case 'offer':
          if (this.role !== 'guest') return;
          await this.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
          await this.flushCandidates();
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          if (this.closed) return;
          this.sendSignal({ kind: 'answer', sdp: this.pc.localDescription!.sdp });
          break;
        case 'answer':
          if (this.role !== 'host') return;
          await this.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
          await this.flushCandidates();
          break;
        case 'candidate':
          if (this.opts.blockIce) return;
          if (!this.pc.remoteDescription) this.pending.push(d.candidate);
          else await this.addCandidate(d.candidate);
          break;
        case 'relay':
          break;
      }
    } catch (e) {
      if (!this.closed) console.debug('[webrtc] signal failed', e);
    }
  }

  send(data: Uint8Array, channel: Channel): void {
    if (!this.isOpen) return;
    const ch = channel === 'unreliable' ? this.stateCh : this.eventCh;
    if (channel === 'unreliable' && ch.bufferedAmount > P2P_UNRELIABLE_MAX_BUFFER) return;
    try {
      ch.send(data as Uint8Array<ArrayBuffer>);
    } catch (e) {
      console.debug('[webrtc] send failed', e);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.stateCh.close();
      this.eventCh.close();
      this.pc.close();
    } catch {
      /* 無視 */
    }
  }

  private async flushCandidates(): Promise<void> {
    const list = this.pending;
    this.pending = [];
    for (const c of list) await this.addCandidate(c);
  }

  private async addCandidate(c: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(c);
    } catch (e) {
      console.debug('[webrtc] addIceCandidate failed', e);
    }
  }

  private checkOpen(): void {
    if (this.closed || this.opened || !this.isOpen) return;
    this.opened = true;
    this.onOpen?.();
  }

  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.pc.close();
    } catch {
      /* 無視 */
    }
    this.onClose?.();
  }
}
