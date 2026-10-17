import type { JSX } from "preact";
import { isConfirmEnter } from "../core/keyboard";
import { formatChangeTypeLabel } from "../core/markdown";
import type { AppEvent, AppState } from "../core/state";
import {
  type DraftEditorState,
  type Item,
  type PageMetaValues,
  type Rect,
  TOOL_VERSION,
} from "../core/types";

export type OverlayAppProps = {
  readonly state: AppState;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly viewportW: number;
  readonly viewportH: number;
  readonly dispatch: (event: AppEvent) => void;
  readonly onBadgeClick: (seq: number) => void;
  readonly onOpenPageMeta: () => void;
  readonly onAttachmentFileSelected: (file: File) => void;
};

const toViewportStyle = (
  rect: Rect,
  scrollX: number,
  scrollY: number,
): Readonly<Record<string, string>> => ({
  left: `${rect.x - scrollX}px`,
  top: `${rect.y - scrollY}px`,
  width: `${Math.max(4, rect.w)}px`,
  height: `${Math.max(4, rect.h)}px`,
});

const computePopoverPosition = (
  rect: Rect,
  scrollX: number,
  scrollY: number,
  viewportW: number,
  viewportH: number,
): Readonly<Record<string, string>> => {
  const vx = rect.x - scrollX;
  const vy = rect.y - scrollY;
  const left = Math.max(12, Math.min(vx, viewportW - 356));
  const preferBelow = vy + rect.h + 8;
  const top = preferBelow + 280 < viewportH ? Math.max(12, preferBelow) : Math.max(12, vy - 260);
  return {
    left: `${left}px`,
    top: `${top}px`,
  };
};

const summarizeItemText = (item: Item): string => {
  const base =
    item.after ??
    item.before ??
    item.hrefAfter ??
    item.memo ??
    formatChangeTypeLabel(item.changeType);
  return base.length > 20 ? `${base.slice(0, 20)}…` : base;
};

