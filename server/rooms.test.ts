import { describe, expect, it } from 'vitest';
import { PROTO_VERSION, type ServerMsg } from '../src/shared/protocol';
import { RoomManager, type Peer } from './rooms';

interface FakePeer extends Peer {
  msgs: ServerMsg[];
  bins: Uint8Array[];
  last(): ServerMsg | undefined;
}

let nextId = 1;
function peer(): FakePeer {
  const p: FakePeer = {
    id: nextId++,
    msgs: [],
    bins: [],
    send(m) {
      p.msgs.push(m);
    },
    sendBinary(d) {
      p.bins.push(d);
    },
    last() {
      return p.msgs[p.msgs.length - 1];
    },
  };
  return p;
}

const V = PROTO_VERSION;

function createdCode(p: FakePeer): string {
  const m = p.last();
  if (m?.type !== 'room_created') throw new Error(`room_created でない: ${JSON.stringify(m)}`);
  return m.code;
}

describe('RoomManager.create', () => {
  it('4 桁の文字列で room_created を返す', () => {
    const rm = new RoomManager();
    const h = peer();
    rm.create(h, V);
    const code = createdCode(h);
    expect(code).toMatch(/^\d{4}$/);
    expect(rm.size).toBe(1);
    expect(rm.roomOf(h)).toBe(code);
  });

  it('連続作成でコードが重複しない', () => {
    const rm = new RoomManager();
    const codes = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const h = peer();
      rm.create(h, V);
      codes.add(createdCode(h));
    }
    expect(codes.size).toBe(300);
    expect(rm.size).toBe(300);
  });

  it('randomInt が小さい数を返しても 4 桁にゼロ埋めする', () => {
    const rm = new RoomManager({ randomInt: () => 7 });
    const h = peer();
    rm.create(h, V);
    expect(createdCode(h)).toBe('0007');
  });

  it('コード衝突時は再抽選する', () => {
    const seq = [1234, 1234, 1234, 4321];
    let i = 0;
    const calls: number[] = [];
    const rm = new RoomManager({
      randomInt: (n) => {
        calls.push(n);
        return seq[Math.min(i++, seq.length - 1)];
      },
    });
    const a = peer();
    const b = peer();
    rm.create(a, V);
    rm.create(b, V);
    expect(createdCode(a)).toBe('1234');
    expect(createdCode(b)).toBe('4321');
    expect(calls.every((n) => n === 10000)).toBe(true);
    expect(calls.length).toBe(4);
  });

  it('50 回再抽選しても空かなければ 0000 から線形探索', () => {
    let calls = 0;
    const rm = new RoomManager({
      randomInt: () => {
        calls++;
        return 0;
      },
    });
    const peers = [peer(), peer(), peer()];
    for (const p of peers) rm.create(p, V);
    expect(peers.map(createdCode)).toEqual(['0000', '0001', '0002']);
    // 1 部屋目 1 回 + 2 部屋目 50 回 + 3 部屋目 50 回
    expect(calls).toBe(101);
  });

  it('maxRooms=2 で 3 部屋目は server_full', () => {
    const rm = new RoomManager({ maxRooms: 2 });
    const [a, b, c] = [peer(), peer(), peer()];
    rm.create(a, V);
    rm.create(b, V);
    rm.create(c, V);
    expect(c.last()).toEqual({ type: 'error', code: 'server_full' });
    expect(rm.size).toBe(2);
    expect(rm.roomOf(c)).toBeNull();
    // 1 部屋消えれば作れる
    rm.leave(a);
    rm.create(c, V);
    expect(c.last()?.type).toBe('room_created');
  });

  it('v 不一致は version_mismatch', () => {
    const rm = new RoomManager();
    const h = peer();
    rm.create(h, V + 1);
    expect(h.last()).toEqual({ type: 'error', code: 'version_mismatch' });
    expect(rm.size).toBe(0);
  });

  it('二重作成は already_in_room', () => {
    const rm = new RoomManager();
    const h = peer();
    rm.create(h, V);
    rm.create(h, V);
    expect(h.last()).toEqual({ type: 'error', code: 'already_in_room' });
    expect(rm.size).toBe(1);
  });
});

describe('RoomManager.join', () => {
  function setup(opts?: ConstructorParameters<typeof RoomManager>[0]) {
    const rm = new RoomManager(opts);
    const h = peer();
    rm.create(h, V);
    return { rm, h, code: createdCode(h) };
  }

  it('成功：ゲストに joined、ホストに peer_joined{forceRelay}', () => {
    for (const fr of [false, true]) {
      const { rm, h, code } = setup();
      const g = peer();
      rm.join(g, code, V, fr);
      expect(g.last()).toEqual({ type: 'joined', code });
      expect(h.last()).toEqual({ type: 'peer_joined', forceRelay: fr });
      expect(rm.roomOf(g)).toBe(code);
    }
  });

  it('存在しないコードは room_not_found', () => {
    const { rm, code } = setup();
    const g = peer();
    const other = code === '9999' ? '9998' : '9999';
    rm.join(g, other, V, false);
    expect(g.last()).toEqual({ type: 'error', code: 'room_not_found' });
    expect(rm.roomOf(g)).toBeNull();
  });

  it('3 人目は room_full（ホストには何も届かない）', () => {
    const { rm, h, code } = setup();
    const g = peer();
    const x = peer();
    rm.join(g, code, V, false);
    const before = h.msgs.length;
    rm.join(x, code, V, false);
    expect(x.last()).toEqual({ type: 'error', code: 'room_full' });
    expect(h.msgs.length).toBe(before);
    expect(rm.roomOf(x)).toBeNull();
  });

  it.each(['123', '12345', 'abcd', '12a4', '', ' 123', '１２３４'])('形式不正 %j は bad_request', (bad) => {
    const { rm } = setup();
    const g = peer();
    rm.join(g, bad, V, false);
    expect(g.last()).toEqual({ type: 'error', code: 'bad_request' });
  });

  it('v 不一致は version_mismatch', () => {
    const { rm, h, code } = setup();
    const g = peer();
    rm.join(g, code, V + 1, false);
    expect(g.last()).toEqual({ type: 'error', code: 'version_mismatch' });
    expect(h.last()?.type).toBe('room_created');
  });

  it('二重所属は already_in_room（ホストが別の部屋に join・ゲストが再 join・ゲストが create）', () => {
    const { rm, h, code } = setup();
    const h2 = peer();
    rm.create(h2, V);
    const code2 = createdCode(h2);
    rm.join(h, code2, V, false);
    expect(h.last()).toEqual({ type: 'error', code: 'already_in_room' });

    const g = peer();
    rm.join(g, code, V, false);
    rm.join(g, code2, V, false);
    expect(g.last()).toEqual({ type: 'error', code: 'already_in_room' });
    rm.create(g, V);
    expect(g.last()).toEqual({ type: 'error', code: 'already_in_room' });
    expect(rm.size).toBe(2);
  });
});

