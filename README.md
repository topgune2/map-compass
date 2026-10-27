# 目的地コンパス - Googleマップ共有リンク連携 直線距離＆方角ナビ (PWA)

Googleマップの共有リンク（`https://maps.app.goo.gl/...` 等）から目的地の緯度・経度を取得し、現在地から目的地までの**「直線距離」**と**「方角（矢印）」**をリアルタイムで示すモバイル向けWebアプリ（PWA）です。

iOSのショートカット作成不要で、**Googleマップで「共有」→「コピー」してアプリ内のボタンを1回タップするだけ**（AndroidのPWAインストール時は共有メニューから直接起動も可能）で計測を開始できます。

---

## 主な特徴・実装仕様

1. **「コピーしたリンクから開始」ワンタップボタン（iOS / Android 共通のメイン導線）**
   - ボタンの `onClick` 内で **最優先（同期的）に `DeviceOrientationEvent.requestPermission()`** を呼び出し、iOS Safari の User Activation 制約によるセキュリティブロックを確実に回避します。
   - 並行して `navigator.clipboard.readText()` でクリップボードからGoogleマップの共有文字列を取得し、正規表現 `https?://[^\s]+` でURLのみを抽出して座標へ変換します。
   - 万が一クリップボード読み取りが拒否された場合は、下部の折りたたみ手動入力欄を自動で開いてフォーカスします。

2. **Android向け：PWA & Web Share Target API（共有メニューから直接起動）**
   - Chromeでホーム画面に追加（アプリをインストール）すると、Googleマップの「共有」シートから直接このアプリを起動できます。
   - `?url=...` / `?text=...` / `?q=...` クエリ付きで開かれた際は自動で目的地座標をセット済みの状態で待機し、**「コンパスを有効にして開始」**の1タップだけで計測が始まります。

3. **スリープ防止（Screen Wake Lock API）＆ 前回目的地のワンタップ再開**
   - 計測中は `navigator.wakeLock.request('screen')` を有効化し、移動中にスマホ画面が自動消灯するのを防ぎます。
   - 一度セットした目的地の座標（`lat`, `lng`, `name`）は `localStorage` に自動保存され、次回アクセス時に**「前回の目的地で再開」**ボタンから1タップで再開できます。

---

## ファイル構成

- **そのままGitHub Pagesにアップして動く静的PWA一式（ルート直下）**
  - [`index.html`](file:///c:/WorkSpace/app4/index.html) / [`style.css`](file:///c:/WorkSpace/app4/style.css) / [`app.js`](file:///c:/WorkSpace/app4/app.js) / [`manifest.json`](file:///c:/WorkSpace/app4/manifest.json) / [`sw.js`](file:///c:/WorkSpace/app4/sw.js)
- **Next.js (App Router, TypeScript, Tailwind CSS, Lucide React) 構成一式**
  - [`app/page.tsx`](file:///c:/WorkSpace/app4/app/page.tsx) : フロントエンドコンポーネント
  - [`app/api/resolve-url/route.ts`](file:///c:/WorkSpace/app4/app/api/resolve-url/route.ts) : 短縮URL展開＆座標抽出 API Route
  - [`app/manifest.ts`](file:///c:/WorkSpace/app4/app/manifest.ts) : Web Share Target 対応マニフェスト
  - [`lib/geo.ts`](file:///c:/WorkSpace/app4/lib/geo.ts) : 座標抽出（優先度1〜4）・Haversine距離・方位角計算ロジック
