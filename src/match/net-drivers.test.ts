import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HALF_L, MALLET_R, TICK_DT } from '../shared/constants';
import { decode, encode, type GameMsg, type StateMsg } from '../shared/protocol';
import type { NetSession } from '../net/session';
import type { DriverHooks } from './driver';
import { NetGuestDriver } from './net-guest';
import { NetHostDriver } from './net-host';

/** NetHostDriver / NetGuestDriver が使う部分だけの偽 NetSession */
function fakeSession(kind: 'p2p' | 'relay' = 'p2p') {
  const sent: GameMsg[] = [];
  const s = {
    onMessage: null as ((m: GameMsg) => void) | null,
    status: { kind },
    send(m: GameMsg) {
      // 実際の経路と同じくバイナリを通す
      const d = decode(encode(m));
      if (d) sent.push(d);
    },
  };
  return { s, sent, session: s as unknown as NetSession, deliver: (m: GameMsg) => s.onMessage?.(m) };
}

function hooks() {
  const h = { started: 0, peerRematch: 0 };
  const api: DriverHooks = {
    matchStarted: () => h.started++,
    peerWantsRematch: () => h.peerRematch++,
  };
  return { h, api };
}

function runHost(d: NetHostDriver, ticks: number, target: { x: number; z: number } | null = null) {
  const out = [];
  for (let i = 0; i < ticks; i++) out.push(...d.update(TICK_DT + 1e-9, target));
  return out;
}

