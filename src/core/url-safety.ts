// biome-ignore lint/suspicious/noControlCharactersInRegex: strips control chars on purpose
const IGNORED_CHARS_PATTERN = /[\u0000-\u0020\u007f-\u009f\u200b\u200c\u2028\u2029\ufeff]|\u200d/g;
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

const NAVIGABLE_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel"]);
const BLOCKED_SCHEMES: ReadonlySet<string> = new Set(["javascript", "vbscript"]);

const normalizeForSchemeCheck = (value: string): string => value.replace(IGNORED_CHARS_PATTERN, "");

const extractScheme = (value: string): string | null => {
  const match = SCHEME_PATTERN.exec(normalizeForSchemeCheck(value));
  return match?.[1]?.toLowerCase() ?? null;
};

export const isSafeNavigationUrl = (value: string): boolean => {
  const scheme = extractScheme(value);
  return scheme === null || NAVIGABLE_SCHEMES.has(scheme);
};

export const isDangerousUrl = (value: string): boolean => {
  const scheme = extractScheme(value);
  if (scheme === null) {
    return false;
  }
  if (BLOCKED_SCHEMES.has(scheme)) {
    return true;
  }
  return scheme === "data" && /^data:text\/html/i.test(normalizeForSchemeCheck(value));
};
