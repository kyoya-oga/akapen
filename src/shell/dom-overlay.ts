import {
  captureElementLocator,
  computeSmallestContainingElement,
  extractCleanElementText,
  extractImageSrc,
  findClosestLink,
  hasFormattingChildren,
  resolveElementLocator,
} from "../core/anchor";
import { HOST_ELEMENT_ID } from "../core/sanitize";
import type {
  DraftEditorState,
  ElementLocator,
  Item,
  PageMetaDiff,
  PageMetaValues,
  Rect,
  ResolvedAnchor,
  TargetKind,
} from "../core/types";

export const getElementPageRect = (doc: Document, el: Element): Rect => {
  const r = el.getBoundingClientRect();
  const scrollX = doc.defaultView?.scrollX ?? 0;
  const scrollY = doc.defaultView?.scrollY ?? 0;
  return {
    x: Math.round(r.left + scrollX),
    y: Math.round(r.top + scrollY),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
};

export const pageRectToViewportRect = (doc: Document, pageRect: Rect): Rect => {
  const scrollX = doc.defaultView?.scrollX ?? 0;
  const scrollY = doc.defaultView?.scrollY ?? 0;
  return {
    x: pageRect.x - scrollX,
    y: pageRect.y - scrollY,
    w: pageRect.w,
    h: pageRect.h,
  };
};

export const readPageMetaValues = (doc: Document): PageMetaValues => {
  const getMetaContent = (selector: string): string =>
    doc.querySelector(selector)?.getAttribute("content") ?? "";
  return {
    title: doc.title ?? "",
    description: getMetaContent('meta[name="description"]'),
    ogTitle: getMetaContent('meta[property="og:title"]'),
    ogDescription: getMetaContent('meta[property="og:description"]'),
    ogImage: getMetaContent('meta[property="og:image"]'),
  };
};

const IMAGE_TAGS = new Set(["img", "picture", "video", "svg"]);

export const detectTargetKind = (doc: Document, element: Element): TargetKind => {
  const tag = element.tagName.toLowerCase();
  if (IMAGE_TAGS.has(tag)) {
    return "image";
  }
  const computedBg = doc.defaultView?.getComputedStyle(element).backgroundImage ?? "";
  if (
    extractImageSrc(element) !== undefined ||
    (computedBg !== "none" && computedBg.includes("url("))
  ) {
    return "image";
  }
  if (findClosestLink(element) !== null) {
    return "link";
  }
  return "text";
};

const buildOptionalHrefEditorProps = (
  initialHref: string | undefined,
  existingItem: Item | undefined,
): Partial<DraftEditorState> => {
  if (initialHref === undefined) {
    return {};
  }
  const startHref = existingItem?.hrefBefore ?? initialHref;
  const currentHref = existingItem?.hrefAfter ?? startHref;
  return { initialHref: startHref, currentHref };
};

const buildOptionalAttachmentEditorProps = (
  existingItem: Item | undefined,
): Partial<DraftEditorState> => {
  const firstAtt = existingItem?.attachmentIds[0];
  if (firstAtt === undefined) {
    return {};
  }
  return { attachmentId: firstAtt };
};

export const createEditorStateForElement = (
  doc: Document,
  element: Element,
  withCleanDom: <T>(fn: () => T) => T,
  existingItem?: Item,
): DraftEditorState =>
  withCleanDom(() => {
    const locator = captureElementLocator(doc, element);
    const rect = getElementPageRect(doc, element);
    const targetKind = detectTargetKind(doc, element);
    const rawText = extractCleanElementText(doc, element);
    const initialText = existingItem?.before ?? rawText;
    const currentText = existingItem?.after ?? initialText;
    const linkEl = findClosestLink(element);
    const initialHref = linkEl?.getAttribute("href") ?? undefined;

    return {
      ...(existingItem !== undefined ? { editingSeq: existingItem.seq } : {}),
      targetKind,
      anchor: { kind: "element", locator, rect },
      expansionHistory: [],
      initialText,
      currentText,
      ...buildOptionalHrefEditorProps(initialHref, existingItem),
      memo: existingItem?.memo ?? "",
      ...buildOptionalAttachmentEditorProps(existingItem),
      isDeleteRequested: existingItem?.changeType === "DELETE",
      hasChildFormatting: hasFormattingChildren(element),
      popoverRect: rect,
    };
  });

export const createEditorStateForRegion = (
  doc: Document,
  pageRect: Rect,
  withCleanDom: <T>(fn: () => T) => T,
): DraftEditorState =>
  withCleanDom(() => {
    const containerEl = computeSmallestContainingElement(doc, pageRect, (el) =>
      getElementPageRect(doc, el),
    );
    const containerRect = getElementPageRect(doc, containerEl);
    const containerLocator = captureElementLocator(doc, containerEl);
    const safeW = Math.max(1, containerRect.w);
    const safeH = Math.max(1, containerRect.h);
    const ratio: Rect = {
      x: Number(((pageRect.x - containerRect.x) / safeW).toFixed(4)),
      y: Number(((pageRect.y - containerRect.y) / safeH).toFixed(4)),
      w: Number((pageRect.w / safeW).toFixed(4)),
      h: Number((pageRect.h / safeH).toFixed(4)),
    };

    return {
      targetKind: "region",
      anchor: {
        kind: "region",
        container: containerLocator,
        ratio,
        pageRect,
      },
      expansionHistory: [],
      initialText: "",
      currentText: "",
      memo: "",
      isDeleteRequested: false,
      hasChildFormatting: false,
      popoverRect: pageRect,
    };
  });

const applyExistingMetaDiffs = (
  base: PageMetaValues,
  diffs: readonly PageMetaDiff[] | undefined,
): PageMetaValues => {
  if (diffs === undefined || diffs.length === 0) {
    return base;
  }
  const map = new Map(diffs.map((d) => [d.field, d.after]));
  return {
    title: map.get("title") ?? base.title,
    description: map.get("description") ?? base.description,
    ogTitle: map.get("ogTitle") ?? base.ogTitle,
    ogDescription: map.get("ogDescription") ?? base.ogDescription,
    ogImage: map.get("ogImage") ?? base.ogImage,
  };
};

export const createEditorStateForPageMeta = (
  doc: Document,
  existingItem?: Item,
): DraftEditorState => {
  const initialMeta = readPageMetaValues(doc);
  const currentMeta = applyExistingMetaDiffs(initialMeta, existingItem?.meta);
  const scrollX = doc.defaultView?.scrollX ?? 0;
  const scrollY = doc.defaultView?.scrollY ?? 0;

  return {
    ...(existingItem !== undefined ? { editingSeq: existingItem.seq } : {}),
    targetKind: "pageMeta",
    anchor: { kind: "pageMeta" },
    expansionHistory: [],
    initialText: "",
    currentText: "",
    initialMeta,
    currentMeta,
    memo: existingItem?.memo ?? "",
    isDeleteRequested: false,
    hasChildFormatting: false,
    popoverRect: { x: scrollX + 80, y: scrollY + 80, w: 320, h: 40 },
  };
};

const resolveSingleItemAnchor = (doc: Document, item: Item): ResolvedAnchor | null => {
  if (item.anchor.kind === "pageMeta") {
    return null;
  }
  if (item.anchor.kind === "element") {
    const res = resolveElementLocator(doc, item.anchor.locator);
    if (res.ok && res.value.element !== null) {
      return {
        seq: item.seq,
        rect: getElementPageRect(doc, res.value.element),
        confidence: res.value.confidence,
      };
    }
    return {
      seq: item.seq,
      rect: item.anchor.rect,
      confidence: "fallback_rect",
    };
  }
  const containerRes = resolveElementLocator(doc, item.anchor.container);
  if (containerRes.ok && containerRes.value.element !== null) {
    const cRect = getElementPageRect(doc, containerRes.value.element);
    return {
      seq: item.seq,
      rect: {
        x: Math.round(cRect.x + cRect.w * item.anchor.ratio.x),
        y: Math.round(cRect.y + cRect.h * item.anchor.ratio.y),
        w: Math.round(cRect.w * item.anchor.ratio.w),
        h: Math.round(cRect.h * item.anchor.ratio.h),
      },
      confidence: containerRes.value.confidence,
    };
  }
  return {
    seq: item.seq,
    rect: item.anchor.pageRect,
    confidence: "fallback_rect",
  };
};

export const resolvePageAnchors = (
  doc: Document,
  items: readonly Item[],
  currentUrl: string,
): readonly ResolvedAnchor[] =>
  items
    .filter((i) => i.url === currentUrl)
    .flatMap((item) => {
      const resolved = resolveSingleItemAnchor(doc, item);
      return resolved !== null ? [resolved] : [];
    });

export const mountShadowHost = (
  doc: Document,
  cssText: string,
): {
  readonly host: HTMLElement;
  readonly shadowRoot: ShadowRoot;
  readonly mountNode: HTMLElement;
} => {
  const existing = doc.getElementById(HOST_ELEMENT_ID);
  if (existing !== null) {
    existing.remove();
  }
  const host = doc.createElement("div");
  host.id = HOST_ELEMENT_ID;
  host.setAttribute(
    "style",
    "position:fixed;inset:0;pointer-events:none;z-index:2147483647;margin:0;padding:0;border:0;",
  );
  doc.documentElement.appendChild(host);
  const shadowRoot = host.attachShadow({ mode: "open" });

  const applyAdoptedStyles = (): boolean => {
    if ("adoptedStyleSheets" in shadowRoot && typeof CSSStyleSheet !== "undefined") {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(cssText);
        shadowRoot.adoptedStyleSheets = [sheet];
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };

  if (!applyAdoptedStyles()) {
    const styleEl = doc.createElement("style");
    styleEl.textContent = cssText;
    shadowRoot.appendChild(styleEl);
  }

  const mountNode = doc.createElement("div");
  shadowRoot.appendChild(mountNode);
  return { host, shadowRoot, mountNode };
};

export const expandCurrentEditorLocator = (
  doc: Document,
  editor: DraftEditorState,
  withCleanDom: <T>(fn: () => T) => T,
): {
  readonly locator: ElementLocator;
  readonly rect: Rect;
  readonly expansionHistory: readonly ElementLocator[];
  readonly initialText: string;
  readonly hasChildFormatting: boolean;
} | null => {
  if (editor.anchor.kind !== "element") {
    return null;
  }
  const currentLocator = editor.anchor.locator;
  return withCleanDom(() => {
    const resolved = resolveElementLocator(doc, currentLocator);
    if (!resolved.ok || resolved.value.element === null) {
      return null;
    }
    const currentEl = resolved.value.element;
    const currentRect = getElementPageRect(doc, currentEl);
    const findLargerParent = (el: Element | null): Element | null => {
      if (
        el === null ||
        el.tagName.toLowerCase() === "body" ||
        el.tagName.toLowerCase() === "html"
      ) {
        return null;
      }
      const r = getElementPageRect(doc, el);
      if (r.w > currentRect.w + 2 || r.h > currentRect.h + 2) {
        return el;
      }
      return findLargerParent(el.parentElement);
    };
    const nextEl = findLargerParent(currentEl.parentElement);
    if (nextEl === null) {
      return null;
    }
    return {
      locator: captureElementLocator(doc, nextEl),
      rect: getElementPageRect(doc, nextEl),
      expansionHistory: [...editor.expansionHistory, currentLocator],
      initialText: extractCleanElementText(doc, nextEl),
      hasChildFormatting: hasFormattingChildren(nextEl),
    };
  });
};

export const shrinkCurrentEditorLocator = (
  doc: Document,
  editor: DraftEditorState,
  withCleanDom: <T>(fn: () => T) => T,
): {
  readonly locator: ElementLocator;
  readonly rect: Rect;
  readonly expansionHistory: readonly ElementLocator[];
  readonly initialText: string;
  readonly hasChildFormatting: boolean;
} | null => {
  if (editor.anchor.kind !== "element" || editor.expansionHistory.length === 0) {
    return null;
  }
  const fallbackRect = editor.anchor.rect;
  const prevLocator = editor.expansionHistory[editor.expansionHistory.length - 1];
  if (prevLocator === undefined) {
    return null;
  }
  return withCleanDom(() => {
    const resolved = resolveElementLocator(doc, prevLocator);
    const el = resolved.ok ? resolved.value.element : null;
    const rect = el !== null ? getElementPageRect(doc, el) : fallbackRect;
    return {
      locator: prevLocator,
      rect,
      expansionHistory: editor.expansionHistory.slice(0, -1),
      initialText: prevLocator.textQuote.exact,
      hasChildFormatting: el !== null ? hasFormattingChildren(el) : false,
    };
  });
};
