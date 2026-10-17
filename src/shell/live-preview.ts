import { findClosestLink, resolveElementLocator } from "../core/anchor";
import type { AnchorMatchConfidence, Item } from "../core/types";
import { isSafeNavigationUrl } from "../core/url-safety";

export type OriginalElementSnapshot = {
  readonly element: Element;
  readonly textContent: string | null;
  readonly childNodes: readonly Node[];
  readonly href: string | null;
  readonly linkElement: Element | null;
  readonly src: string | null;
  readonly srcset: string | null;
  readonly styleAttr: string | null;
};

export type ResolvedLiveTarget = {
  readonly element: Element;
  readonly confidence: AnchorMatchConfidence;
};

export type LivePreviewController = {
  readonly syncItems: (
    doc: Document,
    items: readonly Item[],
    currentUrl: string,
    getAttachmentPreviewUrl: (id: string) => string | undefined,
  ) => void;
  readonly restoreAll: () => void;
  readonly withCleanDom: <T>(fn: () => T) => T;
  readonly getResolvedTarget: (seq: number) => ResolvedLiveTarget | undefined;
};

const captureOriginalElement = (element: Element): OriginalElementSnapshot => {
  const linkElement = findClosestLink(element);
  return {
    element,
    textContent: element.textContent,
    childNodes: Array.from(element.childNodes),
    href: linkElement?.getAttribute("href") ?? null,
    linkElement,
    src: element.getAttribute("src"),
    srcset: element.getAttribute("srcset"),
    styleAttr: element.getAttribute("style"),
  };
};

const setOrRemoveAttr = (el: Element, attr: string, val: string | null): void => {
  if (val === null) {
    el.removeAttribute(attr);
  } else {
    el.setAttribute(attr, val);
  }
};

const restoreOriginalElement = (
  orig: OriginalElementSnapshot,
  wasChildrenReplaced: boolean,
): void => {
  if (wasChildrenReplaced) {
    while (orig.element.firstChild !== null) {
      orig.element.removeChild(orig.element.firstChild);
    }
    orig.childNodes.map((n) => orig.element.appendChild(n));
  }
  if (orig.linkElement !== null) {
    setOrRemoveAttr(orig.linkElement, "href", orig.href);
  }
  setOrRemoveAttr(orig.element, "src", orig.src);
  setOrRemoveAttr(orig.element, "srcset", orig.srcset);
  setOrRemoveAttr(orig.element, "style", orig.styleAttr);
};

const appendLiveStyle = (element: Element, cssText: string): void => {
  const prevStyle = element.getAttribute("style") ?? "";
  const sep = prevStyle.length > 0 && !prevStyle.trim().endsWith(";") ? ";" : "";
  element.setAttribute("style", `${prevStyle}${sep}${cssText}`);
};

const applyLiveImageChange = (element: Element, url: string): void => {
  if (element.tagName.toLowerCase() === "img") {
    element.setAttribute("src", url);
    element.removeAttribute("srcset");
    return;
  }
  appendLiveStyle(element, `background-image:url("${url}") !important;`);
};

const applySingleLiveChange = (
  element: Element,
  item: Item,
  getAttachmentPreviewUrl: (id: string) => string | undefined,
  childrenReplacedElements: Set<Element>,
): void => {
  if (item.after !== undefined) {
    childrenReplacedElements.add(element);
    element.textContent = item.after;
  }
  if (item.hrefAfter !== undefined && isSafeNavigationUrl(item.hrefAfter)) {
    const linkEl = findClosestLink(element) ?? element;
    linkEl.setAttribute("href", item.hrefAfter);
  }
  if (item.changeType === "DELETE") {
    appendLiveStyle(element, "opacity:0.35 !important;text-decoration:line-through !important;");
  }
  if (item.changeType === "IMAGE_REPLACE") {
    const attId = item.attachmentIds[0];
    const url = attId !== undefined ? getAttachmentPreviewUrl(attId) : undefined;
    if (url !== undefined) {
      applyLiveImageChange(element, url);
    }
  }
};

export const createLivePreviewController = (): LivePreviewController => {
  const originals = new Map<Element, OriginalElementSnapshot>();
  const childrenReplacedElements = new Set<Element>();
  const resolvedBySeq = new Map<number, ResolvedLiveTarget>();
  const lastArgsRef: {
    doc: Document | null;
    items: readonly Item[];
    currentUrl: string;
    getAttachmentPreviewUrl: (id: string) => string | undefined;
  } = {
    doc: null,
    items: [],
    currentUrl: "",
    getAttachmentPreviewUrl: () => undefined,
  };

  const restoreAll = (): void => {
    Array.from(originals.values())
      .reverse()
      .map((orig) => restoreOriginalElement(orig, childrenReplacedElements.has(orig.element)));
    originals.clear();
    childrenReplacedElements.clear();
    resolvedBySeq.clear();
  };

  const syncItems = (
    doc: Document,
    items: readonly Item[],
    currentUrl: string,
    getAttachmentPreviewUrl: (id: string) => string | undefined,
  ): void => {
    lastArgsRef.doc = doc;
    lastArgsRef.items = items;
    lastArgsRef.currentUrl = currentUrl;
    lastArgsRef.getAttachmentPreviewUrl = getAttachmentPreviewUrl;

    restoreAll();

    const pageItems = items.filter((item) => item.url === currentUrl);
    const resolvedEntries = pageItems.flatMap((item) => {
      if (item.anchor.kind !== "element") {
        return [];
      }
      const resolved = resolveElementLocator(doc, item.anchor.locator);
      if (!resolved.ok || resolved.value.element === null) {
        return [];
      }
      return [
        { item, element: resolved.value.element, confidence: resolved.value.confidence } as const,
      ];
    });

    resolvedEntries.map(({ item, element, confidence }) => {
      resolvedBySeq.set(item.seq, { element, confidence });
      if (!originals.has(element)) {
        originals.set(element, captureOriginalElement(element));
      }
      applySingleLiveChange(element, item, getAttachmentPreviewUrl, childrenReplacedElements);
    });
  };

  const withCleanDom = <T>(fn: () => T): T => {
    restoreAll();
    try {
      return fn();
    } finally {
      if (lastArgsRef.doc !== null && lastArgsRef.items.length > 0) {
        syncItems(
          lastArgsRef.doc,
          lastArgsRef.items,
          lastArgsRef.currentUrl,
          lastArgsRef.getAttachmentPreviewUrl,
        );
      }
    }
  };

  const getResolvedTarget = (seq: number): ResolvedLiveTarget | undefined => {
    const entry = resolvedBySeq.get(seq);
    if (entry?.element.isConnected) {
      return entry;
    }
    return undefined;
  };

  return {
    syncItems,
    restoreAll,
    withCleanDom,
    getResolvedTarget,
  };
};
