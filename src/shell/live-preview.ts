import { findClosestLink, resolveElementLocator } from "../core/anchor";
import type { Item } from "../core/types";

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

export type LivePreviewController = {
  readonly syncItems: (
    doc: Document,
    items: readonly Item[],
    currentUrl: string,
    getAttachmentPreviewUrl: (id: string) => string | undefined,
  ) => void;
  readonly restoreAll: () => void;
  readonly withCleanDom: <T>(fn: () => T) => T;
};

const captureOriginalElement = (element: Element): OriginalElementSnapshot => {
  const linkElement = findClosestLink(element);
  return {
    element,
    textContent: element.textContent,
    childNodes: Array.from(element.childNodes).map((n) => n.cloneNode(true)),
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

const restoreOriginalElement = (orig: OriginalElementSnapshot): void => {
  while (orig.element.firstChild !== null) {
    orig.element.removeChild(orig.element.firstChild);
  }
  orig.childNodes.map((n) => orig.element.appendChild(n.cloneNode(true)));
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
): void => {
  if (item.after !== undefined) {
    element.textContent = item.after;
  }
  if (item.hrefAfter !== undefined) {
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
    Array.from(originals.values()).reverse().map(restoreOriginalElement);
    originals.clear();
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
    pageItems.map((item) => {
      if (item.anchor.kind !== "element") {
        return;
      }
      const resolved = resolveElementLocator(doc, item.anchor.locator);
      if (!resolved.ok || resolved.value.element === null) {
        return;
      }
      const target = resolved.value.element;
      if (!originals.has(target)) {
        originals.set(target, captureOriginalElement(target));
      }
      applySingleLiveChange(target, item, getAttachmentPreviewUrl);
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

  return {
    syncItems,
    restoreAll,
    withCleanDom,
  };
};
