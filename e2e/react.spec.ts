import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { build } from "esbuild";

const BUNDLE_PATH = join(process.cwd(), "dist", "bookmarklet.js");
const REACT_APP_ENTRY = join(process.cwd(), "e2e", "fixtures", "react-app.tsx");
const PAGE_URL = "https://react.example.com/products/1";

let reactAppScript = "";

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [REACT_APP_ENTRY],
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "react",
    define: { "process.env.NODE_ENV": '"development"' },
    write: false,
  });
  reactAppScript = result.outputFiles[0]?.text ?? "";
});

const openReactPageWithTool = async (page: Page): Promise<string[]> => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await page.route("https://react.example.com/**", (route) => {
    if (route.request().url() === PAGE_URL) {
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><meta charset="utf-8"><title>React</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      });
    }
    if (route.request().url().endsWith("/app.js")) {
      return route.fulfill({ contentType: "text/javascript", body: reactAppScript });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(PAGE_URL);
  await expect(page.getByTestId("price")).toContainText("1000");
  await page.evaluate(readFileSync(BUNDLE_PATH, "utf-8"));
  return pageErrors;
};

const editAndConfirm = async (page: Page, testId: string, newText: string): Promise<void> => {
  await page.getByTestId(testId).click();
  await page.evaluate((text) => {
    const sr = document.getElementById("pcr-bookmarklet-host")?.shadowRoot;
    const textarea = sr?.querySelector(".pcr-textarea") as HTMLTextAreaElement | null;
    if (textarea === null || textarea === undefined) {
      throw new Error("editor textarea not found");
    }
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const confirmBtn = Array.from(sr?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "確定",
    );
    confirmBtn?.click();
  }, newText);
};

const badgeCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      document.getElementById("pcr-bookmarklet-host")?.shadowRoot?.querySelectorAll(".pcr-badge")
        .length ?? 0,
  );

test.describe("React アプリ上での動作", () => {
  test("複数の子ノードを持つ要素の文言を変更したあと React が再描画しても、ページが壊れずプレビューが維持される", async ({
    page,
  }) => {
    const pageErrors = await openReactPageWithTool(page);

    await editAndConfirm(page, "price", "価格 980 円（税込・送料込み）");
    await expect.poll(() => badgeCount(page)).toBe(1);
    await expect(page.getByTestId("price")).toHaveText("価格 980 円（税込・送料込み）");

    await page.evaluate(() => window.__bumpPrice?.());
    await page.evaluate(() => window.__toggleNotice?.());
    await expect(page.getByTestId("notice")).toBeVisible();

    expect(pageErrors).toEqual([]);
    await expect(page.getByTestId("price")).toHaveText("価格 980 円（税込・送料込み）");
    await expect.poll(() => badgeCount(page)).toBe(1);
  });

  test("ツールを閉じると React が管理する最新の表示に戻り、その後の再描画でもエラーにならない", async ({
    page,
  }) => {
    const pageErrors = await openReactPageWithTool(page);

    await editAndConfirm(page, "price", "価格 980 円");
    await expect(page.getByTestId("price")).toHaveText("価格 980 円");
    await page.evaluate(() => window.__bumpPrice?.());

    await page.evaluate(() => window.__pageChangeRequest?.destroy());
    await expect(page.getByTestId("price")).toHaveText("価格 1100 円（税込）");
    await page.evaluate(() => window.__bumpPrice?.());
    await expect(page.getByTestId("price")).toHaveText("価格 1200 円（税込）");
    expect(pageErrors).toEqual([]);
  });

  test("子要素が増減する要素の文言を変更しても、React の再描画でページが壊れない", async ({
    page,
  }) => {
    const pageErrors = await openReactPageWithTool(page);

    await editAndConfirm(page, "campaign", "夏のキャンペーン実施中");
    await expect(page.getByTestId("campaign")).toHaveText("夏のキャンペーン実施中");

    await page.evaluate(() => window.__toggleBadge?.());
    await page.evaluate(() => window.__toggleBadge?.());
    await page.evaluate(() => window.__bumpPrice?.());
    await expect(page.getByTestId("price")).toContainText("1100");

    expect(pageErrors).toEqual([]);
    await expect(page.getByTestId("campaign")).toHaveText("夏のキャンペーン実施中");
  });

  test("変更した要素を React が作り直しても、新しい要素にプレビューが再適用される", async ({
    page,
  }) => {
    const pageErrors = await openReactPageWithTool(page);

    await editAndConfirm(page, "lead", "送料は全国一律 500 円です");
    await expect(page.getByTestId("lead")).toHaveText("送料は全国一律 500 円です");

    await page.evaluate(() => window.__remountLead?.());

    await expect(page.getByTestId("lead")).toHaveText("送料は全国一律 500 円です");
    await expect.poll(() => badgeCount(page)).toBe(1);
    expect(pageErrors).toEqual([]);
  });
});
