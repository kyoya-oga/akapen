import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { type Plugin, build, transform } from "esbuild";
import { TOOL_VERSION } from "../src/core/types";
import { VIEWER_CSS } from "../src/viewer/styles";

const MAX_BUNDLE_BYTES = 100 * 1024;

const computeSha256Base64 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("base64");

// レポート出力時にしか使わないビューアは gzip して埋め込み、ブックマークレット本体を小さく保つ
const gzipToBase64 = (text: string): string =>
  gzipSync(Buffer.from(text, "utf8"), { level: 9 }).toString("base64");

const minifyCss = async (css: string): Promise<string> =>
  (await transform(css, { loader: "css", minify: true })).code.trim();

// UI の CSS はテンプレート文字列のため esbuild の minify が効かない。ビルド時に CSS として圧縮して差し込む
const minifyOverlayCssPlugin: Plugin = {
  name: "minify-overlay-css",
  setup: (pluginBuild) => {
    pluginBuild.onLoad({ filter: /[\\/]src[\\/]ui[\\/]styles\.ts$/ }, async () => {
      const { OVERLAY_CSS } = await import("../src/ui/styles");
      const minified = await minifyCss(OVERLAY_CSS);
      return { contents: `export const OVERLAY_CSS = ${JSON.stringify(minified)};`, loader: "ts" };
    });
  },
};

