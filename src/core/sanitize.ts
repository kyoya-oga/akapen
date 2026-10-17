export const HOST_ELEMENT_ID = "pcr-bookmarklet-host";

const EXCLUDED_PATH_PATTERNS: readonly RegExp[] = [
  /^\/mypage(\/|$)/i,
  /^\/account(\/|$)/i,
  /^\/orders?(\/|$)/i,
  /^\/history(\/|$)/i,
  /^\/checkout(\/|$)/i,
  /^\/cart(\/|$)/i,
  /^\/payment(\/|$)/i,
  /^\/profile(\/|$)/i,
  /^\/settings(\/|$)/i,
  /^\/address(\/|$)/i,
];

export const shouldExcludeSnapshotForUrl = (urlStr: string): boolean => {
  try {
    const parsed = new URL(urlStr, "https://example.com");
    return EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(parsed.pathname));
  } catch {
    return false;
  }
};

const PASSTHROUGH_URL_PREFIXES: readonly string[] = ["data:", "blob:", "pcr-res:", "#"];

export const toAbsoluteUrl = (rawUrl: string, baseUrl: string): string => {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || PASSTHROUGH_URL_PREFIXES.some((p) => trimmed.startsWith(p))) {
    return trimmed;
  }
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
};

export const rewriteCssUrlsToAbsolute = (cssText: string, baseUrl: string): string =>
  cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_match, quote: string, urlPart: string) => {
    const abs = toAbsoluteUrl(urlPart, baseUrl);
    return `url(${quote}${abs}${quote})`;
  });

export const extractCssUrls = (cssText: string, baseUrl: string): readonly string[] => {
  const matches = Array.from(cssText.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g));
  return matches
    .map((m) => toAbsoluteUrl(m[2] ?? "", baseUrl))
    .filter((u) => u.startsWith("http://") || u.startsWith("https://"));
};

const BUTTON_INPUT_TYPES = new Set(["submit", "button", "reset"]);
const CHECKABLE_INPUT_TYPES = new Set(["checkbox", "radio"]);

const sanitizeInputElement = (inputEl: HTMLInputElement): void => {
  const inputType = (inputEl.getAttribute("type") ?? "text").toLowerCase();
  if (CHECKABLE_INPUT_TYPES.has(inputType)) {
    if (inputEl.checked) {
      inputEl.setAttribute("checked", "");
    } else {
      inputEl.removeAttribute("checked");
    }
    inputEl.removeAttribute("value");
    return;
  }
  if (!BUTTON_INPUT_TYPES.has(inputType)) {
    inputEl.value = "";
    inputEl.setAttribute("value", "");
  }
};

const sanitizeFormElement = (el: Element): void => {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    sanitizeInputElement(el as HTMLInputElement);
    return;
  }
  if (tag === "textarea") {
    const area = el as HTMLTextAreaElement;
    area.value = "";
    area.textContent = "";
    return;
  }
  if (tag === "option") {
    const opt = el as HTMLOptionElement;
    if (opt.selected) {
      opt.setAttribute("selected", "");
    } else {
      opt.removeAttribute("selected");
    }
  }
};

const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction"]);
const DANGEROUS_URL_PATTERN = /^(javascript:|vbscript:|data:text\/html)/i;

const sanitizeUrlAttribute = (
  el: Element,
  attrName: string,
  val: string,
  baseUrl: string,
): void => {
  if (DANGEROUS_URL_PATTERN.test(val.trim())) {
    el.setAttribute(attrName, "#");
    return;
  }
  if (attrName === "href" || attrName === "src") {
    el.setAttribute(attrName, toAbsoluteUrl(val, baseUrl));
  }
};

const sanitizeSingleAttribute = (el: Element, attr: Attr, baseUrl: string): void => {
  const name = attr.name.toLowerCase();
  if (name.startsWith("on")) {
    el.removeAttribute(attr.name);
    return;
  }
  if (URL_ATTRIBUTES.has(name)) {
    sanitizeUrlAttribute(el, attr.name, attr.value, baseUrl);
    return;
  }
  if (name === "srcset") {
    el.removeAttribute("srcset");
    return;
  }
  if (name === "style") {
    el.setAttribute("style", rewriteCssUrlsToAbsolute(attr.value, baseUrl));
  }
};

const sanitizeAttributes = (el: Element, baseUrl: string): void => {
  Array.from(el.attributes).map((attr) => sanitizeSingleAttribute(el, attr, baseUrl));
};

const REMOVABLE_TAGS = new Set(["script", "noscript", "object", "embed", "applet"]);
const REMOVABLE_LINK_RELS = new Set(["preload", "modulepreload", "prefetch", "prerender"]);

const isSensitiveMeta = (el: Element): boolean => {
  const httpEquiv = (el.getAttribute("http-equiv") ?? "").toLowerCase();
  const name = (el.getAttribute("name") ?? "").toLowerCase();
  return (
    httpEquiv === "refresh" ||
    httpEquiv === "content-security-policy" ||
    name.includes("csrf") ||
    name.includes("token")
  );
};

const shouldReplaceWithEmptyTemplate = (el: Element): boolean => {
  const tag = el.tagName.toLowerCase();
  if (REMOVABLE_TAGS.has(tag)) {
    return true;
  }
  if (tag === "link") {
    const rel = (el.getAttribute("rel") ?? "").toLowerCase();
    return REMOVABLE_LINK_RELS.has(rel);
  }
  return tag === "meta" && isSensitiveMeta(el);
};

