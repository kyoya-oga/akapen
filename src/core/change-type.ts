import type { ChangeType, PageMetaDiff, PageMetaField, PageMetaValues } from "./types";

export type ChangeEvaluationInput =
  | {
      readonly kind: "text";
      readonly initialText: string;
      readonly currentText: string;
      readonly memo: string;
      readonly isDeleteRequested: boolean;
    }
  | {
      readonly kind: "link";
      readonly initialText: string;
      readonly currentText: string;
      readonly initialHref: string;
      readonly currentHref: string;
      readonly memo: string;
      readonly isDeleteRequested: boolean;
    }
  | {
      readonly kind: "image";
      readonly attachmentId?: string;
      readonly memo: string;
      readonly isDeleteRequested: boolean;
    }
  | {
      readonly kind: "region";
      readonly memo: string;
    }
  | {
      readonly kind: "pageMeta";
      readonly initialMeta: PageMetaValues;
      readonly currentMeta: PageMetaValues;
      readonly memo: string;
    };

const evaluateTextChange = (
  initialText: string,
  currentText: string,
  memo: string,
  isDeleteRequested: boolean,
): ChangeType | null => {
  if (isDeleteRequested) {
    return "DELETE";
  }
  if (currentText !== initialText) {
    return "TEXT_REPLACE";
  }
  if (memo.trim().length > 0) {
    return "OTHER";
  }
  return null;
};

const evaluateLinkChange = (
  initialText: string,
  currentText: string,
  initialHref: string,
  currentHref: string,
  memo: string,
  isDeleteRequested: boolean,
): ChangeType | null => {
  if (isDeleteRequested) {
    return "DELETE";
  }
  const textChanged = currentText !== initialText;
  const hrefChanged = currentHref.trim() !== initialHref.trim();
  if (textChanged && hrefChanged) {
    return "TEXT_AND_LINK_CHANGE";
  }
  if (textChanged) {
    return "TEXT_REPLACE";
  }
  if (hrefChanged) {
    return "LINK_CHANGE";
  }
  if (memo.trim().length > 0) {
    return "OTHER";
  }
  return null;
};

const evaluateImageChange = (
  attachmentId: string | undefined,
  memo: string,
  isDeleteRequested: boolean,
): ChangeType | null => {
  if (isDeleteRequested) {
    return "DELETE";
  }
  if (attachmentId !== undefined && attachmentId.length > 0) {
    return "IMAGE_REPLACE";
  }
  if (memo.trim().length > 0) {
    return "OTHER";
  }
  return null;
};

export const computePageMetaDiffs = (
  initialMeta: PageMetaValues,
  currentMeta: PageMetaValues,
): readonly PageMetaDiff[] => {
  const fields: readonly PageMetaField[] = [
    "title",
    "description",
    "ogTitle",
    "ogDescription",
    "ogImage",
  ];
  return fields.flatMap((field): readonly PageMetaDiff[] => {
    const before = initialMeta[field];
    const after = currentMeta[field];
    if (before === after) {
      return [];
    }
    return [{ field, before, after }];
  });
};

export const determineChangeType = (input: ChangeEvaluationInput): ChangeType | null => {
  switch (input.kind) {
    case "text": {
      return evaluateTextChange(
        input.initialText,
        input.currentText,
        input.memo,
        input.isDeleteRequested,
      );
    }
    case "link": {
      return evaluateLinkChange(
        input.initialText,
        input.currentText,
        input.initialHref,
        input.currentHref,
        input.memo,
        input.isDeleteRequested,
      );
    }
    case "image": {
      return evaluateImageChange(input.attachmentId, input.memo, input.isDeleteRequested);
    }
    case "region": {
      return input.memo.trim().length > 0 ? "OTHER" : null;
    }
    case "pageMeta": {
      const diffs = computePageMetaDiffs(input.initialMeta, input.currentMeta);
      if (diffs.length > 0 || input.memo.trim().length > 0) {
        return "PAGE_META";
      }
      return null;
    }
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
};
