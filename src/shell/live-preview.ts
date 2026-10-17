import {
  type TextIndexProvider,
  collectVisibleTextNodes,
  createTextIndexProvider,
  findClosestLink,
  resolveElementLocator,
} from "../core/anchor";
import type { AnchorMatchConfidence, Item } from "../core/types";
import { isSafeNavigationUrl } from "../core/url-safety";

export type ResolvedLiveTarget = {
  readonly element: Element;
  readonly confidence: AnchorMatchConfidence;
};

export type LivePreviewHooks = {
  /** ツール自身が DOM を書き換える直前・直後に呼ばれる（MutationObserver の自己検知除外用） */
  readonly beforeMutate?: () => void;
  readonly afterMutate?: () => void;
};

export type LivePreviewController = {
  readonly syncItems: (
    doc: Document,
    items: readonly Item[],
    currentUrl: string,
    getAttachmentPreviewUrl: (id: string) => string | undefined,
  ) => void;
  /** 直前の syncItems と同じ内容でプレビューを当て直す（ページ側の再描画への追従用） */
  readonly resync: () => void;
  readonly restoreAll: () => void;
  readonly withCleanDom: <T>(fn: () => T) => T;
  readonly getResolvedTarget: (seq: number) => ResolvedLiveTarget | undefined;
  /** ページ側の DOM 変更がプレビュー対象に影響したか（作り直し・子要素の増減・文字の更新） */
  readonly isAffectedByMutations: (records: readonly MutationRecord[]) => boolean;
  readonly hasUnresolvedItems: () => boolean;
};

// React などのフレームワークは自分が作った DOM ノードへの参照を持ち続けるため、
// ノードの差し替え（textContent 代入や子要素の付け替え）は再描画時の例外の原因になる。
// ここでは既存ノードを残したまま「文字の値」と「属性」だけを書き換え、
// 戻すときもツールが書いた値のままのときだけ戻す（ページ側が更新した値は尊重する）。
type TextOverride = {
  readonly node: Text;
  readonly original: string;
  readonly applied: string;
};

type AttrOverride = {
  readonly element: Element;
  readonly name: string;
  readonly original: string | null;
  readonly applied: string | null;
};

type Overrides = {
  readonly texts: TextOverride[];
  readonly attrs: AttrOverride[];
  readonly addedNodes: Node[];
};

const setOrRemoveAttr = (el: Element, attr: string, val: string | null): void => {
  if (val === null) {
    el.removeAttribute(attr);
  } else {
    el.setAttribute(attr, val);
  }
};

const overrideAttr = (
  overrides: Overrides,
  element: Element,
  name: string,
  value: string | null,
): void => {
  const original = element.getAttribute(name);
  if (original === value) {
    return;
  }
  overrides.attrs.push({ element, name, original, applied: value });
  setOrRemoveAttr(element, name, value);
};

const appendStyle = (overrides: Overrides, element: Element, cssText: string): void => {
  const prevStyle = element.getAttribute("style") ?? "";
  const sep = prevStyle.length > 0 && !prevStyle.trim().endsWith(";") ? ";" : "";
  overrideAttr(overrides, element, "style", `${prevStyle}${sep}${cssText}`);
};

const overrideText = (overrides: Overrides, node: Text, value: string): void => {
  const original = node.nodeValue ?? "";
  if (original === value) {
    return;
  }
  overrides.texts.push({ node, original, applied: value });
  node.nodeValue = value;
};

const applyLiveText = (
  doc: Document,
  overrides: Overrides,
  element: Element,
  text: string,
): void => {
  const textNodes = collectVisibleTextNodes(doc, element).filter(
    (n) => (n.nodeValue ?? "").trim().length > 0,
  );
  const primary = textNodes.find((n) => n.parentNode === element) ?? textNodes[0];
  if (primary === undefined) {
    const added = doc.createTextNode(text);
    element.appendChild(added);
    overrides.addedNodes.push(added);
    return;
  }
  textNodes.map((n) => overrideText(overrides, n, n === primary ? text : ""));
};

const applyLiveImage = (overrides: Overrides, element: Element, url: string): void => {
  const tag = element.tagName.toLowerCase();
  const img = tag === "picture" ? element.querySelector("img") : tag === "img" ? element : null;
  if (img === null) {
    appendStyle(overrides, element, `background-image:url("${url}") !important;`);
    return;
  }
  overrideAttr(overrides, img, "src", url);
  overrideAttr(overrides, img, "srcset", null);
  const picture = img.parentElement?.tagName.toLowerCase() === "picture" ? img.parentElement : null;
  if (picture !== null) {
    Array.from(picture.querySelectorAll("source")).map((source) =>
      overrideAttr(overrides, source, "srcset", url),
    );
  }
};