const replaceWithPlaceholder = (doc: Document, el: Element): void => {
  const tag = el.tagName.toLowerCase();
  if (tag === "iframe") {
    const placeholder = doc.createElement("div");
    const width = el.getAttribute("width") ?? "100%";
    const height = el.getAttribute("height") ?? "150px";
    placeholder.setAttribute("data-pcr-iframe-placeholder", "true");
    placeholder.setAttribute(
      "style",
      `display:inline-block;width:${width};height:${height};background:#f1f5f9;border:1px dashed #94a3b8;`,
    );
    el.replaceWith(placeholder);
    return;
  }
  const tmpl = doc.createElement("template");
  tmpl.setAttribute("data-pcr-removed", tag);
  el.replaceWith(tmpl);
};

const syncSelectOptions = (liveSelect: HTMLSelectElement, cloneSelect: HTMLSelectElement): void => {
  const liveOpts = Array.from(liveSelect.options);
  const cloneOpts = Array.from(cloneSelect.options);
  liveOpts.map((opt, optIdx) => {
    const cOpt = cloneOpts[optIdx];
    if (cOpt === undefined) {
      return;
    }
    if (opt.selected) {
      cOpt.setAttribute("selected", "");
    } else {
      cOpt.removeAttribute("selected");
    }
  });
};

const syncSingleLiveElement = (liveEl: Element, cloneEl: Element): void => {
  sanitizeFormElement(cloneEl);
  const tag = liveEl.tagName.toLowerCase();
  if (tag === "input") {
    sanitizeInputElement(cloneEl as HTMLInputElement);
  } else if (tag === "select") {
    syncSelectOptions(liveEl as HTMLSelectElement, cloneEl as HTMLSelectElement);
  } else if (tag === "img") {
    const liveImg = liveEl as HTMLImageElement;
    if (liveImg.currentSrc && liveImg.currentSrc.length > 0) {
      cloneEl.setAttribute("src", liveImg.currentSrc);
    }
  }
  if (liveEl.scrollTop > 0 || liveEl.scrollLeft > 0) {
    cloneEl.setAttribute("data-pcr-scroll-top", String(liveEl.scrollTop));
    cloneEl.setAttribute("data-pcr-scroll-left", String(liveEl.scrollLeft));
  }
};

export const syncLiveDomStateBeforeClone = (liveRoot: Element, cloneRoot: Element): void => {
  const liveElements = Array.from(liveRoot.querySelectorAll("*"));
  const cloneElements = Array.from(cloneRoot.querySelectorAll("*"));
  if (liveElements.length !== cloneElements.length) {
    return;
  }
  liveElements.map((liveEl, idx) => {
    const cloneEl = cloneElements[idx];
    if (cloneEl !== undefined) {
      syncSingleLiveElement(liveEl, cloneEl);
    }
  });
};

export const sanitizeClonedDocument = (doc: Document, baseUrl: string): void => {
  const host = doc.getElementById(HOST_ELEMENT_ID);
  if (host !== null) {
    host.remove();
  }
  const allElements = Array.from(doc.documentElement.querySelectorAll("*"));
  allElements.map((el) => {
    if (shouldReplaceWithEmptyTemplate(el) || el.tagName.toLowerCase() === "iframe") {
      replaceWithPlaceholder(doc, el);
      return;
    }
    sanitizeFormElement(el);
    sanitizeAttributes(el, baseUrl);
    if (el.tagName.toLowerCase() === "style") {
      const css = el.textContent ?? "";
      el.textContent = rewriteCssUrlsToAbsolute(css, baseUrl);
    }
  });
};

export const collectImageUrlsFromClonedRoot = (
  root: Element,
  baseUrl: string,
): readonly string[] => {
  const imgUrls = Array.from(root.querySelectorAll("img"))
    .map((img) => toAbsoluteUrl(img.getAttribute("src") ?? "", baseUrl))
    .filter((u) => u.startsWith("http://") || u.startsWith("https://"));

  const styleUrls = Array.from(root.querySelectorAll("[style]")).flatMap((el) =>
    extractCssUrls(el.getAttribute("style") ?? "", baseUrl),
  );

  const styleSheetUrls = Array.from(root.querySelectorAll("style")).flatMap((el) =>
    extractCssUrls(el.textContent ?? "", baseUrl),
  );

  return Array.from(new Set([...imgUrls, ...styleUrls, ...styleSheetUrls]));
};

export const replaceImageUrlsWithResourceHashes = (
  root: Element,
  baseUrl: string,
  urlToHash: Readonly<Record<string, string>>,
): void => {
  Array.from(root.querySelectorAll("img")).map((img) => {
    const abs = toAbsoluteUrl(img.getAttribute("src") ?? "", baseUrl);
    const hash = urlToHash[abs];
    if (hash !== undefined) {
      img.setAttribute("src", `pcr-res:${hash}`);
    }
  });

  const replaceInCss = (css: string): string =>
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (full, quote: string, rawUrl: string) => {
      const abs = toAbsoluteUrl(rawUrl, baseUrl);
      const hash = urlToHash[abs];
      return hash === undefined ? full : `url(${quote}pcr-res:${hash}${quote})`;
    });

  Array.from(root.querySelectorAll("[style]")).map((el) => {
    const styleVal = el.getAttribute("style") ?? "";
    el.setAttribute("style", replaceInCss(styleVal));
  });

  Array.from(root.querySelectorAll("style")).map((el) => {
    const css = el.textContent ?? "";
    el.textContent = replaceInCss(css);
  });
};
