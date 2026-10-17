import {
  base64ToUint8Array,
  compressStringGzipBase64,
  decompressGzipBase64ToString,
  uint8ArrayToBase64,
} from "./codec";
export {
  base64ToUint8Array,
  compressStringGzipBase64,
  decompressGzipBase64ToString,
  uint8ArrayToBase64,
};
import { type Result, err, ok } from "../core/result";
import {
  collectImageUrlsFromClonedRoot,
  replaceImageUrlsWithResourceHashes,
  rewriteCssUrlsToAbsolute,
  sanitizeClonedDocument,
  syncLiveDomStateBeforeClone,
} from "../core/sanitize";
import type { AttachmentMeta, SnapshotMeta } from "../core/types";

export const MAX_SINGLE_RESOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_RESOURCE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_DIMENSION = 2000;
const FETCH_TIMEOUT_MS = 4000;

export type ResourceEntry = {
  readonly hash: string;
  readonly mime: string;
  readonly base64: string;
  readonly byteLength: number;
};

export type CapturedSnapshotData = {
  readonly meta: SnapshotMeta;
  readonly compressedHtmlBase64: string;
  readonly newResources: readonly ResourceEntry[];
};

import { sha256HexSync } from "../core/sha256";

export const computeSha256Hex = async (bytes: Uint8Array): Promise<string> => {
  if (typeof crypto !== "undefined" && crypto.subtle !== undefined) {
    try {
      const hashBuffer = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return sha256HexSync(bytes);
    }
  }
  return sha256HexSync(bytes);
};

const replaceCanvasesWithImages = (liveRoot: Element, cloneRoot: Element): void => {
  const liveCanvases = Array.from(liveRoot.querySelectorAll("canvas"));
  const cloneCanvases = Array.from(cloneRoot.querySelectorAll("canvas"));
  if (liveCanvases.length !== cloneCanvases.length) {
    return;
  }
  liveCanvases.map((liveCanvas, idx) => {
    const cloneCanvas = cloneCanvases[idx];
    if (cloneCanvas === undefined || cloneCanvas.ownerDocument === null) {
      return;
    }
    try {
      const dataUrl = (liveCanvas as HTMLCanvasElement).toDataURL("image/png");
      const img = cloneCanvas.ownerDocument.createElement("img");
      img.setAttribute("src", dataUrl);
      img.setAttribute("width", String((liveCanvas as HTMLCanvasElement).width));
      img.setAttribute("height", String((liveCanvas as HTMLCanvasElement).height));
      cloneCanvas.replaceWith(img);
    } catch {
      // Tainted canvas; leave as is
    }
  });
};

const extractDynamicStyles = (doc: Document, baseUrl: string): string => {
  const sheetRules = Array.from(doc.styleSheets).flatMap((sheet) => {
    if (sheet.href !== null) {
      return [];
    }
    try {
      return Array.from(sheet.cssRules).map((r) => r.cssText);
    } catch {
      return [];
    }
  });
  const adoptedRules = (doc.adoptedStyleSheets ?? []).flatMap((sheet) => {
    try {
      return Array.from(sheet.cssRules).map((r) => r.cssText);
    } catch {
      return [];
    }
  });
  const combined = [...sheetRules, ...adoptedRules].join("\n");
  return rewriteCssUrlsToAbsolute(combined, baseUrl);
};

const urlResourceCache = new Map<string, ResourceEntry>();

const fetchSingleImageResource = async (url: string): Promise<Result<ResourceEntry, string>> => {
  const cached = urlResourceCache.get(url);
  if (cached !== undefined) {
    return ok(cached);
  }
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { credentials: "same-origin", signal: controller.signal });
    if (!resp.ok) {
      return err(`HTTP ${resp.status}`);
    }
    const contentType =
      (resp.headers.get("content-type") ?? "image/png").split(";")[0]?.trim() ?? "image/png";
    if (contentType.includes("svg")) {
      return err("SVG is excluded");
    }
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > MAX_SINGLE_RESOURCE_BYTES || buffer.byteLength === 0) {
      return err("Exceeds single resource limit");
    }
    const bytes = new Uint8Array(buffer);
    const hash = await computeSha256Hex(bytes);
    const entry: ResourceEntry = {
      hash,
      mime: contentType,
      base64: uint8ArrayToBase64(bytes),
      byteLength: buffer.byteLength,
    };
    urlResourceCache.set(url, entry);
    return ok(entry);
  } catch {
    return err("Fetch error");
  } finally {
    clearTimeout(timerId);
  }
};

export const selectResourcesWithinBudget = (
  fetched: readonly { readonly url: string; readonly entry: ResourceEntry }[],
  existingResources: Readonly<Record<string, ResourceEntry>>,
): {
  readonly urlToHash: Readonly<Record<string, string>>;
  readonly newResources: readonly ResourceEntry[];
} => {
  const initialTotalBytes = Object.values(existingResources).reduce(
    (sum, r) => sum + r.byteLength,
    0,
  );
  const urlToHashMap = new Map<string, string>();
  const newByHashMap = new Map<string, ResourceEntry>();

  fetched.reduce<number>((currentBytes, { url, entry }) => {
    if (existingResources[entry.hash] !== undefined || newByHashMap.has(entry.hash)) {
      urlToHashMap.set(url, entry.hash);
      return currentBytes;
    }
    if (currentBytes + entry.byteLength > MAX_TOTAL_RESOURCE_BYTES) {
      return currentBytes;
    }
    urlToHashMap.set(url, entry.hash);
    newByHashMap.set(entry.hash, entry);
    return currentBytes + entry.byteLength;
  }, initialTotalBytes);

  return {
    urlToHash: Object.fromEntries(urlToHashMap),
    newResources: Array.from(newByHashMap.values()),
  };
};