const applySingleLiveChange = (
  doc: Document,
  overrides: Overrides,
  element: Element,
  item: Item,
  getAttachmentPreviewUrl: (id: string) => string | undefined,
): void => {
  if (item.after !== undefined) {
    applyLiveText(doc, overrides, element, item.after);
  }
  if (item.hrefAfter !== undefined && isSafeNavigationUrl(item.hrefAfter)) {
    const linkEl = findClosestLink(element) ?? element;
    overrideAttr(overrides, linkEl, "href", item.hrefAfter);
  }
  if (item.changeType === "DELETE") {
    appendStyle(
      overrides,
      element,
      "opacity:0.35 !important;text-decoration:line-through !important;",
    );
  }
  if (item.changeType === "IMAGE_REPLACE") {
    const attId = item.attachmentIds[0];
    const url = attId !== undefined ? getAttachmentPreviewUrl(attId) : undefined;
    if (url !== undefined) {
      applyLiveImage(overrides, element, url);
    }
  }
};

const restoreOverrides = (overrides: Overrides): void => {
  overrides.addedNodes.splice(0).map((node) => node.parentNode?.removeChild(node));
  overrides.attrs
    .splice(0)
    .reverse()
    .map((o) => {
      if (o.element.getAttribute(o.name) === o.applied) {
        setOrRemoveAttr(o.element, o.name, o.original);
      }
    });
  overrides.texts
    .splice(0)
    .reverse()
    .map((o) => {
      if (o.node.nodeValue === o.applied) {
        o.node.nodeValue = o.original;
      }
    });
};

export const createLivePreviewController = (
  hooks: LivePreviewHooks = {},
): LivePreviewController => {
  const overrides: Overrides = { texts: [], attrs: [], addedNodes: [] };
  const resolvedBySeq = new Map<number, ResolvedLiveTarget>();
  const unresolvedSeqs = new Set<number>();
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
  const mutationDepth = { value: 0 };

  const mutate = <T>(fn: () => T): T => {
    if (mutationDepth.value === 0) {
      hooks.beforeMutate?.();
    }
    mutationDepth.value += 1;
    try {
      return fn();
    } finally {
      mutationDepth.value -= 1;
      if (mutationDepth.value === 0) {
        hooks.afterMutate?.();
      }
    }
  };

  const restoreAll = (): void =>
    mutate(() => {
      restoreOverrides(overrides);
      resolvedBySeq.clear();
      unresolvedSeqs.clear();
    });

  const applyItems = (
    doc: Document,
    items: readonly Item[],
    currentUrl: string,
    getAttachmentPreviewUrl: (id: string) => string | undefined,
    getTextIndex: TextIndexProvider,
  ): void => {
    const pageItems = items.filter((item) => item.url === currentUrl);
    const resolvedEntries = pageItems.flatMap((item) => {
      if (item.anchor.kind !== "element") {
        return [];
      }
      const resolved = resolveElementLocator(doc, item.anchor.locator, undefined, getTextIndex);
      if (!resolved.ok || resolved.value.element === null) {
        unresolvedSeqs.add(item.seq);
        return [];
      }
      return [
        { item, element: resolved.value.element, confidence: resolved.value.confidence } as const,
      ];
    });

    // 先に全件を解決してから書き換える（書き換え後の文言で他の項目の解決がずれないように）
    resolvedEntries.map(({ item, element, confidence }) => {
      resolvedBySeq.set(item.seq, { element, confidence });
      applySingleLiveChange(doc, overrides, element, item, getAttachmentPreviewUrl);
    });
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

    mutate(() => {
      restoreAll();
      applyItems(doc, items, currentUrl, getAttachmentPreviewUrl, createTextIndexProvider(doc));
    });
  };

  const resync = (): void => {
    if (lastArgsRef.doc === null) {
      return;
    }
    syncItems(
      lastArgsRef.doc,
      lastArgsRef.items,
      lastArgsRef.currentUrl,
      lastArgsRef.getAttachmentPreviewUrl,
    );
  };

  const withCleanDom = <T>(fn: () => T): T =>
    mutate(() => {
      restoreAll();
      try {
        return fn();
      } finally {
        if (lastArgsRef.items.length > 0) {
          resync();
        }
      }
    });

  const getResolvedTarget = (seq: number): ResolvedLiveTarget | undefined => {
    const entry = resolvedBySeq.get(seq);
    if (entry?.element.isConnected) {
      return entry;
    }
    return undefined;
  };

  const isAffectedByMutations = (records: readonly MutationRecord[]): boolean => {
    const targets = Array.from(resolvedBySeq.values()).map((t) => t.element);
    if (targets.some((el) => !el.isConnected)) {
      return true;
    }
    return records.some((record) => targets.some((el) => el.contains(record.target)));
  };

  return {
    syncItems,
    resync,
    restoreAll,
    withCleanDom,
    getResolvedTarget,
    isAffectedByMutations,
    hasUnresolvedItems: () => unresolvedSeqs.size > 0,
  };
};
