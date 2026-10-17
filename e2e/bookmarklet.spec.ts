import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const BUNDLE_PATH = join(process.cwd(), "dist", "bookmarklet.js");
const FIXTURE_PATH = join(process.cwd(), "tests", "fixtures", "product-page.html");

test.describe("赤ペン（ブックマークレット）の実ブラウザ動作検証", () => {
  test("ローカルファイル（file://）や非HTTPS環境でも、要素をクリックして文言を書き換え「確定」を押すと、画面上の文字が書き換わり番号バッジと件数が更新される", async ({
    page,
  }) => {
    await page.goto(`file://${join(process.cwd(), "install.html")}`);
    const bundleCode = readFileSync(BUNDLE_PATH, "utf-8");
    await page.evaluate(bundleCode);

    await page.click("h1");

    const popoverInfo = await page.evaluate(() => {
      const sr = document.getElementById("pcr-bookmarklet-host")?.shadowRoot;
      const textarea = sr?.querySelector(".pcr-textarea") as HTMLTextAreaElement | null;
      return {
        isOpen: sr?.querySelector(".pcr-popover") !== null,
        initialValue: textarea?.value,
      };
    });
    expect(popoverInfo.isOpen).toBe(true);
    expect(popoverInfo.initialValue).toBe("赤ペン（ページ変更依頼ツール）");

    await page.evaluate(() => {
      const sr = document.getElementById("pcr-bookmarklet-host")?.shadowRoot;
      const textarea = sr?.querySelector(".pcr-textarea") as HTMLTextAreaElement | undefined;
      if (textarea !== undefined) {
        textarea.value = "変更後の新しい見出しタイトル";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const confirmBtn = Array.from(sr?.querySelectorAll("button") ?? []).find(
        (b) => b.textContent === "確定",
      );
      confirmBtn?.click();
    });

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const sr = document.getElementById("pcr-bookmarklet-host")?.shadowRoot;
          return {
            h1Text: document.querySelector("h1")?.textContent,
            badgeCount: sr?.querySelectorAll(".pcr-badge").length ?? 0,
            barText: sr?.querySelector(".pcr-bar")?.textContent ?? "",
            popoverOpen: sr?.querySelector(".pcr-popover") !== null,
          };
        });
      })
      .toEqual({
        h1Text: "変更後の新しい見出しタイトル",
        badgeCount: 1,
        barText: expect.stringContaining("指摘 1件"),
        popoverOpen: false,
      });
  });

  test("「外枠へ広げる ↑」ボタンを押したとき、scriptやstyleの中身が混入せず、外側のセクション全体の削除やメモ指定に切り替わり、この要素を削除できる", async ({
    page,
  }) => {
    const html = readFileSync(FIXTURE_PATH, "utf-8");
    await page.setContent(html);
    const bundleCode = readFileSync(BUNDLE_PATH, "utf-8");
    await page.evaluate(bundleCode);

    await page.click('[data-testid="product-title"]');

    await page.evaluate(() => {
      const sr = document.getElementById("pcr-bookmarklet-host")?.shadowRoot;
      const expandBtn = Array.from(sr?.querySelectorAll("button") ?? []).find((b) =>
        b.textContent?.includes("外枠へ広げる"),
      );
      expandBtn?.click();
    });

    const expandedInfo = await page.evaluate(() => {
      const sr = document.getElementById("pcr-bookmarklet-host")?.shadowRoot;
      const note = sr?.querySelector(".pcr-note")?.textContent ?? "";
      return { note };
    });
    expect(expandedInfo.note).toContain("選択範囲を外側のブロック（<section>）に広げました");

    await page.evaluate(() => {
      const sr = document.getElementById("pcr-bookmarklet-host")?.shadowRoot;
      const deleteBtn = Array.from(sr?.querySelectorAll("button") ?? []).find((b) =>
        b.textContent?.includes("この要素を削除"),
      );
      deleteBtn?.click();
    });

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const hero = document.querySelector(".hero-banner");
          const sr = document.getElementById("pcr-bookmarklet-host")?.shadowRoot;
          return {
            heroStyle: hero?.getAttribute("style") ?? "",
            badgeCount: sr?.querySelectorAll(".pcr-badge").length ?? 0,
          };
        });
      })
      .toEqual({
        heroStyle: expect.stringContaining("line-through"),
        badgeCount: 1,
      });
  });

  test("指摘を確定したあと「完了」ボタンを押すと、HTMLレポートがダウンロードされ、そのレポートをブラウザで開くとスナップショットと変更差分が表示される", async ({
    page,
  }) => {
    const html = readFileSync(FIXTURE_PATH, "utf-8");
    await page.route("https://shop.example.com/**", (route) => {
      if (route.request().url() === "https://shop.example.com/products/123") {
        return route.fulfill({ contentType: "text/html", body: html });
      }
      return route.fulfill({ status: 404, body: "" });
    });

    await page.goto("https://shop.example.com/products/123");
    const bundleCode = readFileSync(BUNDLE_PATH, "utf-8");
    await page.evaluate(bundleCode);

    await page.click('[data-testid="product-title"]');
    await page.evaluate(() => {
      const sr = document.getElementById("pcr-bookmarklet-host")?.shadowRoot;
      const textarea = sr?.querySelector(".pcr-textarea") as HTMLTextAreaElement | undefined;
      if (textarea !== undefined) {
        textarea.value = "リニューアル後のビタミンC美容液 50mL";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const confirmBtn = Array.from(sr?.querySelectorAll("button") ?? []).find(
        (b) => b.textContent === "確定",
      );
      confirmBtn?.click();
    });

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            document
              .getElementById("pcr-bookmarklet-host")
              ?.shadowRoot?.querySelectorAll(".pcr-badge").length ?? 0,
        ),
      )
      .toBe(1);

    const downloadPromise = page.waitForEvent("download");
    await page.evaluate(() => {
      const sr = document.getElementById("pcr-bookmarklet-host")?.shadowRoot;
      const completeBtn = Array.from(sr?.querySelectorAll("button") ?? []).find(
        (b) => b.textContent === "完了",
      );
      completeBtn?.click();
    });
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("変更依頼_");
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();

    const reportHtml = readFileSync(downloadPath ?? "", "utf-8");
    const reportPage = await page.context().newPage();
    await reportPage.setContent(reportHtml);

    await expect(reportPage.locator(".v-title")).toHaveText("ページ変更依頼レポート");
    await expect(reportPage.locator(".v-card")).toHaveCount(1);
    await expect(reportPage.locator(".v-diff-ins")).toContainText("リニューアル後の");
  });
});
