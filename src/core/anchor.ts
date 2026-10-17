import { computeDomPath, findClosestLink, resolveDomPath } from "./dom-path";
export { computeDomPath, findClosestLink, resolveDomPath };
import { finder } from "@medv/finder";
import { type Result, err, ok } from "./result";
import type { AnchorMatchConfidence, ElementLocator, Rect, TextQuote } from "./types";

const CSS_MODULES_HASH_PATTERN = /__[A-Za-z0-9_-]{5}$/;
// emotion (css-1x2y3z), styled-components (sc-xxxx と kXbTqG のような乱数名), styled-jsx (jsx-1234)
const CSS_IN_JS_CLASS_PATTERNS: readonly RegExp[] = [
  /^css-[a-z0-9]+(-[A-Za-z0-9_]+)?$/,
  /^sc-[A-Za-z0-9]+$/,
  /^jsx-\d+$/,
  /^(?=[a-zA-Z]*[a-z])(?=[a-zA-Z]*[A-Z])[a-zA-Z]{5,7}$/,
];
const REACT_ID_PATTERN = /^(:r[0-9a-zA-Z]+:|«r[0-9a-zA-Z]+»|_R_[0-9a-zA-Z_]+_)$/;
const MAX_EXACT_LENGTH = 500;
const CONTEXT_LENGTH = 32;

export const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

export const isStableIdName = (name: string): boolean =>
  name.length > 0 && !REACT_ID_PATTERN.test(name);

export const isStableClassName = (name: string): boolean =>
  name.length > 0 &&
  !CSS_MODULES_HASH_PATTERN.test(name) &&
  !CSS_IN_JS_CLASS_PATTERNS.some((pattern) => pattern.test(name));

type TextSegment = {
  readonly node: Node;
  readonly text: string;
  readonly start: number;
  readonly end: number;
};

const NON_TEXT_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe"]);

const NON_TEXT_SELECTOR = Array.from(NON_TEXT_TAGS).join(",");
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

const isNonTextElement = (el: Element): boolean => NON_TEXT_TAGS.has(el.tagName.toLowerCase());

const isInsideNonTextElement = (node: Node): boolean => {
  const startEl = node.nodeType === TEXT_NODE ? node.parentElement : (node as Element);
  return (startEl?.closest(NON_TEXT_SELECTOR) ?? null) !== null;
};

// script / style などはサブツリーごと飛ばし、祖先を毎回たどらない。
// 深い DOM でもスタックが溢れないよう再帰ではなく明示的なスタックで走査する
const shouldDescendInto = (node: Node, root: Node): boolean =>
  node === root || (node.nodeType === ELEMENT_NODE && !isNonTextElement(node as Element));

const collectTextNodes = (root: Node, _doc: Document): readonly Node[] => {
  if (isInsideNonTextElement(root)) {
    return [];
  }
  const result: Node[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (node.nodeType === TEXT_NODE) {
      result.push(node);
    } else if (shouldDescendInto(node, root)) {
      stack.push(...Array.from(node.childNodes).reverse());
    }
  }
  return result;
};

export const collectVisibleTextNodes = (doc: Document, root: Element): readonly Text[] =>
  collectTextNodes(root, doc) as readonly Text[];

export const extractFullElementText = (doc: Document, element: Element): string => {
  const nodes = collectTextNodes(element, doc);
  const raw = nodes.map((n) => n.textContent ?? "").join("");
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
};

export const extractCleanElementText = (doc: Document, element: Element): string =>
  extractFullElementText(doc, element).slice(0, MAX_EXACT_LENGTH);

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

export type TextIndex = {
  readonly segments: readonly TextSegment[];
  readonly fullText: string;
};

/** 1 回の解決処理の間だけページ全文の走査結果を使い回すための遅延キャッシュ */
export type TextIndexProvider = () => TextIndex;

export const createTextIndexProvider = (doc: Document): TextIndexProvider => {
  const cache: { value: TextIndex | null } = { value: null };
  return () => {
    if (cache.value === null) {
      const root = doc.body ?? doc.documentElement;
      const segments = collectTextSegments(root, doc);
      cache.value = { segments, fullText: segments.map((s) => s.text).join("") };
    }
    return cache.value;
  };
};

