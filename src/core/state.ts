import { computePageMetaDiffs, determineChangeType } from "./change-type";
import { extractPathname } from "./markdown";
import type {
  Anchor,
  AttachmentMeta,
  ChangeType,
  DraftEditorState,
  DraftRecord,
  ElementLocator,
  Item,
  PageMetaDiff,
  PageMetaValues,
  Rect,
  ResolvedAnchor,
  SnapshotMeta,
  TargetKind,
} from "./types";
import { isSafeNavigationUrl } from "./url-safety";

export type AppState = {
  readonly isVisible: boolean;
  readonly isPaused: boolean;
  readonly isAltPressed: boolean;
  readonly isQuickListOpen: boolean;
  readonly barPosition: { readonly x: number; readonly y: number };
  readonly currentUrl: string;
  readonly isIncognitoWarning: boolean;
  readonly hasRecentCompletedDraft: boolean;
  readonly nextSeq: number;
  readonly items: readonly Item[];
  readonly snapshots: readonly SnapshotMeta[];
  readonly attachments: readonly AttachmentMeta[];
  /** 確定済みだが画面スナップショットの記録が終わっていない項目 */
  readonly pendingSnapshotSeqs: readonly number[];
  readonly hoveredRect: Rect | null;
  readonly dragSelectionRect: Rect | null;
  readonly resolvedAnchors: readonly ResolvedAnchor[];
  readonly editor: DraftEditorState | null;
  readonly statusMessage: string | null;
};

export type Effect =
  | { readonly type: "SYNC_LIVE_DOM"; readonly items: readonly Item[] }
  | { readonly type: "RESTORE_ALL_LIVE_DOM" }
  | { readonly type: "SAVE_DRAFT_DEBOUNCED" }
  | { readonly type: "CLEAR_DRAFT_DB" }
  | { readonly type: "LOAD_COMPLETED_DRAFT_FROM_DB" }
  | { readonly type: "CAPTURE_SNAPSHOT_FOR_ITEM"; readonly item: Item }
  | { readonly type: "SCROLL_TO_ITEM"; readonly item: Item }
  | { readonly type: "OPEN_EDITOR_FOR_ITEM"; readonly seq: number }
  | { readonly type: "EXPAND_EDITOR_SELECTION" }
  | { readonly type: "SHRINK_EDITOR_SELECTION" }
  | { readonly type: "COMPLETE_AND_EXPORT" }
  | { readonly type: "DESTROY_APP" };

