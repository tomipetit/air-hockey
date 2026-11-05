# Neon Air Hockey

スマホ 2 台で遊ぶ対戦エアホッケー（Web アプリ）。仕様は [docs/SPEC.md](docs/SPEC.md)、M2 の詳細設計は [docs/design/M2.md](docs/design/M2.md)。

## 現在の状態: M2（2 台対戦の最小構成）

- 2 台対戦：P1 が「部屋を作る」→ 4 桁コード・QR・招待 URL を表示 → P2 がコード入力 / URL / QR で参加
- 通信：WebRTC DataChannel で P2P 接続（ホスト権威）。5 秒でつながらなければサーバー中継に自動で切り替え
- P2 の自マレットは即時描画、パックと相手マレットは補間（tick 基準）
- 画面上部中央に通信状態（`P2P 12ms` / `中継 45ms` / `通信不安定`）
- 切断・退出・エラー時は理由を表示してタイトルへ（再接続は M4）
- CPU 練習（M1 と同じ）：ネオン風 3D テーブル、7 点先取、CPU の強さ・視点・エフェクト・サウンド設定

## 開発

```bash
npm install
npm run dev            # Vite(:5173) + シグナリング(:8787) を同時起動。PC の Chrome の 2 タブで P1/P2 を確認できる
npm run dev:https      # スマホ実機用（自己署名 HTTPS）。PC と同じ Wi-Fi で https://<PCのIP>:5173 を開き、証明書警告を許可
npm test               # ユニットテスト（vitest）
npm run test:e2e       # ビルド → 本番サーバー起動 → Playwright（Chromium 2 コンテキスト）で 2 台接続
npm run build          # 型チェック（クライアント + サーバー）→ dist/ に本番ビルド
npm start              # 本番構成：dist/ の静的配信と /ws を 1 プロセスで（http://<IP>:8787）
npm run build:artifact # dist-artifact/neon-air-hockey.html（CPU 練習のみ。three は CDN 読み込みの 1 ファイル版）
```

- 実機は `dev:https` 推奨（画面スリープ防止の Wake Lock が HTTPS でしか動かないため）。
- PC のファイアウォールで 5173（本番確認時は 8787）の受信を許可してください。
- 個別起動：`npm run dev:web`（Vite のみ）/ `npm run dev:server`（シグナリングのみ）。
- サーバーの環境変数：`PORT`（既定 8787）、`HOST`（既定 `0.0.0.0`）、`STATIC_DIR`（既定 `dist`。無ければ静的配信なし）。`GET /healthz` は `ok`。
- クライアントのシグナリング先は既定で同一オリジンの `/ws`。別ホストにする場合はビルド時に `VITE_SIGNAL_URL` を指定。

### URL フラグ

| フラグ | 効果 |
|---|---|
| `?debug` | FPS を表示 |
| `?room=1234` | コード入力を飛ばしてその部屋に参加（招待 URL） |
| `?forceRelay` | P2P を試さずサーバー中継で接続（どちらの端末に付けても有効） |
| `?blockIce` | ICE 候補を送受信しない → P2P が確立せず 5 秒後に中継へ自動フォールバック（P1 に付ける） |
| `?e2e` | テスト用フック `window.__ah`（`snapshot()` / `forceGoal(side)`）を有効化し、エフェクトを「低」に固定 |

## 構成

```
src/
  shared/   constants.ts（寸法・物理値） physics.ts（物理） game-host.ts（試合進行）
            protocol.ts（通信メッセージ型・バイナリ encode/decode。サーバーと共用）
  net/      config.ts（定数・URL フラグ） signaling-client.ts（WebSocket）
            webrtc.ts（P2P: DataChannel 2 本） relay.ts（中継） session.ts（接続の状態機械）
  match/    driver.ts（MatchDriver） local-cpu.ts（CPU 練習） net-host.ts（P1） net-guest.ts（P2）
  sync.ts   受信スナップショットの補間
  ui/       hud.ts（HUD 演出・通信状態） lobby.ts（待機・参加・メッセージ画面） qr.ts（QR 描画）
  ai/       cpu.ts（簡易 CPU）
  render/   scene.ts（テーブル等） camera.ts（視点・自動フィット） neon.ts（Bloom） effects.ts（トレイル・火花）
  input.ts  タッチ → テーブル座標
  audio.ts  効果音
  main.ts   画面遷移・メインループ
server/
  main.ts       HTTP（静的配信・/healthz）+ シグナリング
  signaling.ts  /ws の WebSocket（JSON シグナリング・バイナリ中継・ハートビート）
  rooms.ts      ルーム管理（純粋ロジック）
```

`src/shared/` は DOM や Three.js に依存しません（`tsc -p server` で確認）。ネット関連モジュールは動的 import なので、Artifact 版には含まれません。

## 既知の課題（M4 で対応予定）

- P2P 対戦中に一度でもシグナリングの `peer_left` を受けると、その試合の間は 1.5 秒の受信途絶で切断扱いになる（`src/net/session.ts` の `peerLeftAt` が解除されない）。再接続（SPEC 7.5）の実装時に見直す。
- `NetGuestDriver.onMatchStart` が E2E 用の `lastStateTick` をリセットしない（ゲーム表示には影響なし）。