export const buildTextQuote = (doc: Document, target: Element): TextQuote => {
  const rawExact = extractCleanElementText(doc, target);
  if (rawExact.length === 0 || doc.body === null) {
    return { exact: "", prefix: "", suffix: "" };
  }
  const { segments, fullText } = createTextIndexProvider(doc)();
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

const MAX_OCCURRENCES = 200;

const findOccurrences = (text: string, needle: string): readonly number[] => {
  if (needle.length === 0) {
    return [];
  }
  const collect = (from: number, acc: number[]): readonly number[] => {
    const idx = text.indexOf(needle, from);
    if (idx === -1 || acc.length >= MAX_OCCURRENCES) {
      return acc;
    }
    acc.push(idx);
    return collect(idx + 1, acc);
  };
  return collect(0, []);
};

const scoreElementContextInSegments = (
  el: Element,
  segments: readonly TextSegment[],
  fullText: string,
  quote: TextQuote,
): number => {
  const targetSegments = segments.filter((s) => el.contains(s.node));
  const firstSeg = targetSegments[0];
  const lastSeg = targetSegments[targetSegments.length - 1];
  if (firstSeg === undefined || lastSeg === undefined) {
    return 0;
  }
  return scoreContextMatch(fullText, firstSeg.start, lastSeg.end, quote);
};

const matchesNormalizedText = (doc: Document, el: Element, normExact: string): boolean => {
  const normRaw = normalizeWhitespace(el.textContent ?? "");
  if (normRaw === normExact) {
    return true;
  }
  if (!normRaw.includes(normExact) || el.querySelector(NON_TEXT_SELECTOR) === null) {
    return false;
  }
  return normalizeWhitespace(extractCleanElementText(doc, el)) === normExact;
};

const searchByTextQuote = (
  doc: Document,
  locator: ElementLocator,
  getTextIndex: TextIndexProvider,
): Element | null => {
  const root = doc.body ?? doc.documentElement;
  const normExact = normalizeWhitespace(locator.textQuote.exact);
  if (normExact.length === 0) {
    return null;
  }
  const { segments, fullText } = getTextIndex();
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

  // Whitespace-normalized fallback scan across elements (with context scoring)
  const allElements = Array.from(root.querySelectorAll(locator.tagName || "*"));
  const matchingElements = allElements.filter((el) => matchesNormalizedText(doc, el, normExact));
  if (matchingElements.length === 0) {
    return null;
  }
  const scoredElements = matchingElements.map((element) => ({
    element,
    score: scoreElementContextInSegments(element, segments, fullText, locator.textQuote),
  }));
  return scoredElements.reduce((a, b) => (b.score > a.score ? b : a)).element;
};

const doesElementMatchText = (doc: Document, element: Element, expectedText: string): boolean => {
  const normExpected = normalizeWhitespace(expectedText.slice(0, MAX_EXACT_LENGTH));
  if (normExpected.length === 0) {
    return true;
  }
  const normClean = normalizeWhitespace(extractCleanElementText(doc, element));
  const normRaw = normalizeWhitespace(element.textContent ?? "");
  return normClean === normExpected || normRaw === normalizeWhitespace(expectedText);
};

export const resolveElementLocator = (
  doc: Document,
  locator: ElementLocator,
  expectedAfterText?: string,
  getTextIndex: TextIndexProvider = createTextIndexProvider(doc),
): Result<ResolvedElementResult, string> => {
  const bySelector = safeQuerySelector(doc, locator.selector);

  if (bySelector !== null) {
    const matchesBefore = doesElementMatchText(doc, bySelector, locator.textQuote.exact);
    const matchesAfter =
      expectedAfterText !== undefined && doesElementMatchText(doc, bySelector, expectedAfterText);
    if (matchesBefore || matchesAfter) {
      return ok({ element: bySelector, confidence: "exact_selector" });
    }
  }

  const byAfterQuote =
    expectedAfterText !== undefined && expectedAfterText.trim().length > 0
      ? searchByTextQuote(
          doc,
          {
            ...locator,
            textQuote: {
              ...locator.textQuote,
              exact: expectedAfterText.slice(0, MAX_EXACT_LENGTH),
            },
          },
          getTextIndex,
        )
      : null;
  if (byAfterQuote !== null) {
    return ok({ element: byAfterQuote, confidence: "text_quote" });
  }

  const byQuote = searchByTextQuote(doc, locator, getTextIndex);
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
