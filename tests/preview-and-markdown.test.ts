import { describe, expect, test } from "vitest";
import { captureElementLocator, resolveDomPath } from "../src/core/anchor";
import { generateAiInstructionMarkdown, generateTicketMarkdown } from "../src/core/markdown";
import { applyPreviewToClonedDocument, computeCharDiff } from "../src/core/preview";
import type { ChangeRequestDoc, Item } from "../src/core/types";
import { createLivePreviewController } from "../src/shell/live-preview";
import { createTestDocument, mustQuery } from "./helpers";

describe("対象ページのライブ書き換えと元の状態への巻き戻し", () => {
  test("依頼者が文言やリンク・削除を確定したとき画面上のDOMに即座に反映され、ツール終了や巻き戻しで元のDOMが完全に復元される", () => {
    const doc = createTestDocument();
    const url = "https://shop.example.com/products/123";
    const titleEl = mustQuery(doc, '[data-testid="product-title"]');
    const linkSpanEl = mustQuery(doc, ".campaign-link .link-text");
    const cartBtnEl = mustQuery(doc, ".cart-btn");

    const titleLoc = captureElementLocator(doc, titleEl);
    const linkSpanLoc = captureElementLocator(doc, linkSpanEl);
    const cartLoc = captureElementLocator(doc, cartBtnEl);

    const items: readonly Item[] = [
      {
        seq: 1,
        url,
        anchor: { kind: "element", locator: titleLoc, rect: { x: 0, y: 0, w: 100, h: 30 } },
        changeType: "TEXT_REPLACE",
        before: "プレミアムビタミンC美容液 30mL",
        after: "プレミアムビタミンC美容液 50mL（大容量）",
        attachmentIds: [],
      },
      {
        seq: 2,
        url,
        anchor: { kind: "element", locator: linkSpanLoc, rect: { x: 0, y: 0, w: 100, h: 30 } },
        changeType: "TEXT_AND_LINK_CHANGE",
        before: "秋の特別キャンペーン詳細はこちら",
        after: "冬の特別キャンペーン詳細はこちら",
        hrefBefore: "/campaigns/autumn",
        hrefAfter: "/campaigns/winter",
        attachmentIds: [],
      },
      {
        seq: 3,
        url,
        anchor: { kind: "element", locator: cartLoc, rect: { x: 0, y: 0, w: 100, h: 30 } },
        changeType: "DELETE",
        before: "カートに入れる",
        attachmentIds: [],
      },
    ];

    const controller = createLivePreviewController();
    controller.syncItems(doc, items, url, () => undefined);

    expect(titleEl.textContent).toBe("プレミアムビタミンC美容液 50mL（大容量）");
    expect(linkSpanEl.textContent).toBe("冬の特別キャンペーン詳細はこちら");
    expect(doc.querySelector(".campaign-link")?.getAttribute("href")).toBe("/campaigns/winter");
    expect(cartBtnEl.getAttribute("style")).toContain("line-through");

    const cleanSnapshotTitle = controller.withCleanDom(() => titleEl.textContent);
    expect(cleanSnapshotTitle).toBe("プレミアムビタミンC美容液 30mL");
    expect(titleEl.textContent).toBe("プレミアムビタミンC美容液 50mL（大容量）");

    controller.restoreAll();
    expect(titleEl.textContent).toBe("プレミアムビタミンC美容液 30mL");
    expect(linkSpanEl.textContent).toBe("秋の特別キャンペーン詳細はこちら");
    expect(doc.querySelector(".campaign-link")?.getAttribute("href")).toBe("/campaigns/autumn");
    expect(cartBtnEl.getAttribute("style")).toBeNull();
  });
});

