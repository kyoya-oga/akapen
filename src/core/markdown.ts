import type { ChangeRequestDoc, ChangeType, Item, PageMetaField, SnapshotMeta } from "./types";

const MAX_TEXT_LENGTH = 200;

export const escapeMarkdown = (text: string): string =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/([*_#`~[\]()<>|!])/g, "\\$1")
    .replace(/\r?\n/g, " ");

export const truncateForTicket = (text: string): string => {
  const escaped = escapeMarkdown(text);
  if (text.length > MAX_TEXT_LENGTH) {
    const sliced = escapeMarkdown(text.slice(0, MAX_TEXT_LENGTH));
    return `${sliced}…（全文は HTML 参照）`;
  }
  return escaped;
};

export const formatChangeTypeLabel = (changeType: ChangeType): string => {
  switch (changeType) {
    case "TEXT_REPLACE":
      return "文言の差し替え";
    case "LINK_CHANGE":
      return "リンク先の変更";
    case "TEXT_AND_LINK_CHANGE":
      return "文言とリンク先の変更";
    case "IMAGE_REPLACE":
      return "画像の差し替え";
    case "DELETE":
      return "削除";
    case "PAGE_META":
      return "ページ情報の変更";
    case "OTHER":
      return "その他";
    default: {
      const _exhaustive: never = changeType;
      return _exhaustive;
    }
  }
};

export const formatPageMetaFieldLabel = (field: PageMetaField): string => {
  switch (field) {
    case "title":
      return "タイトル";
    case "description":
      return "説明文";
    case "ogTitle":
      return "OGPタイトル";
    case "ogDescription":
      return "OGP説明文";
    case "ogImage":
      return "OGP画像";
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
};

const extractPathname = (urlStr: string): string => {
  try {
    const parsed = new URL(urlStr, "https://example.com");
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch {
    return urlStr;
  }
};

const formatTicketItemHeader = (
  item: Item,
  index: number,
  snapshotsById: Readonly<Record<string, SnapshotMeta>>,
): string => {
  const label = formatChangeTypeLabel(item.changeType);
  const path = extractPathname(item.url);
  const snap = item.snapshotId !== undefined ? snapshotsById[item.snapshotId] : undefined;
  const widthPart = snap !== undefined ? `、幅 ${snap.viewport.w}px` : "";
  return `${index + 1}. **${label}**（${path}${widthPart}）`;
};

const formatTicketTextLines = (item: Item): readonly string[] => [
  ...(item.before !== undefined ? [`    - 変更前：${truncateForTicket(item.before)}`] : []),
  ...(item.after !== undefined ? [`    - 変更後：${truncateForTicket(item.after)}`] : []),
];

const formatTicketLinkLines = (item: Item): readonly string[] => [
  ...(item.hrefBefore !== undefined
    ? [`    - リンク変更前：${truncateForTicket(item.hrefBefore)}`]
    : []),
  ...(item.hrefAfter !== undefined
    ? [`    - リンク変更後：${truncateForTicket(item.hrefAfter)}`]
    : []),
];

const formatTicketMetaLines = (item: Item): readonly string[] =>
  (item.meta ?? []).map(
    (m) =>
      `    - ${formatPageMetaFieldLabel(m.field)}：「${truncateForTicket(m.before)}」→「${truncateForTicket(m.after)}」`,
  );

const formatTicketMemoLines = (item: Item): readonly string[] => {
  const hasMemo = item.memo !== undefined && item.memo.trim().length > 0;
  if (hasMemo && item.memo !== undefined) {
    const suffix = item.changeType === "IMAGE_REPLACE" ? "（新しい画像は HTML 内）" : "";
    return [`    - メモ：${truncateForTicket(item.memo)}${suffix}`];
  }
  if (item.changeType === "IMAGE_REPLACE") {
    return ["    - 差し替え画像：HTML レポート内を参照"];
  }
  return [];
};

const formatTicketItemDetails = (item: Item): readonly string[] => [
  ...formatTicketTextLines(item),
  ...formatTicketLinkLines(item),
  ...formatTicketMetaLines(item),
  ...formatTicketMemoLines(item),
];

export const generateTicketMarkdown = (doc: ChangeRequestDoc): string => {
  const snapshotsById: Record<string, SnapshotMeta> = Object.fromEntries(
    doc.snapshots.map((s) => [s.id, s]),
  );
  const itemBlocks = doc.items.map((item, idx) => {
    const header = formatTicketItemHeader(item, idx, snapshotsById);
    const details = formatTicketItemDetails(item);
    return [header, ...details].join("\n");
  });

  return [
    `### 変更箇所（${doc.items.length}件）`,
    "",
    "詳細は添付の HTML レポートを開いてください。",
    "",
    ...itemBlocks,
  ].join("\n");
};

const formatAiAnchorLines = (item: Item): readonly string[] => {
  if (item.anchor.kind === "element") {
    const { locator } = item.anchor;
    const hasContext = locator.textQuote.prefix.length > 0 || locator.textQuote.suffix.length > 0;
    return [
      ...(hasContext
        ? [
            `- 前後の文脈：「…${escapeMarkdown(locator.textQuote.prefix)}」｜「${escapeMarkdown(locator.textQuote.suffix)}…」`,
          ]
        : []),
      `- 要素：${locator.tagName}（セレクタの参考：${locator.selector}）`,
    ];
  }
  if (item.anchor.kind === "region") {
    const { pageRect } = item.anchor;
    return [
      `- 範囲の基準要素：${item.anchor.container.tagName}（セレクタの参考：${item.anchor.container.selector}、範囲：x=${pageRect.x}, y=${pageRect.y}, w=${pageRect.w}, h=${pageRect.h}）`,
    ];
  }
  return [];
};

const formatAiItemSection = (
  item: Item,
  index: number,
  snapshotsById: Readonly<Record<string, SnapshotMeta>>,
): string => {
  const label = formatChangeTypeLabel(item.changeType);
  const path = extractPathname(item.url);
  const snap = item.snapshotId !== undefined ? snapshotsById[item.snapshotId] : undefined;
  const widthPart = snap !== undefined ? `（表示幅 ${snap.viewport.w}px）` : "";

  const lines: readonly string[] = [
    `## ${index + 1}. ${label}`,
    `- ページ：${path}${widthPart}`,
    ...(item.before !== undefined ? [`- 変更前：${escapeMarkdown(item.before)}`] : []),
    ...(item.after !== undefined ? [`- 変更後：${escapeMarkdown(item.after)}`] : []),
    ...(item.hrefBefore !== undefined
      ? [`- リンク変更前：${escapeMarkdown(item.hrefBefore)}`]
      : []),
    ...(item.hrefAfter !== undefined ? [`- リンク変更後：${escapeMarkdown(item.hrefAfter)}`] : []),
    ...(item.meta !== undefined
      ? item.meta.map(
          (m) =>
            `- ${formatPageMetaFieldLabel(m.field)}：「${escapeMarkdown(m.before)}」→「${escapeMarkdown(m.after)}」`,
        )
      : []),
    ...(item.changeType === "IMAGE_REPLACE" ? ["- 画像：差し替え画像あり（レポート参照）"] : []),
    ...(item.memo !== undefined && item.memo.trim().length > 0
      ? [`- メモ：${escapeMarkdown(item.memo)}`]
      : []),
    ...formatAiAnchorLines(item),
  ];
  return lines.join("\n");
};

export const generateAiInstructionMarkdown = (doc: ChangeRequestDoc): string => {
  const snapshotsById: Record<string, SnapshotMeta> = Object.fromEntries(
    doc.snapshots.map((s) => [s.id, s]),
  );
  const sections = doc.items.map((item, idx) => formatAiItemSection(item, idx, snapshotsById));

  return [
    "以下の変更を行ってください。各項目の「変更前」の文字列でリポジトリを検索し、「前後の文脈」で箇所を絞り込んでください。",
    "同じ文言が別の表示幅用の要素や他のページにもある場合は、それも報告してください。",
    "共通コンポーネントや CMS・DB 管理の文言だった場合は、変更せずにその旨を報告してください。",
    "",
    sections.join("\n\n"),
  ].join("\n");
};