describe('NetHostDriver', () => {
  it('生成時に match_start（startTick=tickCount）を送り matchStarted を呼ぶ', () => {
    const f = fakeSession();
    const k = hooks();
    const d = new NetHostDriver(f.session, k.api);
    expect(k.h.started).toBe(1);
    expect(f.sent[0]).toEqual({ type: 'match_start', startTick: d.host.tickCount });
    expect(d.localSide).toBe(1);
  });

  it('tick が進んだフレームだけ STATE を送る（最大 60Hz）', () => {
    const f = fakeSession();
    const d = new NetHostDriver(f.session, hooks().api);
    d.update(0.02, null);
    f.sent.length = 0;
    d.update(0.004, null); // tick 進まない
    expect(f.sent.filter((m) => m.type === 'state')).toHaveLength(0);
    d.update(0.02, null);
    const st = f.sent.filter((m) => m.type === 'state') as StateMsg[];
    expect(st).toHaveLength(1);
    expect(st[0].tick).toBe(d.host.tickCount);
    f.sent.length = 0;
    d.update(0.1, null); // 6 tick 進んでも最新 1 回だけ
    expect(f.sent.filter((m) => m.type === 'state')).toHaveLength(1);
  });

  it('EVENT は発生 tick 付きで送り、goal は送らない', () => {
    const f = fakeSession();
    const d = new NetHostDriver(f.session, hooks().api);
    runHost(d, 200);
    const evs = f.sent.filter((m) => m.type === 'event');
    expect(evs.map((e) => e.type === 'event' && e.ev.kind)).toEqual(['countdown', 'countdown', 'countdown', 'start']);
    expect(d.phase).toBe('playing');
    // 得点させる
    const w = d.world;
    w.puck.x = 0;
    w.puck.z = -HALF_L + 0.06;
    w.puck.vx = 0;
    w.puck.vz = -3;
    w.puckActive = true;
    f.sent.length = 0;
    const local = runHost(d, 30);
    expect(local.some((e) => e.type === 'goal')).toBe(true);
    const wire = f.sent.filter((m) => m.type === 'event');
    const score = wire.find((m) => m.type === 'event' && m.ev.kind === 'score');
    expect(score).toMatchObject({ ev: { kind: 'score', scorer: 1, score: [1, 0] } });
    expect(wire.length).toBe(local.filter((e) => e.type !== 'goal').length);
    const st = f.sent.filter((m) => m.type === 'state').pop() as StateMsg;
    expect(st.score).toEqual([1, 0]);
    expect(st.phase).toBe(2);
  });

  describe('P2 の INPUT 検証', () => {
    function setup() {
      const f = fakeSession();
      const d = new NetHostDriver(f.session, hooks().api);
      return { f, d, t: () => d.world.targets[1] };
    }
    it('正常な入力は自陣にクランプして適用', () => {
      const { f, t } = setup();
      f.deliver({ type: 'input', seq: 1, x: 0.2, z: -0.5 });
      expect(t()).toEqual({ x: 0.2, z: -0.5 });
      f.deliver({ type: 'input', seq: 2, x: 0.9, z: 0.8 }); // 相手陣地・壁の外
      expect(t().x).toBeCloseTo(0.5 - MALLET_R, 9);
      expect(t().z).toBeCloseTo(-MALLET_R, 9);
    });
    it.each([
      [NaN, 0],
      [0, NaN],
      [Infinity, 0],
      [0, -Infinity],
      [2.5, -0.5],
      [0, -2.01],
      [-1e9, 0],
    ])('x=%s z=%s は無視（直前の目標のまま）', (x, z) => {
      const { f, t } = setup();
      f.deliver({ type: 'input', seq: 1, x: 0.1, z: -0.3 });
      f.deliver({ type: 'input', seq: 2, x, z });
      expect(t()).toEqual({ x: 0.1, z: -0.3 });
    });
    it('範囲内（|v|≤2）の外側入力はクランプ', () => {
      const { f, t } = setup();
      f.deliver({ type: 'input', seq: 1, x: -2, z: -2 });
      expect(t().x).toBeCloseTo(-(0.5 - MALLET_R), 9);
      expect(t().z).toBeCloseTo(-(HALF_L - MALLET_R), 9);
    });
    it('古い seq（順不同到着）は捨て、ラップアラウンドは新しいとみなす', () => {
      const { f, t, d } = setup();
      f.deliver({ type: 'input', seq: 65534, x: 0.1, z: -0.3 });
      f.deliver({ type: 'input', seq: 65530, x: 0.2, z: -0.3 });
      expect(t().x).toBe(0.1);
      f.deliver({ type: 'input', seq: 65534, x: 0.3, z: -0.3 }); // 同じ seq
      expect(t().x).toBe(0.1);
      f.deliver({ type: 'input', seq: 1, x: 0.25, z: -0.3 }); // 65535 → 0 → 1 を越えた
      expect(t().x).toBe(0.25);
      // ackSeq に反映
      f.sent.length = 0;
      d.update(0.02, null);
      expect((f.sent.find((m) => m.type === 'state') as StateMsg).ackSeq).toBe(1);
    });
    it('P2 の入力は P1 のマレットを動かさない', () => {
      const { f, d } = setup();
      const before = { ...d.world.targets[0] };
      f.deliver({ type: 'input', seq: 1, x: 0.3, z: 0.5 });
      expect(d.world.targets[0]).toEqual(before);
    });
    it('ホスト自身の入力も自陣（P1）にクランプされる', () => {
      const { d } = setup();
      runHost(d, 60, { x: 0, z: -0.9 });
      expect(d.world.mallets[0].z).toBeGreaterThanOrEqual(MALLET_R - 1e-9);
    });
  });

  describe('再戦', () => {
    it('相手→自分の順：peerWantsRematch の後、自分の requestRematch で新しい試合', () => {
      const f = fakeSession();
      const k = hooks();
      const d = new NetHostDriver(f.session, k.api);
      runHost(d, 300);
      const tickBefore = d.host.tickCount;
      d.host.score = [3, 7];
      d.host.phase = 'over';
      f.deliver({ type: 'rematch' });
      expect(k.h.peerRematch).toBe(1);
      expect(k.h.started).toBe(1);
      f.sent.length = 0;
      d.requestRematch();
      expect(k.h.started).toBe(2);
      expect(d.score).toEqual([0, 0]);
      expect(d.phase).toBe('countdown');
      expect(f.sent).toContainEqual({ type: 'rematch' });
      const ms = f.sent.find((m) => m.type === 'match_start');
      expect(ms).toEqual({ type: 'match_start', startTick: tickBefore });
      expect(d.host.tickCount).toBe(tickBefore); // reset で戻らない
    });
    it('自分→相手の順でも再戦が始まる', () => {
      const f = fakeSession();
      const k = hooks();
      const d = new NetHostDriver(f.session, k.api);
      d.requestRematch();
      expect(k.h.started).toBe(1);
      f.deliver({ type: 'rematch' });
      expect(k.h.started).toBe(2);
      expect(k.h.peerRematch).toBe(0);
    });
    it('再戦開始で希望フラグはリセットされる（次の試合で片方だけでは始まらない）', () => {
      const f = fakeSession();
      const k = hooks();
      const d = new NetHostDriver(f.session, k.api);
      d.requestRematch();
      f.deliver({ type: 'rematch' });
      expect(k.h.started).toBe(2);
      f.deliver({ type: 'rematch' });
      expect(k.h.started).toBe(2);
      expect(k.h.peerRematch).toBe(1);
    });
  });

  it('dispose 後は INPUT を無視', () => {
    const f = fakeSession();
    const d = new NetHostDriver(f.session, hooks().api);
    const before = { ...d.world.targets[1] };
    const handler = f.s.onMessage!;
    d.dispose();
    handler({ type: 'input', seq: 1, x: 0.3, z: -0.3 });
    expect(d.world.targets[1]).toEqual(before);
  });
});