const PageMetaEditorFields = ({
  meta,
  dispatch,
}: {
  readonly meta: PageMetaValues;
  readonly dispatch: (ev: AppEvent) => void;
}): JSX.Element => {
  const updateField = (key: keyof PageMetaValues, value: string): void => {
    dispatch({
      type: "UPDATE_EDITOR_META",
      meta: { ...meta, [key]: value },
    });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <label>
        <span class="pcr-field-label">ページタイトル (title)</span>
        <input
          class="pcr-input"
          type="text"
          value={meta.title}
          onInput={(e) => updateField("title", (e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        <span class="pcr-field-label">説明文 (meta description)</span>
        <textarea
          class="pcr-textarea"
          rows={2}
          value={meta.description}
          onInput={(e) => updateField("description", (e.target as HTMLTextAreaElement).value)}
        />
      </label>
      <label>
        <span class="pcr-field-label">OGP タイトル (og:title)</span>
        <input
          class="pcr-input"
          type="text"
          value={meta.ogTitle}
          onInput={(e) => updateField("ogTitle", (e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        <span class="pcr-field-label">OGP 説明文 (og:description)</span>
        <textarea
          class="pcr-textarea"
          rows={2}
          value={meta.ogDescription}
          onInput={(e) => updateField("ogDescription", (e.target as HTMLTextAreaElement).value)}
        />
      </label>
      <label>
        <span class="pcr-field-label">OGP 画像URL (og:image)</span>
        <input
          class="pcr-input"
          type="text"
          value={meta.ogImage}
          onInput={(e) => updateField("ogImage", (e.target as HTMLInputElement).value)}
        />
      </label>
    </div>
  );
};

const ImageEditorField = ({
  editor,
  onAttachmentFileSelected,
}: {
  readonly editor: DraftEditorState;
  readonly onAttachmentFileSelected: (file: File) => void;
}): JSX.Element => (
  <div>
    <span class="pcr-field-label">差し替え画像（ドロップ・貼り付け・クリック）</span>
    <label
      class="pcr-dropzone"
      style={{ display: "block" }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (f !== undefined) {
          onAttachmentFileSelected(f);
        }
      }}
    >
      <div>PNG / JPEG / WebP / GIF を選択またはドロップ</div>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (f !== undefined) {
            onAttachmentFileSelected(f);
          }
        }}
      />
      {editor.attachmentPreviewUrl !== undefined && (
        <img src={editor.attachmentPreviewUrl} alt="preview" />
      )}
    </label>
  </div>
);

const TextOrLinkEditorFields = ({
  editor,
  dispatch,
}: {
  readonly editor: DraftEditorState;
  readonly dispatch: (ev: AppEvent) => void;
}): JSX.Element => {
  if (editor.expansionHistory.length > 0) {
    const tag = editor.anchor.kind === "element" ? editor.anchor.locator.tagName : "要素";
    return (
      <div class="pcr-note">
        選択範囲を外側のブロック（&lt;{tag}
        &gt;）に広げました。ブロック全体の削除やメモの記入ができます。
      </div>
    );
  }
  const handleTextKeyDown = (e: KeyboardEvent): void => {
    if (isConfirmEnter(e)) {
      e.preventDefault();
      dispatch({ type: "CONFIRM_EDITOR" });
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <label>
        <span class="pcr-field-label">文言（Enterで確定 / Shift+Enterで改行）</span>
        <textarea
          class="pcr-textarea"
          rows={3}
          value={editor.currentText}
          onKeyDown={handleTextKeyDown}
          onInput={(e) =>
            dispatch({
              type: "UPDATE_EDITOR_TEXT",
              text: (e.target as HTMLTextAreaElement).value,
            })
          }
        />
      </label>
      {editor.targetKind === "link" && (
        <label>
          <span class="pcr-field-label">リンク先 URL (href)</span>
          <input
            class="pcr-input"
            type="text"
            value={editor.currentHref ?? ""}
            onKeyDown={handleTextKeyDown}
            onInput={(e) =>
              dispatch({
                type: "UPDATE_EDITOR_HREF",
                href: (e.target as HTMLInputElement).value,
              })
            }
          />
        </label>
      )}
      {editor.hasChildFormatting && editor.currentText !== editor.initialText && (
        <div class="pcr-note">※子要素の装飾はプレビューに反映されていません</div>
      )}
    </div>
  );
};

const EditorTargetInput = ({
  editor,
  dispatch,
  onAttachmentFileSelected,
}: {
  readonly editor: DraftEditorState;
  readonly dispatch: (ev: AppEvent) => void;
  readonly onAttachmentFileSelected: (file: File) => void;
}): JSX.Element | null => {
  if (editor.targetKind === "pageMeta" && editor.currentMeta !== undefined) {
    return <PageMetaEditorFields meta={editor.currentMeta} dispatch={dispatch} />;
  }
  if (editor.targetKind === "image") {
    return <ImageEditorField editor={editor} onAttachmentFileSelected={onAttachmentFileSelected} />;
  }
  if (editor.targetKind === "text" || editor.targetKind === "link") {
    return <TextOrLinkEditorFields editor={editor} dispatch={dispatch} />;
  }
  return null;
};

const EditorPopover = ({
  editor,
  scrollX,
  scrollY,
  viewportW,
  viewportH,
  dispatch,
  onAttachmentFileSelected,
}: {
  readonly editor: DraftEditorState;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly viewportW: number;
  readonly viewportH: number;
  readonly dispatch: (ev: AppEvent) => void;
  readonly onAttachmentFileSelected: (file: File) => void;
}): JSX.Element => {
  const posStyle = computePopoverPosition(
    editor.popoverRect,
    scrollX,
    scrollY,
    viewportW,
    viewportH,
  );
  const canExpand = editor.anchor.kind === "element";
  const canShrink = editor.expansionHistory.length > 0;
  const canDeleteElement =
    editor.targetKind === "text" || editor.targetKind === "link" || editor.targetKind === "image";

  return (
    <div
      class="pcr-popover"
      style={posStyle}
      onPaste={(e) => {
        const f = e.clipboardData?.files?.[0];
        if (f !== undefined && editor.targetKind === "image") {
          onAttachmentFileSelected(f);
        }
      }}
    >
      <div class="pcr-popover-header">
        <span>
          {editor.editingSeq !== undefined ? `#${editor.editingSeq} の編集` : "変更内容の入力"}
        </span>
        <div style={{ display: "flex", gap: "4px" }}>
          {canExpand && (
            <button
              type="button"
              class="pcr-btn"
              title="セクションごと削除したいときなどに、選択枠を1段外側の要素へ広げます (↑)"
              onClick={() => dispatch({ type: "REQUEST_EXPAND_SELECTION" })}
            >
              外枠へ広げる ↑
            </button>
          )}
          {canShrink && (
            <button
              type="button"
              class="pcr-btn"
              title="元の要素に戻す (↓)"
              onClick={() => dispatch({ type: "REQUEST_SHRINK_SELECTION" })}
            >
              戻す ↓
            </button>
          )}
        </div>
      </div>

      <EditorTargetInput
        editor={editor}
        dispatch={dispatch}
        onAttachmentFileSelected={onAttachmentFileSelected}
      />

      <label>
        <span class="pcr-field-label">メモ（色・大きさ・余白・その他の指示）</span>
        <textarea
          class="pcr-textarea"
          rows={2}
          placeholder="任意メモを入力"
          value={editor.memo}
          onKeyDown={(e) => {
            if (isConfirmEnter(e)) {
              e.preventDefault();
              dispatch({ type: "CONFIRM_EDITOR" });
            }
          }}
          onInput={(e) =>
            dispatch({
              type: "UPDATE_EDITOR_MEMO",
              memo: (e.target as HTMLTextAreaElement).value,
            })
          }
        />
      </label>

      <div class="pcr-popover-footer">
        <div style={{ display: "flex", gap: "4px" }}>
          {canDeleteElement && (
            <button
              type="button"
              class="pcr-btn pcr-btn-danger"
              onClick={() => dispatch({ type: "REQUEST_DELETE_IN_EDITOR" })}
            >
              この要素を削除
            </button>
          )}
          {editor.editingSeq !== undefined && (
            <button
              type="button"
              class="pcr-btn"
              onClick={() => {
                if (editor.editingSeq !== undefined) {
                  dispatch({ type: "DELETE_ITEM", seq: editor.editingSeq });
                }
              }}
            >
              指摘を取り消す
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: "4px" }}>
          <button type="button" class="pcr-btn" onClick={() => dispatch({ type: "CLOSE_EDITOR" })}>
            キャンセル
          </button>
          <button
            type="button"
            class="pcr-btn pcr-btn-primary"
            onClick={() => dispatch({ type: "CONFIRM_EDITOR" })}
          >
            確定
          </button>
        </div>
      </div>
    </div>
  );
};

const QuickListPopover = ({
  items,
  dispatch,
}: {
  readonly items: readonly Item[];
  readonly dispatch: (ev: AppEvent) => void;
}): JSX.Element => (
  <div class="pcr-quicklist">
    {items.length === 0 ? (
      <div style={{ fontSize: "11px", color: "#94a3b8", padding: "4px" }}>
        まだ指摘箇所がありません
      </div>
    ) : (
      items.map((item) => (
        <div key={item.seq} class="pcr-quicklist-item">
          <button
            type="button"
            class="pcr-btn"
            style={{ flex: 1, textAlign: "left", border: "none", background: "transparent" }}
            onClick={() => dispatch({ type: "SELECT_QUICK_LIST_ITEM", seq: item.seq })}
          >
            <strong>#{item.seq}</strong> {summarizeItemText(item)}
          </button>
          <button
            type="button"
            class="pcr-btn"
            style={{ padding: "1px 6px" }}
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: "DELETE_ITEM", seq: item.seq });
            }}
          >
            ×
          </button>
        </div>
      ))
    )}
  </div>
);

