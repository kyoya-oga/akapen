import {
  type TextIndexProvider,
  captureElementLocator,
  computeSmallestContainingElement,
  createTextIndexProvider,
  extractFullElementText,
  extractImageSrc,
  findClosestLink,
  hasFormattingChildren,
  resolveElementLocator,
} from "../core/anchor";
import { HOST_ELEMENT_ID } from "../core/sanitize";
import type {
  AnchorMatchConfidence,
  DraftEditorState,
  ElementLocator,
  Item,
  PageMetaDiff,
  PageMetaValues,
  Rect,
  ResolvedAnchor,
  TargetKind,
} from "../core/types";
import type { ResolvedLiveTarget } from "./live-preview";

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

const IMAGE_TAGS = new Set(["img", "picture", "video", "svg", "canvas"]);

/**
 * クリック位置の要素を、依頼の対象として自然な単位に寄せる。
 * SVG アイコンの内部（path や g）を拾うと中身のない対象になるため、svg 要素全体を選ぶ。
 */
export const normalizePickTarget = (element: Element): Element => element.closest("svg") ?? element;

const hasBackgroundImage = (doc: Document, element: Element): boolean => {
  if (extractImageSrc(element) !== undefined) {
    return true;
  }
  const computedBg = doc.defaultView?.getComputedStyle(element).backgroundImage ?? "";
  return computedBg !== "none" && computedBg.includes("url(");
};

export const detectTargetKind = (doc: Document, element: Element): TargetKind => {
  const tag = element.tagName.toLowerCase();
  if (IMAGE_TAGS.has(tag)) {
    return "image";
  }
  // 背景画像つきのボタンや見出しでも、文字があれば文言を直せることを優先する
  const hasText = extractFullElementText(doc, element).length > 0;
  if (!hasText && hasBackgroundImage(doc, element)) {
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
    const locator =
      existingItem?.anchor.kind === "element"
        ? existingItem.anchor.locator
        : captureElementLocator(doc, element);
    const rect = getElementPageRect(doc, element);
    const targetKind = detectTargetKind(doc, element);
    const rawText = extractFullElementText(doc, element);
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
  existingItem?: Item,
): DraftEditorState =>
  withCleanDom(() => {
    if (existingItem !== undefined && existingItem.anchor.kind === "region") {
      return {
        editingSeq: existingItem.seq,
        targetKind: "region",
        anchor: existingItem.anchor,
        expansionHistory: [],
        initialText: "",
        currentText: "",
        memo: existingItem.memo ?? "",
        isDeleteRequested: false,
        hasChildFormatting: false,
        popoverRect: pageRect,
      };
    }

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

export type AnchorTarget =
  | {
      readonly seq: number;
      readonly kind: "element";
      readonly element: Element | null;
      readonly confidence: AnchorMatchConfidence;
      readonly fallbackRect: Rect;
    }
  | {
      readonly seq: number;
      readonly kind: "region";
      readonly container: Element | null;
      readonly confidence: AnchorMatchConfidence;
      readonly ratio: Rect;
      readonly fallbackRect: Rect;
    };

const resolveLocatorOrNull = (
  doc: Document,
  locator: ElementLocator,
  expectedAfterText: string | undefined,
  getTextIndex: TextIndexProvider,
): { readonly element: Element | null; readonly confidence: AnchorMatchConfidence } => {
  const res = resolveElementLocator(doc, locator, expectedAfterText, getTextIndex);
  return res.ok && res.value.element !== null
    ? res.value
    : { element: null, confidence: "fallback_rect" };
};

const resolveSingleAnchorTarget = (
  doc: Document,
  item: Item,
  getTextIndex: TextIndexProvider,
  getResolvedTarget?: (seq: number) => ResolvedLiveTarget | undefined,
): AnchorTarget | null => {
  const { anchor } = item;
  if (anchor.kind === "pageMeta") {
    return null;
  }
  if (anchor.kind === "element") {
    const resolved =
      getResolvedTarget?.(item.seq) ??
      resolveLocatorOrNull(doc, anchor.locator, item.after, getTextIndex);
    return { seq: item.seq, kind: "element", ...resolved, fallbackRect: anchor.rect };
  }
  const { element, confidence } = resolveLocatorOrNull(
    doc,
    anchor.container,
    undefined,
    getTextIndex,
  );
  return {
    seq: item.seq,
    kind: "region",
    container: element,
    confidence,
    ratio: anchor.ratio,
    fallbackRect: anchor.pageRect,
  };
};

/** DOM が変わったときだけ呼ぶ重い処理（要素の特定） */
export const resolvePageAnchorTargets = (
  doc: Document,
  items: readonly Item[],
  currentUrl: string,
  getResolvedTarget?: (seq: number) => ResolvedLiveTarget | undefined,
): readonly AnchorTarget[] => {
  const getTextIndex = createTextIndexProvider(doc);
  return items
    .filter((i) => i.url === currentUrl)
    .flatMap((item) => {
      const target = resolveSingleAnchorTarget(doc, item, getTextIndex, getResolvedTarget);
      return target !== null ? [target] : [];
    });
};

/** スクロールやリサイズのたびに呼ぶ軽い処理（位置の計測だけ） */
export const measureAnchorTargets = (
  doc: Document,
  targets: readonly AnchorTarget[],
): readonly ResolvedAnchor[] =>
  targets.map((target): ResolvedAnchor => {
    if (target.kind === "element") {
      return target.element?.isConnected
        ? {
            seq: target.seq,
            rect: getElementPageRect(doc, target.element),
            confidence: target.confidence,
          }
        : { seq: target.seq, rect: target.fallbackRect, confidence: "fallback_rect" };
    }
    if (target.container === null || !target.container.isConnected) {
      return { seq: target.seq, rect: target.fallbackRect, confidence: "fallback_rect" };
    }
    const cRect = getElementPageRect(doc, target.container);
    return {
      seq: target.seq,
      rect: {
        x: Math.round(cRect.x + cRect.w * target.ratio.x),
        y: Math.round(cRect.y + cRect.h * target.ratio.y),
        w: Math.round(cRect.w * target.ratio.w),
        h: Math.round(cRect.h * target.ratio.h),
      },
      confidence: target.confidence,
    };
  });

export const resolvePageAnchors = (
  doc: Document,
  items: readonly Item[],
  currentUrl: string,
  getResolvedTarget?: (seq: number) => ResolvedLiveTarget | undefined,
): readonly ResolvedAnchor[] =>
  measureAnchorTargets(doc, resolvePageAnchorTargets(doc, items, currentUrl, getResolvedTarget));

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
  ["keydown", "keyup", "keypress"].map((type) =>
    host.addEventListener(type, (e) => e.stopPropagation()),
  );

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
      initialText: extractFullElementText(doc, nextEl),
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
    const initialText = el !== null ? extractFullElementText(doc, el) : prevLocator.textQuote.exact;
    return {
      locator: prevLocator,
      rect,
      expansionHistory: editor.expansionHistory.slice(0, -1),
      initialText,
      hasChildFormatting: el !== null ? hasFormattingChildren(el) : false,
    };
  });
};