const generateInstallHtml = (bookmarkletHref: string, bundleBytes: number): string => {
  const sizeKb = (bundleBytes / 1024).toFixed(1);
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>赤ペン（ページ変更依頼ツール）インストール v${TOOL_VERSION}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", sans-serif;
      max-width: 760px;
      margin: 40px auto;
      padding: 0 20px;
      color: #0f172a;
      line-height: 1.65;
    }
    h2 {
      margin-top: 32px;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 6px;
    }
    .hero {
      background: #f8fafc;
      border: 2px dashed #94a3b8;
      border-radius: 12px;
      padding: 28px;
      text-align: center;
      margin: 24px 0;
    }
    .bookmarklet-btn {
      display: inline-block;
      background: #dc2626;
      color: #ffffff;
      font-weight: 700;
      font-size: 16px;
      padding: 12px 28px;
      border-radius: 9999px;
      text-decoration: none;
      box-shadow: 0 4px 12px rgba(220, 38, 38, 0.35);
      cursor: grab;
    }
    .meta {
      font-size: 13px;
      color: #475569;
      margin-top: 12px;
    }
    ol li, ul li {
      margin-bottom: 8px;
    }
    .feature-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      margin: 12px 0;
    }
    .feature-table th, .feature-table td {
      border: 1px solid #cbd5e1;
      padding: 8px 12px;
      text-align: left;
      vertical-align: top;
    }
    .feature-table th {
      background: #f1f5f9;
      width: 28%;
      font-weight: 600;
    }
    code, kbd {
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
  </style>
</head>
<body>
  <h1>赤ペン（ページ変更依頼ツール）</h1>
  <p>Webページの文言・リンク・画像・要素削除・ページ情報（title / OGP）などの変更依頼を、画面を直接クリック＆ドラッグして作成できるブックマークレットです。</p>

  <div class="hero">
    <p><strong>下の赤いボタンをブラウザのブックマークバーへドラッグ＆ドロップしてください</strong></p>
    <a class="bookmarklet-btn" href="${bookmarkletHref}">赤ペン</a>
    <div class="meta">バージョン: v${TOOL_VERSION} / バンドルサイズ: ${sizeKb} KB</div>
  </div>

  <h2>基本的な使い方</h2>
  <ol>
    <li>変更を依頼したいページを開き、ブックマークバーに登録した「<strong>赤ペン</strong>」をクリックします。</li>
    <li>変えたい箇所をクリック（または範囲ドラッグ）すると入力欄が開くので、変更後の文言・リンク先・差し替え画像・メモを入力して <kbd>Enter</kbd>（または「確定」）で保存します。</li>
    <li>同じサイト内の別ページへ移動しても下書きは自動保存されます。番号バッジや素早い一覧（「変更 N件」）からいつでも再編集・削除できます。</li>
    <li>すべての変更箇所の入力が終わったら、ツールバーの「<strong>完了</strong>」を押します。</li>
    <li>チケット貼り付け用の Markdown がクリップボードにコピーされ、単一 HTML レポートがダウンロードされます。チケット本文に貼り付け、HTML ファイルを添付してください。</li>
  </ol>

  <h2>指定できる変更と便利操作</h2>
  <table class="feature-table">
    <tbody>
      <tr>
        <th>文言・リンク先の変更</th>
        <td>要素をクリックして変更後の文言やリンク先 URL（<code>href</code>）を入力します。<kbd>Enter</kbd> で確定、<kbd>Shift</kbd> + <kbd>Enter</kbd> で改行できます（日本語変換確定の Enter では誤確定されません）。</td>
      </tr>
      <tr>
        <th>画像の差し替え</th>
        <td>画像をクリックし、PNG / JPEG / WebP / GIF ファイルを選択・ドロップ・ペースト（<kbd>Ctrl+V</kbd> / <kbd>Cmd+V</kbd>）すると画面上で即座に差し替わります。</td>
      </tr>
      <tr>
        <th>要素・セクションの削除</th>
        <td>「削除を依頼」を押すと削除依頼になります。「<strong>外枠へ広げる ↑</strong>」（または <kbd>↑</kbd> / <kbd>↓</kbd> キー）で親ブロック単位に選択範囲を広げてから削除・メモ指示することも可能です。</td>
      </tr>
      <tr>
        <th>範囲ドラッグ選択</th>
        <td>複数要素にまたがる余白やレイアウトの指示は、画面上をドラッグして四角く囲みメモを残せます。</td>
      </tr>
      <tr>
        <th>ページ情報（Meta / OGP）</th>
        <td>ツールバーの「<strong>ページ情報</strong>」から、<code>title</code> / <code>description</code> / <code>og:title</code> / <code>og:description</code> / <code>og:image</code> の変更を指定できます。</td>
      </tr>
      <tr>
        <th>通常のページ操作（一時停止）</th>
        <td><kbd>Alt</kbd>（Mac は <kbd>Option</kbd>）キーを押している間、またはツールバーの「<strong>一時停止</strong>」中は、メニューやアコーディオン開閉など通常のクリック操作ができます。</td>
      </tr>
      <tr>
        <th>HTML レポートの閲覧・AI 指示コピー</th>
        <td>出力された HTML レポートを開くと、「変更前 / 変更後 / 差分」や「幅 375px（スマホ幅）」の切り替え、原文の検索用コピー、AI コーディングエージェント向けの「<strong>作業指示としてコピー</strong>」が使えます。</td>
      </tr>
    </tbody>
  </table>

  <h2>更新履歴</h2>
  <ul>
    <li>
      <strong>v0.3.0</strong>:
      <ul>
        <li>React などの SPA 上でも、ライブプレビューがページの再描画を壊さず、要素の作り直し後も自動で当て直すように変更</li>
        <li>確定した変更が画面の記録を待たずに即座に一覧・バッジへ反映され、記録中はその旨を表示</li>
        <li>エディタを開いたまま別の要素をクリックすると編集対象が切り替わるように（入力途中なら確認を表示）</li>
        <li>背景画像つきのボタン・見出しでも文言を編集でき、SVG アイコンはアイコン全体を選択するように改善</li>
        <li>ボタン名を「削除を依頼」「この変更を破棄」に変更。文言を空にして確定しても削除にはならず案内を表示</li>
        <li>リセットを一覧内の「すべて破棄してやり直す」へ移動。操作ヒント・下書き復元の通知・バッジの状態説明を追加</li>
        <li>Mac で Option+クリックしたリンクがダウンロードされてしまう問題を修正</li>
        <li>チケット・レポート・画面の番号を #番号 に統一し、AI 向け作業指示の文言を原文のままコードブロックで出力</li>
        <li>外部 CSS・CSS-in-JS のスタイルをレポートに埋め込み、レポートを開いても外部へ一切通信しないよう CSP を強化</li>
        <li>取り消した変更のスナップショット・画像をレポートと下書きから除外</li>
        <li>文脈検索の高速化、スクロール時の再計算削減、スナップショットの使い回し、下書き保存の差分化、レポートの小型化</li>
        <li>個人情報ページ（/mypage など）でスナップショットを撮らない機能を廃止</li>
      </ul>
    </li>
    <li>
      <strong>v0.2.0</strong>:
      <ul>
        <li>ライブプレビュー適用後のアンカー位置維持・同一要素再クリック時の再編集対応</li>
        <li>範囲ドラッグ選択（region）のバッジ再編集およびレポート上の矩形ハイライト表示に対応</li>
        <li>500文字を超える長文要素の全文編集、および複数行インデント要素の前後文脈マッチングを改善</li>
        <li>連続確定時の採番競合防止、画像取得キャッシュ・タイムアウト、未参照アセットのレポート除外を追加</li>
        <li>日本語 IME 変換確定 Enter の誤確定防止、大規模 DOM でのスタック溢れ防止、URL スキーム・CSP 検証を強化</li>
        <li>UI・文言から「指摘」表記を廃止し「変更」「変更箇所」に統一</li>
      </ul>
    </li>
    <li>
      <strong>v0.1.0</strong>: 初回リリース（スナップショット・変更後プレビュー・個人情報除去・AI作業指示出力対応）
    </li>
  </ul>
</body>
</html>`;
};

const EMBEDDED_BUNDLE_PATH = "./src/viewer/embedded-bundle.ts";

// 内容が同じなら書き換えない（pretest / pretypecheck のたびにファイルの更新日時が変わらないように）
const writeFileIfChanged = async (path: string, content: string): Promise<void> => {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current !== content) {
    await writeFile(path, content, "utf8");
  }
};

/**
 * レポート用ビューアをビルドし、本体が import する src/viewer/embedded-bundle.ts を生成する。
 * 生成物は git 管理外のため、型検査・テストの前にも実行する（npm run generate:viewer）
 */
const generateEmbeddedViewer = async (): Promise<void> => {
  const viewerResult = await build({
    entryPoints: ["./src/viewer/index.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    minify: true,
    write: false,
  });

  const viewerOutput = viewerResult.outputFiles[0];
  if (viewerOutput === undefined) {
    throw new Error("Viewer bundle build failed");
  }

  const viewerCode = viewerOutput.text.trim();
  const viewerHash = computeSha256Base64(viewerCode);

  const embeddedSource = [
    `export const EMBEDDED_VIEWER_SCRIPT_GZIP_BASE64 = ${JSON.stringify(gzipToBase64(viewerCode))};`,
    `export const EMBEDDED_VIEWER_SHA256_BASE64 = ${JSON.stringify(viewerHash)};`,
    `export const EMBEDDED_VIEWER_CSS_GZIP_BASE64 = ${JSON.stringify(gzipToBase64(await minifyCss(VIEWER_CSS)))};`,
    "",
  ].join("\n");

  await writeFileIfChanged(EMBEDDED_BUNDLE_PATH, embeddedSource);
};

const runBuild = async (): Promise<void> => {
  await generateEmbeddedViewer();

  const mainResult = await build({
    entryPoints: ["./src/index.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    minify: true,
    jsx: "automatic",
    jsxImportSource: "preact",
    plugins: [minifyOverlayCssPlugin],
    write: false,
  });

  const mainOutput = mainResult.outputFiles[0];
  if (mainOutput === undefined) {
    throw new Error("Main bookmarklet bundle build failed");
  }

  const mainCode = mainOutput.text.trim();
  const bundleBytes = Buffer.byteLength(mainCode, "utf8");

  if (bundleBytes > MAX_BUNDLE_BYTES) {
    throw new Error(
      `Bundle size ${bundleBytes} bytes exceeds 100KB limit (${MAX_BUNDLE_BYTES} bytes)`,
    );
  }

  const bookmarkletHref = `javascript:${encodeURIComponent(mainCode)}`;
  const installHtml = generateInstallHtml(bookmarkletHref, bundleBytes);

  await mkdir("./dist", { recursive: true });
  await writeFile("./dist/bookmarklet.js", mainCode, "utf8");
  await writeFile("./dist/install.html", installHtml, "utf8");
  await writeFile("./install.html", installHtml, "utf8");
};

if (process.argv.includes("--viewer-only")) {
  await generateEmbeddedViewer();
} else {
  await runBuild();
}