const ToolbarWarnings = ({ state }: { readonly state: AppState }): JSX.Element | null => {
  const hasAny =
    state.isSnapshotExcludedPage || state.isIncognitoWarning || state.statusMessage !== null;
  if (!hasAny) {
    return null;
  }
  return (
    <div class="pcr-warnings">
      {state.isSnapshotExcludedPage && (
        <div>⚠ 個人情報保護対象ページのため、画面スナップショットは保存されません</div>
      )}
      {state.isIncognitoWarning && <div>⚠ シークレットウィンドウでは閉じると下書きが消えます</div>}
      {state.statusMessage !== null && <div class="pcr-status">{state.statusMessage}</div>}
    </div>
  );
};

const CanvasBoxes = ({
  state,
  scrollX,
  scrollY,
  onBadgeClick,
}: {
  readonly state: AppState;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly onBadgeClick: (seq: number) => void;
}): JSX.Element => (
  <div>
    {state.hoveredRect !== null && !state.isPaused && !state.isAltPressed && (
      <div class="pcr-hover-box" style={toViewportStyle(state.hoveredRect, scrollX, scrollY)} />
    )}

    {state.editor !== null && state.editor.anchor.kind === "element" && (
      <div
        class="pcr-hover-box"
        style={{
          ...toViewportStyle(state.editor.anchor.rect, scrollX, scrollY),
          borderColor: "#16a34a",
          background: "rgba(22, 163, 74, 0.10)",
        }}
      />
    )}

    {state.dragSelectionRect !== null && (
      <div
        class="pcr-drag-box"
        style={toViewportStyle(state.dragSelectionRect, scrollX, scrollY)}
      />
    )}

    {state.resolvedAnchors.map((resolved) => (
      <div key={resolved.seq}>
        <div
          class={`pcr-anchor-box ${resolved.confidence === "fallback_rect" ? "is-fallback" : ""}`}
          style={toViewportStyle(resolved.rect, scrollX, scrollY)}
        />
        <button
          type="button"
          class="pcr-badge"
          style={{
            left: `${resolved.rect.x - scrollX - 10}px`,
            top: `${resolved.rect.y - scrollY - 10}px`,
          }}
          title={
            resolved.confidence === "selector_only" ? "文言が変わっています" : `#${resolved.seq}`
          }
          onClick={() => onBadgeClick(resolved.seq)}
        >
          {resolved.seq}
        </button>
      </div>
    ))}
  </div>
);

