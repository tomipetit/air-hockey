// ルーム管理の純粋ロジック（ソケット非依存）
import { randomInt as cryptoRandomInt } from 'node:crypto';
import { PROTO_VERSION, ROOM_CODE_RE, type ServerMsg, type SignalData } from '../src/shared/protocol';

export interface Peer {
  readonly id: number;
  send(m: ServerMsg): void;
  sendBinary(d: Uint8Array): void;
}

export interface RoomOptions {
  /** 同時に存在できる部屋数の上限（既定 5000） */
  maxRooms?: number;
  /** 0 以上 n 未満の整数（既定 crypto.randomInt） */
  randomInt?: (n: number) => number;
}

interface Room {
  code: string;
  v: number;
  host: Peer;
  guest: Peer | null;
}

const MAX_RETRY = 50;

export class RoomManager {
  private rooms = new Map<string, Room>();
  private byPeer = new Map<Peer, Room>();
  private maxRooms: number;
  private randomInt: (n: number) => number;

  constructor(opts: RoomOptions = {}) {
    this.maxRooms = opts.maxRooms ?? 5000;
    this.randomInt = opts.randomInt ?? ((n) => cryptoRandomInt(n));
  }

  get size(): number {
    return this.rooms.size;
  }

  /** テスト用：所属している部屋のコード */
  roomOf(p: Peer): string | null {
    return this.byPeer.get(p)?.code ?? null;
  }

  create(p: Peer, v: number): void {
    if (this.byPeer.has(p)) return p.send({ type: 'error', code: 'already_in_room' });
    if (v !== PROTO_VERSION) return p.send({ type: 'error', code: 'version_mismatch' });
    if (this.rooms.size >= this.maxRooms) return p.send({ type: 'error', code: 'server_full' });
    const code = this.newCode();
    if (code === null) return p.send({ type: 'error', code: 'server_full' });
    const room: Room = { code, v, host: p, guest: null };
    this.rooms.set(code, room);
    this.byPeer.set(p, room);
    p.send({ type: 'room_created', code });
  }

  join(p: Peer, code: string, v: number, forceRelay: boolean): void {
    if (this.byPeer.has(p)) return p.send({ type: 'error', code: 'already_in_room' });
    if (!ROOM_CODE_RE.test(code)) return p.send({ type: 'error', code: 'bad_request' });
    if (v !== PROTO_VERSION) return p.send({ type: 'error', code: 'version_mismatch' });
    const room = this.rooms.get(code);
    if (!room) return p.send({ type: 'error', code: 'room_not_found' });
    if (room.v !== v) return p.send({ type: 'error', code: 'version_mismatch' });
    if (room.guest) return p.send({ type: 'error', code: 'room_full' });
    room.guest = p;
    this.byPeer.set(p, room);
    p.send({ type: 'joined', code });
    room.host.send({ type: 'peer_joined', forceRelay });
  }

  /** 相手がいれば signal として転送、いなければ捨てる */
  signal(p: Peer, data: SignalData): void {
    this.other(p)?.send({ type: 'signal', data });
  }

  /** ゲームパケットの中継（そのまま転送） */
  relay(p: Peer, data: Uint8Array): void {
    this.other(p)?.sendBinary(data);
  }

  /** ホストが交渉に失敗したゲストを外す（ゲストには kicked、ゲスト枠は空く）。ホスト以外・ゲスト不在なら何もしない */
  kickGuest(p: Peer): void {
    const room = this.byPeer.get(p);
    if (!room || room.host !== p || !room.guest) return;
    const guest = room.guest;
    room.guest = null;
    this.byPeer.delete(guest);
    guest.send({ type: 'kicked' });
  }

  leave(p: Peer): void {
    const room = this.byPeer.get(p);
    if (!room) return;
    this.byPeer.delete(p);
    if (room.host === p) {
      this.rooms.delete(room.code);
      if (room.guest) {
        this.byPeer.delete(room.guest);
        room.guest.send({ type: 'peer_left' });
      }
    } else if (room.guest === p) {
      room.guest = null;
      room.host.send({ type: 'peer_left' });
    }
  }

  private other(p: Peer): Peer | null {
    const room = this.byPeer.get(p);
    if (!room) return null;
    return room.host === p ? room.guest : room.host;
  }

  private newCode(): string | null {
    for (let i = 0; i < MAX_RETRY; i++) {
      const code = String(this.randomInt(10000)).padStart(4, '0');
      if (!this.rooms.has(code)) return code;
    }
    for (let n = 0; n < 10000; n++) {
      const code = String(n).padStart(4, '0');
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }
}
