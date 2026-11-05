# Neon Air Hockey

スマホ 2 台で遊ぶ対戦エアホッケー（Web アプリ）。仕様は [docs/SPEC.md](docs/SPEC.md)。

## 現在の状態: M1（1 台で CPU と練習）

- ネオン風 3D テーブル、タッチでマレット操作
- 7 点先取、得点後は失点側から再開、膠着時のリスタート
- 簡易 CPU（弱・中・強）
- 効果音（Web Audio）、振動（Android）、画面スリープ防止
- 設定：CPU の強さ / 視点（3D・真上）/ エフェクト（高・低）/ サウンド
- 動作が重いと自動でエフェクトを「低」に切り替え

## 開発

```bash
npm install
npm run dev          # http://<PCのIP>:5173 を同じ Wi-Fi のスマホで開く
npm run build        # dist/ に本番ビルド
npm run build:artifact   # dist-artifact/neon-air-hockey.html（three は CDN 読み込みの 1 ファイル版）
```

URL に `?debug` を付けると FPS を表示します。

## 構成

```
src/
  shared/   constants.ts（寸法・物理値） physics.ts（物理） game-host.ts（試合進行）
  ai/       cpu.ts（簡易 CPU）
  render/   scene.ts（テーブル等） camera.ts（視点・自動フィット） neon.ts（Bloom） effects.ts（トレイル・火花）
  input.ts  タッチ → テーブル座標
  audio.ts  効果音
  main.ts   画面遷移・メインループ
```

`shared/` は DOM や Three.js に依存しないので、M2 以降はホスト端末でそのまま動かします。