export const OverlayApp = (props: OverlayAppProps): JSX.Element | null => {
  const { state, scrollX, scrollY, viewportW, viewportH, dispatch } = props;
  if (!state.isVisible) {
    return null;
  }

  const handleBarDragStart = (e: PointerEvent): void => {
    e.preventDefault();
    const startX = e.clientX - state.barPosition.x;
    const startY = e.clientY - state.barPosition.y;
    const onMove = (moveEv: PointerEvent): void => {
      dispatch({
        type: "MOVE_BAR",
        x: Math.max(8, Math.min(viewportW - 220, moveEv.clientX - startX)),
        y: Math.max(8, Math.min(viewportH - 60, moveEv.clientY - startY)),
      });
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div>
      <CanvasBoxes
        state={state}
        scrollX={scrollX}
        scrollY={scrollY}
        onBadgeClick={props.onBadgeClick}
      />

      {state.editor !== null && (
        <EditorPopover
          editor={state.editor}
          scrollX={scrollX}
          scrollY={scrollY}
          viewportW={viewportW}
          viewportH={viewportH}
          dispatch={dispatch}
          onAttachmentFileSelected={props.onAttachmentFileSelected}
        />
      )}

      <div
        class="pcr-bar"
        style={{
          left: `${state.barPosition.x}px`,
          top: `${state.barPosition.y}px`,
        }}
      >
        <div class="pcr-bar-main">
          <span class="pcr-drag-handle" onPointerDown={handleBarDragStart}>
            ⠿ 赤ペン v{TOOL_VERSION}
          </span>
          <button
            type="button"
            class="pcr-btn"
            onClick={() => dispatch({ type: "TOGGLE_QUICK_LIST" })}
          >
            指摘 {state.items.length}件
          </button>
          <button
            type="button"
            class={`pcr-btn ${state.isPaused || state.isAltPressed ? "is-active" : ""}`}
            onClick={() => dispatch({ type: "SET_PAUSED", isPaused: !state.isPaused })}
          >
            {state.isPaused || state.isAltPressed ? "再開" : "一時停止"}
          </button>
          <button type="button" class="pcr-btn" onClick={props.onOpenPageMeta}>
            ページ情報
          </button>
          <button
            type="button"
            class="pcr-btn"
            onClick={() => {
              if (window.confirm("現在の下書きをすべて破棄して1番からやり直しますか？")) {
                dispatch({ type: "RESET_ALL_CONFIRMED" });
              }
            }}
          >
            リセット
          </button>
          <button
            type="button"
            class="pcr-btn pcr-btn-primary"
            onClick={() => dispatch({ type: "REQUEST_COMPLETE" })}
          >
            完了
          </button>
          <button type="button" class="pcr-btn" onClick={() => dispatch({ type: "CLOSE_TOOL" })}>
            閉じる
          </button>
          {state.hasRecentCompletedDraft && state.items.length === 0 && (
            <button
              type="button"
              class="pcr-btn"
              style={{ fontSize: "11px" }}
              onClick={() => dispatch({ type: "REOPEN_RECENT_COMPLETED" })}
            >
              前回の続きを開く
            </button>
          )}
        </div>

        <ToolbarWarnings state={state} />

        {state.isQuickListOpen && <QuickListPopover items={state.items} dispatch={dispatch} />}
      </div>
    </div>
  );
};
