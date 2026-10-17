import { describe, expect, test } from "vitest";
import { determineChangeType } from "../src/core/change-type";
import { createInitialState, update } from "../src/core/state";
import type { DraftEditorState, ElementLocator, PageMetaValues } from "../src/core/types";

const createSampleLocator = (): ElementLocator => ({
  selector: ".notice-highlight",
  textQuote: {
    exact: "5,000円以上のご購入で送料無料",
    prefix: "（税込・送料別）",
    suffix: "カートに入れる",
  },
  tagName: "div",
  domPath: [1, 1, 1, 0, 1],
});

const createTextEditor = (overrides: Partial<DraftEditorState> = {}): DraftEditorState => ({
  targetKind: "text",
  anchor: {
    kind: "element",
    locator: createSampleLocator(),
    rect: { x: 100, y: 200, w: 300, h: 40 },
  },
  expansionHistory: [],
  initialText: "5,000円以上のご購入で送料無料",
  currentText: "5,000円以上のご購入で送料無料",
  memo: "",
  isDeleteRequested: false,
  hasChildFormatting: false,
  popoverRect: { x: 100, y: 200, w: 300, h: 40 },
  ...overrides,
});

describe("文言・リンク・画像・範囲・ページ情報の変更種別の自動判定", () => {
  test("依頼者が要素の文言を新しい文章に書き換えて確定したとき、「文言の差し替え」として記録される", () => {
    const baseState = createInitialState("https://shop.example.com/products/123", false);
    const opened = update(baseState, {
      type: "OPEN_EDITOR",
      editor: createTextEditor(),
    });
    const edited = update(opened.state, {
      type: "UPDATE_EDITOR_TEXT",
      text: "3,980円以上のご購入で送料無料",
    });
    const confirmed = update(edited.state, { type: "CONFIRM_EDITOR" });
    const effect = confirmed.effects[0];

    expect(effect?.type).toBe("CAPTURE_SNAPSHOT_AND_COMMIT_ITEM");
    if (effect?.type === "CAPTURE_SNAPSHOT_AND_COMMIT_ITEM") {
      expect(effect.pendingItem.changeType).toBe("TEXT_REPLACE");
      expect(effect.pendingItem.before).toBe("5,000円以上のご購入で送料無料");
      expect(effect.pendingItem.after).toBe("3,980円以上のご購入で送料無料");
    }
  });

  test("依頼者が文言の入力欄を空にして確定したとき、その要素の「削除」依頼として記録される", () => {
    const result = determineChangeType({
      kind: "text",
      initialText: "期間限定キャンペーン中",
      currentText: "   ",
      memo: "",
      isDeleteRequested: false,
    });

    expect(result).toBe("DELETE");
  });

  test("依頼者が「この要素を削除」ボタンを押したとき、即座にその要素の「削除」依頼として確定される", () => {
    const baseState = createInitialState("https://shop.example.com/products/123", false);
    const opened = update(baseState, {
      type: "OPEN_EDITOR",
      editor: createTextEditor(),
    });
    const deleted = update(opened.state, { type: "REQUEST_DELETE_IN_EDITOR" });
    const effect = deleted.effects[0];

    expect(deleted.state.editor).toBeNull();
    expect(effect?.type).toBe("CAPTURE_SNAPSHOT_AND_COMMIT_ITEM");
    if (effect?.type === "CAPTURE_SNAPSHOT_AND_COMMIT_ITEM") {
      expect(effect.pendingItem.changeType).toBe("DELETE");
    }
  });

  test("依頼者が文言を変えずにメモだけを入力したとき、「その他」の依頼として記録される", () => {
    const result = determineChangeType({
      kind: "text",
      initialText: "カートに入れる",
      currentText: "カートに入れる",
      memo: "ボタンの背景色を赤から緑に変更してください",
      isDeleteRequested: false,
    });

    expect(result).toBe("OTHER");
  });

  test("リンク内の文字と飛び先URLの両方を書き換えたとき、1つの依頼項目で文言とリンク先の両方の変更として扱われる", () => {
    const bothChanged = determineChangeType({
      kind: "link",
      initialText: "秋の特別キャンペーン詳細はこちら",
      currentText: "冬の特別キャンペーン詳細はこちら",
      initialHref: "/campaigns/autumn",
      currentHref: "/campaigns/winter",
      memo: "",
      isDeleteRequested: false,
    });
    const urlOnlyChanged = determineChangeType({
      kind: "link",
      initialText: "秋の特別キャンペーン詳細はこちら",
      currentText: "秋の特別キャンペーン詳細はこちら",
      initialHref: "/campaigns/autumn",
      currentHref: "/campaigns/autumn-2026",
      memo: "",
      isDeleteRequested: false,
    });

    expect(bothChanged).toBe("TEXT_AND_LINK_CHANGE");
    expect(urlOnlyChanged).toBe("LINK_CHANGE");
  });

  test("画像要素に対して差し替え画像を添付したとき、「画像の差し替え」として記録される", () => {
    const withImage = determineChangeType({
      kind: "image",
      attachmentId: "att-12345",
      memo: "冬バナーに差し替え",
      isDeleteRequested: false,
    });

    expect(withImage).toBe("IMAGE_REPLACE");
  });

  test("ページ情報の入力欄でタイトルやOGP説明文を書き換えたとき、変更された項目だけが差分として記録される", () => {
    const initialMeta: PageMetaValues = {
      title: "旧タイトル",
      description: "同じ説明文",
      ogTitle: "旧OGPタイトル",
      ogDescription: "同じOGP説明文",
      ogImage: "https://shop.example.com/old.jpg",
    };
    const currentMeta: PageMetaValues = {
      title: "新タイトル",
      description: "同じ説明文",
      ogTitle: "新OGPタイトル",
      ogDescription: "同じOGP説明文",
      ogImage: "https://shop.example.com/old.jpg",
    };
    const baseState = createInitialState("https://shop.example.com/products/123", false);
    const opened = update(baseState, {
      type: "OPEN_EDITOR",
      editor: {
        targetKind: "pageMeta",
        anchor: { kind: "pageMeta" },
        expansionHistory: [],
        initialText: "",
        currentText: "",
        initialMeta,
        currentMeta,
        memo: "",
        isDeleteRequested: false,
        hasChildFormatting: false,
        popoverRect: { x: 80, y: 80, w: 320, h: 40 },
      },
    });
    const confirmed = update(opened.state, { type: "CONFIRM_EDITOR" });
    const effect = confirmed.effects[0];

    expect(effect?.type).toBe("CAPTURE_SNAPSHOT_AND_COMMIT_ITEM");
    if (effect?.type === "CAPTURE_SNAPSHOT_AND_COMMIT_ITEM") {
      expect(effect.skipSnapshot).toBe(true);
      expect(effect.pendingItem.changeType).toBe("PAGE_META");
      expect(effect.pendingItem.meta).toEqual([
        { field: "title", before: "旧タイトル", after: "新タイトル" },
        { field: "ogTitle", before: "旧OGPタイトル", after: "新OGPタイトル" },
      ]);
    }
  });
});

