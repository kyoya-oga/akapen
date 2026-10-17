import { resolveDomPath } from "../core/dom-path";
import {
  extractPathname,
  formatChangeTypeLabel,
  formatPageMetaFieldLabel,
  generateAiInstructionMarkdown,
  generateTicketMarkdown,
} from "../core/markdown";
import { type PreviewMode, applyPreviewToClonedDocument, computeCharDiff } from "../core/preview";
import type { ChangeRequestDoc, Item, Rect } from "../core/types";
import {
  base64ToUint8Array,
  copyTextToClipboard,
  decompressGzipBase64ToString,
} from "../shell/codec";
import type { ResourceEntry } from "../shell/snapshot-io";

const createResourceBlobUrls = (
  resources: Readonly<Record<string, ResourceEntry>>,
): Readonly<Record<string, string>> => {
  const entries = Object.entries(resources).map(([hash, res]) => {
    const bytes = base64ToUint8Array(res.base64);
    const blob = new Blob([bytes as unknown as BlobPart], { type: res.mime });
    return [hash, URL.createObjectURL(blob)] as const;
  });
  return Object.fromEntries(entries);
};

const replacePcrResWithBlobUrls = (
  html: string,
  blobUrlsByHash: Readonly<Record<string, string>>,
): string =>
  html.replace(/pcr-res:([a-f0-9]+)/g, (full, hash: string) => blobUrlsByHash[hash] ?? full);

const computeIframeRegionRect = (
  iframeDoc: Document,
  item: Item & { readonly anchor: Extract<Item["anchor"], { readonly kind: "region" }> },
): Rect => {
  const container = resolveDomPath(iframeDoc.documentElement, item.anchor.container.domPath);
  if (container !== null) {
    const r = container.getBoundingClientRect();
    const scrollX = iframeDoc.defaultView?.scrollX ?? 0;
    const scrollY = iframeDoc.defaultView?.scrollY ?? 0;
    if (r.width > 0 && r.height > 0) {
      return {
        x: Math.round(r.left + scrollX + r.width * item.anchor.ratio.x),
        y: Math.round(r.top + scrollY + r.height * item.anchor.ratio.y),
        w: Math.round(r.width * item.anchor.ratio.w),
        h: Math.round(r.height * item.anchor.ratio.h),
      };
    }
  }
  return item.anchor.pageRect;
};

const ensureRegionOverlayElement = (
  iframeDoc: Document,
  item: Item & { readonly anchor: Extract<Item["anchor"], { readonly kind: "region" }> },
): Element | null => {
  if (iframeDoc.body === null) {
    return null;
  }
  const existing = iframeDoc.querySelector(`[data-pcr-region-seq="${item.seq}"]`);
  const box = existing ?? iframeDoc.createElement("div");
  const rect = computeIframeRegionRect(iframeDoc, item);
  box.setAttribute("data-pcr-region-seq", String(item.seq));
  box.setAttribute(
    "style",
    `position:absolute;left:${rect.x}px;top:${rect.y}px;width:${Math.max(4, rect.w)}px;height:${Math.max(4, rect.h)}px;border:2px dashed #ea580c;background:rgba(234,88,12,0.12);pointer-events:none;z-index:2147483640;`,
  );
  if (existing === null) {
    iframeDoc.body.appendChild(box);
  }
  return box;
};

const resolveItemTargetInIframe = (iframeDoc: Document, item: Item): Element | null => {
  if (item.anchor.kind === "element") {
    return resolveDomPath(iframeDoc.documentElement, item.anchor.locator.domPath);
  }
  if (item.anchor.kind === "region") {
    return ensureRegionOverlayElement(
      iframeDoc,
      item as Item & { readonly anchor: Extract<Item["anchor"], { readonly kind: "region" }> },
    );
  }
  return null;
};

const ensureIframeHighlightStyle = (iframeDoc: Document, mode: PreviewMode): void => {
  const styleId = "pcr-viewer-highlight-style";
  const existing = iframeDoc.getElementById(styleId);
  const styleEl = existing ?? iframeDoc.createElement("style");
  styleEl.id = styleId;
  const baseRule =
    mode === "before"
      ? "[data-pcr-seq] { outline: 2px solid #dc2626 !important; outline-offset: 2px !important; }"
      : "";
  styleEl.textContent = [
    baseRule,
    '[data-pcr-selected="true"] { box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.5) !important; }',
  ].join("\n");
  if (existing === null) {
    (iframeDoc.head ?? iframeDoc.documentElement).appendChild(styleEl);
  }
};

