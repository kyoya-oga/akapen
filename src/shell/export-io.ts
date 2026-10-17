import { copyTextToClipboard } from "./codec";
export { copyTextToClipboard };
import type { ChangeRequestDoc } from "../core/types";
import { uint8ArrayToBase64 } from "./codec";
import type { ResourceEntry } from "./snapshot-io";

export const encodeJsonToBase64 = (data: unknown): string => {
  const jsonStr = JSON.stringify(data);
  const bytes = new TextEncoder().encode(jsonStr);
  return uint8ArrayToBase64(bytes);
};

export const escapeScriptContent = (text: string): string =>
  text.replace(/<\/script/gi, "<\\/script");

export const escapeHtmlText = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const formatReportFilename = (pageTitle: string, date = new Date()): string => {
  const safeTitle =
    pageTitle
      .replace(/[\\/:*?"<>|\s]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "ページ";
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  return `変更依頼_${safeTitle}_${yyyy}${mm}${dd}-${hh}${min}.html`;
};

export type BuildReportHtmlParams = {
  readonly pageTitle: string;
  readonly doc: ChangeRequestDoc;
  readonly snapshotBodies: Readonly<Record<string, string>>;
  readonly resources: Readonly<Record<string, ResourceEntry>>;
  readonly viewerScript: string;
  readonly viewerScriptSha256Base64: string;
  readonly viewerStyles: string;
};

export const buildReportHtmlString = (params: BuildReportHtmlParams): string => {
  const safeTitle = escapeHtmlText(params.pageTitle || "ページ");
  const jsonPayload = escapeScriptContent(JSON.stringify(params.doc));
  const snapshotsBase64 = encodeJsonToBase64(params.snapshotBodies);
  const resourcesBase64 = encodeJsonToBase64(params.resources);
  const cspContent = [
    "default-src 'none'",
    `script-src 'sha256-${params.viewerScriptSha256Base64}'`,
    "style-src 'unsafe-inline' https:",
    "img-src data: blob: https:",
    "font-src data: blob: https:",
    "frame-src blob:",
  ].join("; ");

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${cspContent}">
  <title>変更依頼：${safeTitle}</title>
  <style>${params.viewerStyles}</style>
</head>
<body>
  <div id="app"></div>
  <script type="application/json" id="pcr-data">${jsonPayload}</script>
  <script type="application/octet-stream" id="pcr-snapshots">${snapshotsBase64}</script>
  <script type="application/octet-stream" id="pcr-resources">${resourcesBase64}</script>
  <script>${params.viewerScript}</script>
</body>
</html>`;
};

export const downloadHtmlReportBlob = (htmlContent: string, filename: string): void => {
  if (typeof document === "undefined" || document.body === null) {
    return;
  }
  const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.setAttribute("data-pcr-download", "true");
  a.setAttribute("style", "display:none;");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