describe("指摘項目の管理・削除・リセット時の振る舞い", () => {
  test("途中の番号の指摘項目を削除しても、残った項目の番号は詰められず新しい項目には連番が振られる", () => {
    const s0 = createInitialState("https://shop.example.com/products/123", false);
    const item1 = {
      seq: 1,
      url: s0.currentUrl,
      anchor: { kind: "pageMeta" as const },
      changeType: "PAGE_META" as const,
      attachmentIds: [],
    };
    const item2 = {
      seq: 2,
      url: s0.currentUrl,
      anchor: { kind: "pageMeta" as const },
      changeType: "PAGE_META" as const,
      attachmentIds: [],
    };
    const s1 = update(s0, { type: "SNAPSHOT_CAPTURED_FOR_ITEM", item: item1 }).state;
    const s2 = update(s1, { type: "SNAPSHOT_CAPTURED_FOR_ITEM", item: item2 }).state;
    const s3 = update(s2, { type: "DELETE_ITEM", seq: 1 }).state;

    expect(s3.items.map((i) => i.seq)).toEqual([2]);
    expect(s3.nextSeq).toBe(3);
  });

  test("依頼者がリセットを実行したとき、すべての指摘項目が破棄され番号が1番に戻り画面復元の指示が出る", () => {
    const s0 = createInitialState("https://shop.example.com/products/123", false);
    const item1 = {
      seq: 1,
      url: s0.currentUrl,
      anchor: { kind: "pageMeta" as const },
      changeType: "PAGE_META" as const,
      attachmentIds: [],
    };
    const s1 = update(s0, { type: "SNAPSHOT_CAPTURED_FOR_ITEM", item: item1 }).state;
    const resetResult = update(s1, { type: "RESET_ALL_CONFIRMED" });

    expect(resetResult.state.items).toHaveLength(0);
    expect(resetResult.state.nextSeq).toBe(1);
    expect(resetResult.effects).toContainEqual({ type: "RESTORE_ALL_LIVE_DOM" });
    expect(resetResult.effects).toContainEqual({ type: "CLEAR_DRAFT_DB" });
  });
});