export type AppEvent =
  | { readonly type: "TOGGLE_VISIBILITY" }
  | { readonly type: "SET_PAUSED"; readonly isPaused: boolean }
  | { readonly type: "SET_ALT_PRESSED"; readonly isAltPressed: boolean }
  | { readonly type: "TOGGLE_QUICK_LIST" }
  | { readonly type: "MOVE_BAR"; readonly x: number; readonly y: number }
  | { readonly type: "URL_CHANGED"; readonly url: string }
  | { readonly type: "SET_INCOGNITO_WARNING"; readonly isIncognito: boolean }
  | {
      readonly type: "HYDRATE_DRAFT";
      readonly draft: DraftRecord;
      readonly hasCompletedDraft: boolean;
    }
  | { readonly type: "UPDATE_HOVER_RECT"; readonly rect: Rect | null }
  | { readonly type: "UPDATE_DRAG_RECT"; readonly rect: Rect | null }
  | { readonly type: "UPDATE_RESOLVED_ANCHORS"; readonly anchors: readonly ResolvedAnchor[] }
  | {
      readonly type: "OPEN_EDITOR";
      readonly editor: DraftEditorState;
    }
  | {
      readonly type: "UPDATE_EDITOR_LOCATOR";
      readonly locator: ElementLocator;
      readonly rect: Rect;
      readonly expansionHistory: readonly ElementLocator[];
      readonly initialText: string;
      readonly hasChildFormatting: boolean;
    }
  | { readonly type: "UPDATE_EDITOR_TEXT"; readonly text: string }
  | { readonly type: "UPDATE_EDITOR_HREF"; readonly href: string }
  | { readonly type: "UPDATE_EDITOR_META"; readonly meta: PageMetaValues }
  | { readonly type: "UPDATE_EDITOR_MEMO"; readonly memo: string }
  | {
      readonly type: "ATTACH_IMAGE_READY";
      readonly attachment: AttachmentMeta;
      readonly previewUrl: string;
    }
  | { readonly type: "REQUEST_DELETE_IN_EDITOR" }
  | { readonly type: "REQUEST_EXPAND_SELECTION" }
  | { readonly type: "REQUEST_SHRINK_SELECTION" }
  | { readonly type: "CLOSE_EDITOR" }
  | { readonly type: "CONFIRM_EDITOR" }
  | {
      readonly type: "SNAPSHOT_CAPTURED_FOR_ITEM";
      readonly seq: number;
      readonly snapshot?: SnapshotMeta;
    }
  | { readonly type: "DELETE_ITEM"; readonly seq: number }
  | { readonly type: "SELECT_QUICK_LIST_ITEM"; readonly seq: number }
  | { readonly type: "RESET_ALL_CONFIRMED" }
  | { readonly type: "REOPEN_RECENT_COMPLETED" }
  | { readonly type: "REQUEST_COMPLETE" }
  | { readonly type: "EXPORT_FINISHED"; readonly message: string }
  | { readonly type: "OPERATION_FAILED"; readonly message: string }
  | { readonly type: "SHOW_STATUS"; readonly message: string }
  | { readonly type: "CLEAR_STATUS" }
  | { readonly type: "CLOSE_TOOL" };

export type UpdateResult = {
  readonly state: AppState;
  readonly effects: readonly Effect[];
};

export const createInitialState = (currentUrl: string): AppState => ({
  isVisible: true,
  isPaused: false,
  isAltPressed: false,
  isQuickListOpen: false,
  barPosition: { x: 24, y: 24 },
  currentUrl,
  isIncognitoWarning: false,
  hasRecentCompletedDraft: false,
  nextSeq: 1,
  items: [],
  snapshots: [],
  attachments: [],
  pendingSnapshotSeqs: [],
  hoveredRect: null,
  dragSelectionRect: null,
  resolvedAnchors: [],
  editor: null,
  statusMessage: null,
});

const computeEditorKey = (editor: DraftEditorState): string =>
  JSON.stringify([
    editor.currentText,
    editor.currentHref ?? null,
    editor.currentMeta ?? null,
    editor.memo,
    editor.attachmentId ?? null,
    editor.isDeleteRequested,
  ]);

const withPristineKey = (editor: DraftEditorState): DraftEditorState => ({
  ...editor,
  pristineKey: computeEditorKey(editor),
});

/** エディタを開いてから入力内容が変わったか（別の要素へ移るときの破棄確認に使う） */
export const isEditorDirty = (editor: DraftEditorState): boolean =>
  editor.pristineKey !== undefined && computeEditorKey(editor) !== editor.pristineKey;

/** どの変更項目・開いているエディタからも参照されていないスナップショットと添付を外す */
export const pruneUnreferencedAssets = (state: AppState): AppState => {
  const snapshotIds = new Set(
    state.items.flatMap((i) => (i.snapshotId !== undefined ? [i.snapshotId] : [])),
  );
  const attachmentIds = new Set([
    ...state.items.flatMap((i) => i.attachmentIds),
    ...(state.editor?.attachmentId !== undefined ? [state.editor.attachmentId] : []),
  ]);
  const snapshots = state.snapshots.filter((s) => snapshotIds.has(s.id));
  const attachments = state.attachments.filter((a) => attachmentIds.has(a.id));
  if (
    snapshots.length === state.snapshots.length &&
    attachments.length === state.attachments.length
  ) {
    return state;
  }
  return { ...state, snapshots, attachments };
};

