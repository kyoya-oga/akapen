# 赤ペン（page-change-request）

Web ページの文言・リンク・画像・要素削除・ページ情報（title / meta / OGP）などの変更依頼を、ブラウザ上の画面を直接クリックして作成できるブックマークレットです。

外部サーバーへの通信や拡張機能のインストールは不要で、完了時に **チケット貼り付け用 Markdown** のクリップボードコピーと、**画面スナップショット・変更後プレビュー・AI 向け作業指示を内蔵した単一 HTML レポート** のダウンロードを行います。

---

## 主な機能

### 1. 画面を直接操作する直感的な変更指定
- **文言・リンクの変更**: 要素をクリックしてその場で変更後のテキストやリンク先 URL（`href`）を入力すると、ページ上の表示に即座にライブプレビューされます。
- **画像の差し替え**: 画像要素（`<img>` / `<picture>` / 背景画像）をクリックし、PNG / JPEG / WebP / GIF をドラッグ＆ドロップまたはペーストで添付できます（自動で最大 2000px・WebP に圧縮）。
- **要素・ブロック全体の削除**: 「この要素を削除」ボタン（または文言を空にして確定）で削除指示を記録します。「外枠へ広げる ↑」（`ArrowUp` / `ArrowDown`）で親セクション単位に選択範囲を広げて削除・メモ指示することも可能です。
- **範囲ドラッグ選択**: 複数要素にまたがる余白調整やレイアウト指示は、画面をドラッグして矩形範囲を囲みメモを残せます。
- **ページ情報（Meta / OGP）の変更**: ツールバーの「ページ情報」から `title` / `meta description` / `og:title` / `og:description` / `og:image` の変更依頼を入力できます。
- **操作の一時停止**: `Alt`（Mac は `Option`）キーを押している間、またはツールバーの「一時停止」ボタンで、アコーディオン展開やモーダル表示など通常のページ操作を行えます。
- **自動下書き保存**: 変更内容とスナップショットはブラウザ内の IndexedDB に自動保存されるため、同一オリジン内の別ページへ遷移しながら複数の変更依頼をまとめられます。

### 2. 単一ファイルで完結する HTML レポート & チケット連携
「完了」ボタンを押すと以下の 2 つが同時に出力されます。

1. **チケット用 Markdown（クリップボードに自動コピー）**
   - Redmine や GitHub Issues などにそのまま貼り付けられる変更箇所サマリ。
2. **単一 HTML レポート（`変更依頼_<ページタイトル>_<日時>.html`）**
   - **変更前 / 変更後 / 差分の切り替えプレビュー**: 保存時の DOM・CSS・画像を埋め込んだスナップショット上で、変更前後の状態や文字差分・枠線ハイライトを確認できます。
   - **表示幅の切り替え**: 取得時の画面幅とスマートフォン幅（`375px`）をワンクリックで切り替えられます。
   - **検索用テキストコピー**: 各変更カードから変更前の原文をワンクリックでコピーし、ソースコード検索に使えます。
   - **AI 向け作業指示 Markdown コピー**: 「変更前の文言」「前後の文脈（TextQuote）」「要素タグ・参考セレクタ」を構造化したプロンプトをコピーし、コーディングエージェントへそのまま渡せます。

---

## セキュリティ・プライバシー設計

- **外部送信ゼロ**: すべての処理はブラウザ内で完結し、外部サーバーへデータを送信しません。
- **個人情報・機密情報の自動無害化**:
  - スナップショット取得時に `<input>` / `<textarea>` の入力値や hidden トークン、CSRF メタタグ、`<script>`、インラインイベントハンドラ（`onclick` 等）、`javascript:` URL を自動除去します。
  - `/mypage`・`/account`・`/cart`・`/checkout`・`/orders` などの個人情報ページでは自動的に画面スナップショットの保存をスキップし、テキストの変更内容のみを記録します。
- **安全なレポート閲覧**:
  - 出力される HTML レポートには厳格な `Content-Security-Policy`（`default-src 'none'` + ビューアスクリプトの SHA-256 ハッシュ指定）と `sandbox="allow-same-origin"`（スクリプト実行不可）の iframe を適用しています。

---

## セットアップ・開発コマンド

### 必要環境
- Node.js 20 以上

### インストールとビルド

```bash
npm install
npm run build
```

ビルドを実行すると以下が生成されます。
- `dist/bookmarklet.js`: 単一 IIFE バンドル（100KB 以下）
- `dist/install.html` / `install.html`: ブックマークバーへドラッグ＆ドロップするためのインストールページ

### テスト・品質チェック

```bash
# Biome による Lint・フォーマット検査
npm run check

# TypeScript 型検査
npm run typecheck

# Vitest 単体テスト
npm test

# Playwright 実ブラウザ E2E テスト
npm run test:e2e
```

---

## ディレクトリ構成

```text
├── src/
│   ├── core/               # DOM・ブラウザ API に依存しない純粋ロジック
│   │   ├── anchor.ts       # セレクタ生成・TextQuote（前後文脈）抽出と要素再解決
│   │   ├── change-type.ts  # 変更種別（TEXT_REPLACE / LINK_CHANGE / DELETE 等）の判定
│   │   ├── dom-path.ts     # DOM ツリー経路の計算・解決
│   │   ├── keyboard.ts     # IME 変換中（isComposing / keyCode 229）を考慮した Enter 判定
│   │   ├── markdown.ts     # チケット用 Markdown・AI 作業指示 Markdown 生成
│   │   ├── preview.ts      # 文字単位差分（computeCharDiff）とスナップショット DOM への変更適用
│   │   ├── sanitize.ts     # フォーム値・スクリプト除去、相対 URL の絶対 URL 化、リソース置換
│   │   ├── sha256.ts       # 非 HTTPS / file:// 環境向けの純粋 SHA-256 実装
│   │   ├── state.ts        # アプリケーション状態遷移（純粋 Reducer + Effect 定義）
│   │   ├── types.ts        # 型定義・スキーマ定義
│   │   └── url-safety.ts   # リンク先・属性 URL のスキーム検証
│   ├── shell/              # ブラウザ・DOM・IndexedDB・圧縮などの副作用層
│   │   ├── codec.ts        # Gzip 圧縮/展開（CompressionStream）、Base64、クリップボード
│   │   ├── dom-overlay.ts  # Shadow DOM ホスト構築、矩形計算、要素拡大/縮小
│   │   ├── export-io.ts    # 単一 HTML レポート組み立て（CSP 付与）・ファイルダウンロード
│   │   ├── live-preview.ts # 対象ページのリアルタイム DOM 書き換えとクリーン DOM 復元
│   │   ├── snapshot-io.ts  # クリーン DOM クローン、画像取得・予算管理、添付画像の WebP 変換
│   │   └── storage-idb.ts  # IndexedDB による下書き永続化・有効期限管理
│   ├── ui/                 # ブックマークレットの Shadow DOM 内 Preact UI
│   ├── viewer/             # HTML レポートに埋め込まれるスタンドアロンビューア
│   └── index.ts            # エントリポイント・イベント制御・Effect ランナー
├── scripts/
│   └── build.ts            # Viewer ビルド → SHA-256 算出 → 本体バンドル → install.html 生成
├── tests/                  # 単体テスト（Vitest + happy-dom）
└── e2e/                    # 実ブラウザ E2E テスト（Playwright）
```
