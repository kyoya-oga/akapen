export const TOOL_VERSION = "0.3.0";
export const SCHEMA_VERSION = 1 as const;

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

export type TextQuote = {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
};

export type ElementLocator = {
  readonly selector: string;
  readonly textQuote: TextQuote;
  readonly tagName: string;
  readonly testId?: string;
  readonly href?: string;
  readonly imageSrc?: string;
  readonly domPath: readonly number[];
};

export type Anchor =
  | { readonly kind: "element"; readonly locator: ElementLocator; readonly rect: Rect }
  | {
      readonly kind: "region";
      readonly container: ElementLocator;
      readonly ratio: Rect;
      readonly pageRect: Rect;
    }
  | { readonly kind: "pageMeta" };

export type ChangeType =
  | "TEXT_REPLACE"
  | "LINK_CHANGE"
  | "TEXT_AND_LINK_CHANGE"
  | "IMAGE_REPLACE"
  | "DELETE"
  | "PAGE_META"
  | "OTHER";

export type PageMetaField = "title" | "description" | "ogTitle" | "ogDescription" | "ogImage";

export type PageMetaValues = {
  readonly title: string;
  readonly description: string;
  readonly ogTitle: string;
  readonly ogDescription: string;
  readonly ogImage: string;
};

export type PageMetaDiff = {
  readonly field: PageMetaField;
  readonly before: string;
  readonly after: string;
};

export type Item = {
  readonly seq: number;
  readonly url: string;
  readonly snapshotId?: string;
  readonly anchor: Anchor;
  readonly changeType: ChangeType;
  readonly before?: string;
  readonly after?: string;
  readonly hrefBefore?: string;
  readonly hrefAfter?: string;
  readonly meta?: readonly PageMetaDiff[];
  readonly memo?: string;
  readonly attachmentIds: readonly string[];
  readonly hasChildFormatting?: boolean;
};

export type SnapshotMeta = {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly viewport: { readonly w: number; readonly h: number };
  readonly scroll: { readonly x: number; readonly y: number };
  readonly capturedAt: string;
  /** スナップショット本文が参照する画像・フォントのハッシュ（未参照リソースの除外に使う） */
  readonly resourceHashes?: readonly string[];
};

export type AttachmentMeta = {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly resourceHash: string;
};

export type ChangeRequestDoc = {
  readonly schemaVersion: 1;
  readonly toolVersion: string;
  readonly createdAt: string;
  readonly origin: string;
  readonly snapshots: readonly SnapshotMeta[];
  readonly items: readonly Item[];
  readonly attachments: readonly AttachmentMeta[];
};

export type TargetKind = "text" | "link" | "image" | "region" | "pageMeta";

export type DraftEditorState = {
  readonly editingSeq?: number;
  readonly targetKind: TargetKind;
  readonly anchor: Anchor;
  readonly expansionHistory: readonly ElementLocator[];
  readonly initialText: string;
  readonly currentText: string;
  readonly initialHref?: string;
  readonly currentHref?: string;
  readonly initialMeta?: PageMetaValues;
  readonly currentMeta?: PageMetaValues;
  readonly memo: string;
  readonly attachmentId?: string;
  readonly attachmentPreviewUrl?: string;
  readonly isDeleteRequested: boolean;
  readonly hasChildFormatting: boolean;
  readonly popoverRect: Rect;
  /** エディタを開いた時点の入力内容。未確定の変更があるかの判定に使う */
  readonly pristineKey?: string;
};

export type AnchorMatchConfidence =
  | "exact_selector"
  | "text_quote"
  | "selector_only"
  | "fallback_rect";

export type ResolvedAnchor = {
  readonly seq: number;
  readonly rect: Rect;
  readonly confidence: AnchorMatchConfidence;
};

export type DraftRecord = {
  readonly id: "active" | "completed";
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly nextSeq: number;
  readonly items: readonly Item[];
  readonly snapshots: readonly SnapshotMeta[];
  readonly attachments: readonly AttachmentMeta[];
};
