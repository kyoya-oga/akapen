import { describe, expect, test } from "vitest";
import {
  captureElementLocator,
  isStableClassName,
  isStableIdName,
  resolveElementLocator,
} from "../src/core/anchor";
import { detectTargetKind, normalizePickTarget } from "../src/shell/dom-overlay";
import { createTestDocument, mustQuery } from "./helpers";

describe("アンカーの捕捉と別ビルド後の箇所の復元", () => {
  test("CSS Modulesのハッシュ付きクラス名やReactの動的IDはセレクタ生成から除外され、data-testidや安定した構造が優先される", () => {
    expect(isStableClassName("Header_title__a1B2c")).toBe(false);
    expect(isStableClassName("notice-highlight")).toBe(true);
    expect(isStableIdName(":r1:")).toBe(false);
    expect(isStableIdName("main-content")).toBe(true);

    const doc = createTestDocument();
    const titleEl = mustQuery(doc, '[data-testid="product-title"]');
    const leadEl = mustQuery(doc, ".Product_lead__m7N8o");

    const titleLocator = captureElementLocator(doc, titleEl);
    const leadLocator = captureElementLocator(doc, leadEl);

    expect(titleLocator.selector).toBe('[data-testid="product-title"]');
    expect(leadLocator.selector).not.toContain("__m7N8o");
    expect(leadLocator.selector).not.toContain(":r1:");
  });

  test("再ビルドでCSS Modulesのクラス名やDOM階層が変わっても、前後の文脈（TextQuote）から依頼者が指した元の文言の箇所を特定できる", () => {
    const originalDoc = createTestDocument();
    const leadEl = mustQuery(originalDoc, ".Product_lead__m7N8o");
    const locator = captureElementLocator(originalDoc, leadEl);

    const rebuiltHtml = `<!doctype html>
      <html><body>
        <div class="NewLayout_wrapper__z9X8c">
          <h1>プレミアムビタミンC美容液 30mL</h1>
          <div class="NewLayout_box__q1W2e">
            <p class="Product_lead__99999">朝晩のスキンケアに。透明感のある肌へ導きます。</p>
          </div>
        </div>
      </body></html>`;
    const rebuiltDoc = createTestDocument(rebuiltHtml);

    const resolved = resolveElementLocator(rebuiltDoc, {
      ...locator,
      selector: ".non-existent-selector-after-rebuild",
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.confidence).toBe("text_quote");
      expect(resolved.value.element?.textContent).toBe(
        "朝晩のスキンケアに。透明感のある肌へ導きます。",
      );
    }
  });

  test("同じ文言がページ内に複数あっても、前後の文脈（prefix / suffix）で依頼者が指した正しい方の要素を特定できる", () => {
    const doc = createTestDocument();
    const notices = doc.querySelectorAll(".notice-highlight");
    const firstNotice = notices[0] ?? mustQuery(doc, ".notice-highlight");
    const secondNotice = notices[1] ?? mustQuery(doc, ".notice-highlight");

    const secondLocator = captureElementLocator(doc, secondNotice);
    const locatorWithoutExactSelector = {
      ...secondLocator,
      selector: ".broken-selector",
    };

    const resolved = resolveElementLocator(doc, locatorWithoutExactSelector);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.element).toBe(secondNotice);
      expect(resolved.value.element).not.toBe(firstNotice);
    }
  });

  test("対象箇所の文言が既に書き換わっていてセレクタだけが一致するとき、「文言が変わっています」と判別できる信頼度で要素を返す", () => {
    const doc = createTestDocument();
    const titleEl = mustQuery(doc, '[data-testid="product-title"]');
    const locator = captureElementLocator(doc, titleEl);

    titleEl.textContent = "リニューアル後の新しい商品名";

    const resolved = resolveElementLocator(doc, locator);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.confidence).toBe("selector_only");
      expect(resolved.value.element).toBe(titleEl);
    }
  });
});

describe("クリックした要素の扱い", () => {
  test("SVG アイコンの内部をクリックしても、アイコン全体が画像として選ばれる", () => {
    const doc = createTestDocument(
      '<html><body><button><svg id="icon"><g><path id="p" d="M0 0h1v1z"></path></g></svg>保存</button></body></html>',
    );
    const path = doc.getElementById("p") as Element;

    const picked = normalizePickTarget(path);

    expect(picked.id).toBe("icon");
    expect(detectTargetKind(doc, picked)).toBe("image");
  });

  test("背景画像つきでも文字がある要素は文言の編集対象になり、文字の無い背景画像要素は画像の差し替え対象になる", () => {
    const doc = createTestDocument(
      `<html><body>
        <a id="cta" href="/buy" style="background-image:url('/img/arrow.png')">購入する</a>
        <div id="banner" style="background-image:url('/img/banner.png')"></div>
      </body></html>`,
    );

    expect(detectTargetKind(doc, doc.getElementById("cta") as Element)).toBe("link");
    expect(detectTargetKind(doc, doc.getElementById("banner") as Element)).toBe("image");
  });

  test("CSS-in-JS が生成する乱数クラス名はセレクタに使わない", () => {
    expect(isStableClassName("css-1x2y3z")).toBe(false);
    expect(isStableClassName("sc-bdVaJa")).toBe(false);
    expect(isStableClassName("kXbTqG")).toBe(false);
    expect(isStableClassName("jsx-2385271")).toBe(false);
    expect(isStableClassName("product-title")).toBe(true);
    expect(isStableClassName("btn")).toBe(true);
  });
});
