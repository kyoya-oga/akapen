import { describe, expect, test } from "vitest";
import { captureElementLocator, resolveDomPath } from "../src/core/anchor";
import {
  HOST_ELEMENT_ID,
  collectImageUrlsFromClonedRoot,
  replaceImageUrlsWithResourceHashes,
  sanitizeClonedDocument,
  shouldExcludeSnapshotForUrl,
  syncLiveDomStateBeforeClone,
} from "../src/core/sanitize";
import {
  MAX_TOTAL_RESOURCE_BYTES,
  type ResourceEntry,
  selectResourcesWithinBudget,
} from "../src/shell/snapshot-io";
import { createTestDocument, mustQuery } from "./helpers";

describe("スナップショットからの個人情報・スクリプト・危険属性の除去", () => {
  test("フォームに入力途中の氏名や住所、隠しトークンがあっても、書き出されるスナップショットからは個人情報が消去され選択状態だけが残る", () => {
    const liveDoc = createTestDocument();
    const nameInput = liveDoc.querySelector('input[name="customer_name"]') as HTMLInputElement;
    nameInput.value = "鈴木 花子";
    const checkbox = liveDoc.querySelector('input[name="gift_wrap"]') as HTMLInputElement;
    checkbox.checked = true;
    const select = liveDoc.querySelector('select[name="delivery_time"]') as HTMLSelectElement;
    if (select.options[0]) {
      select.options[0].selected = true;
    }
    if (select.options[1]) {
      select.options[1].selected = false;
    }

    const cloneDoc = createTestDocument();
    syncLiveDomStateBeforeClone(liveDoc.documentElement, cloneDoc.documentElement);
    sanitizeClonedDocument(cloneDoc, "https://shop.example.com/products/123");

    const clonedName = cloneDoc.querySelector('input[name="customer_name"]') as HTMLInputElement;
    const clonedEmail = cloneDoc.querySelector('input[name="customer_email"]') as HTMLInputElement;
    const clonedHidden = cloneDoc.querySelector('input[name="session_secret"]') as HTMLInputElement;
    const clonedNote = cloneDoc.querySelector(
      'textarea[name="delivery_note"]',
    ) as HTMLTextAreaElement;
    const clonedCheckbox = cloneDoc.querySelector('input[name="gift_wrap"]') as HTMLInputElement;
    const clonedSelect = cloneDoc.querySelector(
      'select[name="delivery_time"]',
    ) as HTMLSelectElement;

    expect(clonedName.getAttribute("value")).toBe("");
    expect(clonedEmail.getAttribute("value")).toBe("");
    expect(clonedHidden.getAttribute("value")).toBe("");
    expect(clonedNote.textContent).toBe("");
    expect(clonedCheckbox.hasAttribute("checked")).toBe(true);
    expect(clonedSelect.options[0]?.hasAttribute("selected")).toBe(true);
    expect(clonedSelect.options[1]?.hasAttribute("selected")).toBe(false);
  });

  test("__NEXT_DATA__を含むスクリプトやイベントハンドラ、javascript:リンク、CSRFメタタグがすべて無害化・消去される", () => {
    const doc = createTestDocument();
    sanitizeClonedDocument(doc, "https://shop.example.com/products/123");

    const html = doc.documentElement.outerHTML;
    expect(doc.querySelectorAll("script")).toHaveLength(0);
    expect(html).not.toContain("__NEXT_DATA__");
    expect(html).not.toContain("090-1234-5678");
    expect(html).not.toContain("secret-csrf-token-99999");
    expect(doc.querySelector(".cart-btn")?.hasAttribute("onclick")).toBe(false);
    expect(doc.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(doc.querySelector(".bad-link")?.getAttribute("href")).toBe("#");
    expect(doc.querySelectorAll("iframe")).toHaveLength(0);
    expect(doc.querySelector('[data-pcr-iframe-placeholder="true"]')).not.toBeNull();
  });

  test("スクリプトやpreloadタグを取り除いて無害化した後でも、依頼者が指した要素の位置（domPath）がずれずにレポート上で特定できる", () => {
    const doc = createTestDocument();
    const host = doc.createElement("div");
    host.id = HOST_ELEMENT_ID;
    doc.documentElement.appendChild(host);

    const targetEl = mustQuery(doc, ".campaign-section .link-text");
    const locator = captureElementLocator(doc, targetEl);

    sanitizeClonedDocument(doc, "https://shop.example.com/products/123");

    const resolvedInSanitized = resolveDomPath(doc.documentElement, locator.domPath);
    expect(resolvedInSanitized).not.toBeNull();
    expect(resolvedInSanitized?.textContent).toBe("秋の特別キャンペーン詳細はこちら");
  });

  test("マイページや購入手続きなどの対象外ページでは、個人情報保護のためスナップショットを撮らないと判定される", () => {
    expect(shouldExcludeSnapshotForUrl("https://shop.example.com/mypage/orders")).toBe(true);
    expect(shouldExcludeSnapshotForUrl("https://shop.example.com/checkout/confirm")).toBe(true);
    expect(shouldExcludeSnapshotForUrl("https://shop.example.com/cart")).toBe(true);
    expect(shouldExcludeSnapshotForUrl("https://shop.example.com/products/123")).toBe(false);
    expect(shouldExcludeSnapshotForUrl("https://shop.example.com/campaigns/autumn")).toBe(false);
  });
});

describe("CSSと画像リソースのURL変換・重複除去・サイズ上限", () => {
  test("スナップショット内の相対パス画像やCSSのurl()がすべて絶対URLに変換され、取得済み画像はハッシュ参照に置き換わる", () => {
    const doc = createTestDocument();
    const baseUrl = "https://shop.example.com/products/123";
    sanitizeClonedDocument(doc, baseUrl);

    const stylesheetHref = doc.querySelector('link[rel="stylesheet"]')?.getAttribute("href");
    expect(stylesheetHref).toBe("https://shop.example.com/styles/main.css");

    const urls = collectImageUrlsFromClonedRoot(doc.documentElement, baseUrl);
    expect(urls).toContain("https://shop.example.com/images/autumn-banner.jpg");
    expect(urls).toContain("https://shop.example.com/images/hero-sub.jpg");
    expect(urls).toContain("https://shop.example.com/images/campaign-bg.png");

    replaceImageUrlsWithResourceHashes(doc.documentElement, baseUrl, {
      "https://shop.example.com/images/autumn-banner.jpg": "aaaa1111",
      "https://shop.example.com/images/campaign-bg.png": "bbbb2222",
    });

    expect(doc.querySelector(".campaign-section img")?.getAttribute("src")).toBe(
      "pcr-res:aaaa1111",
    );
    expect(doc.querySelector("style")?.textContent).toContain("pcr-res:bbbb2222");
    // Unmapped image remains absolute URL
    expect(doc.querySelector(".hero-banner")?.getAttribute("style")).toContain(
      "https://shop.example.com/images/hero-sub.jpg",
    );
  });

  test("同じ画像が複数箇所で使われていても重複して保持されず、合計10MBの上限を超えた画像は外部URLのまま残される", () => {
    const entryA: ResourceEntry = {
      hash: "hash-a",
      mime: "image/jpeg",
      base64: "AAAA",
      byteLength: 6 * 1024 * 1024,
    };
    const entryB: ResourceEntry = {
      hash: "hash-b",
      mime: "image/jpeg",
      base64: "BBBB",
      byteLength: 5 * 1024 * 1024,
    };

    const budgetResult = selectResourcesWithinBudget(
      [
        { url: "https://shop.example.com/img1.jpg", entry: entryA },
        { url: "https://shop.example.com/img1-dup.jpg", entry: entryA },
        { url: "https://shop.example.com/img2-over-limit.jpg", entry: entryB },
      ],
      {},
    );

    expect(MAX_TOTAL_RESOURCE_BYTES).toBe(10 * 1024 * 1024);
    expect(budgetResult.newResources).toHaveLength(1);
    expect(budgetResult.urlToHash["https://shop.example.com/img1.jpg"]).toBe("hash-a");
    expect(budgetResult.urlToHash["https://shop.example.com/img1-dup.jpg"]).toBe("hash-a");
    expect(budgetResult.urlToHash["https://shop.example.com/img2-over-limit.jpg"]).toBeUndefined();
  });
});
