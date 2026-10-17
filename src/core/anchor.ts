import { computeDomPath, findClosestLink, resolveDomPath } from "./dom-path";
export { computeDomPath, findClosestLink, resolveDomPath };
import { finder } from "@medv/finder";
import { type Result, err, ok } from "./result";
import type { AnchorMatchConfidence, ElementLocator, Rect, TextQuote } from "./types";

const CSS_MODULES_HASH_PATTERN = /__[A-Za-z0-9_-]{5}$/;
const REACT_ID_PATTERN = /^:r[0-9a-zA-Z]+:$/;
const MAX_EXACT_LENGTH = 500;
const CONTEXT_LENGTH = 32;

export const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

export const isStableIdName = (name: string): boolean =>
  name.length > 0 && !REACT_ID_PATTERN.test(name);

export const isStableClassName = (name: string): boolean =>
  name.length > 0 && !CSS_MODULES_HASH_PATTERN.test(name);

type TextSegment = {
  readonly node: Node;
  readonly text: string;
  readonly start: number;
  readonly end: number;
};

const NON_TEXT_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe"]);

const isInsideNonTextElement = (node: Node): boolean => {
  const checkParent = (el: Element | null): boolean => {
    if (el === null) {
      return false;
    }
    if (NON_TEXT_TAGS.has(el.tagName.toLowerCase())) {
      return true;
    }
    return checkParent(el.parentElement);
  };
  return checkParent(node.parentElement);
};

const SHOW_ALL = -1;
const TEXT_NODE = 3;

const walkerToIterable = (walker: TreeWalker): Iterable<Node> => ({
  [Symbol.iterator]: (): Iterator<Node> => ({
    next: (): IteratorResult<Node> => {
      const node = walker.nextNode();
      return node === null ? { done: true, value: undefined } : { done: false, value: node };
    },
  }),
});

const collectTextNodes = (root: Node, doc: Document): readonly Node[] =>
  Array.from(walkerToIterable(doc.createTreeWalker(root, SHOW_ALL))).filter(
    (node) => node.nodeType === TEXT_NODE && !isInsideNonTextElement(node),
  );

export const extractCleanElementText = (doc: Document, element: Element): string => {
  const nodes = collectTextNodes(element, doc);
  const raw = nodes.map((n) => n.textContent ?? "").join("");
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, MAX_EXACT_LENGTH);
};

const collectTextSegments = (root: Node, doc: Document): readonly TextSegment[] => {
  const nonEmpty = collectTextNodes(root, doc).filter(
    (node) => (node.textContent ?? "").length > 0,
  );
  const ends = nonEmpty.reduce<number[]>((acc, node) => {
    acc.push((acc[acc.length - 1] ?? 0) + (node.textContent ?? "").length);
    return acc;
  }, []);
  return nonEmpty.map((node, idx) => {
    const text = node.textContent ?? "";
    const end = ends[idx] ?? 0;
    return { node, text, start: end - text.length, end };
  });
};

export const buildTextQuote = (doc: Document, target: Element): TextQuote => {
  const rawExact = extractCleanElementText(doc, target);
  if (rawExact.length === 0 || doc.body === null) {
    return { exact: "", prefix: "", suffix: "" };
  }
  const segments = collectTextSegments(doc.body, doc);
  const fullText = segments.map((s) => s.text).join("");
  const targetSegments = segments.filter((s) => target.contains(s.node));
  const firstSeg = targetSegments[0];
  const lastSeg = targetSegments[targetSegments.length - 1];
  if (firstSeg === undefined || lastSeg === undefined) {
    return { exact: rawExact, prefix: "", suffix: "" };
  }
  const prefixStart = Math.max(0, firstSeg.start - CONTEXT_LENGTH);
  const prefix = fullText.slice(prefixStart, firstSeg.start);
  const suffix = fullText.slice(lastSeg.end, lastSeg.end + CONTEXT_LENGTH);
  return {
    exact: rawExact,
    prefix,
    suffix,
  };
};

