// 中継経路：シグナリング WS のバイナリフレームでゲームパケットを送受信する
import type { Channel, Transport } from './transport';
import type { SignalingClient } from './signaling-client';

const RELAY_UNRELIABLE_MAX_BUFFER = 16 * 1024;

export class RelayTransport implements Transport {
  readonly kind = 'relay' as const;
  onMessage: ((data: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;
  private closed = false;
  private prevOnClose: (() => void) | null;

  constructor(private sig: SignalingClient) {
    sig.onBinary = (d) => {
      if (!this.closed) this.onMessage?.(d);
    };
    // 既存の onClose（NetSession のもの）も引き続き呼ぶ
    this.prevOnClose = sig.onClose;
    const prev = this.prevOnClose;
    sig.onClose = () => {
      prev?.();
      if (this.closed) return;
      this.closed = true;
      this.onClose?.();
    };
  }

  get isOpen(): boolean {
    return !this.closed && this.sig.isOpen;
  }

  send(data: Uint8Array, channel: Channel): void {
    if (!this.isOpen) return;
    if (channel === 'unreliable' && this.sig.bufferedAmount > RELAY_UNRELIABLE_MAX_BUFFER) return;
    this.sig.sendBinary(data);
  }

  /** 中継をやめる（WS 自体は NetSession が閉じる） */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sig.onBinary = null;
    this.sig.onClose = this.prevOnClose;
  }
}
