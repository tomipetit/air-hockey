import { describe, expect, it } from 'vitest';
import type { GameEvent } from './game-host';
import {
  INPUT_LEN,
  MsgType,
  STATE_LEN,
  channelOf,
  codeToPhase,
  decode,
  encode,
  fromWireEvent,
  parseClientMsg,
  parseServerMsg,
  phaseToCode,
  seqNewer,
  toWireEvent,
  type GameMsg,
  type StateMsg,
  type WireEvent,
} from './protocol';

const state = (over: Partial<StateMsg> = {}): StateMsg => ({
  type: 'state',
  tick: 12345,
  phase: 1,
  puckActive: true,
  ackSeq: 777,
  puck: { x: 0.123, z: -0.456, vx: 3.25, vz: -4.5 },
  m1: { x: -0.2, z: 0.75 },
  m2: { x: 0.3, z: -0.6 },
  score: [3, 6],
  ...over,
});

const events: WireEvent[] = [
  { kind: 'countdown', n: 3 },
  { kind: 'start' },
  { kind: 'score', scorer: 2, score: [1, 4] },
  { kind: 'stall', serveTo: 1 },
  { kind: 'over', winner: 1, score: [7, 5] },
  { kind: 'wall', x: -0.5, z: 0.321, speed: 2.5 },
  { kind: 'mallet', side: 2, x: 0.1, z: -0.7, speed: 4.75 },
];
const EVENT_LEN: Record<WireEvent['kind'], number> = {
  countdown: 7,
  start: 6,
  score: 9,
  stall: 7,
  over: 9,
  wall: 18,
  mallet: 19,
};