const evaluateEditorChangeType = (editor: DraftEditorState): ChangeType | null => {
  const kind: TargetKind = editor.targetKind;
  switch (kind) {
    case "text":
      return determineChangeType({
        kind: "text",
        initialText: editor.initialText,
        currentText: editor.currentText,
        memo: editor.memo,
        isDeleteRequested: editor.isDeleteRequested,
      });
    case "link":
      return determineChangeType({
        kind: "link",
        initialText: editor.initialText,
        currentText: editor.currentText,
        initialHref: editor.initialHref ?? "",
        currentHref: editor.currentHref ?? "",
        memo: editor.memo,
        isDeleteRequested: editor.isDeleteRequested,
      });
    case "image":
      return determineChangeType({
        kind: "image",
        ...(editor.attachmentId !== undefined ? { attachmentId: editor.attachmentId } : {}),
        memo: editor.memo,
        isDeleteRequested: editor.isDeleteRequested,
      });
    case "region":
      return determineChangeType({
        kind: "region",
        memo: editor.memo,
      });
    case "pageMeta": {
      const fallbackMeta: PageMetaValues = {
        title: "",
        description: "",
        ogTitle: "",
        ogDescription: "",
        ogImage: "",
      };
      return determineChangeType({
        kind: "pageMeta",
        initialMeta: editor.initialMeta ?? fallbackMeta,
        currentMeta: editor.currentMeta ?? fallbackMeta,
        memo: editor.memo,
      });
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
};

const extractEditorMetaDiffs = (editor: DraftEditorState): readonly PageMetaDiff[] => {
  if (
    editor.targetKind !== "pageMeta" ||
    editor.initialMeta === undefined ||
    editor.currentMeta === undefined
  ) {
    return [];
  }
  return computePageMetaDiffs(editor.initialMeta, editor.currentMeta);
};

const buildOptionalItemTextProps = (
  editor: DraftEditorState,
  changeType: ChangeType,
): Partial<Item> => {
  const hasBefore =
    (editor.targetKind === "text" || editor.targetKind === "link" || changeType === "DELETE") &&
    editor.initialText.length > 0;
  const hasAfter = changeType === "TEXT_REPLACE" || changeType === "TEXT_AND_LINK_CHANGE";
  return {
    ...(hasBefore ? { before: editor.initialText } : {}),
    ...(hasAfter ? { after: editor.currentText } : {}),
  };
};

const buildOptionalItemLinkProps = (
  editor: DraftEditorState,
  changeType: ChangeType,
): Partial<Item> => {
  const includeHref = changeType === "LINK_CHANGE" || changeType === "TEXT_AND_LINK_CHANGE";
  if (!includeHref) {
    return {};
  }
  return {
    ...(editor.initialHref !== undefined ? { hrefBefore: editor.initialHref } : {}),
    ...(editor.currentHref !== undefined ? { hrefAfter: editor.currentHref } : {}),
  };
};

const buildItemFromEditor = (
  state: AppState,
  editor: DraftEditorState,
  changeType: ChangeType,
): Item => {
  const seq = editor.editingSeq ?? state.nextSeq;
  const existingItem = state.items.find((i) => i.seq === seq);
  const url = existingItem?.url ?? state.currentUrl;
  const memoTrimmed = editor.memo.trim();
  const metaDiffs = extractEditorMetaDiffs(editor);
  const anchor: Anchor = editor.anchor;

  return {
    seq,
    url,
    ...(existingItem?.snapshotId !== undefined ? { snapshotId: existingItem.snapshotId } : {}),
    anchor,
    changeType,
    ...buildOptionalItemTextProps(editor, changeType),
    ...buildOptionalItemLinkProps(editor, changeType),
    ...(metaDiffs.length > 0 ? { meta: metaDiffs } : {}),
    ...(memoTrimmed.length > 0 ? { memo: memoTrimmed } : {}),
    attachmentIds: editor.attachmentId !== undefined ? [editor.attachmentId] : [],
    ...(editor.hasChildFormatting ? { hasChildFormatting: true } : {}),
  };
};

export const UNSAFE_HREF_MESSAGE =
  "リンク先に使えるのは http(s) / mailto / tel / 相対パスのみです（javascript: などは不可）";

export const EMPTY_TEXT_MESSAGE =
  "文言が空です。要素ごと消したい場合は「削除を依頼」を押してください";

const isTextClearedWithoutDelete = (editor: DraftEditorState): boolean =>
  (editor.targetKind === "text" || editor.targetKind === "link") &&
  !editor.isDeleteRequested &&
  editor.initialText.trim().length > 0 &&
  editor.currentText.trim().length === 0;

const hasUnsafeEditedHref = (editor: DraftEditorState): boolean =>
  editor.targetKind === "link" &&
  editor.currentHref !== undefined &&
  editor.currentHref !== editor.initialHref &&
  !isSafeNavigationUrl(editor.currentHref);

const handleConfirmEditor = (state: AppState): UpdateResult => {
  const { editor } = state;
  if (editor === null) {
    return { state, effects: [] };
  }
  if (hasUnsafeEditedHref(editor)) {
    return { state: { ...state, statusMessage: UNSAFE_HREF_MESSAGE }, effects: [] };
  }
  if (isTextClearedWithoutDelete(editor)) {
    return { state: { ...state, statusMessage: EMPTY_TEXT_MESSAGE }, effects: [] };
  }
  const changeType = evaluateEditorChangeType(editor);
  if (changeType === null) {
    return {
      state: pruneUnreferencedAssets({ ...state, editor: null }),
      effects: [],
    };
  }
  const item = buildItemFromEditor(state, editor, changeType);
  const exists = state.items.some((i) => i.seq === item.seq);
  const items = exists
    ? state.items.map((i) => (i.seq === item.seq ? item : i))
    : [...state.items, item];
  const needsSnapshot = changeType !== "PAGE_META" && item.snapshotId === undefined;

  // スナップショットの記録を待たずに一覧・バッジ・プレビューへ即座に反映する
  return {
    state: pruneUnreferencedAssets({
      ...state,
      items,
      nextSeq: Math.max(state.nextSeq, item.seq + 1),
      pendingSnapshotSeqs:
        needsSnapshot && !state.pendingSnapshotSeqs.includes(item.seq)
          ? [...state.pendingSnapshotSeqs, item.seq]
          : state.pendingSnapshotSeqs,
      editor: null,
      statusMessage: null,
    }),
    effects: [
      { type: "SYNC_LIVE_DOM", items },
      { type: "SAVE_DRAFT_DEBOUNCED" },
      ...(needsSnapshot ? [{ type: "CAPTURE_SNAPSHOT_FOR_ITEM", item } as const] : []),
    ],
  };
};

const handleSnapshotCaptured = (
  state: AppState,
  seq: number,
  snapshot: SnapshotMeta | undefined,
): UpdateResult => {
  const pendingSnapshotSeqs = state.pendingSnapshotSeqs.filter((s) => s !== seq);
  const target = state.items.find((i) => i.seq === seq);
  // 記録中に取り消された・既に別のスナップショットが付いた項目には付けない
  if (snapshot === undefined || target === undefined || target.snapshotId !== undefined) {
    return { state: { ...state, pendingSnapshotSeqs }, effects: [] };
  }
  const items = state.items.map((i) => (i.seq === seq ? { ...i, snapshotId: snapshot.id } : i));
  const snapshots = state.snapshots.some((s) => s.id === snapshot.id)
    ? state.snapshots
    : [...state.snapshots, snapshot];
  return {
    state: { ...state, items, snapshots, pendingSnapshotSeqs },
    effects: [{ type: "SAVE_DRAFT_DEBOUNCED" }],
  };
};

const handleEditorUpdate = (
  state: AppState,
  updater: (editor: DraftEditorState) => DraftEditorState,
): UpdateResult => {
  if (state.editor === null) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, editor: updater(state.editor) },
    effects: [],
  };
};

