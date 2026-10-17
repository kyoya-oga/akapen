import { findClosestLink, resolveDomPath } from "./dom-path";
import type { Item } from "./types";
import { isSafeNavigationUrl } from "./url-safety";

export type PreviewMode = "before" | "after" | "diff";

export type DiffSegment = {
  readonly kind: "equal" | "insert" | "delete";
  readonly text: string;
};

export const computeCharDiff = (before: string, after: string): readonly DiffSegment[] => {
  if (before === after) {
    return before.length > 0 ? [{ kind: "equal", text: before }] : [];
  }
  const indices = (length: number): readonly number[] =>
    Array.from({ length: Math.max(0, length) }, (_, idx) => idx);
  const firstIndexOrLength = (
    candidates: readonly number[],
    isDifferent: (i: number) => boolean,
  ) => {
    const found = candidates.findIndex(isDifferent);
    return found === -1 ? candidates.length : found;
  };

  const maxPrefix = Math.min(before.length, after.length);
  const prefixLen = firstIndexOrLength(indices(maxPrefix), (i) => before[i] !== after[i]);

  const maxSuffix = maxPrefix - prefixLen;
  const suffixLen = firstIndexOrLength(
    indices(maxSuffix),
    (i) => before[before.length - 1 - i] !== after[after.length - 1 - i],
  );

  const prefix = before.slice(0, prefixLen);
  const deleted = before.slice(prefixLen, before.length - suffixLen);
  const inserted = after.slice(prefixLen, after.length - suffixLen);
  const suffix = before.slice(before.length - suffixLen);

  return [
    ...(prefix.length > 0 ? [{ kind: "equal" as const, text: prefix }] : []),
    ...(deleted.length > 0 ? [{ kind: "delete" as const, text: deleted }] : []),
    ...(inserted.length > 0 ? [{ kind: "insert" as const, text: inserted }] : []),
    ...(suffix.length > 0 ? [{ kind: "equal" as const, text: suffix }] : []),
  ];
};

const appendInlineStyle = (el: Element, extraCss: string): void => {
  const prev = el.getAttribute("style") ?? "";
  const sep = prev.length > 0 && !prev.trim().endsWith(";") ? ";" : "";
  el.setAttribute("style", `${prev}${sep}${extraCss}`);
};

const addDiffOutline = (el: Element, color: string, dashed = false): void => {
  const borderStyle = dashed ? `2px dashed ${color}` : `2px solid ${color}`;
  appendInlineStyle(el, `outline:${borderStyle} !important;outline-offset:2px !important;`);
};

const applyTextOrLinkItem = (target: Element, item: Item, mode: PreviewMode): void => {
  if (item.after !== undefined) {
    target.textContent = item.after;
  }
  if (item.hrefAfter !== undefined && isSafeNavigationUrl(item.hrefAfter)) {
    const linkEl = findClosestLink(target) ?? target;
    linkEl.setAttribute("href", item.hrefAfter);
    if (mode === "diff") {
      linkEl.setAttribute("data-pcr-href-after", item.hrefAfter);
    }
  }
  if (mode === "diff") {
    addDiffOutline(target, "#16a34a");
  }
};

const applyDeleteItem = (target: Element, mode: PreviewMode): void => {
  if (mode === "after") {
    appendInlineStyle(target, "display:none !important;");
  } else if (mode === "diff") {
    appendInlineStyle(
      target,
      "opacity:0.4 !important;text-decoration:line-through !important;outline:2px solid #dc2626 !important;outline-offset:2px !important;",
    );
  }
};

const replaceElementImageUrl = (target: Element, newUrl: string): void => {
  const tag = target.tagName.toLowerCase();
  if (tag === "img") {
    target.setAttribute("src", newUrl);
    target.removeAttribute("srcset");
    return;
  }
  if (tag === "picture") {
    const img = target.querySelector("img");
    if (img !== null) {
      img.setAttribute("src", newUrl);
    }
    Array.from(target.querySelectorAll("source")).map((s) => s.remove());
    return;
  }
  appendInlineStyle(target, `background-image:url("${newUrl}") !important;`);
};

const applyImageItem = (
  target: Element,
  item: Item,
  mode: PreviewMode,
  resolveAttachmentUrl: (attachmentId: string) => string | undefined,
): void => {
  const firstAttachmentId = item.attachmentIds[0];
  const newUrl =
    firstAttachmentId !== undefined ? resolveAttachmentUrl(firstAttachmentId) : undefined;
  if (newUrl !== undefined) {
    replaceElementImageUrl(target, newUrl);
  }
  if (mode === "diff") {
    addDiffOutline(target, "#16a34a");
  }
};

const resolveOrCreateRegionBoxInDoc = (
  doc: Document,
  seq: number,
  rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
): Element | null => {
  if (doc.body === null) {
    return null;
  }
  const existing = doc.querySelector(`[data-pcr-region-seq="${seq}"]`);
  if (existing !== null) {
    return existing;
  }
  const box = doc.createElement("div");
  box.setAttribute("data-pcr-region-seq", String(seq));
  box.setAttribute(
    "style",
    `position:absolute;left:${rect.x}px;top:${rect.y}px;width:${Math.max(4, rect.w)}px;height:${Math.max(4, rect.h)}px;pointer-events:none;z-index:2147483640;`,
  );
  doc.body.appendChild(box);
  return box;
};

const resolveItemElementInDoc = (doc: Document, item: Item): Element | null => {
  if (item.anchor.kind === "element") {
    return resolveDomPath(doc.documentElement, item.anchor.locator.domPath);
  }
  if (item.anchor.kind === "region") {
    return resolveOrCreateRegionBoxInDoc(doc, item.seq, item.anchor.pageRect);
  }
  return null;
};

export const applyPreviewToClonedDocument = (
  doc: Document,
  items: readonly Item[],
  mode: PreviewMode,
  resolveAttachmentUrl: (attachmentId: string) => string | undefined,
): void => {
  if (mode === "before") {
    return;
  }
  const resolvedTargets = items.map((item) => ({
    item,
    element: resolveItemElementInDoc(doc, item),
  }));

  resolvedTargets.map(({ item, element }) => {
    if (element === null) {
      return;
    }
    switch (item.changeType) {
      case "TEXT_REPLACE":
      case "LINK_CHANGE":
      case "TEXT_AND_LINK_CHANGE":
        applyTextOrLinkItem(element, item, mode);
        return;
      case "DELETE":
        applyDeleteItem(element, mode);
        return;
      case "IMAGE_REPLACE":
        applyImageItem(element, item, mode, resolveAttachmentUrl);
        return;
      case "OTHER":
        if (mode === "diff") {
          addDiffOutline(element, "#eab308", true);
        }
        return;
      case "PAGE_META":
        return;
      default: {
        const _exhaustive: never = item.changeType;
        return _exhaustive;
      }
    }
  });
};
