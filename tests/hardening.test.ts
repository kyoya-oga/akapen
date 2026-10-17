import { afterEach, describe, expect, test, vi } from "vitest";
import { buildTextQuote } from "../src/core/anchor";
import { isConfirmEnter } from "../src/core/keyboard";
import { applyPreviewToClonedDocument, computeCharDiff } from "../src/core/preview";
import { sanitizeClonedDocument } from "../src/core/sanitize";
import { UNSAFE_HREF_MESSAGE, createInitialState, update } from "../src/core/state";
import type { DraftEditorState, ElementLocator, Item } from "../src/core/types";
import { isDangerousUrl, isSafeNavigationUrl } from "../src/core/url-safety";
import { mountShadowHost } from "../src/shell/dom-overlay";
import { buildReportHtmlString, escapeScriptContent } from "../src/shell/export-io";
import { saveDraftAndAssetsToDb } from "../src/shell/storage-idb";
import { createTestDocument } from "./helpers";

describe("日本語 IME の変換確定 Enter で入力が確定してしまわない", () => {
  test("変換中（isComposing / keyCode 229）の Enter は確定扱いにならない", () => {
    expect(isConfirmEnter({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(isConfirmEnter({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
  });

  test("通常の Enter は確定、Shift+Enter は改行のため確定にならない", () => {
    expect(isConfirmEnter({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 })).toBe(
      true,
    );
    expect(isConfirmEnter({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isConfirmEnter({ key: "a", shiftKey: false })).toBe(false);
  });
});

describe("巨大な DOM や長文でもスタックが溢れない", () => {
  test("約4万ノードのページで要素を選んでも、前後の文脈つきで引用位置を取得できる", () => {
    const doc = createTestDocument("<html><body></body></html>");
    doc.body.innerHTML = Array.from({ length: 20000 }, (_, i) => `<p>row ${i}</p>`).join("");
    const target = doc.body.children[10000] as Element;

    const quote = buildTextQuote(doc, target);

    expect(quote.exact).toBe("row 10000");
    expect(quote.prefix.endsWith("row 9999")).toBe(true);
    expect(quote.suffix.startsWith("row 10001")).toBe(true);
  });

  test("5万文字の変更後テキストでも、差分は変更箇所だけを挿入・削除として返す", () => {
    const before = "あ".repeat(50000);
    const after = `${"あ".repeat(49999)}い`;

    const segments = computeCharDiff(before, after);

    expect(segments.map((s) => s.kind)).toEqual(["equal", "delete", "insert"]);
    expect(segments[1]?.text).toBe("あ");
    expect(segments[2]?.text).toBe("い");
  });

  test("前後が一致する差分は従来どおり接頭辞・差分・接尾辞に分割される", () => {
    expect(computeCharDiff("送料500円です", "送料無料です")).toEqual([
      { kind: "equal", text: "送料" },
      { kind: "delete", text: "500円" },
      { kind: "insert", text: "無料" },
      { kind: "equal", text: "です" },
    ]);
  });
});

describe("リンク先 URL の検証", () => {
  test("依頼者が入力するリンク先は http(s) / mailto / tel / 相対パスだけ許可される", () => {
    expect(isSafeNavigationUrl("https://example.com/a?b=1")).toBe(true);
    expect(isSafeNavigationUrl("/campaign/spring")).toBe(true);
    expect(isSafeNavigationUrl("#top")).toBe(true);
    expect(isSafeNavigationUrl("mailto:info@example.com")).toBe(true);
    expect(isSafeNavigationUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeNavigationUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeNavigationUrl("file:///etc/passwd")).toBe(false);
  });

  test("スキーム中に空白・タブ・改行・制御文字・ゼロ幅文字を混ぜても危険な URL として検出される", () => {
    expect(isDangerousUrl("java\tscript:alert(1)")).toBe(true);
    expect(isDangerousUrl("  JaVa\nScRiPt:alert(1)")).toBe(true);
    expect(isDangerousUrl("\u0001javascript:alert(1)")).toBe(true);
    expect(isDangerousUrl("java\u200bscript:alert(1)")).toBe(true);
    expect(isSafeNavigationUrl("java\tscript:alert(1)")).toBe(false);
  });

  test("スナップショットに正当に含まれる画像 data URL と通常リンクは危険扱いされない", () => {
    expect(isDangerousUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isDangerousUrl("https://example.com/")).toBe(false);
    expect(isDangerousUrl("/relative/path")).toBe(false);
  });

  test("リンクを変更して javascript: を入力したまま確定しようとしても、記録されずエラーが表示される", () => {
    const editor: DraftEditorState = {
      targetKind: "link",
      anchor: {
        kind: "element",
        locator: {
          selector: "a",
          textQuote: { exact: "詳細", prefix: "", suffix: "" },
          tagName: "a",
          domPath: [0],
        },
        rect: { x: 0, y: 0, w: 10, h: 10 },
      },
      expansionHistory: [],
      initialText: "詳細",
      currentText: "詳細",
      initialHref: "/detail",
      currentHref: "javascript:alert(1)",
      memo: "",
      isDeleteRequested: false,
      hasChildFormatting: false,
      popoverRect: { x: 0, y: 0, w: 10, h: 10 },
    };
    const opened = update(createInitialState("https://shop.example.com/", false), {
      type: "OPEN_EDITOR",
      editor,
    });

    const result = update(opened.state, { type: "CONFIRM_EDITOR" });

    expect(result.effects).toEqual([]);
    expect(result.state.editor).not.toBeNull();
    expect(result.state.statusMessage).toBe(UNSAFE_HREF_MESSAGE);
  });

  test("元ページの href が javascript:void(0) のとき、リンクを変更せず文言だけ直しても確定できる", () => {
    const locator: ElementLocator = {
      selector: "a",
      textQuote: { exact: "開く", prefix: "", suffix: "" },
      tagName: "a",
      domPath: [0],
    };
    const editor: DraftEditorState = {
      targetKind: "link",
      anchor: { kind: "element", locator, rect: { x: 0, y: 0, w: 10, h: 10 } },
      expansionHistory: [],
      initialText: "開く",
      currentText: "閉じる",
      initialHref: "javascript:void(0)",
      currentHref: "javascript:void(0)",
      memo: "",
      isDeleteRequested: false,
      hasChildFormatting: false,
      popoverRect: { x: 0, y: 0, w: 10, h: 10 },
    };
    const opened = update(createInitialState("https://shop.example.com/", false), {
      type: "OPEN_EDITOR",
      editor,
    });

    const result = update(opened.state, { type: "CONFIRM_EDITOR" });

    expect(result.effects[0]?.type).toBe("CAPTURE_SNAPSHOT_AND_COMMIT_ITEM");
  });

  test("下書きやレポートに javascript: のリンク先が紛れ込んでいても、プレビューの href には適用されない", () => {
    const doc = createTestDocument('<html><body><a id="t" href="/old">旧</a></body></html>');
    const item: Item = {
      seq: 1,
      url: "https://shop.example.com/",
      anchor: {
        kind: "element",
        locator: {
          selector: "#t",
          textQuote: { exact: "旧", prefix: "", suffix: "" },
          tagName: "a",
          domPath: [1, 0],
        },
        rect: { x: 0, y: 0, w: 1, h: 1 },
      },
      changeType: "LINK_CHANGE",
      hrefBefore: "/old",
      hrefAfter: "javascript:alert(1)",
      attachmentIds: [],
    };

    applyPreviewToClonedDocument(doc, [item], "after", () => undefined);

    expect(doc.getElementById("t")?.getAttribute("href")).toBe("/old");
  });
});

describe("スナップショットの無害化（追加分）", () => {
  test("<base> タグは除去され、相対 URL の解決先を差し替えられない", () => {
    const doc = createTestDocument(
      '<html><head><base href="https://evil.example/"></head><body><a href="/x">x</a></body></html>',
    );

    sanitizeClonedDocument(doc, "https://shop.example.com/products/123");

    expect(doc.querySelector("base")).toBeNull();
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("https://shop.example.com/x");
  });

  test("スキーム中にタブや改行を挟んだ javascript: リンクも無害化される", () => {
    const doc = createTestDocument('<html><body><a id="t" href="/x">x</a></body></html>');
    doc.getElementById("t")?.setAttribute("href", "java\tscr\nipt:alert(1)");

    sanitizeClonedDocument(doc, "https://shop.example.com/");

    expect(doc.getElementById("t")?.getAttribute("href")).toBe("#");
  });
});

describe("書き出す HTML レポートの安全性", () => {
  test("本文に </script> や <!--<script> を含んでも JSON から < が出力されず、パース後は元の文字列に戻る", () => {
    const payload = JSON.stringify({ t: "</script><!--<script>alert(1)</script>" });

    const escaped = escapeScriptContent(payload);

    expect(escaped).not.toContain("<");
    expect(JSON.parse(escaped)).toEqual({ t: "</script><!--<script>alert(1)</script>" });
  });

  test("CSP で <base> の差し替えとフォーム送信が禁止され、外部通信は画像・CSS 以外に許可されない", () => {
    const html = buildReportHtmlString({
      pageTitle: "t",
      doc: {
        schemaVersion: 1,
        toolVersion: "0",
        createdAt: "2026-01-01T00:00:00.000Z",
        origin: "https://shop.example.com",
        snapshots: [],
        items: [],
        attachments: [],
      } as never,
      snapshotBodies: {},
      resources: {},
      viewerScript: "",
      viewerScriptSha256Base64: "HASH",
      viewerStyles: "",
    });

    expect(html).toContain("default-src 'none'");
    expect(html).toContain("base-uri 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("script-src 'sha256-HASH'");
  });
});

describe("操作の失敗がユーザーに通知される", () => {
  test("失敗イベントを受け取ると、ステータスメッセージとして表示される", () => {
    const state = createInitialState("https://shop.example.com/", false);

    const result = update(state, {
      type: "OPERATION_FAILED",
      message: "エクスポートに失敗しました",
    });

    expect(result.state.statusMessage).toBe("エクスポートに失敗しました");
  });
});

describe("テキスト引用位置の算出", () => {
  test("インライン要素や空白だけのテキストノードが混在していても、要素の前後の文脈が文書順で取れる", () => {
    const doc = createTestDocument(
      '<html><body><p>前置き<b>強調</b>の続き</p><p>  </p><p id="t">対象</p><p>後ろ</p></body></html>',
    );

    const quote = buildTextQuote(doc, doc.getElementById("t") as Element);

    expect(quote).toEqual({ exact: "対象", prefix: "前置き強調の続き  ", suffix: "後ろ" });
  });

  test("同じ文言が何度も出現しても、すべての出現位置を前後の文脈で見分けられる", () => {
    const doc = createTestDocument(
      '<html><body><p>A</p><p>x</p><p>A</p><p>y</p><p id="t">A</p><p>z</p></body></html>',
    );

    const quote = buildTextQuote(doc, doc.getElementById("t") as Element);

    expect(quote).toEqual({ exact: "A", prefix: "AxAy", suffix: "z" });
  });
});

describe("文字差分の境界", () => {
  test("接頭辞と接尾辞が重なる繰り返し文字列でも、追加された分だけが挿入になる", () => {
    expect(computeCharDiff("aa", "aaa")).toEqual([
      { kind: "equal", text: "aa" },
      { kind: "insert", text: "a" },
    ]);
    expect(computeCharDiff("aaa", "aa")).toEqual([
      { kind: "equal", text: "aa" },
      { kind: "delete", text: "a" },
    ]);
  });

  test("片方が空文字のときは全文が挿入または削除になる", () => {
    expect(computeCharDiff("", "新規")).toEqual([{ kind: "insert", text: "新規" }]);
    expect(computeCharDiff("既存", "")).toEqual([{ kind: "delete", text: "既存" }]);
  });
});

describe("ツール内のキー入力がサイトのショートカットに漏れない", () => {
  test("ツールの入力欄で打ったキーは、ページ側の document リスナーに届かない", () => {
    const doc = createTestDocument("<html><body></body></html>");
    const received: string[] = [];
    doc.addEventListener("keydown", (e) => received.push((e as KeyboardEvent).key));
    const { shadowRoot } = mountShadowHost(doc, "");
    const input = doc.createElement("input");
    shadowRoot.appendChild(input);
    const KeyEvent = (doc.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent })
      .KeyboardEvent;

    input.dispatchEvent(new KeyEvent("keydown", { key: "j", bubbles: true, composed: true }));
    doc.body.dispatchEvent(new KeyEvent("keydown", { key: "k", bubbles: true }));

    expect(received).toEqual(["k"]);
  });
});

type FakeTxOutcome = "complete" | "abort" | "error";

const stubIndexedDb = (outcome: FakeTxOutcome): void => {
  const fakeDb = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const tx: {
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        onabort: (() => void) | null;
        objectStore: () => { put: () => void };
      } = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: () => ({
          put: () =>
            setTimeout(() => {
              const handler = { complete: tx.oncomplete, abort: tx.onabort, error: tx.onerror }[
                outcome
              ];
              handler?.();
            }, 0),
        }),
      };
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const req: { result: unknown; onsuccess: (() => void) | null } = {
        result: fakeDb,
        onsuccess: null,
      };
      setTimeout(() => req.onsuccess?.(), 0);
      return req;
    },
  });
};

describe("下書きの保存結果", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const draft = {
    id: "active",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextSeq: 1,
    items: [],
    snapshots: [],
    attachments: [],
  } as const;

  test("すべて書き込めたときだけ保存成功として返す", async () => {
    stubIndexedDb("complete");

    await expect(saveDraftAndAssetsToDb(draft, { s1: "body" }, {})).resolves.toBe(true);
  });

  test("容量超過でトランザクションが abort されても、固まらず保存失敗として返す", async () => {
    stubIndexedDb("abort");

    await expect(saveDraftAndAssetsToDb(draft, { s1: "body" }, {})).resolves.toBe(false);
  });

  test("書き込みエラーのときも保存失敗として返す", async () => {
    stubIndexedDb("error");

    await expect(saveDraftAndAssetsToDb(draft, {}, {})).resolves.toBe(false);
  });

  test("IndexedDB が使えない環境では保存失敗として返す", async () => {
    vi.stubGlobal("indexedDB", undefined);

    await expect(saveDraftAndAssetsToDb(draft, {}, {})).resolves.toBe(false);
  });
});
