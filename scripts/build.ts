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
      max-width: 720px;
      margin: 40px auto;
      padding: 0 20px;
      color: #0f172a;
      line-height: 1.6;
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
      padding: 12px 24px;
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
    ol li {
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <h1>赤ペン（ページ変更依頼ツール）</h1>
  <p>Webページの文言・リンク・画像・削除などの変更依頼を、画面を直接クリックして作成するブックマークレットです。</p>

  <div class="hero">
    <p><strong>下の赤いボタンをブラウザのブックマークバーへドラッグ＆ドロップしてください</strong></p>
    <a class="bookmarklet-btn" href="${bookmarkletHref}">赤ペン v${TOOL_VERSION}</a>
    <div class="meta">バージョン: v${TOOL_VERSION} / バンドルサイズ: ${sizeKb} KB</div>
  </div>

  <h2>使い方</h2>
  <ol>
    <li>変更を依頼したいページを開き、ブックマークバーに登録した「<strong>赤ペン v${TOOL_VERSION}</strong>」をクリックします。</li>
    <li>変えたい箇所をクリック（または範囲ドラッグ）すると入力欄が出るので、変更後の文言やメモを入力して Enter で確定します。</li>
    <li>すべての指摘が終わったら、バーの「<strong>完了</strong>」を押します。</li>
    <li>Redmine チケット用の Markdown がクリップボードにコピーされ、詳細 HTML レポートがダウンロードされます。チケットに貼り付け＆HTMLファイルを添付してください。</li>
  </ol>

  <h2>更新履歴</h2>
  <ul>
    <li><strong>v${TOOL_VERSION}</strong>: 初回リリース（スナップショット・変更後プレビュー・個人情報除去・AI作業指示出力対応）</li>
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