describe("レポート上の変更後プレビュー・差分表示・Markdown出力", () => {
  test("レポート上で「変更後」と「差分」を切り替えたとき、スナップショット内の要素に文言置換・非表示化・色枠がそれぞれ適用される", () => {
    const docAfter = createTestDocument();
    const titleEl = mustQuery(docAfter, '[data-testid="product-title"]');
    const cartBtnEl = mustQuery(docAfter, ".cart-btn");
    const titleLoc = captureElementLocator(docAfter, titleEl);
    const cartLoc = captureElementLocator(docAfter, cartBtnEl);

    const items: readonly Item[] = [
      {
        seq: 1,
        url: "https://shop.example.com/products/123",
        snapshotId: "snap-1",
        anchor: { kind: "element", locator: titleLoc, rect: { x: 0, y: 0, w: 100, h: 30 } },
        changeType: "TEXT_REPLACE",
        before: "プレミアムビタミンC美容液 30mL",
        after: "新・ビタミンC美容液",
        attachmentIds: [],
      },
      {
        seq: 2,
        url: "https://shop.example.com/products/123",
        snapshotId: "snap-1",
        anchor: { kind: "element", locator: cartLoc, rect: { x: 0, y: 0, w: 100, h: 30 } },
        changeType: "DELETE",
        before: "カートに入れる",
        attachmentIds: [],
      },
    ];

    applyPreviewToClonedDocument(docAfter, items, "after", () => undefined);
    expect(resolveDomPath(docAfter.documentElement, titleLoc.domPath)?.textContent).toBe(
      "新・ビタミンC美容液",
    );
    expect(
      resolveDomPath(docAfter.documentElement, cartLoc.domPath)?.getAttribute("style"),
    ).toContain("display:none");

    const docDiff = createTestDocument();
    applyPreviewToClonedDocument(docDiff, items, "diff", () => undefined);
    expect(
      resolveDomPath(docDiff.documentElement, titleLoc.domPath)?.getAttribute("style"),
    ).toContain("#16a34a");
    expect(
      resolveDomPath(docDiff.documentElement, cartLoc.domPath)?.getAttribute("style"),
    ).toContain("line-through");
  });

  test("変更前後の文言から文字単位の差分（共通部分・削除部分・追加部分）が計算される", () => {
    const diff = computeCharDiff("5,000円以上のご購入で送料無料", "3,980円以上のご購入で送料無料");
    expect(diff).toEqual([
      { kind: "delete", text: "5,00" },
      { kind: "insert", text: "3,98" },
      { kind: "equal", text: "0円以上のご購入で送料無料" },
    ]);
  });

  test("完了時に出力されるRedmineチケット用MarkdownとAI向け作業指示に、エスケープ済みの変更内容と前後の文脈・参考セレクタが含まれる", () => {
    const doc = createTestDocument();
    const noticeEl = mustQuery(doc, ".shipping-notice .notice-highlight");
    const locator = captureElementLocator(doc, noticeEl);

    const requestDoc: ChangeRequestDoc = {
      schemaVersion: 1,
      toolVersion: "0.1.0",
      createdAt: "2026-10-16T12:00:00.000Z",
      origin: "https://shop.example.com",
      snapshots: [
        {
          id: "snap-1",
          url: "https://shop.example.com/products/123",
          title: "商品ページ",
          viewport: { w: 1280, h: 800 },
          scroll: { x: 0, y: 0 },
          capturedAt: "2026-10-16T12:00:00.000Z",
        },
      ],
      attachments: [],
      items: [
        {
          seq: 1,
          url: "https://shop.example.com/products/123",
          snapshotId: "snap-1",
          anchor: { kind: "element", locator, rect: { x: 0, y: 0, w: 100, h: 30 } },
          changeType: "TEXT_REPLACE",
          before: "5,000円以上のご購入で送料無料",
          after: "3,980円以上のご購入で*送料無料*",
          attachmentIds: [],
        },
        {
          seq: 2,
          url: "https://shop.example.com/",
          anchor: { kind: "pageMeta" },
          changeType: "PAGE_META",
          meta: [{ field: "title", before: "旧タイトル", after: "新タイトル" }],
          attachmentIds: [],
        },
      ],
    };

    const ticketMd = generateTicketMarkdown(requestDoc);
    expect(ticketMd).toContain("### 変更箇所（2件）");
    expect(ticketMd).toContain("1. **文言の差し替え**（/products/123、幅 1280px）");
    expect(ticketMd).toContain("変更前：5,000円以上のご購入で送料無料");
    expect(ticketMd).toContain("変更後：3,980円以上のご購入で\\*送料無料\\*");
    expect(ticketMd).toContain("2. **ページ情報の変更**（/）");
    expect(ticketMd).toContain("タイトル：「旧タイトル」→「新タイトル」");

    const aiMd = generateAiInstructionMarkdown(requestDoc);
    expect(aiMd).toContain("## 1. 文言の差し替え");
    expect(aiMd).toContain("前後の文脈：");
    expect(aiMd).toContain("税込・送料別");
    expect(aiMd).toContain("カートに入れる");
    expect(aiMd).toContain("セレクタの参考：");
  });
});
