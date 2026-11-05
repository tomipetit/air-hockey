// シグナリング用 WebSocket のラッパー。テキスト = JSON シグナリング、バイナリ = 中継ゲームパケット
import { parseServerMsg, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { SIGNAL_CONNECT_TIMEOUT_MS } from './config';

export class SignalingClient {
  onJson: ((m: ServerMsg) => void) | null = null;
  onBinary: ((data: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;
  private ws: WebSocket | null = null;
  private closed = false;

  constructor(private url: string) {}

  /** open するか SIGNAL_CONNECT_TIMEOUT_MS 経過で reject */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        reject(e);
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.closed = true;
        ws.close();
        reject(new Error('signaling connect timeout'));
      }, SIGNAL_CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onmessage = (e: MessageEvent) => {
        if (this.closed) return;
        if (typeof e.data === 'string') {
          const m = parseServerMsg(e.data);
          if (!m) {
            console.warn('[signal] invalid message', e.data);
            return;
          }
          this.onJson?.(m);
        } else if (e.data instanceof ArrayBuffer) {
          this.onBinary?.(new Uint8Array(e.data));
        }
      };
      ws.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('signaling closed'));
        }
        if (this.closed) return;
        this.closed = true;
        this.onClose?.();
      };
      ws.onerror = () => {
        /* onclose が続く */
      };
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.ws?.readyState === WebSocket.OPEN;
  }

  sendJson(m: ClientMsg): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(m));
  }

  sendBinary(data: Uint8Array): void {
    if (this.isOpen) this.ws!.send(data);
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /** leave を送ってから閉じる。以後 onClose は呼ばない */
  close(): void {
    if (this.closed) return;
    this.sendJson({ type: 'leave' });
    this.closed = true;
    this.ws?.close();
  }
}
