import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { TOOL_VERSION } from "../src/core/types";

const MAX_BUNDLE_BYTES = 100 * 1024;

const computeSha256Base64 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("base64");

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
        <td>「この要素を削除」を押すと削除依頼になります。「<strong>外枠へ広げる ↑</strong>」（または <kbd>↑</kbd> / <kbd>↓</kbd> キー）で親ブロック単位に選択範囲を広げてから削除・メモ指示することも可能です。</td>
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

const runBuild = async (): Promise<void> => {
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
    `export const EMBEDDED_VIEWER_SCRIPT = ${JSON.stringify(viewerCode)};`,
    `export const EMBEDDED_VIEWER_SHA256_BASE64 = ${JSON.stringify(viewerHash)};`,
    "",
  ].join("\n");

  await writeFile("./src/viewer/embedded-bundle.ts", embeddedSource, "utf8");

  const mainResult = await build({
    entryPoints: ["./src/index.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    minify: true,
    jsx: "automatic",
    jsxImportSource: "preact",
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

await runBuild();
