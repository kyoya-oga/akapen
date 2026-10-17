import { h, render } from "preact";
import { resolveElementLocator } from "./core/anchor";
import { generateTicketMarkdown } from "./core/markdown";
import { shouldExcludeSnapshotForUrl } from "./core/sanitize";
import {
  type AppEvent,
  type AppState,
  type Effect,
  createInitialState,
  update,
} from "./core/state";
import {
  type ChangeRequestDoc,
  type DraftRecord,
  type Item,
  type Rect,
  SCHEMA_VERSION,
  TOOL_VERSION,
} from "./core/types";
import {
  createEditorStateForElement,
  createEditorStateForPageMeta,
  createEditorStateForRegion,
  expandCurrentEditorLocator,
  getElementPageRect,
  mountShadowHost,
  resolvePageAnchors,
  shrinkCurrentEditorLocator,
} from "./shell/dom-overlay";
import {
  buildReportHtmlString,
  copyTextToClipboard,
  downloadHtmlReportBlob,
  formatReportFilename,
} from "./shell/export-io";
import { createLivePreviewController } from "./shell/live-preview";
import {
  type ResourceEntry,
  captureCleanSnapshot,
  processAttachmentImageFile,
} from "./shell/snapshot-io";
import {
  clearAllDraftDataInDb,
  detectIncognitoMode,
  loadInitialStorageBundle,
  markDraftAsCompletedInDb,
  promoteCompletedDraftToActiveInDb,
  saveDraftAndAssetsToDb,
} from "./shell/storage-idb";
import { OverlayApp } from "./ui/app";
import { OVERLAY_CSS } from "./ui/styles";
import { EMBEDDED_VIEWER_SCRIPT, EMBEDDED_VIEWER_SHA256_BASE64 } from "./viewer/embedded-bundle";
import { VIEWER_CSS } from "./viewer/styles";

export type PageChangeRequestGlobal = {
  readonly toggle: () => void;
  readonly destroy: () => void;
};

declare global {
  interface Window {
    __pageChangeRequest?: PageChangeRequestGlobal | undefined;
  }
}

const DRAG_THRESHOLD_PX = 5;
const SAVE_DEBOUNCE_MS = 500;

const isEventInsideHost = (event: Event, host: HTMLElement): boolean =>
  event.composedPath().includes(host);

const computeDragRect = (
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  scrollX: number,
  scrollY: number,
): Rect => ({
  x: Math.round(Math.min(startX, endX) + scrollX),
  y: Math.round(Math.min(startY, endY) + scrollY),
  w: Math.round(Math.abs(endX - startX)),
  h: Math.round(Math.abs(endY - startY)),
});

type RuntimeContext = {
  state: AppState;
  readonly snapshotBodies: Map<string, string>;
  readonly resources: Map<string, ResourceEntry>;
  readonly previewUrls: Map<string, string>;
  saveTimerId: ReturnType<typeof setTimeout> | null;
  rafId: number | null;
  pointerDownPos: { readonly x: number; readonly y: number } | null;
};