const handleEditorEvent = (state: AppState, event: AppEvent): UpdateResult | null => {
  switch (event.type) {
    case "OPEN_EDITOR":
      return {
        state: {
          ...state,
          editor: withPristineKey(event.editor),
          hoveredRect: null,
          dragSelectionRect: null,
          isQuickListOpen: false,
        },
        effects: [],
      };
    case "UPDATE_EDITOR_LOCATOR":
      return handleEditorUpdate(state, (ed) =>
        withPristineKey({
          ...ed,
          anchor: { kind: "element", locator: event.locator, rect: event.rect },
          expansionHistory: event.expansionHistory,
          initialText: event.initialText,
          currentText: event.initialText,
          hasChildFormatting: event.hasChildFormatting,
          popoverRect: event.rect,
        }),
      );
    case "UPDATE_EDITOR_TEXT":
      return handleEditorUpdate(state, (ed) => ({
        ...ed,
        currentText: event.text,
        isDeleteRequested: false,
      }));
    case "UPDATE_EDITOR_HREF":
      return handleEditorUpdate(state, (ed) => ({ ...ed, currentHref: event.href }));
    case "UPDATE_EDITOR_META":
      return handleEditorUpdate(state, (ed) => ({ ...ed, currentMeta: event.meta }));
    case "UPDATE_EDITOR_MEMO":
      return handleEditorUpdate(state, (ed) => ({ ...ed, memo: event.memo }));
    case "ATTACH_IMAGE_READY": {
      const nextAttachments = state.attachments.some((a) => a.id === event.attachment.id)
        ? state.attachments
        : [...state.attachments, event.attachment];
      const baseState: AppState = { ...state, attachments: nextAttachments };
      return handleEditorUpdate(baseState, (ed) => ({
        ...ed,
        attachmentId: event.attachment.id,
        attachmentPreviewUrl: event.previewUrl,
        isDeleteRequested: false,
      }));
    }
    case "REQUEST_DELETE_IN_EDITOR": {
      const updated = handleEditorUpdate(state, (ed) => ({
        ...ed,
        isDeleteRequested: true,
      }));
      return handleConfirmEditor(updated.state);
    }
    case "REQUEST_EXPAND_SELECTION":
      return { state, effects: [{ type: "EXPAND_EDITOR_SELECTION" }] };
    case "REQUEST_SHRINK_SELECTION":
      return { state, effects: [{ type: "SHRINK_EDITOR_SELECTION" }] };
    case "CLOSE_EDITOR":
      return { state: pruneUnreferencedAssets({ ...state, editor: null }), effects: [] };
    case "CONFIRM_EDITOR":
      return handleConfirmEditor(state);
    default:
      return null;
  }
};