const fetchResourcesWithinBudget = async (
  urls: readonly string[],
  existingResources: Readonly<Record<string, ResourceEntry>>,
): Promise<{
  readonly urlToHash: Readonly<Record<string, string>>;
  readonly newResources: readonly ResourceEntry[];
}> => {
  const uniqueUrls = Array.from(new Set(urls));
  const results = await Promise.all(
    uniqueUrls.map(async (url) => ({ url, res: await fetchSingleImageResource(url) })),
  );
  const validFetched = results.flatMap(({ url, res }) =>
    res.ok ? [{ url, entry: res.value }] : [],
  );
  return selectResourcesWithinBudget(validFetched, existingResources);
};

export const captureCleanSnapshot = async (
  liveDoc: Document,
  withCleanDom: <T>(fn: () => T) => T,
  existingResources: Readonly<Record<string, ResourceEntry>>,
): Promise<CapturedSnapshotData> => {
  const baseUrl = liveDoc.location?.href ?? "https://localhost/";
  const viewport = {
    w: liveDoc.defaultView?.innerWidth ?? 1280,
    h: liveDoc.defaultView?.innerHeight ?? 800,
  };
  const scroll = {
    x: liveDoc.defaultView?.scrollX ?? 0,
    y: liveDoc.defaultView?.scrollY ?? 0,
  };
  const title = liveDoc.title || "無題のページ";

  const clonedDoc = withCleanDom(() => {
    const parser = new DOMParser();
    const docCopy = parser.parseFromString("<!doctype html><html></html>", "text/html");
    const clonedHtml = liveDoc.documentElement.cloneNode(true) as Element;
    syncLiveDomStateBeforeClone(liveDoc.documentElement, clonedHtml);
    replaceCanvasesWithImages(liveDoc.documentElement, clonedHtml);
    docCopy.replaceChild(clonedHtml, docCopy.documentElement);
    return docCopy;
  });

  sanitizeClonedDocument(clonedDoc, baseUrl);

  const dynamicCss = extractDynamicStyles(liveDoc, baseUrl);
  if (dynamicCss.trim().length > 0 && clonedDoc.head !== null) {
    const styleEl = clonedDoc.createElement("style");
    styleEl.setAttribute("data-pcr-dynamic-styles", "true");
    styleEl.textContent = dynamicCss;
    clonedDoc.head.appendChild(styleEl);
  }

  const imageUrls = collectImageUrlsFromClonedRoot(clonedDoc.documentElement, baseUrl);
  const { urlToHash, newResources } = await fetchResourcesWithinBudget(
    imageUrls,
    existingResources,
  );
  replaceImageUrlsWithResourceHashes(clonedDoc.documentElement, baseUrl, urlToHash);

  const serializedHtml = `<!doctype html>\n${clonedDoc.documentElement.outerHTML}`;
  const htmlHash = (await computeSha256Hex(new TextEncoder().encode(serializedHtml))).slice(0, 16);
  const compressedHtmlBase64 = await compressStringGzipBase64(serializedHtml);

  const meta: SnapshotMeta = {
    id: `snap-${htmlHash}`,
    url: baseUrl,
    title,
    viewport,
    scroll,
    capturedAt: new Date().toISOString(),
  };

  return {
    meta,
    compressedHtmlBase64,
    newResources,
  };
};

const ALLOWED_ATTACHMENT_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const processAttachmentImageFile = async (
  file: File,
): Promise<
  Result<
    {
      readonly attachment: AttachmentMeta;
      readonly resource: ResourceEntry;
      readonly previewUrl: string;
    },
    string
  >
> => {
  if (!ALLOWED_ATTACHMENT_MIMES.has(file.type)) {
    return err("添付できるのは PNG / JPEG / WebP / GIF 画像のみです（SVG は不可）");
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_ATTACHMENT_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return err("Canvas コンテキストの取得に失敗しました");
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/webp", 0.88),
    );
    if (blob === null) {
      return err("画像のWebP変換に失敗しました");
    }
    const buffer = await blob.arrayBuffer();
    if (buffer.byteLength > MAX_SINGLE_RESOURCE_BYTES) {
      return err("画像サイズが上限（2MB）を超えています");
    }
    const bytes = new Uint8Array(buffer);
    const hash = await computeSha256Hex(bytes);
    const base64 = uint8ArrayToBase64(bytes);
    const previewUrl = `data:image/webp;base64,${base64}`;
    const attachment: AttachmentMeta = {
      id: `att-${hash.slice(0, 12)}`,
      name: file.name.replace(/\.[^.]+$/, ".webp"),
      mime: "image/webp",
      resourceHash: hash,
    };
    const resource: ResourceEntry = {
      hash,
      mime: "image/webp",
      base64,
      byteLength: buffer.byteLength,
    };
    return ok({ attachment, resource, previewUrl });
  } catch {
    return err("画像の読み込みに失敗しました");
  }
};