describe('RoomManager.signal / relay', () => {
  function pair() {
    const rm = new RoomManager();
    const h = peer();
    rm.create(h, V);
    const code = createdCode(h);
    const g = peer();
    rm.join(g, code, V, false);
    return { rm, h, g, code };
  }

  it('signal は相手にだけ届く', () => {
    const { rm, h, g } = pair();
    const outsider = peer();
    rm.create(outsider, V);
    const n = outsider.msgs.length;
    rm.signal(h, { kind: 'offer', sdp: 'SDP-O' });
    expect(g.last()).toEqual({ type: 'signal', data: { kind: 'offer', sdp: 'SDP-O' } });
    rm.signal(g, { kind: 'answer', sdp: 'SDP-A' });
    expect(h.last()).toEqual({ type: 'signal', data: { kind: 'answer', sdp: 'SDP-A' } });
    expect(outsider.msgs.length).toBe(n);
  });

  it('relay は相手にだけ同じバイト列で届く', () => {
    const { rm, h, g } = pair();
    const data = new Uint8Array([1, 2, 3, 4]);
    rm.relay(g, data);
    expect(h.bins).toHaveLength(1);
    expect([...h.bins[0]]).toEqual([1, 2, 3, 4]);
    expect(g.bins).toHaveLength(0);
    rm.relay(h, new Uint8Array([9]));
    expect([...g.bins[0]]).toEqual([9]);
  });

  it('相手不在（ゲスト未参加・未所属）なら捨てる', () => {
    const rm = new RoomManager();
    const h = peer();
    rm.create(h, V);
    const n = h.msgs.length;
    rm.signal(h, { kind: 'relay' });
    rm.relay(h, new Uint8Array([1]));
    expect(h.msgs.length).toBe(n);
    expect(h.bins).toHaveLength(0);
    const stranger = peer();
    expect(() => rm.signal(stranger, { kind: 'relay' })).not.toThrow();
    expect(() => rm.relay(stranger, new Uint8Array([1]))).not.toThrow();
  });
});

describe('RoomManager.leave', () => {
  it('ホスト退出で部屋削除＋ゲストに peer_left。ゲストは所属なしに戻る', () => {
    const rm = new RoomManager();
    const h = peer();
    rm.create(h, V);
    const code = createdCode(h);
    const g = peer();
    rm.join(g, code, V, false);
    rm.leave(h);
    expect(g.last()).toEqual({ type: 'peer_left' });
    expect(rm.size).toBe(0);
    expect(rm.roomOf(h)).toBeNull();
    expect(rm.roomOf(g)).toBeNull();
    // 元ゲストは新しい部屋を作れる
    rm.create(g, V);
    expect(g.last()?.type).toBe('room_created');
    // 削除された部屋には入れない（別コードが当たった場合）
    const x = peer();
    if (createdCode(g) !== code) {
      rm.join(x, code, V, false);
      expect(x.last()).toEqual({ type: 'error', code: 'room_not_found' });
    }
  });

  it('ゲスト退出でホストに peer_left、部屋は残り別の人が join できる', () => {
    const rm = new RoomManager();
    const h = peer();
    rm.create(h, V);
    const code = createdCode(h);
    const g = peer();
    rm.join(g, code, V, false);
    rm.leave(g);
    expect(h.last()).toEqual({ type: 'peer_left' });
    expect(rm.size).toBe(1);
    expect(rm.roomOf(g)).toBeNull();
    const g2 = peer();
    rm.join(g2, code, V, true);
    expect(g2.last()).toEqual({ type: 'joined', code });
    expect(h.last()).toEqual({ type: 'peer_joined', forceRelay: true });
    // 退出したゲストの signal はもう届かない
    const n = h.msgs.length;
    rm.signal(g, { kind: 'relay' });
    expect(h.msgs.length).toBe(n);
  });

  it('ゲストなしのホスト退出・未所属の leave・二重 leave は安全', () => {
    const rm = new RoomManager();
    const h = peer();
    rm.create(h, V);
    rm.leave(h);
    expect(rm.size).toBe(0);
    expect(() => rm.leave(h)).not.toThrow();
    expect(() => rm.leave(peer())).not.toThrow();
  });

  it('退出したホストのコードは再利用できる', () => {
    const rm = new RoomManager({ randomInt: () => 4242 });
    const a = peer();
    rm.create(a, V);
    rm.leave(a);
    const b = peer();
    rm.create(b, V);
    expect(createdCode(b)).toBe('4242');
  });
});
