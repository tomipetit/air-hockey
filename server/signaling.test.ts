import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROTO_VERSION, encode, type ServerMsg } from '../src/shared/protocol';
import { attachSignaling, type Signaling } from './signaling';

/** 受信をキューに貯め、条件に合うものを待てる WebSocket クライアント */
class Client {
  readonly ws: WebSocket;
  readonly json: ServerMsg[] = [];
  readonly bins: Buffer[] = [];
  private waiters: (() => void)[] = [];
  closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) this.bins.push(Buffer.from(data as Buffer));
      else this.json.push(JSON.parse(String(data)) as ServerMsg);
      this.kick();
    });
    this.ws.on('close', () => {
      this.closed = true;
      this.kick();
    });
  }

  private kick() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  open(): Promise<void> {
    return new Promise((res, rej) => {
      if (this.ws.readyState === WebSocket.OPEN) return res();
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
  }

  send(o: unknown) {
    this.ws.send(JSON.stringify(o));
  }

  /** pred に合う JSON を待つ（既に来ていればそれ）。見つかったものはキューから取り除く */
  async next(pred: (m: ServerMsg) => boolean = () => true, ms = 2000): Promise<ServerMsg> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.json.findIndex(pred);
      if (i >= 0) return this.json.splice(i, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting message; got ${JSON.stringify(this.json)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  async nextBin(ms = 2000): Promise<Buffer> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (this.bins.length) return this.bins.shift()!;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timeout waiting binary');
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  async waitClose(ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!this.closed) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timeout waiting close');
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Server;
let sig: Signaling;
let port: number;
let clients: Client[] = [];

async function start(opts: Parameters<typeof attachSignaling>[1] = {}) {
  server = createServer();
  sig = attachSignaling(server, opts);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
}

async function client(path = '/ws'): Promise<Client> {
  const c = new Client(`ws://127.0.0.1:${port}${path}`);
  clients.push(c);
  await c.open();
  return c;
}

async function pair(forceRelay = false) {
  const h = await client();
  h.send({ type: 'create_room', v: PROTO_VERSION });
  const created = await h.next();
  expect(created.type).toBe('room_created');
  const code = (created as { code: string }).code;
  const g = await client();
  g.send({ type: 'join_room', v: PROTO_VERSION, code, forceRelay });
  return { h, g, code };
}

beforeEach(async () => {
  clients = [];
  await start();
});

afterEach(async () => {
  for (const c of clients) c.ws.terminate();
  sig.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('attachSignaling（実ソケット）', () => {
  it('create → join → 双方に通知', async () => {
    const { h, g, code } = await pair(true);
    expect(code).toMatch(/^\d{4}$/);
    expect(await g.next()).toEqual({ type: 'joined', code });
    expect(await h.next()).toEqual({ type: 'peer_joined', forceRelay: true });
    expect(sig.rooms.size).toBe(1);
  });

  it('forceRelay 省略時は peer_joined.forceRelay=false', async () => {
    const h = await client();
    h.send({ type: 'create_room', v: PROTO_VERSION });
    const { code } = (await h.next()) as { code: string };
    const g = await client();
    g.send({ type: 'join_room', v: PROTO_VERSION, code });
    expect(await h.next()).toEqual({ type: 'peer_joined', forceRelay: false });
  });

  it('signal の JSON を相手へ転送（offer/answer/candidate/relay）', async () => {
    const { h, g } = await pair();
    await g.next((m) => m.type === 'joined');
    await h.next((m) => m.type === 'peer_joined');
    h.send({ type: 'signal', data: { kind: 'offer', sdp: 'v=0 offer' } });
    expect(await g.next()).toEqual({ type: 'signal', data: { kind: 'offer', sdp: 'v=0 offer' } });
    g.send({ type: 'signal', data: { kind: 'answer', sdp: 'v=0 answer' } });
    expect(await h.next()).toEqual({ type: 'signal', data: { kind: 'answer', sdp: 'v=0 answer' } });
    const cand = { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    g.send({ type: 'signal', data: { kind: 'candidate', candidate: cand } });
    expect(await h.next()).toEqual({ type: 'signal', data: { kind: 'candidate', candidate: cand } });
    h.send({ type: 'signal', data: { kind: 'relay' } });
    expect(await g.next()).toEqual({ type: 'signal', data: { kind: 'relay' } });
  });

  it('バイナリ 42 byte（STATE）がバイト一致で双方向に転送される', async () => {
    const { h, g } = await pair();
    await g.next((m) => m.type === 'joined');
    const st = encode({
      type: 'state',
      tick: 0x01020304,
      phase: 1,
      puckActive: true,
      ackSeq: 5,
      puck: { x: 0.1, z: 0.2, vx: 0.3, vz: 0.4 },
      m1: { x: 0, z: 0.7 },
      m2: { x: 0, z: -0.7 },
      score: [2, 3],
    });
    expect(st.length).toBe(42);
    h.ws.send(st);
    const got = await g.nextBin();
    expect(got.length).toBe(42);
    expect([...got]).toEqual([...st]);
    const inp = encode({ type: 'input', seq: 9, x: 0.1, z: -0.5 });
    g.ws.send(inp);
    expect([...(await h.nextBin())]).toEqual([...inp]);
  });

  it('512 byte は転送、513 byte は転送されない', async () => {
    const { h, g } = await pair();
    await g.next((m) => m.type === 'joined');
    h.ws.send(new Uint8Array(513).fill(7));
    h.ws.send(new Uint8Array(512).fill(5));
    const got = await g.nextBin();
    expect(got.length).toBe(512);
    expect(got[0]).toBe(5);
    await sleep(100);
    expect(g.bins.length).toBe(0);
  });

  it('不正 JSON・不正メッセージ → error{bad_request}（接続は維持）', async () => {
    const c = await client();
    c.ws.send('{not json');
    expect(await c.next()).toEqual({ type: 'error', code: 'bad_request' });
    c.send({ type: 'create_room' });
    expect(await c.next()).toEqual({ type: 'error', code: 'bad_request' });
    c.send({ type: 'hello' });
    expect(await c.next()).toEqual({ type: 'error', code: 'bad_request' });
    c.send({ type: 'create_room', v: PROTO_VERSION });
    expect((await c.next()).type).toBe('room_created');
  });

  it('room_not_found / room_full / version_mismatch / already_in_room がソケット越しに返る', async () => {
    const { h, g, code } = await pair();
    await g.next((m) => m.type === 'joined');
    const x = await client();
    x.send({ type: 'join_room', v: PROTO_VERSION, code });
    expect(await x.next()).toEqual({ type: 'error', code: 'room_full' });
    x.send({ type: 'join_room', v: PROTO_VERSION, code: code === '0000' ? '0001' : '0000' });
    expect(await x.next()).toEqual({ type: 'error', code: 'room_not_found' });
    x.send({ type: 'create_room', v: PROTO_VERSION + 1 });
    expect(await x.next()).toEqual({ type: 'error', code: 'version_mismatch' });
    h.send({ type: 'create_room', v: PROTO_VERSION });
    expect(await h.next((m) => m.type === 'error')).toEqual({ type: 'error', code: 'already_in_room' });
  });

  it('ゲスト切断でホストに peer_left、同じ部屋に別の人が入れる', async () => {
    const { h, g, code } = await pair();
    await g.next((m) => m.type === 'joined');
    await h.next((m) => m.type === 'peer_joined');
    g.ws.close();
    expect(await h.next()).toEqual({ type: 'peer_left' });
    const g2 = await client();
    g2.send({ type: 'join_room', v: PROTO_VERSION, code });
    expect(await g2.next()).toEqual({ type: 'joined', code });
  });

  it('ゲストの leave でもホストに peer_left', async () => {
    const { h, g } = await pair();
    await g.next((m) => m.type === 'joined');
    await h.next((m) => m.type === 'peer_joined');
    g.send({ type: 'leave' });
    expect(await h.next()).toEqual({ type: 'peer_left' });
  });

  it('ホスト切断でゲストに peer_left、部屋は消える', async () => {
    const { h, g, code } = await pair();
    await g.next((m) => m.type === 'joined');
    h.ws.terminate();
    expect(await g.next()).toEqual({ type: 'peer_left' });
    expect(sig.rooms.size).toBe(0);
    const x = await client();
    x.send({ type: 'join_room', v: PROTO_VERSION, code });
    expect(await x.next()).toEqual({ type: 'error', code: 'room_not_found' });
  });

  it('kick_guest：ゲストに kicked が届き、同じ部屋に別の人が入れる。ゲストからの kick_guest は無視', async () => {
    const { h, g, code } = await pair();
    await g.next((m) => m.type === 'joined');
    await h.next((m) => m.type === 'peer_joined');
    g.send({ type: 'kick_guest' }); // ゲストからは無効
    await sleep(100);
    expect(h.json).toHaveLength(0);
    expect(g.json).toHaveLength(0);
    h.send({ type: 'kick_guest' });
    expect(await g.next()).toEqual({ type: 'kicked' });
    expect(g.closed).toBe(false); // ソケット自体は切らない
    const g2 = await client();
    g2.send({ type: 'join_room', v: PROTO_VERSION, code });
    expect(await g2.next()).toEqual({ type: 'joined', code });
    expect(await h.next()).toEqual({ type: 'peer_joined', forceRelay: false });
    // 外されたゲストの中継パケットはホストに届かない
    g.ws.send(new Uint8Array([1, 2, 3]));
    await sleep(100);
    expect(h.bins).toHaveLength(0);
    // 外されたゲストが切断してもホストに peer_left は来ない
    g.ws.close();
    await sleep(150);
    expect(h.json).toHaveLength(0);
  });

  it('GET /healthz が 200 ok', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/healthz', method: 'GET' }, (r) => {
        let body = '';
        r.on('data', (d) => (body += d));
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('/ws 以外のパスでは WebSocket 接続できない', async () => {
    const c = new Client(`ws://127.0.0.1:${port}/other`);
    clients.push(c);
    await expect(c.open()).rejects.toBeTruthy();
  });

  it('64KiB を超えるテキストは接続ごと切られる（maxPayload）', async () => {
    const c = await client();
    c.ws.send('x'.repeat(64 * 1024 + 10));
    await c.waitClose();
  });
});

describe('ハートビート', () => {
  it('pong を返さないクライアントは terminate される／返すクライアントは残る', async () => {
    // 既定サーバーを閉じて短い周期で立て直す
    for (const c of clients) c.ws.terminate();
    clients = [];
    sig.close();
    await new Promise<void>((r) => server.close(() => r()));
    await start({ heartbeatMs: 80 });

    const good = await client();
    const bad = await client();
    expect(sig.wss.clients.size).toBe(2);
    // bad は受信を止めて ping に pong を返さない（ws クライアントの自動 pong を止める）
    bad.ws.pause();
    const deadline = Date.now() + 2000;
    while (sig.wss.clients.size > 1 && Date.now() < deadline) await sleep(20);
    expect(sig.wss.clients.size).toBe(1);
    await sleep(300); // good は何周期経っても残る
    expect(sig.wss.clients.size).toBe(1);
    expect(good.closed).toBe(false);
  });
});