const applyHighlightToTarget = (
  target: Element,
  item: Item,
  isSelected: boolean,
  mode: PreviewMode,
): void => {
  target.setAttribute("data-pcr-seq", String(item.seq));
  if (isSelected) {
    target.setAttribute("data-pcr-selected", "true");
    const scrollTarget =
      mode === "after" && item.changeType === "DELETE" ? (target.parentElement ?? target) : target;
    scrollTarget.scrollIntoView({ behavior: "smooth", block: "center" });
  } else {
    target.removeAttribute("data-pcr-selected");
  }
};

const decorateIframeBadges = (
  iframeDoc: Document,
  snapshotItems: readonly Item[],
  selectedSeq: number | null,
  mode: PreviewMode,
): void => {
  ensureIframeHighlightStyle(iframeDoc, mode);
  snapshotItems.map((item) => {
    const target = resolveItemTargetInIframe(iframeDoc, item);
    if (target !== null) {
      applyHighlightToTarget(target, item, item.seq === selectedSeq, mode);
    }
  });
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string>> = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  Object.entries(attrs).map(([k, v]) => node.setAttribute(k, v));
  children.map((c) => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return node;
};

const buildCharDiffNode = (before: string, after: string): HTMLElement => {
  const box = el("div", { class: "v-diff-box" });
  computeCharDiff(before, after).map((seg) => {
    const cls = seg.kind === "delete" ? "v-diff-del" : seg.kind === "insert" ? "v-diff-ins" : "";
    box.appendChild(el("span", cls ? { class: cls } : {}, [seg.text]));
  });
  return box;
};

const buildPageMetaCardNode = (item: Item): HTMLElement => {
  const card = el("div", { class: "v-card" }, [
    el("div", { class: "v-card-head" }, [
      el("div", {}, [
        el("span", { class: "v-badge" }, [`#${item.seq}`]),
        " ",
        el("span", { class: "v-type-tag" }, [formatChangeTypeLabel(item.changeType)]),
      ]),
    ]),
  ]);
  if (item.meta !== undefined && item.meta.length > 0) {
    const rows = item.meta.map((m) =>
      el("tr", {}, [
        el("th", {}, [formatPageMetaFieldLabel(m.field)]),
        el("td", {}, [m.before]),
        el("td", {}, [m.after]),
      ]),
    );
    const table = el("table", { class: "v-table" }, [
      el("thead", {}, [
        el("tr", {}, [el("th", {}, ["項目"]), el("th", {}, ["変更前"]), el("th", {}, ["変更後"])]),
      ]),
      el("tbody", {}, rows),
    ]);
    card.appendChild(table);
  }
  if (item.memo !== undefined) {
    card.appendChild(el("div", { class: "v-diff-box" }, [`メモ：${item.memo}`]));
  }
  return card;
};

const appendItemCardBody = (card: HTMLElement, item: Item, attUrl: string | undefined): void => {
  if (item.before !== undefined && item.after !== undefined) {
    card.appendChild(buildCharDiffNode(item.before, item.after));
  } else if (item.before !== undefined) {
    card.appendChild(
      el("div", { class: "v-diff-box" }, [el("span", { class: "v-diff-del" }, [item.before])]),
    );
  }
  if (item.hrefBefore !== undefined || item.hrefAfter !== undefined) {
    card.appendChild(
      el("div", { class: "v-diff-box", style: "font-size:12px;" }, [
        el("div", {}, [`リンク変更前：${item.hrefBefore ?? "(なし)"}`]),
        el("div", {}, [`リンク変更後：${item.hrefAfter ?? "(なし)"}`]),
      ]),
    );
  }
  if (attUrl !== undefined) {
    card.appendChild(
      el("div", {}, [
        el("a", { href: attUrl, download: `attachment-${item.seq}.webp` }, [
          el("img", { class: "v-att-img", src: attUrl, alt: "差し替え画像" }),
        ]),
      ]),
    );
  }
  if (item.memo !== undefined) {
    card.appendChild(el("div", { class: "v-diff-box" }, [`メモ：${item.memo}`]));
  }
  if (item.hasChildFormatting) {
    card.appendChild(
      el("div", { class: "v-notice" }, ["※子要素の装飾はプレビューに反映されていません"]),
    );
  }
};

const buildItemDetailCardNode = (
  item: Item,
  isSelected: boolean,
  onSelect: () => void,
  resolveAttachmentBlobUrl: (attId: string) => string | undefined,
): HTMLElement => {
  const headRight: HTMLElement[] = [];
  if (item.before !== undefined && item.before.length > 0) {
    const copyText = item.before;
    const copyBtn = el(
      "button",
      { type: "button", class: "v-btn v-btn-light", style: "padding:3px 8px;font-size:11px;" },
      ["検索用にコピー"],
    );
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void copyTextToClipboard(copyText);
    });
    headRight.push(copyBtn);
  }

  const card = el("div", { class: `v-card ${isSelected ? "is-selected" : ""}` }, [
    el("div", { class: "v-card-head" }, [
      el("div", {}, [
        el("span", { class: "v-badge" }, [`#${item.seq}`]),
        " ",
        el("span", { class: "v-type-tag" }, [formatChangeTypeLabel(item.changeType)]),
      ]),
      ...headRight,
    ]),
    el("div", { class: "v-card-url" }, [
      extractPathname(item.url),
      ...(item.snapshotId === undefined ? ["（画面の記録なし）"] : []),
    ]),
  ]);
  card.addEventListener("click", onSelect);
  const attId = item.attachmentIds[0];
  const attUrl = attId !== undefined ? resolveAttachmentBlobUrl(attId) : undefined;
  appendItemCardBody(card, item, attUrl);
  return card;
};