export const launchPageChangeRequestTool = (): PageChangeRequestGlobal => {
  const existing = window.__pageChangeRequest;
  if (existing !== undefined) {
    existing.toggle();
    return existing;
  }

  const doc = document;
  const { host, mountNode } = mountShadowHost(doc, OVERLAY_CSS);
  const livePreview = createLivePreviewController();

  const ctx: RuntimeContext = {
    state: createInitialState(
      window.location.href,
      shouldExcludeSnapshotForUrl(window.location.href),
    ),
    snapshotBodies: new Map<string, string>(),
    resources: new Map<string, ResourceEntry>(),
    previewUrls: new Map<string, string>(),
    saveTimerId: null,
    rafId: null,
    pointerDownPos: null,
  };

  const getAttachmentPreviewUrl = (attId: string): string | undefined => {
    const cached = ctx.previewUrls.get(attId);
    if (cached !== undefined) {
      return cached;
    }
    const att = ctx.state.attachments.find((a) => a.id === attId);
    const res = att !== undefined ? ctx.resources.get(att.resourceHash) : undefined;
    if (res === undefined) {
      return undefined;
    }
    const dataUrl = `data:${res.mime};base64,${res.base64}`;
    ctx.previewUrls.set(attId, dataUrl);
    return dataUrl;
  };

  const buildDraftRecord = (): DraftRecord => ({
    id: "active",
    updatedAt: new Date().toISOString(),
    nextSeq: ctx.state.nextSeq,
    items: ctx.state.items,
    snapshots: ctx.state.snapshots,
    attachments: ctx.state.attachments,
  });

  const renderApp = (): void => {
    render(
      h(OverlayApp, {
        state: ctx.state,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
        dispatch,
        onBadgeClick: handleBadgeClick,
        onOpenPageMeta: () => {
          const existingMetaItem = ctx.state.items.find(
            (i) => i.changeType === "PAGE_META" && i.url === ctx.state.currentUrl,
          );
          const editor = createEditorStateForPageMeta(doc, existingMetaItem);
          dispatch({ type: "OPEN_EDITOR", editor });
        },
        onAttachmentFileSelected: (file: File) => {
          void processAttachmentImageFile(file).then((res) => {
            if (!res.ok) {
              window.alert(res.error);
              return;
            }
            ctx.resources.set(res.value.resource.hash, res.value.resource);
            ctx.previewUrls.set(res.value.attachment.id, res.value.previewUrl);
            dispatch({
              type: "ATTACH_IMAGE_READY",
              attachment: res.value.attachment,
              previewUrl: res.value.previewUrl,
            });
          });
        },
      }),
      mountNode,
    );
  };

  const scheduleAnchorRefresh = (): void => {
    if (ctx.rafId !== null) {
      return;
    }
    ctx.rafId = window.requestAnimationFrame(() => {
      ctx.rafId = null;
      if (window.location.href !== ctx.state.currentUrl) {
        dispatch({
          type: "URL_CHANGED",
          url: window.location.href,
          isExcluded: shouldExcludeSnapshotForUrl(window.location.href),
        });
      }
      const resolved = resolvePageAnchors(doc, ctx.state.items, ctx.state.currentUrl);
      ctx.state = { ...ctx.state, resolvedAnchors: resolved };
      renderApp();
    });
  };

  const openEditorForElementItem = (item: Item): void => {
    if (item.anchor.kind !== "element") {
      return;
    }
    const locator = item.anchor.locator;
    const res = livePreview.withCleanDom(() => resolveElementLocator(doc, locator));
    if (!res.ok || res.value.element === null) {
      return;
    }
    const ed = createEditorStateForElement(doc, res.value.element, livePreview.withCleanDom, item);
    const previewUrl =
      ed.attachmentId !== undefined ? getAttachmentPreviewUrl(ed.attachmentId) : undefined;
    dispatch({
      type: "OPEN_EDITOR",
      editor: previewUrl !== undefined ? { ...ed, attachmentPreviewUrl: previewUrl } : ed,
    });
  };

  const handleBadgeClick = (seq: number): void => {
    const item = ctx.state.items.find((i) => i.seq === seq);
    if (item === undefined) {
      return;
    }
    if (item.anchor.kind === "pageMeta") {
      dispatch({ type: "OPEN_EDITOR", editor: createEditorStateForPageMeta(doc, item) });
      return;
    }
    openEditorForElementItem(item);
  };

  const executeCaptureSnapshotEffect = async (
    pendingItem: Item,
    skipSnapshot: boolean,
  ): Promise<void> => {
    if (skipSnapshot) {
      dispatch({ type: "SNAPSHOT_CAPTURED_FOR_ITEM", item: pendingItem });
      return;
    }
    const captured = await captureCleanSnapshot(
      doc,
      livePreview.withCleanDom,
      Object.fromEntries(ctx.resources),
    );
    ctx.snapshotBodies.set(captured.meta.id, captured.compressedHtmlBase64);
    captured.newResources.map((r) => ctx.resources.set(r.hash, r));
    const itemWithSnap: Item = { ...pendingItem, snapshotId: captured.meta.id };
    dispatch({
      type: "SNAPSHOT_CAPTURED_FOR_ITEM",
      item: itemWithSnap,
      snapshot: captured.meta,
    });
  };

  const executeCompleteAndExport = async (): Promise<void> => {
    const exportDoc: ChangeRequestDoc = {
      schemaVersion: SCHEMA_VERSION,
      toolVersion: TOOL_VERSION,
      createdAt: new Date().toISOString(),
      origin: window.location.origin,
      snapshots: ctx.state.snapshots,
      items: ctx.state.items,
      attachments: ctx.state.attachments,
    };
    const markdown = generateTicketMarkdown(exportDoc);
    await copyTextToClipboard(markdown);

    const htmlReport = buildReportHtmlString({
      pageTitle: doc.title || "ページ",
      doc: exportDoc,
      snapshotBodies: Object.fromEntries(ctx.snapshotBodies),
      resources: Object.fromEntries(ctx.resources),
      viewerScript: EMBEDDED_VIEWER_SCRIPT,
      viewerScriptSha256Base64: EMBEDDED_VIEWER_SHA256_BASE64,
      viewerStyles: VIEWER_CSS,
    });
    downloadHtmlReportBlob(htmlReport, formatReportFilename(doc.title));
    await markDraftAsCompletedInDb(buildDraftRecord());
    dispatch({
      type: "EXPORT_FINISHED",
      message: "Markdown をコピーし HTML レポートを保存しました",
    });
  };

  const scrollToTargetItem = (item: Item): void => {
    if (item.anchor.kind === "element") {
      const res = resolveElementLocator(doc, item.anchor.locator);
      if (res.ok && res.value.element !== null) {
        res.value.element.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      window.scrollTo({ top: Math.max(0, item.anchor.rect.y - 120), behavior: "smooth" });
    } else if (item.anchor.kind === "region") {
      window.scrollTo({ top: Math.max(0, item.anchor.pageRect.y - 120), behavior: "smooth" });
    }
  };

  const scheduleDebouncedDraftSave = (): void => {
    if (ctx.saveTimerId !== null) {
      clearTimeout(ctx.saveTimerId);
    }
    ctx.saveTimerId = setTimeout(() => {
      void saveDraftAndAssetsToDb(
        buildDraftRecord(),
        Object.fromEntries(ctx.snapshotBodies),
        Object.fromEntries(ctx.resources),
      );
    }, SAVE_DEBOUNCE_MS);
  };

  const handleExpandOrShrinkEffect = (expand: boolean): void => {
    if (ctx.state.editor === null) {
      return;
    }
    const next = expand
      ? expandCurrentEditorLocator(doc, ctx.state.editor, livePreview.withCleanDom)
      : shrinkCurrentEditorLocator(doc, ctx.state.editor, livePreview.withCleanDom);
    if (next !== null) {
      dispatch({ type: "UPDATE_EDITOR_LOCATOR", ...next });
    }
  };

  const runEffect = (effect: Effect): void => {
    switch (effect.type) {
      case "SYNC_LIVE_DOM":
        livePreview.syncItems(doc, effect.items, ctx.state.currentUrl, getAttachmentPreviewUrl);
        scheduleAnchorRefresh();
        break;
      case "RESTORE_ALL_LIVE_DOM":
        livePreview.restoreAll();
        scheduleAnchorRefresh();
        break;
      case "SAVE_DRAFT_DEBOUNCED":
        scheduleDebouncedDraftSave();
        break;
      case "CLEAR_DRAFT_DB":
        ctx.snapshotBodies.clear();
        ctx.resources.clear();
        void clearAllDraftDataInDb();
        break;
      case "LOAD_COMPLETED_DRAFT_FROM_DB":
        void promoteCompletedDraftToActiveInDb().then((draft) => {
          if (draft !== null) {
            dispatch({ type: "HYDRATE_DRAFT", draft, hasCompletedDraft: false });
          }
        });
        break;
      case "CAPTURE_SNAPSHOT_AND_COMMIT_ITEM":
        void executeCaptureSnapshotEffect(effect.pendingItem, effect.skipSnapshot);
        break;
      case "SCROLL_TO_ITEM":
        scrollToTargetItem(effect.item);
        break;
      case "EXPAND_EDITOR_SELECTION":
        handleExpandOrShrinkEffect(true);
        break;
      case "SHRINK_EDITOR_SELECTION":
        handleExpandOrShrinkEffect(false);
        break;
      case "COMPLETE_AND_EXPORT":
        void executeCompleteAndExport();
        break;
      case "DESTROY_APP":
        destroy();
        break;
      default: {
        const _exhaustive: never = effect;
        void _exhaustive;
      }
    }
  };

  function dispatch(event: AppEvent): void {
    const result = update(ctx.state, event);
    ctx.state = result.state;
    renderApp();
    result.effects.map(runEffect);
  }

  const isPointingActive = (): boolean =>
    ctx.state.isVisible &&
    !ctx.state.isPaused &&
    !ctx.state.isAltPressed &&
    ctx.state.editor === null;

  const updateHoverTargetAtPoint = (clientX: number, clientY: number): void => {
    const target = doc.elementFromPoint(clientX, clientY);
    if (target === null || target === doc.documentElement || target === doc.body) {
      dispatch({ type: "UPDATE_HOVER_RECT", rect: null });
      return;
    }
    dispatch({ type: "UPDATE_HOVER_RECT", rect: getElementPageRect(doc, target) });
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (isEventInsideHost(e, host) || !isPointingActive()) {
      return;
    }
    if (ctx.pointerDownPos !== null) {
      const dist = Math.hypot(e.clientX - ctx.pointerDownPos.x, e.clientY - ctx.pointerDownPos.y);
      if (dist > DRAG_THRESHOLD_PX) {
        const rect = computeDragRect(
          ctx.pointerDownPos.x,
          ctx.pointerDownPos.y,
          e.clientX,
          e.clientY,
          window.scrollX,
          window.scrollY,
        );
        dispatch({ type: "UPDATE_DRAG_RECT", rect });
        return;
      }
    }
    updateHoverTargetAtPoint(e.clientX, e.clientY);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (isEventInsideHost(e, host) || !isPointingActive() || e.button !== 0) {
      return;
    }
    if (e.altKey) {
      dispatch({ type: "SET_ALT_PRESSED", isAltPressed: true });
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    ctx.pointerDownPos = { x: e.clientX, y: e.clientY };
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (isEventInsideHost(e, host) || ctx.pointerDownPos === null) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const start = ctx.pointerDownPos;
    ctx.pointerDownPos = null;
    const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);

    if (dist > DRAG_THRESHOLD_PX) {
      const regionRect = computeDragRect(
        start.x,
        start.y,
        e.clientX,
        e.clientY,
        window.scrollX,
        window.scrollY,
      );
      const editor = createEditorStateForRegion(doc, regionRect, livePreview.withCleanDom);
      dispatch({ type: "OPEN_EDITOR", editor });
      return;
    }

    const target = doc.elementFromPoint(e.clientX, e.clientY);
    if (target !== null && target !== doc.documentElement && target !== doc.body) {
      const editor = createEditorStateForElement(doc, target, livePreview.withCleanDom);
      dispatch({ type: "OPEN_EDITOR", editor });
    }
  };

  const onClickCapture = (e: MouseEvent): void => {
    if (isEventInsideHost(e, host)) {
      return;
    }
    if (e.target instanceof Element && e.target.hasAttribute("data-pcr-download")) {
      return;
    }
    if (ctx.state.isVisible && !ctx.state.isPaused && !ctx.state.isAltPressed && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const handleEditorArrowKeys = (e: KeyboardEvent): void => {
    if (ctx.state.editor === null || isEventInsideHost(e, host)) {
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      dispatch({ type: "REQUEST_EXPAND_SELECTION" });
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      dispatch({ type: "REQUEST_SHRINK_SELECTION" });
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Alt") {
      dispatch({ type: "SET_ALT_PRESSED", isAltPressed: true });
      return;
    }
    if (e.key === "Escape" && ctx.state.editor !== null) {
      e.preventDefault();
      dispatch({ type: "CLOSE_EDITOR" });
      return;
    }
    handleEditorArrowKeys(e);
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Alt") {
      dispatch({ type: "SET_ALT_PRESSED", isAltPressed: false });
    }
  };

  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("click", onClickCapture, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("scroll", scheduleAnchorRefresh, { passive: true, capture: true });
  window.addEventListener("resize", scheduleAnchorRefresh, { passive: true });
  window.addEventListener("popstate", scheduleAnchorRefresh);

  const mutationObserver = new MutationObserver(() => {
    scheduleAnchorRefresh();
  });
  if (doc.body !== null) {
    mutationObserver.observe(doc.body, { childList: true, subtree: true });
  }

  void detectIncognitoMode().then((isIncognito) => {
    if (isIncognito) {
      dispatch({ type: "SET_INCOGNITO_WARNING", isIncognito: true });
    }
  });

  void loadInitialStorageBundle().then((bundle) => {
    Object.entries(bundle.snapshotBodies).map(([id, b64]) => ctx.snapshotBodies.set(id, b64));
    Object.entries(bundle.resources).map(([hKey, r]) => ctx.resources.set(hKey, r));
    if (bundle.activeDraft !== null) {
      dispatch({
        type: "HYDRATE_DRAFT",
        draft: bundle.activeDraft,
        hasCompletedDraft: bundle.hasRecentCompletedDraft,
      });
    } else if (bundle.hasRecentCompletedDraft) {
      dispatch({
        type: "HYDRATE_DRAFT",
        draft: {
          id: "active",
          updatedAt: new Date().toISOString(),
          nextSeq: 1,
          items: [],
          snapshots: [],
          attachments: [],
        },
        hasCompletedDraft: true,
      });
    }
  });

  renderApp();

  function destroy(): void {
    if (ctx.saveTimerId !== null) {
      clearTimeout(ctx.saveTimerId);
    }
    if (ctx.rafId !== null) {
      cancelAnimationFrame(ctx.rafId);
    }
    mutationObserver.disconnect();
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("click", onClickCapture, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("scroll", scheduleAnchorRefresh, true);
    window.removeEventListener("resize", scheduleAnchorRefresh);
    window.removeEventListener("popstate", scheduleAnchorRefresh);
    livePreview.restoreAll();
    render(null, mountNode);
    host.remove();
    window.__pageChangeRequest = undefined;
  }

  const handle: PageChangeRequestGlobal = {
    toggle: () => dispatch({ type: "TOGGLE_VISIBILITY" }),
    destroy,
  };
  window.__pageChangeRequest = handle;
  return handle;
};

if (typeof window !== "undefined" && typeof document !== "undefined") {
  launchPageChangeRequestTool();
}
