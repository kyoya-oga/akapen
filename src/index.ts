import { h, render } from "preact";
import { resolveElementLocator } from "./core/anchor";
import { generateTicketMarkdown } from "./core/markdown";
import {
  type AppEvent,
  type AppState,
  type Effect,
  createInitialState,
  isEditorDirty,
  update,
} from "./core/state";
import {
  type ChangeRequestDoc,
  type DraftRecord,
  type Item,
  type Rect,
  SCHEMA_VERSION,
  type SnapshotMeta,
  TOOL_VERSION,
} from "./core/types";
import { decompressGzipBase64ToString } from "./shell/codec";
import {
  type AnchorTarget,
  createEditorStateForElement,
  createEditorStateForPageMeta,
  createEditorStateForRegion,
  expandCurrentEditorLocator,
  getElementPageRect,
  measureAnchorTargets,
  mountShadowHost,
  normalizePickTarget,
  resolvePageAnchorTargets,
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
import {
  EMBEDDED_VIEWER_CSS_GZIP_BASE64,
  EMBEDDED_VIEWER_SCRIPT_GZIP_BASE64,
  EMBEDDED_VIEWER_SHA256_BASE64,
} from "./viewer/embedded-bundle";

export type PageChangeRequestGlobal = {
  readonly toggle: () => void;
  readonly destroy: () => void;
};

declare global {
  interface Window {
    __pageChangeRequest?: PageChangeRequestGlobal | undefined;
  }
}

// トラックパッドやマウスのわずかなぶれで範囲選択にならないよう、少し余裕を持たせる
const DRAG_THRESHOLD_PX = 12;
const SAVE_DEBOUNCE_MS = 500;
const STATUS_DISPLAY_MS = 5000;
const UNRESOLVED_RETRY_MS = 500;

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

export const filterReferencedReportAssets = (
  doc: ChangeRequestDoc,
  snapshotBodies: ReadonlyMap<string, string>,
  resources: ReadonlyMap<string, ResourceEntry>,
): {
  readonly filteredDoc: ChangeRequestDoc;
  readonly filteredSnapshotBodies: Readonly<Record<string, string>>;
  readonly filteredResources: Readonly<Record<string, ResourceEntry>>;
} => {
  const referencedSnapshotIds = new Set(
    doc.items.flatMap((i) => (i.snapshotId !== undefined ? [i.snapshotId] : [])),
  );
  const referencedAttachmentIds = new Set(doc.items.flatMap((i) => i.attachmentIds));
  const filteredSnapshots = doc.snapshots.filter((s) => referencedSnapshotIds.has(s.id));
  const filteredAttachments = doc.attachments.filter((a) => referencedAttachmentIds.has(a.id));
  const filteredSnapshotBodies = Object.fromEntries(
    Array.from(snapshotBodies.entries()).filter(([id]) => referencedSnapshotIds.has(id)),
  );
  // 参照の記録が無い古いスナップショットが混ざるときだけ、取りこぼしを避けて全件残す
  const hasLegacySnapshot = filteredSnapshots.some((s) => s.resourceHashes === undefined);
  const referencedHashes = new Set([
    ...filteredSnapshots.flatMap((s) => s.resourceHashes ?? []),
    ...filteredAttachments.map((a) => a.resourceHash),
  ]);
  const filteredResources = Object.fromEntries(
    Array.from(resources.entries()).filter(
      ([hash]) => hasLegacySnapshot || referencedHashes.has(hash),
    ),
  );

  return {
    filteredDoc: {
      ...doc,
      snapshots: filteredSnapshots,
      attachments: filteredAttachments,
    },
    filteredSnapshotBodies,
    filteredResources,
  };
};

type LastSnapshot = {
  readonly meta: SnapshotMeta;
  readonly domVersion: number;
  readonly viewportW: number;
};

type RuntimeContext = {
  state: AppState;
  readonly snapshotBodies: Map<string, string>;
  readonly resources: Map<string, ResourceEntry>;
  readonly previewUrls: Map<string, string>;
  readonly pendingCaptures: Set<Promise<void>>;
  saveTimerId: ReturnType<typeof setTimeout> | null;
  statusTimerId: ReturnType<typeof setTimeout> | null;
  rafId: number | null;
  hoverRafId: number | null;
  hoverPoint: { readonly x: number; readonly y: number } | null;
  pointerDownPos: { readonly x: number; readonly y: number } | null;
  anchorTargets: readonly AnchorTarget[];
  anchorsDirty: boolean;
  previewDirty: boolean;
  lastUnresolvedRetryAt: number;
  /** ページ側（ツール以外）による DOM 変更の回数。スナップショットを使い回せるかの判定に使う */
  domVersion: number;
  lastSnapshotByUrl: Map<string, LastSnapshot>;
};

export const launchPageChangeRequestTool = (): PageChangeRequestGlobal => {
  const existing = window.__pageChangeRequest;
  if (existing !== undefined) {
    existing.toggle();
    return existing;
  }

  const doc = document;
  const { host, mountNode } = mountShadowHost(doc, OVERLAY_CSS);

  const ctx: RuntimeContext = {
    state: createInitialState(window.location.href),
    snapshotBodies: new Map<string, string>(),
    resources: new Map<string, ResourceEntry>(),
    previewUrls: new Map<string, string>(),
    pendingCaptures: new Set<Promise<void>>(),
    saveTimerId: null,
    statusTimerId: null,
    rafId: null,
    hoverRafId: null,
    hoverPoint: null,
    pointerDownPos: null,
    anchorTargets: [],
    anchorsDirty: true,
    previewDirty: false,
    lastUnresolvedRetryAt: 0,
    domVersion: 0,
    lastSnapshotByUrl: new Map<string, LastSnapshot>(),
  };

  // ツール自身のプレビュー書き換えはページ側の変更として扱わない。
  // 書き換え前に溜まっていた記録は退避して処理し、書き換え中の記録は捨てる
  const pendingMutationRecords: MutationRecord[] = [];
  const mutationObserver = new MutationObserver((records) => handlePageMutations(records));
  const livePreview = createLivePreviewController({
    beforeMutate: () => {
      pendingMutationRecords.push(...mutationObserver.takeRecords());
    },
    afterMutate: () => {
      mutationObserver.takeRecords();
      if (pendingMutationRecords.length > 0) {
        const records = pendingMutationRecords.splice(0);
        queueMicrotask(() => handlePageMutations(records));
      }
    },
  });

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
              dispatch({ type: "OPERATION_FAILED", message: res.error });
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

  // 1 フレームに 1 回だけ、必要な処理（プレビューの当て直し・要素の特定・位置の計測）を行う。
  // スクロール時は位置の計測だけで済ませ、重い要素の特定は DOM や項目が変わったときに限る
  const scheduleFrame = (): void => {
    if (ctx.rafId !== null) {
      return;
    }
    ctx.rafId = window.requestAnimationFrame(() => {
      ctx.rafId = null;
      if (window.location.href !== ctx.state.currentUrl) {
        dispatch({ type: "URL_CHANGED", url: window.location.href });
      }
      if (ctx.previewDirty) {
        ctx.previewDirty = false;
        livePreview.resync();
        ctx.anchorsDirty = true;
      }
      if (ctx.anchorsDirty) {
        ctx.anchorsDirty = false;
        ctx.anchorTargets = resolvePageAnchorTargets(
          doc,
          ctx.state.items,
          ctx.state.currentUrl,
          livePreview.getResolvedTarget,
        );
      }
      ctx.state = { ...ctx.state, resolvedAnchors: measureAnchorTargets(doc, ctx.anchorTargets) };
      renderApp();
    });
  };

  const scheduleAnchorRefresh = (): void => {
    ctx.anchorsDirty = true;
    scheduleFrame();
  };

  const onScrollOrResize = (): void => scheduleFrame();

  function handlePageMutations(records: readonly MutationRecord[]): void {
    if (records.length === 0) {
      return;
    }
    ctx.domVersion += 1;
    // React などの再描画でプレビューが消えた・要素が作り直されたときは当て直す。
    // まだ見つかっていない項目（遅延表示される要素など）は間隔を空けて探し直す
    const now = Date.now();
    const shouldRetryUnresolved =
      livePreview.hasUnresolvedItems() && now - ctx.lastUnresolvedRetryAt > UNRESOLVED_RETRY_MS;
    if (livePreview.isAffectedByMutations(records) || shouldRetryUnresolved) {
      ctx.lastUnresolvedRetryAt = now;
      ctx.previewDirty = true;
    }
    scheduleAnchorRefresh();
  }

  const openEditorForElementAndItem = (element: Element, existingItem?: Item): void => {
    const ed = createEditorStateForElement(doc, element, livePreview.withCleanDom, existingItem);
    const previewUrl =
      ed.attachmentId !== undefined ? getAttachmentPreviewUrl(ed.attachmentId) : undefined;
    dispatch({
      type: "OPEN_EDITOR",
      editor: previewUrl !== undefined ? { ...ed, attachmentPreviewUrl: previewUrl } : ed,
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
    openEditorForElementAndItem(res.value.element, item);
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
    if (item.anchor.kind === "region") {
      const resolved = ctx.state.resolvedAnchors.find((a) => a.seq === item.seq);
      const rect = resolved?.rect ?? item.anchor.pageRect;
      const editor = createEditorStateForRegion(doc, rect, livePreview.withCleanDom, item);
      dispatch({ type: "OPEN_EDITOR", editor });
      return;
    }
    openEditorForElementItem(item);
  };

  const findExistingElementItemForTarget = (target: Element): Item | undefined =>
    ctx.state.items.find((item) => {
      if (item.url !== ctx.state.currentUrl || item.anchor.kind !== "element") {
        return false;
      }
      const cached = livePreview.getResolvedTarget(item.seq);
      return cached?.element === target;
    });

  // 前回の記録から DOM も画面幅も変わっていなければ、同じスナップショットを使い回す
  const findReusableSnapshot = (url: string): SnapshotMeta | null => {
    const last = ctx.lastSnapshotByUrl.get(url);
    if (
      last === undefined ||
      last.domVersion !== ctx.domVersion ||
      last.viewportW !== window.innerWidth ||
      !ctx.snapshotBodies.has(last.meta.id)
    ) {
      return null;
    }
    return last.meta;
  };

  const captureSnapshotForItem = async (item: Item): Promise<void> => {
    const reusable = findReusableSnapshot(item.url);
    if (reusable !== null) {
      dispatch({ type: "SNAPSHOT_CAPTURED_FOR_ITEM", seq: item.seq, snapshot: reusable });
      return;
    }
    const domVersionAtStart = ctx.domVersion;
    try {
      const captured = await captureCleanSnapshot(
        doc,
        livePreview.withCleanDom,
        Object.fromEntries(ctx.resources),
      );
      ctx.snapshotBodies.set(captured.meta.id, captured.compressedHtmlBase64);
      captured.newResources.map((r) => ctx.resources.set(r.hash, r));
      ctx.lastSnapshotByUrl.set(item.url, {
        meta: captured.meta,
        domVersion: domVersionAtStart,
        viewportW: captured.meta.viewport.w,
      });
      dispatch({ type: "SNAPSHOT_CAPTURED_FOR_ITEM", seq: item.seq, snapshot: captured.meta });
    } catch (error) {
      console.error("[page-change-request] snapshot capture failed", error);
      dispatch({ type: "SNAPSHOT_CAPTURED_FOR_ITEM", seq: item.seq });
      dispatch({
        type: "OPERATION_FAILED",
        message: "画面スナップショットの取得に失敗しました（変更内容は保存済み）",
      });
    }
  };

  const executeCaptureSnapshotEffect = (item: Item): void => {
    const task = captureSnapshotForItem(item);
    ctx.pendingCaptures.add(task);
    void task.finally(() => ctx.pendingCaptures.delete(task));
  };

  const executeCompleteAndExport = async (): Promise<void> => {
    try {
      await exportReport();
    } catch (error) {
      console.error("[page-change-request] export failed", error);
      dispatch({ type: "OPERATION_FAILED", message: "エクスポートに失敗しました" });
    }
  };

  const exportReport = async (): Promise<void> => {
    if (ctx.pendingCaptures.size > 0) {
      dispatch({ type: "SHOW_STATUS", message: "画面の記録が終わるのを待っています…" });
      await Promise.all(Array.from(ctx.pendingCaptures));
    }
    const rawDoc: ChangeRequestDoc = {
      schemaVersion: SCHEMA_VERSION,
      toolVersion: TOOL_VERSION,
      createdAt: new Date().toISOString(),
      origin: window.location.origin,
      snapshots: ctx.state.snapshots,
      items: ctx.state.items,
      attachments: ctx.state.attachments,
    };
    const { filteredDoc, filteredSnapshotBodies, filteredResources } = filterReferencedReportAssets(
      rawDoc,
      ctx.snapshotBodies,
      ctx.resources,
    );
    const markdown = generateTicketMarkdown(filteredDoc);
    const isCopied = await copyTextToClipboard(markdown);

    const htmlReport = buildReportHtmlString({
      pageTitle: doc.title || "ページ",
      doc: filteredDoc,
      snapshotBodies: filteredSnapshotBodies,
      resources: filteredResources,
      viewerScript: await decompressGzipBase64ToString(EMBEDDED_VIEWER_SCRIPT_GZIP_BASE64),
      viewerScriptSha256Base64: EMBEDDED_VIEWER_SHA256_BASE64,
      viewerStyles: await decompressGzipBase64ToString(EMBEDDED_VIEWER_CSS_GZIP_BASE64),
    });
    downloadHtmlReportBlob(htmlReport, formatReportFilename(doc.title));
    await markDraftAsCompletedInDb(buildDraftRecord());
    dispatch({
      type: "EXPORT_FINISHED",
      message: isCopied
        ? "Markdown をコピーし HTML レポートを保存しました"
        : "HTML レポートを保存しました（Markdown はコピーできなかったため、レポートの「チケット用にコピー」を使ってください）",
    });
  };

  const findScrollElementForItem = (item: Item): Element | null => {
    if (item.anchor.kind !== "element") {
      return null;
    }
    const cached = livePreview.getResolvedTarget(item.seq);
    if (cached !== undefined) {
      return cached.element;
    }
    const target = ctx.anchorTargets.find((t) => t.seq === item.seq);
    if (target?.kind === "element" && target.element?.isConnected) {
      return target.element;
    }
    const res = resolveElementLocator(doc, item.anchor.locator, item.after);
    return res.ok ? res.value.element : null;
  };

  const scrollToTargetItem = (item: Item): void => {
    const el = findScrollElementForItem(item);
    if (el !== null) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (item.anchor.kind === "element") {
      window.scrollTo({ top: Math.max(0, item.anchor.rect.y - 120), behavior: "smooth" });
    } else if (item.anchor.kind === "region") {
      window.scrollTo({ top: Math.max(0, item.anchor.pageRect.y - 120), behavior: "smooth" });
    }
  };

  // 取り消した項目のスナップショット・画像をメモリに抱え続けないよう、保存のたびに整理する。
  // 記録中のスナップショットが既存の画像を参照する可能性があるため、その間は整理しない
  const pruneInMemoryAssets = (): void => {
    if (ctx.state.pendingSnapshotSeqs.length > 0 || ctx.pendingCaptures.size > 0) {
      return;
    }
    const snapshotIds = new Set(ctx.state.snapshots.map((s) => s.id));
    Array.from(ctx.snapshotBodies.keys())
      .filter((id) => !snapshotIds.has(id))
      .map((id) => ctx.snapshotBodies.delete(id));
    if (ctx.state.snapshots.some((s) => s.resourceHashes === undefined)) {
      return;
    }
    const hashes = new Set([
      ...ctx.state.snapshots.flatMap((s) => s.resourceHashes ?? []),
      ...ctx.state.attachments.map((a) => a.resourceHash),
    ]);
    Array.from(ctx.resources.keys())
      .filter((hash) => !hashes.has(hash))
      .map((hash) => ctx.resources.delete(hash));
    Array.from(ctx.lastSnapshotByUrl.entries())
      .filter(([, last]) => !snapshotIds.has(last.meta.id))
      .map(([url]) => ctx.lastSnapshotByUrl.delete(url));
  };

  const scheduleDebouncedDraftSave = (): void => {
    if (ctx.saveTimerId !== null) {
      clearTimeout(ctx.saveTimerId);
    }
    ctx.saveTimerId = setTimeout(() => {
      pruneInMemoryAssets();
      void saveDraftAndAssetsToDb(
        buildDraftRecord(),
        Object.fromEntries(ctx.snapshotBodies),
        Object.fromEntries(ctx.resources),
      ).then((isSaved) => {
        if (!isSaved) {
          dispatch({
            type: "OPERATION_FAILED",
            message: "下書きを保存できませんでした（ブラウザを閉じると消えます）",
          });
        }
      });
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

  const hydrateCompletedDraftFromDb = async (): Promise<void> => {
    const draft = await promoteCompletedDraftToActiveInDb();
    if (draft === null) {
      return;
    }
    const bundle = await loadInitialStorageBundle();
    Object.entries(bundle.snapshotBodies).map(([id, b64]) => ctx.snapshotBodies.set(id, b64));
    Object.entries(bundle.resources).map(([hKey, r]) => ctx.resources.set(hKey, r));
    dispatch({ type: "HYDRATE_DRAFT", draft, hasCompletedDraft: false });
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
        void hydrateCompletedDraftFromDb();
        break;
      case "CAPTURE_SNAPSHOT_FOR_ITEM":
        executeCaptureSnapshotEffect(effect.item);
        break;
      case "SCROLL_TO_ITEM":
        scrollToTargetItem(effect.item);
        break;
      case "OPEN_EDITOR_FOR_ITEM":
        handleBadgeClick(effect.seq);
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

  // ステータス表示は一定時間で自動的に消す
  const syncStatusTimer = (prevMessage: string | null): void => {
    const message = ctx.state.statusMessage;
    if (message === prevMessage) {
      return;
    }
    if (ctx.statusTimerId !== null) {
      clearTimeout(ctx.statusTimerId);
      ctx.statusTimerId = null;
    }
    if (message !== null) {
      ctx.statusTimerId = setTimeout(() => {
        ctx.statusTimerId = null;
        if (ctx.state.statusMessage === message) {
          dispatch({ type: "CLEAR_STATUS" });
        }
      }, STATUS_DISPLAY_MS);
    }
  };

  function dispatch(event: AppEvent): void {
    const prevMessage = ctx.state.statusMessage;
    const result = update(ctx.state, event);
    ctx.state = result.state;
    syncStatusTimer(prevMessage);
    renderApp();
    result.effects.map(runEffect);
  }

  const isPointingActive = (): boolean =>
    ctx.state.isVisible && !ctx.state.isPaused && !ctx.state.isAltPressed;

  const pickTargetAtPoint = (clientX: number, clientY: number): Element | null => {
    const target = doc.elementFromPoint(clientX, clientY);
    if (
      target === null ||
      target === doc.documentElement ||
      target === doc.body ||
      target === host
    ) {
      return null;
    }
    return normalizePickTarget(target);
  };

  const isSameRect = (a: Rect | null, b: Rect | null): boolean =>
    a === b ||
    (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

  // pointermove ごとに描画し直さず、1 フレームにまとめ、枠が変わったときだけ描画する
  const scheduleHoverUpdate = (clientX: number, clientY: number): void => {
    ctx.hoverPoint = { x: clientX, y: clientY };
    if (ctx.hoverRafId !== null) {
      return;
    }
    ctx.hoverRafId = window.requestAnimationFrame(() => {
      ctx.hoverRafId = null;
      const point = ctx.hoverPoint;
      if (point === null || !isPointingActive()) {
        return;
      }
      const target = pickTargetAtPoint(point.x, point.y);
      const rect = target !== null ? getElementPageRect(doc, target) : null;
      if (!isSameRect(rect, ctx.state.hoveredRect)) {
        dispatch({ type: "UPDATE_HOVER_RECT", rect });
      }
    });
  };

  // 入力途中のエディタがあるときは、黙って捨てずに確認する
  const confirmDiscardEditorIfDirty = (): boolean => {
    const { editor } = ctx.state;
    if (editor === null || !isEditorDirty(editor)) {
      return true;
    }
    return window.confirm("入力中の内容は確定されていません。破棄して別の箇所を選びますか？");
  };

  const syncAltKeyFromEvent = (altKey: boolean): void => {
    if (ctx.state.isAltPressed && !altKey) {
      dispatch({ type: "SET_ALT_PRESSED", isAltPressed: false });
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    syncAltKeyFromEvent(e.altKey);
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
    scheduleHoverUpdate(e.clientX, e.clientY);
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

  const openEditorAtPoint = (clientX: number, clientY: number): void => {
    const target = pickTargetAtPoint(clientX, clientY);
    if (target === null) {
      if (ctx.state.editor !== null) {
        dispatch({ type: "CLOSE_EDITOR" });
      }
      return;
    }
    const existingItem = findExistingElementItemForTarget(target);
    openEditorForElementAndItem(target, existingItem);
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
    dispatch({ type: "UPDATE_DRAG_RECT", rect: null });
    if (!confirmDiscardEditorIfDirty()) {
      return;
    }

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

    openEditorAtPoint(e.clientX, e.clientY);
  };

  // Mac では Option+クリックがリンクの「ダウンロード」になるため、
  // Alt / Option を押したままのリンククリックは修飾キーなしのクリックとして送り直す
  const redispatchAltLinkClick = (e: MouseEvent): boolean => {
    const target = e.target instanceof Element ? e.target : null;
    if (!e.isTrusted || !e.altKey || target?.closest("a[href]") == null) {
      return false;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    target.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        button: e.button,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        altKey: false,
      }),
    );
    return true;
  };

  const isToolDownloadClick = (e: MouseEvent): boolean =>
    e.target instanceof Element && e.target.hasAttribute("data-pcr-download");

  const onClickCapture = (e: MouseEvent): void => {
    if (!ctx.state.isVisible || isEventInsideHost(e, host) || isToolDownloadClick(e)) {
      return;
    }
    if (ctx.state.isPaused || ctx.state.isAltPressed || e.altKey) {
      redispatchAltLinkClick(e);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
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

  const onWindowBlur = (): void => {
    ctx.pointerDownPos = null;
    if (ctx.state.isAltPressed) {
      dispatch({ type: "SET_ALT_PRESSED", isAltPressed: false });
    }
  };

  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("click", onClickCapture, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("scroll", onScrollOrResize, { passive: true, capture: true });
  window.addEventListener("resize", onScrollOrResize, { passive: true });
  window.addEventListener("popstate", scheduleAnchorRefresh);

  if (doc.body !== null) {
    mutationObserver.observe(doc.body, { childList: true, subtree: true, characterData: true });
  }

  void detectIncognitoMode().then((isIncognito) => {
    if (isIncognito) {
      dispatch({ type: "SET_INCOGNITO_WARNING", isIncognito: true });
    }
  });

  void loadInitialStorageBundle().then((bundle) => {
    if (bundle.activeDraft !== null) {
      Object.entries(bundle.snapshotBodies).map(([id, b64]) => ctx.snapshotBodies.set(id, b64));
      Object.entries(bundle.resources).map(([hKey, r]) => ctx.resources.set(hKey, r));
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
    if (ctx.statusTimerId !== null) {
      clearTimeout(ctx.statusTimerId);
    }
    if (ctx.rafId !== null) {
      cancelAnimationFrame(ctx.rafId);
    }
    if (ctx.hoverRafId !== null) {
      cancelAnimationFrame(ctx.hoverRafId);
    }
    mutationObserver.disconnect();
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("click", onClickCapture, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onWindowBlur);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
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