export const mountViewerFromDom = (): void => {
  const dataEl = document.getElementById("pcr-data");
  const snapsEl = document.getElementById("pcr-snapshots");
  const resEl = document.getElementById("pcr-resources");
  const appEl = document.getElementById("app");
  if (dataEl === null || snapsEl === null || resEl === null || appEl === null) {
    return;
  }
  const doc = JSON.parse(dataEl.textContent ?? "{}") as ChangeRequestDoc;
  const snapshotBodies = JSON.parse(snapsEl.textContent ?? "{}") as Readonly<
    Record<string, string>
  >;
  const resources = JSON.parse(resEl.textContent ?? "{}") as Readonly<
    Record<string, ResourceEntry>
  >;
  const blobUrlsByHash = createResourceBlobUrls(resources);

  const resolveAttachmentUrl = (attachmentId: string): string | undefined => {
    const att = doc.attachments.find((a) => a.id === attachmentId);
    return att !== undefined ? blobUrlsByHash[att.resourceHash] : undefined;
  };

  const firstVisualItem = doc.items.find((i) => i.snapshotId !== undefined);
  const state: {
    selectedSeq: number | null;
    mode: PreviewMode;
    customWidth: number | null;
    copyNotice: string | null;
  } = {
    selectedSeq: firstVisualItem?.seq ?? null,
    mode: "diff",
    customWidth: null,
    copyNotice: null,
  };

  const iframe = el("iframe", {
    class: "v-iframe",
    title: "snapshot-preview",
    sandbox: "allow-same-origin",
  }) as HTMLIFrameElement;

  const iframeWrap = el("div", { class: "v-iframe-wrap" }, [iframe]);
  const sidebar = el("aside", { class: "v-sidebar" });
  const headerControls = el("div", { class: "v-controls" });

  const header = el("header", { class: "v-header" }, [
    el("div", { class: "v-title-area" }, [
      el("span", { class: "v-title" }, ["ページ変更依頼レポート"]),
      el("span", { class: "v-meta" }, [
        `作成: ${new Date(doc.createdAt).toLocaleString("ja-JP")} / Tool v${doc.toolVersion}`,
      ]),
    ]),
    headerControls,
  ]);

  const main = el("div", { class: "v-main" }, [
    el("div", { class: "v-preview-pane" }, [iframeWrap]),
    sidebar,
  ]);

  while (appEl.firstChild !== null) {
    appEl.removeChild(appEl.firstChild);
  }
  appEl.appendChild(header);
  appEl.appendChild(main);

  // 選んだ変更に画面の記録が無いときは、別ページの画面を代わりに出さない
  const getActiveSnapshotId = (): string | undefined => {
    const selected = doc.items.find((i) => i.seq === state.selectedSeq);
    if (selected !== undefined) {
      return selected.snapshotId;
    }
    return firstVisualItem?.snapshotId ?? doc.snapshots[0]?.id;
  };

  const showNoSnapshotMessage = (): void => {
    iframe.srcdoc =
      '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;color:#475569;padding:32px;">この変更には画面の記録がありません（記録に失敗したか、ページ情報の変更です）。右の一覧で内容を確認してください。</body>';
  };

  iframe.addEventListener("load", () => {
    const iframeDoc = iframe.contentDocument;
    const snapId = getActiveSnapshotId();
    if (iframeDoc !== null && snapId !== undefined) {
      const sameSnapItems = doc.items.filter((i) => i.snapshotId === snapId);
      decorateIframeBadges(iframeDoc, sameSnapItems, state.selectedSeq, state.mode);
    }
  });

  const refreshIframeContent = (): void => {
    const snapId = getActiveSnapshotId();
    const compressed = snapId !== undefined ? snapshotBodies[snapId] : undefined;
    if (snapId === undefined || compressed === undefined) {
      showNoSnapshotMessage();
      return;
    }
    void decompressGzipBase64ToString(compressed).then((rawHtml) => {
      const parser = new DOMParser();
      const parsedDoc = parser.parseFromString(rawHtml, "text/html");
      const sameSnapItems = doc.items.filter((i) => i.snapshotId === snapId);
      applyPreviewToClonedDocument(parsedDoc, sameSnapItems, state.mode, resolveAttachmentUrl);
      iframe.srcdoc = replacePcrResWithBlobUrls(
        `<!doctype html>\n${parsedDoc.documentElement.outerHTML}`,
        blobUrlsByHash,
      );
    });
  };

  const renderViewerUi = (): void => {
    const snapId = getActiveSnapshotId();
    const snapMeta = doc.snapshots.find((s) => s.id === snapId);
    const displayWidth = state.customWidth ?? snapMeta?.viewport.w ?? 1280;
    iframeWrap.style.width = `${displayWidth}px`;

    while (headerControls.firstChild !== null) {
      headerControls.removeChild(headerControls.firstChild);
    }
    const segGroup = el("div", { class: "v-seg-group" });
    (["before", "after", "diff"] as const).map((m) => {
      const btn = el(
        "button",
        { type: "button", class: `v-seg-btn ${state.mode === m ? "is-active" : ""}` },
        [m === "before" ? "変更前" : m === "after" ? "変更後" : "差分"],
      );
      btn.addEventListener("click", () => {
        state.mode = m;
        renderViewerUi();
        refreshIframeContent();
      });
      segGroup.appendChild(btn);
    });

    const widthBtn = el("button", { type: "button", class: "v-btn" }, [
      state.customWidth === 375 ? `元の幅 (${snapMeta?.viewport.w ?? 1280}px)` : "幅 375px",
    ]);
    widthBtn.addEventListener("click", () => {
      state.customWidth = state.customWidth === 375 ? null : 375;
      renderViewerUi();
    });

    const ticketBtn = el("button", { type: "button", class: "v-btn" }, ["チケット用にコピー"]);
    ticketBtn.addEventListener("click", () => {
      void copyTextToClipboard(generateTicketMarkdown(doc)).then(() => {
        state.copyNotice = "チケット用 Markdown をコピーしました";
        renderViewerUi();
      });
    });

    const aiBtn = el("button", { type: "button", class: "v-btn" }, ["作業指示としてコピー"]);
    aiBtn.addEventListener("click", () => {
      void copyTextToClipboard(generateAiInstructionMarkdown(doc)).then(() => {
        state.copyNotice = "AI 向け作業指示をコピーしました";
        renderViewerUi();
      });
    });

    headerControls.appendChild(segGroup);
    headerControls.appendChild(widthBtn);
    headerControls.appendChild(ticketBtn);
    headerControls.appendChild(aiBtn);

    while (sidebar.firstChild !== null) {
      sidebar.removeChild(sidebar.firstChild);
    }
    const noticeBox = el("div", { class: "v-notice" }, [
      "※プレビューは変更内容の目安です。実際の実装結果とは細部が異なる場合があります。",
    ]);
    if (state.copyNotice !== null) {
      noticeBox.appendChild(
        el("div", { style: "color:#16a34a;font-weight:700;" }, [state.copyNotice]),
      );
    }
    sidebar.appendChild(noticeBox);

    doc.items
      .filter((i) => i.changeType === "PAGE_META")
      .map((item) => sidebar.appendChild(buildPageMetaCardNode(item)));

    doc.items
      .filter((i) => i.changeType !== "PAGE_META")
      .map((item) =>
        sidebar.appendChild(
          buildItemDetailCardNode(
            item,
            item.seq === state.selectedSeq,
            () => {
              const prevSnapId = getActiveSnapshotId();
              state.selectedSeq = item.seq;
              renderViewerUi();
              if (getActiveSnapshotId() !== prevSnapId) {
                refreshIframeContent();
              } else if (iframe.contentDocument !== null && item.snapshotId !== undefined) {
                const sameSnap = doc.items.filter((i) => i.snapshotId === item.snapshotId);
                decorateIframeBadges(
                  iframe.contentDocument,
                  sameSnap,
                  state.selectedSeq,
                  state.mode,
                );
              }
            },
            resolveAttachmentUrl,
          ),
        ),
      );
  };

  renderViewerUi();
  refreshIframeContent();
};

if (typeof document !== "undefined" && document.getElementById("pcr-data") !== null) {
  mountViewerFromDom();
}