export const extractImageSrc = (element: Element): string | undefined => {
  const tag = element.tagName.toLowerCase();
  if (tag === "img") {
    const currentSrc = (element as HTMLImageElement).currentSrc;
    const attrSrc = element.getAttribute("src");
    return currentSrc || attrSrc || undefined;
  }
  if (tag === "picture") {
    const img = element.querySelector("img");
    if (img !== null) {
      return img.currentSrc || img.getAttribute("src") || undefined;
    }
  }
  const styleBg = element.getAttribute("style") ?? "";
  const match = /url\(['"]?([^'")]+)['"]?\)/.exec(styleBg);
  return match?.[1];
};

const generateSafeSelector = (doc: Document, element: Element): string => {
  const testId = element.getAttribute("data-testid");
  if (testId !== null && testId.length > 0) {
    const escaped = testId.replace(/"/g, '\\"');
    const candidate = `[data-testid="${escaped}"]`;
    if (doc.querySelectorAll(candidate).length === 1) {
      return candidate;
    }
  }
  try {
    return finder(element, {
      root: doc.body ?? doc.documentElement,
      idName: isStableIdName,
      className: isStableClassName,
      attr: (name, value) => name === "data-testid" && value.length > 0,
    });
  } catch {
    return element.tagName.toLowerCase();
  }
};

export const captureElementLocator = (doc: Document, element: Element): ElementLocator => {
  const selector = generateSafeSelector(doc, element);
  const textQuote = buildTextQuote(doc, element);
  const tagName = element.tagName.toLowerCase();
  const testId = element.getAttribute("data-testid") ?? undefined;
  const linkEl = findClosestLink(element);
  const href = linkEl?.getAttribute("href") ?? undefined;
  const imageSrc = extractImageSrc(element);
  const domPath = computeDomPath(doc.documentElement, element);

  return {
    selector,
    textQuote,
    tagName,
    ...(testId !== undefined ? { testId } : {}),
    ...(href !== undefined ? { href } : {}),
    ...(imageSrc !== undefined ? { imageSrc } : {}),
    domPath,
  };
};

export type ResolvedElementResult = {
  readonly element: Element | null;
  readonly confidence: AnchorMatchConfidence;
};

const safeQuerySelector = (doc: Document, selector: string): Element | null => {
  if (selector.length === 0) {
    return null;
  }
  try {
    return doc.querySelector(selector);
  } catch {
    return null;
  }
};

const scoreContextMatch = (
  fullText: string,
  matchStart: number,
  matchEnd: number,
  quote: TextQuote,
): number => {
  const normPrefix = normalizeWhitespace(quote.prefix);
  const normSuffix = normalizeWhitespace(quote.suffix);
  const actualPrefix = normalizeWhitespace(
    fullText.slice(Math.max(0, matchStart - CONTEXT_LENGTH * 2), matchStart),
  );
  const actualSuffix = normalizeWhitespace(fullText.slice(matchEnd, matchEnd + CONTEXT_LENGTH * 2));
  const prefixScore =
    normPrefix.length > 0 && actualPrefix.endsWith(normPrefix)
      ? 2
      : normPrefix.length > 0 && actualPrefix.includes(normPrefix)
        ? 1
        : 0;
  const suffixScore =
    normSuffix.length > 0 && actualSuffix.startsWith(normSuffix)
      ? 2
      : normSuffix.length > 0 && actualSuffix.includes(normSuffix)
        ? 1
        : 0;
  return prefixScore + suffixScore;
};

const findCommonAncestorElement = (nodes: readonly Node[], fallback: Element): Element => {
  const first = nodes[0]?.parentElement;
  if (first === undefined || first === null) {
    return fallback;
  }
  const ascend = (el: Element): Element => {
    const containsAll = nodes.every((n) => el.contains(n));
    if (containsAll || el.parentElement === null) {
      return el;
    }
    return ascend(el.parentElement);
  };
  return ascend(first);
};

const findOccurrences = (text: string, needle: string): readonly number[] => {
  if (needle.length === 0) {
    return [];
  }
  return Array.from({ length: text.length - needle.length + 1 }, (_, idx) => idx).filter((idx) =>
    text.startsWith(needle, idx),
  );
};

const searchByTextQuote = (doc: Document, locator: ElementLocator): Element | null => {
  const root = doc.body ?? doc.documentElement;
  const normExact = normalizeWhitespace(locator.textQuote.exact);
  if (normExact.length === 0) {
    return null;
  }
  const segments = collectTextSegments(root, doc);
  const fullText = segments.map((s) => s.text).join("");
  const rawIndices = findOccurrences(fullText, locator.textQuote.exact);

  if (rawIndices.length > 0) {
    const scored = rawIndices.map((start) => {
      const end = start + locator.textQuote.exact.length;
      const score = scoreContextMatch(fullText, start, end, locator.textQuote);
      const overlapping = segments.filter((s) => s.end > start && s.start < end).map((s) => s.node);
      const element = findCommonAncestorElement(overlapping, root);
      return { element, score };
    });
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    return best.element;
  }

  // Whitespace-normalized fallback scan across elements
  const allElements = Array.from(root.querySelectorAll(locator.tagName || "*"));
  const matchingElements = allElements.filter(
    (el) => normalizeWhitespace(el.textContent ?? "") === normExact,
  );
  return matchingElements[0] ?? null;
};

export const resolveElementLocator = (
  doc: Document,
  locator: ElementLocator,
): Result<ResolvedElementResult, string> => {
  const bySelector = safeQuerySelector(doc, locator.selector);
  const normTarget = normalizeWhitespace(locator.textQuote.exact);

  if (bySelector !== null) {
    const normActual = normalizeWhitespace(bySelector.textContent ?? "");
    if (normTarget.length === 0 || normActual === normTarget) {
      return ok({ element: bySelector, confidence: "exact_selector" });
    }
  }

  const byQuote = searchByTextQuote(doc, locator);
  if (byQuote !== null) {
    return ok({ element: byQuote, confidence: "text_quote" });
  }

  if (bySelector !== null) {
    return ok({ element: bySelector, confidence: "selector_only" });
  }

  return err("Target element could not be resolved");
};

export const hasFormattingChildren = (element: Element): boolean => element.children.length > 0;

export const computeSmallestContainingElement = (
  doc: Document,
  region: Rect,
  getRect: (el: Element) => Rect,
): Element => {
  const root = doc.body ?? doc.documentElement;
  const allElements = Array.from(root.querySelectorAll("*"));
  const containing = allElements.filter((el) => {
    const r = getRect(el);
    return (
      r.w > 0 &&
      r.h > 0 &&
      r.x <= region.x &&
      r.y <= region.y &&
      r.x + r.w >= region.x + region.w &&
      r.y + r.h >= region.y + region.h
    );
  });
  if (containing.length === 0) {
    return root;
  }
  return containing.reduce((smallest, el) => {
    const rSmall = getRect(smallest);
    const rEl = getRect(el);
    return rEl.w * rEl.h <= rSmall.w * rSmall.h ? el : smallest;
  });
};

export const expandSelectionTarget = (
  current: Element,
  getRect: (el: Element) => Rect,
): Element | null => {
  const currentRect = getRect(current);
  const stepUp = (el: Element | null): Element | null => {
    if (el === null || el.tagName.toLowerCase() === "html" || el.tagName.toLowerCase() === "body") {
      return null;
    }
    const r = getRect(el);
    const isLarger = r.w > currentRect.w + 2 || r.h > currentRect.h + 2;
    if (isLarger) {
      return el;
    }
    return stepUp(el.parentElement);
  };
  return stepUp(current.parentElement);
};