/** float は f32 精度なので toBeCloseTo で比較する深い比較 */
function expectClose(actual: unknown, expected: unknown, path = '$'): void {
  if (typeof expected === 'number') {
    expect(typeof actual, path).toBe('number');
    expect(actual as number, path).toBeCloseTo(expected, 5);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((v, i) => expectClose((actual as unknown[])[i], v, `${path}[${i}]`));
  } else if (expected !== null && typeof expected === 'object') {
    expect(actual, path).toBeTypeOf('object');
    expect(Object.keys(actual as object).sort(), path).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) {
      expectClose((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`);
    }
  } else {
    expect(actual, path).toBe(expected);
  }
}

const allMsgs: GameMsg[] = [
  state(),
  state({ phase: 0, puckActive: false, tick: 0, ackSeq: 0, score: [0, 0] }),
  state({ phase: 3, tick: 0xffffffff, ackSeq: 0xffff, score: [7, 255] }),
  { type: 'input', seq: 65535, x: -0.43, z: -0.91 },
  { type: 'input', seq: 0, x: 0, z: 0 },
  ...events.map((ev, i): GameMsg => ({ type: 'event', tick: 1000 + i, ev })),
  { type: 'match_start', startTick: 4242 },
  { type: 'ready', v: 1 },
  { type: 'rematch' },
  { type: 'bye' },
  { type: 'ping', t: 123456.789012 },
  { type: 'pong', t: 0.5 },
];

describe('encode/decode 往復', () => {
  it.each(allMsgs.map((m) => [m.type + ('ev' in m ? `:${m.ev.kind}` : ''), m] as const))('%s', (_n, m) => {
    const bytes = encode(m);
    const back = decode(bytes);
    expect(back).not.toBeNull();
    expectClose(back, m);
  });

  it('ArrayBuffer でも Uint8Array（オフセット付き）でも decode できる', () => {
    const bytes = encode(state());
    expectClose(decode(bytes.slice().buffer), state());
    const big = new Uint8Array(bytes.length + 10);
    big.set(bytes, 7);
    expectClose(decode(big.subarray(7, 7 + bytes.length)), state());
  });

  it('ping の t は f64 で正確に往復する', () => {
    const t = 98765.43210987654;
    const m = decode(encode({ type: 'ping', t }));
    expect(m).toEqual({ type: 'ping', t });
  });
});

describe('長さ', () => {
  it('STATE=42 / INPUT=11', () => {
    expect(STATE_LEN).toBe(42);
    expect(INPUT_LEN).toBe(11);
    expect(encode(state()).length).toBe(42);
    expect(encode({ type: 'input', seq: 1, x: 0, z: 0 }).length).toBe(11);
  });
  it.each(events.map((e) => [e.kind, e] as const))('EVENT %s の全長', (kind, ev) => {
    expect(encode({ type: 'event', tick: 1, ev }).length).toBe(EVENT_LEN[kind]);
  });
  it('その他', () => {
    expect(encode({ type: 'match_start', startTick: 1 }).length).toBe(5);
    expect(encode({ type: 'ready', v: 1 }).length).toBe(2);
    expect(encode({ type: 'rematch' }).length).toBe(1);
    expect(encode({ type: 'bye' }).length).toBe(1);
    expect(encode({ type: 'ping', t: 1 }).length).toBe(9);
    expect(encode({ type: 'pong', t: 1 }).length).toBe(9);
  });
  it('先頭バイトが type 値', () => {
    expect(encode(state())[0]).toBe(MsgType.State);
    expect(encode({ type: 'input', seq: 1, x: 0, z: 0 })[0]).toBe(MsgType.Input);
    expect(encode({ type: 'event', tick: 1, ev: { kind: 'start' } })[0]).toBe(MsgType.Event);
    expect(encode({ type: 'match_start', startTick: 1 })[0]).toBe(MsgType.MatchStart);
    expect(encode({ type: 'ready', v: 1 })[0]).toBe(MsgType.Ready);
    expect(encode({ type: 'rematch' })[0]).toBe(MsgType.Rematch);
    expect(encode({ type: 'bye' })[0]).toBe(MsgType.Bye);
    expect(encode({ type: 'ping', t: 1 })[0]).toBe(MsgType.Ping);
    expect(encode({ type: 'pong', t: 1 })[0]).toBe(MsgType.Pong);
  });
});

describe('バイト配置', () => {
  it('リトルエンディアン：tick=0x01020304 の STATE の byte[2..5] が 04 03 02 01', () => {
    const b = encode(state({ tick: 0x01020304 }));
    expect([...b.slice(2, 6)]).toEqual([0x04, 0x03, 0x02, 0x01]);
  });
  it('ackSeq は off 6 の u16 LE、スコアは off 40/41', () => {
    const b = encode(state({ ackSeq: 0xabcd, score: [5, 6] }));
    expect([b[6], b[7]]).toEqual([0xcd, 0xab]);
    expect(b[40]).toBe(5);
    expect(b[41]).toBe(6);
  });
  it('f32 の位置（puck.x=off8, m2.z=off36）', () => {
    const b = encode(state({ puck: { x: 1.5, z: 0, vx: 0, vz: 0 }, m2: { x: 0, z: -0.25 } }));
    const dv = new DataView(b.buffer);
    expect(dv.getFloat32(8, true)).toBe(1.5);
    expect(dv.getFloat32(36, true)).toBe(-0.25);
  });
  it('flags：bit0=puckActive、bit1-2=phase、他は 0', () => {
    for (const phase of [0, 1, 2, 3] as const) {
      for (const puckActive of [false, true]) {
        const f = encode(state({ phase, puckActive }))[1];
        expect(f & 1).toBe(puckActive ? 1 : 0);
        expect((f >> 1) & 3).toBe(phase);
        expect(f & ~7).toBe(0);
        const d = decode(encode(state({ phase, puckActive }))) as StateMsg;
        expect(d.phase).toBe(phase);
        expect(d.puckActive).toBe(puckActive);
      }
    }
  });
  it('INPUT：seq は off1 u16 LE、x/z は off3/off7', () => {
    const b = encode({ type: 'input', seq: 0x1234, x: 0.5, z: -1 });
    const dv = new DataView(b.buffer);
    expect([b[1], b[2]]).toEqual([0x34, 0x12]);
    expect(dv.getFloat32(3, true)).toBe(0.5);
    expect(dv.getFloat32(7, true)).toBe(-1);
  });
  it('EVENT：tick は off1 u32 LE、kind は off5', () => {
    const b = encode({ type: 'event', tick: 0x0a0b0c0d, ev: { kind: 'mallet', side: 1, x: 0, z: 0, speed: 1 } });
    expect([...b.slice(1, 5)]).toEqual([0x0d, 0x0c, 0x0b, 0x0a]);
    expect(b[5]).toBe(7);
    expect(b[6]).toBe(1);
  });
});

describe('不正な入力の拒否', () => {
  const corrupt = (m: GameMsg, f: (b: Uint8Array, dv: DataView) => void) => {
    const b = encode(m);
    f(b, new DataView(b.buffer));
    return decode(b);
  };
  it('空・未知 type', () => {
    expect(decode(new Uint8Array(0))).toBeNull();
    expect(decode(new Uint8Array([0x00]))).toBeNull();
    expect(decode(new Uint8Array([0x0a]))).toBeNull();
    expect(decode(new Uint8Array([0xff, 0, 0, 0, 0]))).toBeNull();
  });
  it.each(allMsgs.map((m) => [m.type + ('ev' in m ? `:${m.ev.kind}` : ''), m] as const))(
    '%s：1 バイト短い・長いと null',
    (_n, m) => {
      const b = encode(m);
      if (b.length > 1) expect(decode(b.subarray(0, b.length - 1))).toBeNull();
      const longer = new Uint8Array(b.length + 1);
      longer.set(b);
      expect(decode(longer)).toBeNull();
    },
  );
  it('EVENT：未知 kind（0, 8, 255）', () => {
    for (const k of [0, 8, 255]) {
      expect(corrupt({ type: 'event', tick: 1, ev: { kind: 'countdown', n: 1 } }, (b) => (b[5] = k))).toBeNull();
    }
  });
  it('EVENT：kind と長さの不一致（start 長で score の kind）', () => {
    expect(corrupt({ type: 'event', tick: 1, ev: { kind: 'start' } }, (b) => (b[5] = 3))).toBeNull();
  });
  it('EVENT：短すぎる（kind が読めない）', () => {
    expect(decode(new Uint8Array([MsgType.Event, 0, 0, 0, 0]))).toBeNull();
  });
  it.each([0, 3, 255])('side/scorer/winner/serveTo = %i は null', (v) => {
    expect(corrupt({ type: 'event', tick: 1, ev: { kind: 'score', scorer: 1, score: [1, 0] } }, (b) => (b[6] = v))).toBeNull();
    expect(corrupt({ type: 'event', tick: 1, ev: { kind: 'stall', serveTo: 1 } }, (b) => (b[6] = v))).toBeNull();
    expect(corrupt({ type: 'event', tick: 1, ev: { kind: 'over', winner: 1, score: [7, 0] } }, (b) => (b[6] = v))).toBeNull();
    expect(
      corrupt({ type: 'event', tick: 1, ev: { kind: 'mallet', side: 1, x: 0, z: 0, speed: 1 } }, (b) => (b[6] = v)),
    ).toBeNull();
  });
  it.each([NaN, Infinity, -Infinity])('INPUT の x/z = %s は null', (v) => {
    expect(decode(encode({ type: 'input', seq: 1, x: v, z: 0 }))).toBeNull();
    expect(decode(encode({ type: 'input', seq: 1, x: 0, z: v }))).toBeNull();
  });
  it('STATE の各 float に NaN が入ると null', () => {
    for (let off = 8; off < 40; off += 4) {
      expect(corrupt(state(), (_b, dv) => dv.setFloat32(off, NaN, true))).toBeNull();
    }
  });
  it('wall / mallet の float に Infinity が入ると null', () => {
    expect(corrupt({ type: 'event', tick: 1, ev: events[5] }, (_b, dv) => dv.setFloat32(14, Infinity, true))).toBeNull();
    expect(corrupt({ type: 'event', tick: 1, ev: events[6] }, (_b, dv) => dv.setFloat32(7, NaN, true))).toBeNull();
  });
  it('PING/PONG の t が非有限なら null', () => {
    expect(decode(encode({ type: 'ping', t: NaN }))).toBeNull();
    expect(decode(encode({ type: 'pong', t: Infinity }))).toBeNull();
  });
});

describe('seqNewer（u16 ラップアラウンド）', () => {
  it.each([
    [1, 0, true],
    [0, 1, false],
    [0, 65535, true],
    [65535, 0, false],
    [5, 5, false],
    [100, 65500, true],
    [0x8000, 0, false], // 差がちょうど半周は「新しくない」
    [0x7fff, 0, true],
  ])('seqNewer(%i, %i) = %s', (a, b, want) => {
    expect(seqNewer(a, b)).toBe(want);
  });
});

describe('channelOf', () => {
  it('state/input/ping/pong は unreliable、それ以外は reliable', () => {
    for (const m of allMsgs) {
      const want = ['state', 'input', 'ping', 'pong'].includes(m.type) ? 'unreliable' : 'reliable';
      expect(channelOf(m), m.type).toBe(want);
    }
  });
});

describe('toWireEvent / fromWireEvent', () => {
  it("goal は null（送らない）", () => {
    expect(toWireEvent({ type: 'goal', scorer: 1 })).toBeNull();
  });
  it('他は往復で元に戻る（バイナリ経由も含む）', () => {
    const evs: GameEvent[] = [
      { type: 'countdown', n: 2 },
      { type: 'start' },
      { type: 'score', scorer: 1, score: [3, 2] },
      { type: 'stall', serveTo: 2 },
      { type: 'over', winner: 2, score: [4, 7] },
      { type: 'wall', x: 0.5, z: 0.25, speed: 1.5 },
      { type: 'mallet', side: 1, x: 0.25, z: 0.5, speed: 3 },
    ];
    for (const ev of evs) {
      const w = toWireEvent(ev);
      expect(w).not.toBeNull();
      expect(fromWireEvent(w!)).toEqual(ev);
      const d = decode(encode({ type: 'event', tick: 9, ev: w! }));
      expect(d && d.type === 'event' && fromWireEvent(d.ev)).toEqual(ev);
    }
  });
  it('score 配列は複製される（GameHost の配列と共有しない）', () => {
    const score: [number, number] = [1, 2];
    const w = toWireEvent({ type: 'score', scorer: 1, score })!;
    score[0] = 99;
    expect(w.kind === 'score' && w.score[0]).toBe(1);
  });
});

describe('phase 変換', () => {
  it('countdown/playing/goal/over ⇄ 0..3', () => {
    (['countdown', 'playing', 'goal', 'over'] as const).forEach((p, i) => {
      expect(phaseToCode(p)).toBe(i);
      expect(codeToPhase(i as 0 | 1 | 2 | 3)).toBe(p);
    });
  });
});

describe('シグナリング JSON の検証', () => {
  it('parseClientMsg：正常系', () => {
    expect(parseClientMsg('{"type":"create_room","v":1}')).toEqual({ type: 'create_room', v: 1 });
    expect(parseClientMsg('{"type":"join_room","v":1,"code":"0123","forceRelay":true}')).toEqual({
      type: 'join_room',
      v: 1,
      code: '0123',
      forceRelay: true,
    });
    expect(parseClientMsg('{"type":"leave"}')).toEqual({ type: 'leave' });
    expect(parseClientMsg('{"type":"signal","data":{"kind":"offer","sdp":"x"}}')).toEqual({
      type: 'signal',
      data: { kind: 'offer', sdp: 'x' },
    });
    expect(
      parseClientMsg('{"type":"signal","data":{"kind":"candidate","candidate":{"candidate":"c","sdpMid":"0","sdpMLineIndex":0}}}'),
    ).toEqual({ type: 'signal', data: { kind: 'candidate', candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } } });
    expect(parseClientMsg('{"type":"signal","data":{"kind":"relay"}}')).toEqual({ type: 'signal', data: { kind: 'relay' } });
  });
  it.each([
    'not json',
    '[]',
    'null',
    '"str"',
    '{}',
    '{"type":"create_room"}',
    '{"type":"create_room","v":"1"}',
    '{"type":"create_room","v":1.5}',
    '{"type":"join_room","v":1}',
    '{"type":"join_room","v":1,"code":1234}',
    '{"type":"join_room","v":1,"code":"1234","forceRelay":"yes"}',
    '{"type":"signal"}',
    '{"type":"signal","data":{"kind":"offer"}}',
    '{"type":"signal","data":{"kind":"bogus"}}',
    '{"type":"signal","data":{"kind":"candidate","candidate":{"candidate":"c","sdpMLineIndex":"0"}}}',
    '{"type":"room_created","code":"1234"}',
  ])('parseClientMsg(%s) は null', (s) => {
    expect(parseClientMsg(s)).toBeNull();
  });
  it('parseClientMsg：巨大な SDP は拒否', () => {
    const sdp = 'a'.repeat(40 * 1024);
    expect(parseClientMsg(JSON.stringify({ type: 'signal', data: { kind: 'offer', sdp } }))).toBeNull();
  });
  it('parseServerMsg', () => {
    expect(parseServerMsg('{"type":"room_created","code":"0042"}')).toEqual({ type: 'room_created', code: '0042' });
    expect(parseServerMsg('{"type":"room_created","code":"42"}')).toBeNull();
    expect(parseServerMsg('{"type":"peer_joined","forceRelay":false}')).toEqual({ type: 'peer_joined', forceRelay: false });
    expect(parseServerMsg('{"type":"peer_joined"}')).toBeNull();
    expect(parseServerMsg('{"type":"error","code":"room_full"}')).toEqual({ type: 'error', code: 'room_full' });
    expect(parseServerMsg('{"type":"error","code":"nope"}')).toBeNull();
    expect(parseServerMsg('{"type":"peer_left"}')).toEqual({ type: 'peer_left' });
  });
});

describe('kick_guest / kicked（中継失敗時のゲスト枠解放）', () => {
  it('parseClientMsg が kick_guest を受理', () => {
    expect(parseClientMsg('{"type":"kick_guest"}')).toEqual({ type: 'kick_guest' });
  });
  it('parseServerMsg が kicked を受理', () => {
    expect(parseServerMsg('{"type":"kicked"}')).toEqual({ type: 'kicked' });
  });
  it('逆方向（クライアントからの kicked・サーバーからの kick_guest）は不正', () => {
    expect(parseClientMsg('{"type":"kicked"}')).toBeNull();
    expect(parseServerMsg('{"type":"kick_guest"}')).toBeNull();
  });
});