export const update = (state: AppState, event: AppEvent): UpdateResult => {
  const editorResult = handleEditorEvent(state, event);
  if (editorResult !== null) {
    return editorResult;
  }

  switch (event.type) {
    case "TOGGLE_VISIBILITY":
      return {
        state: { ...state, isVisible: !state.isVisible, editor: null },
        effects: [],
      };
    case "SET_PAUSED":
      return {
        state: {
          ...state,
          isPaused: event.isPaused,
          isAltPressed: false,
          hoveredRect: null,
        },
        effects: [],
      };
    case "SET_ALT_PRESSED":
      return {
        state: { ...state, isAltPressed: event.isAltPressed, hoveredRect: null },
        effects: [],
      };
    case "TOGGLE_QUICK_LIST":
      return {
        state: { ...state, isQuickListOpen: !state.isQuickListOpen },
        effects: [],
      };
    case "MOVE_BAR":
      return {
        state: { ...state, barPosition: { x: event.x, y: event.y } },
        effects: [],
      };
    case "URL_CHANGED":
      return {
        state: {
          ...state,
          currentUrl: event.url,
          editor: null,
          hoveredRect: null,
        },
        effects: [{ type: "SYNC_LIVE_DOM", items: state.items }],
      };
    case "SET_INCOGNITO_WARNING":
      return {
        state: { ...state, isIncognitoWarning: event.isIncognito },
        effects: [],
      };
    case "HYDRATE_DRAFT":
      return {
        state: {
          ...state,
          nextSeq: event.draft.nextSeq,
          items: event.draft.items,
          snapshots: event.draft.snapshots,
          attachments: event.draft.attachments,
          hasRecentCompletedDraft: event.hasCompletedDraft,
          statusMessage:
            event.draft.items.length > 0
              ? `保存されていた下書き（${event.draft.items.length}件）を復元しました`
              : state.statusMessage,
        },
        effects: [{ type: "SYNC_LIVE_DOM", items: event.draft.items }],
      };
    case "UPDATE_HOVER_RECT":
      return { state: { ...state, hoveredRect: event.rect }, effects: [] };
    case "UPDATE_DRAG_RECT":
      return { state: { ...state, dragSelectionRect: event.rect }, effects: [] };
    case "UPDATE_RESOLVED_ANCHORS":
      return { state: { ...state, resolvedAnchors: event.anchors }, effects: [] };
    case "SNAPSHOT_CAPTURED_FOR_ITEM":
      return handleSnapshotCaptured(state, event.seq, event.snapshot);
    case "DELETE_ITEM": {
      const remaining = state.items.filter((i) => i.seq !== event.seq);
      return {
        state: pruneUnreferencedAssets({
          ...state,
          items: remaining,
          pendingSnapshotSeqs: state.pendingSnapshotSeqs.filter((s) => s !== event.seq),
          editor: state.editor?.editingSeq === event.seq ? null : state.editor,
        }),
        effects: [{ type: "SYNC_LIVE_DOM", items: remaining }, { type: "SAVE_DRAFT_DEBOUNCED" }],
      };
    }
    case "SELECT_QUICK_LIST_ITEM": {
      const target = state.items.find((i) => i.seq === event.seq);
      if (target === undefined) {
        return { state, effects: [] };
      }
      // 別ページの変更は、今のページの似た要素を誤って編集しないよう案内だけにする
      if (target.url !== state.currentUrl) {
        return {
          state: {
            ...state,
            statusMessage: `#${target.seq} は別のページ（${extractPathname(target.url)}）の変更です。そのページを開くと編集できます`,
          },
          effects: [],
        };
      }
      return {
        state: { ...state, isQuickListOpen: false },
        effects: [
          { type: "SCROLL_TO_ITEM", item: target },
          { type: "OPEN_EDITOR_FOR_ITEM", seq: target.seq },
        ],
      };
    }
    case "RESET_ALL_CONFIRMED":
      return {
        state: {
          ...state,
          nextSeq: 1,
          items: [],
          snapshots: [],
          attachments: [],
          pendingSnapshotSeqs: [],
          editor: null,
          isQuickListOpen: false,
          statusMessage: "下書きをリセットしました",
        },
        effects: [{ type: "RESTORE_ALL_LIVE_DOM" }, { type: "CLEAR_DRAFT_DB" }],
      };
    case "REOPEN_RECENT_COMPLETED":
      return {
        state: { ...state, hasRecentCompletedDraft: false },
        effects: [{ type: "LOAD_COMPLETED_DRAFT_FROM_DB" }],
      };
    case "REQUEST_COMPLETE":
      return {
        state: { ...state, editor: null, isQuickListOpen: false },
        effects: [{ type: "COMPLETE_AND_EXPORT" }],
      };
    case "EXPORT_FINISHED":
      return {
        state: {
          ...state,
          statusMessage: event.message,
          hasRecentCompletedDraft: true,
        },
        effects: [],
      };
    case "OPERATION_FAILED":
    case "SHOW_STATUS":
      return { state: { ...state, statusMessage: event.message }, effects: [] };
    case "CLEAR_STATUS":
      return { state: { ...state, statusMessage: null }, effects: [] };
    case "CLOSE_TOOL":
      return {
        state: { ...state, isVisible: false, editor: null },
        effects: [{ type: "RESTORE_ALL_LIVE_DOM" }, { type: "DESTROY_APP" }],
      };
    default:
      return { state, effects: [] };
  }
};
