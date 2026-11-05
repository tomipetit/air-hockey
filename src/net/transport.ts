import type { Channel } from '../shared/protocol';

export type { Channel };
export type TransportKind = 'p2p' | 'relay';

export interface Transport {
  readonly kind: TransportKind;
  /** 両チャネルとも送信可能か */
  readonly isOpen: boolean;
  /** エンコード済みパケットを送る。閉じていれば黙って捨てる。
   *  unreliable は送信バッファが詰まっていたら捨てる（p2p: bufferedAmount > 64KiB、relay: ws.bufferedAmount > 16KiB） */
  send(data: Uint8Array, channel: Channel): void;
  onMessage: ((data: Uint8Array) => void) | null;
  /** 一度だけ呼ばれる。自分で close() した場合は呼ばない */
  onClose: (() => void) | null;
  close(): void;
}