describe('NetGuestDriver', () => {
  let now = 0;
  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  const st = (tick: number, over: Partial<StateMsg> = {}): StateMsg => ({
    type: 'state',
    tick,
    phase: 1,
    puckActive: true,
    ackSeq: 0,
    puck: { x: 0, z: tick * 0.001, vx: 0, vz: 0.06 },
    m1: { x: 0.1, z: 0.7 },
    m2: { x: 0, z: -0.7 },
    score: [0, 0],
    ...over,
  });

  function setup(kind: 'p2p' | 'relay' = 'p2p') {
    const f = fakeSession(kind);
    const k = hooks();
    const d = new NetGuestDriver(f.session, k.api, { startTick: 100 });
    return { f, k, d };
  }

  it('生成時に matchStarted、localSide=2', () => {
    const { k, d } = setup();
    expect(k.h.started).toBe(1);
    expect(d.localSide).toBe(2);
  });

  it('target が null なら INPUT を送らない', () => {
    const { f, d } = setup();
    for (let i = 0; i < 10; i++) d.update(TICK_DT, null);
    expect(f.sent.filter((m) => m.type === 'input')).toHaveLength(0);
  });

  it('INPUT はクランプ前の生の target を最大 60Hz で送り、seq は 1 ずつ増える', () => {
    const { f, d } = setup();
    for (let i = 0; i < 120; i++) d.update(1 / 120, { x: 0.9, z: 0.5 }); // 120fps 描画で 1 秒
    const inputs = f.sent.filter((m) => m.type === 'input');
    expect(inputs.length).toBeGreaterThanOrEqual(58);
    expect(inputs.length).toBeLessThanOrEqual(61);
    const first = inputs[0] as { x: number; z: number; seq: number };
    expect(first.seq).toBe(1);
    expect(first.x).toBeCloseTo(0.9, 6);
    expect(first.z).toBeCloseTo(0.5, 6);
    inputs.forEach((m, i) => expect(m.type === 'input' && m.seq).toBe(i + 1));
  });

  it('自マレットはホスト応答を待たずに自陣内で即時移動（m2 で上書きしない）', () => {
    const { f, d } = setup();
    f.deliver(st(101, { m2: { x: -0.3, z: -0.2 } }));
    for (let i = 0; i < 30; i++) {
      now += 1000 / 60;
      d.update(TICK_DT, { x: 0.3, z: 0.5 });
    }
    const m = d.world.mallets[1];
    expect(m.x).toBeCloseTo(0.3, 6);
    expect(m.z).toBeCloseTo(-MALLET_R, 6); // 相手陣地へは出ない
  });

  it('STATE で score / lastStateTick / phase を更新、補間でパックと相手マレットを描く', () => {
    const { f, d } = setup();
    for (let t = 101; t < 160; t++) {
      f.deliver(st(t, { score: [2, 1] }));
      d.update(1 / 60, null);
      now += 1000 / 60;
    }
    expect(d.score).toEqual([2, 1]);
    expect(d.lastStateTick).toBe(159);
    expect(d.phase).toBe('playing');
    expect(d.renderTick).not.toBeNull();
    expect(d.world.puck.z).toBeCloseTo(d.renderTick! * 0.001, 5);
    expect(d.world.mallets[0].x).toBeCloseTo(0.1, 6);
  });

  it('前の試合の STATE（tick ≤ startTick）は無視し、startTick+1 から受理する', () => {
    const { f, d } = setup(); // startTick = 100
    f.deliver(st(50, { score: [5, 5] }));
    expect(d.lastStateTick).toBeNull();
    // tick == startTick は前の試合の最後の STATE（ホストは reset で tickCount を戻さない）
    f.deliver(st(100, { score: [7, 3], phase: 3 }));
    expect(d.lastStateTick).toBeNull();
    expect(d.score).toEqual([0, 0]);
    expect(d.phase).toBeNull();
    expect(d.interp.newest).toBeNull();
    f.deliver(st(101, { phase: 0 }));
    expect(d.lastStateTick).toBe(101);
    expect(d.phase).toBe('countdown');
  });

  it('再戦：match_start{200} の後に遅れて届いた前試合の最終 STATE(200) は無視、201 は受理', () => {
    const { f, d } = setup();
    for (let t = 101; t <= 200; t++) f.deliver(st(t, { score: [7, 2], phase: t === 200 ? 3 : 1 }));
    f.deliver({ type: 'match_start', startTick: 200 });
    // P2P の state チャネルは順不同：前の試合の最後の STATE が match_start の後に届く
    f.deliver(st(200, { score: [7, 2], phase: 3 }));
    expect(d.score).toEqual([0, 0]);
    expect(d.phase).toBeNull();
    expect(d.interp.newest).toBeNull();
    f.deliver(st(201, { score: [0, 0], phase: 0 }));
    expect(d.interp.newest!.tick).toBe(201);
    expect(d.phase).toBe('countdown');
  });

  it('EVENT は補間表示の tick に追いついてから発火する', () => {
    const { f, d } = setup();
    f.deliver(st(101)); // 新しい試合の最初の STATE（startTick+1）
    d.update(0, null); // renderTick = 101 − 2 = 99
    expect(d.renderTick).toBe(99);
    f.deliver({ type: 'event', tick: 103, ev: { kind: 'score', scorer: 1, score: [1, 0] } });
    const fired: number[] = [];
    for (let t = 102; t <= 110; t++) {
      now += 1000 / 60;
      f.deliver(st(t));
      const evs = d.update(1 / 60, null);
      if (evs.some((e) => e.type === 'score')) fired.push(d.renderTick!);
    }
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBeGreaterThanOrEqual(103);
    expect(fired[0]).toBeLessThan(104.5);
  });

  it('STATE が途絶えても EVENT は 250ms 以内に発火する', () => {
    const { f, d } = setup();
    f.deliver(st(101));
    d.update(0, null);
    expect(d.renderTick).toBe(99);
    f.deliver({ type: 'event', tick: 500, ev: { kind: 'over', winner: 2, score: [3, 7] } });
    now += 200;
    expect(d.update(0.2, null)).toHaveLength(0);
    now += 60;
    const evs = d.update(0.06, null);
    expect(evs).toEqual([{ type: 'over', winner: 2, score: [3, 7] }]);
  });

  it('match_start（再戦）で状態を初期化して matchStarted、古い tick を捨てる', () => {
    const { f, k, d } = setup();
    for (let t = 101; t < 130; t++) f.deliver(st(t, { score: [1, 1] }));
    expect(d.score).toEqual([1, 1]);
    f.deliver({ type: 'event', tick: 129, ev: { kind: 'start' } });
    f.deliver({ type: 'match_start', startTick: 200 });
    expect(k.h.started).toBe(2);
    expect(d.score).toEqual([0, 0]);
    expect(d.phase).toBeNull();
    // 古い試合のイベントは出ない
    now += 1000;
    expect(d.update(0.016, null)).toEqual([]);
    f.deliver(st(150, { score: [6, 6] }));
    expect(d.score).toEqual([0, 0]);
  });

  it('rematch 受信で peerWantsRematch、requestRematch は rematch を送るだけ', () => {
    const { f, k, d } = setup();
    f.deliver({ type: 'rematch' });
    expect(k.h.peerRematch).toBe(1);
    d.requestRematch();
    expect(f.sent).toContainEqual({ type: 'rematch' });
    expect(k.h.started).toBe(1);
  });

  it('経路に応じて補間遅延を切り替える（p2p:2 / relay:4）', () => {
    const a = setup('p2p');
    expect(a.d.interp.delayTicks).toBe(2);
    const b = setup('relay');
    expect(b.d.interp.delayTicks).toBe(4);
    b.f.s.status.kind = 'p2p';
    b.d.update(0.016, null);
    expect(b.d.interp.delayTicks).toBe(2);
  });
});
