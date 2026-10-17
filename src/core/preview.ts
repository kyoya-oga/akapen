import { findClosestLink, resolveDomPath } from "./dom-path";
import type { Item } from "./types";

export type PreviewMode = "before" | "after" | "diff";

export type DiffSegment = {
  readonly kind: "equal" | "insert" | "delete";
  readonly text: string;
};

export const computeCharDiff = (before: string, after: string): readonly DiffSegment[] => {
  if (before === after) {
    return before.length > 0 ? [{ kind: "equal", text: before }] : [];
  }
  const findCommonPrefixLen = (idx: number): number => {
    if (idx >= before.length || idx >= after.length || before[idx] !== after[idx]) {
      return idx;
    }
    return findCommonPrefixLen(idx + 1);
  };
  const prefixLen = findCommonPrefixLen(0);

  const findCommonSuffixLen = (idx: number): number => {
    const bIdx = before.length - 1 - idx;
    const aIdx = after.length - 1 - idx;
    if (bIdx < prefixLen || aIdx < prefixLen || before[bIdx] !== after[aIdx]) {
      return idx;
    }
    return findCommonSuffixLen(idx + 1);
  };
  const suffixLen = findCommonSuffixLen(0);

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
  if (item.hrefAfter !== undefined) {
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

const resolveItemElementInDoc = (doc: Document, item: Item): Element | null => {
  if (item.anchor.kind === "element") {
    return resolveDomPath(doc.documentElement, item.anchor.locator.domPath);
  }
  if (item.anchor.kind === "region") {
    return resolveDomPath(doc.documentElement, item.anchor.container.domPath);
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
