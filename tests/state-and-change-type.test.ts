import { describe, expect, test } from "vitest";
import { determineChangeType } from "../src/core/change-type";
import { EMPTY_TEXT_MESSAGE, createInitialState, isEditorDirty, update } from "../src/core/state";
import type {
  DraftEditorState,
  DraftRecord,
  ElementLocator,
  Item,
  PageMetaValues,
} from "../src/core/types";

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
    const baseState = createInitialState("https://shop.example.com/products/123");
    const opened = update(baseState, {
      type: "OPEN_EDITOR",
      editor: createTextEditor(),
    });
    const edited = update(opened.state, {
      type: "UPDATE_EDITOR_TEXT",
      text: "3,980円以上のご購入で送料無料",
    });
    const confirmed = update(edited.state, { type: "CONFIRM_EDITOR" });
    const item = confirmed.state.items[0];

    expect(item?.changeType).toBe("TEXT_REPLACE");
    expect(item?.before).toBe("5,000円以上のご購入で送料無料");
    expect(item?.after).toBe("3,980円以上のご購入で送料無料");
  });

  test("書き直すつもりで文言を空にして確定しても、勝手に削除依頼にはならず、削除ボタンの案内が出てエディタが開いたままになる", () => {
    const baseState = createInitialState("https://shop.example.com/products/123");
    const opened = update(baseState, {
      type: "OPEN_EDITOR",
      editor: createTextEditor({ currentText: "   " }),
    });

    const confirmed = update(opened.state, { type: "CONFIRM_EDITOR" });

    expect(confirmed.state.items).toHaveLength(0);
    expect(confirmed.state.editor).not.toBeNull();
    expect(confirmed.state.statusMessage).toBe(EMPTY_TEXT_MESSAGE);
    expect(confirmed.effects).toEqual([]);
  });

  test("依頼者が「この要素を削除」ボタンを押したとき、即座にその要素の「削除」依頼として確定される", () => {
    const baseState = createInitialState("https://shop.example.com/products/123");
    const opened = update(baseState, {
      type: "OPEN_EDITOR",
      editor: createTextEditor(),
    });
    const deleted = update(opened.state, { type: "REQUEST_DELETE_IN_EDITOR" });

    expect(deleted.state.editor).toBeNull();
    expect(deleted.state.items.map((i) => i.changeType)).toEqual(["DELETE"]);
    expect(deleted.effects.map((e) => e.type)).toContain("CAPTURE_SNAPSHOT_FOR_ITEM");
  });

  test("確定した瞬間に変更が一覧とプレビューへ反映され、画面の記録はその後で項目に紐付く", () => {
    const baseState = createInitialState("https://shop.example.com/products/123");
    const opened = update(baseState, {
      type: "OPEN_EDITOR",
      editor: createTextEditor({ currentText: "3,980円以上のご購入で送料無料" }),
    });

    const confirmed = update(opened.state, { type: "CONFIRM_EDITOR" });

    expect(confirmed.state.items.map((i) => i.seq)).toEqual([1]);
    expect(confirmed.state.items[0]?.snapshotId).toBeUndefined();
    expect(confirmed.state.pendingSnapshotSeqs).toEqual([1]);
    expect(confirmed.effects.map((e) => e.type)).toEqual([
      "SYNC_LIVE_DOM",
      "SAVE_DRAFT_DEBOUNCED",
      "CAPTURE_SNAPSHOT_FOR_ITEM",
    ]);

    const captured = update(confirmed.state, {
      type: "SNAPSHOT_CAPTURED_FOR_ITEM",
      seq: 1,
      snapshot: {
        id: "snap-1",
        url: "https://shop.example.com/products/123",
        title: "t",
        viewport: { w: 1280, h: 800 },
        scroll: { x: 0, y: 0 },
        capturedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(captured.state.items[0]?.snapshotId).toBe("snap-1");
    expect(captured.state.snapshots.map((s) => s.id)).toEqual(["snap-1"]);
    expect(captured.state.pendingSnapshotSeqs).toEqual([]);
  });

  test("画面の記録中に取り消した変更は、記録が終わっても一覧に復活しない", () => {
    const baseState = createInitialState("https://shop.example.com/products/123");
    const opened = update(baseState, {
      type: "OPEN_EDITOR",
      editor: createTextEditor({ currentText: "新しい文言" }),
    });
    const confirmed = update(opened.state, { type: "CONFIRM_EDITOR" });
    const deleted = update(confirmed.state, { type: "DELETE_ITEM", seq: 1 });

    const captured = update(deleted.state, {
      type: "SNAPSHOT_CAPTURED_FOR_ITEM",
      seq: 1,
      snapshot: {
        id: "snap-1",
        url: "https://shop.example.com/products/123",
        title: "t",
        viewport: { w: 1280, h: 800 },
        scroll: { x: 0, y: 0 },
        capturedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(captured.state.items).toEqual([]);
    expect(captured.state.snapshots).toEqual([]);
    expect(captured.state.pendingSnapshotSeqs).toEqual([]);
  });

  test("エディタを開いた後に文言やメモを変えたときだけ「未確定の入力あり」と判定される", () => {
    const baseState = createInitialState("https://shop.example.com/products/123");
    const opened = update(baseState, { type: "OPEN_EDITOR", editor: createTextEditor() });
    const editorAtOpen = opened.state.editor as DraftEditorState;
    expect(isEditorDirty(editorAtOpen)).toBe(false);

    const typed = update(opened.state, { type: "UPDATE_EDITOR_MEMO", memo: "色を赤に" });
    expect(isEditorDirty(typed.state.editor as DraftEditorState)).toBe(true);
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
    const baseState = createInitialState("https://shop.example.com/products/123");
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
    const item = confirmed.state.items[0];

    expect(confirmed.effects.map((e) => e.type)).not.toContain("CAPTURE_SNAPSHOT_FOR_ITEM");
    expect(item?.changeType).toBe("PAGE_META");
    expect(item?.meta).toEqual([
      { field: "title", before: "旧タイトル", after: "新タイトル" },
      { field: "ogTitle", before: "旧OGPタイトル", after: "新OGPタイトル" },
    ]);
  });
});

const createPageMetaItem = (seq: number, url: string, overrides: Partial<Item> = {}): Item => ({
  seq,
  url,
  anchor: { kind: "pageMeta" },
  changeType: "PAGE_META",
  attachmentIds: [],
  ...overrides,
});

const createDraft = (
  items: readonly Item[],
  overrides: Partial<DraftRecord> = {},
): DraftRecord => ({
  id: "active",
  updatedAt: "2026-01-01T00:00:00.000Z",
  nextSeq: Math.max(0, ...items.map((i) => i.seq)) + 1,
  items,
  snapshots: [],
  attachments: [],
  ...overrides,
});

describe("変更項目の管理・削除・リセット時の振る舞い", () => {
  test("途中の番号の変更項目を削除しても、残った項目の番号は詰められず新しい項目には連番が振られる", () => {
    const s0 = createInitialState("https://shop.example.com/products/123");
    const s1 = update(s0, {
      type: "HYDRATE_DRAFT",
      draft: createDraft([
        createPageMetaItem(1, s0.currentUrl),
        createPageMetaItem(2, s0.currentUrl),
      ]),
      hasCompletedDraft: false,
    }).state;
    const s2 = update(s1, { type: "DELETE_ITEM", seq: 1 }).state;

    expect(s2.items.map((i) => i.seq)).toEqual([2]);
    expect(s2.nextSeq).toBe(3);
  });

  test("変更項目を削除すると、その項目だけが使っていたスナップショットと添付画像も下書きから外れる", () => {
    const s0 = createInitialState("https://shop.example.com/products/123");
    const snapshot = (id: string) => ({
      id,
      url: s0.currentUrl,
      title: "t",
      viewport: { w: 1280, h: 800 },
      scroll: { x: 0, y: 0 },
      capturedAt: "2026-01-01T00:00:00.000Z",
    });
    const s1 = update(s0, {
      type: "HYDRATE_DRAFT",
      draft: createDraft(
        [
          createPageMetaItem(1, s0.currentUrl, { snapshotId: "snap-a", attachmentIds: ["att-a"] }),
          createPageMetaItem(2, s0.currentUrl, { snapshotId: "snap-b" }),
        ],
        {
          snapshots: [snapshot("snap-a"), snapshot("snap-b")],
          attachments: [{ id: "att-a", name: "a.webp", mime: "image/webp", resourceHash: "h" }],
        },
      ),
      hasCompletedDraft: false,
    }).state;

    const s2 = update(s1, { type: "DELETE_ITEM", seq: 1 }).state;

    expect(s2.snapshots.map((s) => s.id)).toEqual(["snap-b"]);
    expect(s2.attachments).toEqual([]);
  });

  test("一覧から別ページの変更を選んでも、今のページの似た要素を編集せず、どのページの変更かを案内する", () => {
    const s0 = createInitialState("https://shop.example.com/products/123");
    const s1 = update(s0, {
      type: "HYDRATE_DRAFT",
      draft: createDraft([createPageMetaItem(1, "https://shop.example.com/about")]),
      hasCompletedDraft: false,
    }).state;

    const selected = update(s1, { type: "SELECT_QUICK_LIST_ITEM", seq: 1 });

    expect(selected.effects).toEqual([]);
    expect(selected.state.statusMessage).toContain("/about");
  });

  test("依頼者がリセットを実行したとき、すべての変更項目が破棄され番号が1番に戻り画面復元の指示が出る", () => {
    const s0 = createInitialState("https://shop.example.com/products/123");
    const s1 = update(s0, {
      type: "HYDRATE_DRAFT",
      draft: createDraft([createPageMetaItem(1, s0.currentUrl)]),
      hasCompletedDraft: false,
    }).state;
    const resetResult = update(s1, { type: "RESET_ALL_CONFIRMED" });

    expect(resetResult.state.items).toHaveLength(0);
    expect(resetResult.state.nextSeq).toBe(1);
    expect(resetResult.effects).toContainEqual({ type: "RESTORE_ALL_LIVE_DOM" });
    expect(resetResult.effects).toContainEqual({ type: "CLEAR_DRAFT_DB" });
  });
});
