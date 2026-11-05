// WebSocket シグナリング（/ws）。テキスト = シグナリング JSON、バイナリ = 中継するゲームパケット
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { parseClientMsg, type ServerMsg } from '../src/shared/protocol';
import { RoomManager, type Peer, type RoomOptions } from './rooms';

export const WS_PATH = '/ws';
export const MAX_PAYLOAD = 64 * 1024;
export const MAX_BINARY = 512;
export const HEARTBEAT_MS = 15_000;

export interface SignalingOptions extends RoomOptions {
  heartbeatMs?: number;
}

export interface Signaling {
  readonly wss: WebSocketServer;
  readonly rooms: RoomManager;
  close(): void;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * http サーバーに /ws の WebSocket シグナリングを取り付ける。
 * `GET /healthz`（200 ok）もここで応答する（静的配信の有無に関係なく生存確認できるように）。
 */
export function attachSignaling(server: Server, opts: SignalingOptions = {}): Signaling {
  const rooms = new RoomManager(opts);
  const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: MAX_PAYLOAD });
  let nextId = 1;
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/healthz' || req.url?.startsWith('/healthz?')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
      res.end('ok');
    }
  });

  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    const peer: Peer = {
      id: nextId++,
      send(m: ServerMsg) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
      },
      sendBinary(d: Uint8Array) {
        if (ws.readyState === ws.OPEN) ws.send(d, { binary: true });
      },
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const bytes = toBytes(data);
        if (bytes.byteLength > MAX_BINARY) return;
        rooms.relay(peer, bytes);
        return;
      }
      const msg = parseClientMsg(toBytesString(data));
      if (!msg) return peer.send({ type: 'error', code: 'bad_request' });
      switch (msg.type) {
        case 'create_room':
          rooms.create(peer, msg.v);
          break;
        case 'join_room':
          rooms.join(peer, msg.code, msg.v, msg.forceRelay ?? false);
          break;
        case 'signal':
          rooms.signal(peer, msg.data);
          break;
        case 'leave':
          rooms.leave(peer);
          break;
      }
    });

    ws.on('close', () => rooms.leave(peer));
    ws.on('error', () => {
      /* close が続けて呼ばれる */
    });
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* 無視 */
      }
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref?.();

  const close = () => {
    clearInterval(timer);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
  server.on('close', () => clearInterval(timer));

  return { wss, rooms, close };
}

function toBytesString(data: RawData): string {
  return Buffer.from(toBytes(data)).toString('utf8');
}
