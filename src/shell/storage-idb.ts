import type { DraftRecord } from "../core/types";
import type { ResourceEntry } from "./snapshot-io";

const DB_NAME = "page-change-request";
const DB_VERSION = 1;
const STORE_DRAFTS = "drafts";
const STORE_SNAPSHOT_BODIES = "snapshotBodies";
const STORE_RESOURCES = "resources";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DRAFT_EXPIRY_DAYS = 30;
const RECENT_COMPLETED_DAYS = 7;

export type HydratedStorageBundle = {
  readonly activeDraft: DraftRecord | null;
  readonly hasRecentCompletedDraft: boolean;
  readonly snapshotBodies: Readonly<Record<string, string>>;
  readonly resources: Readonly<Record<string, ResourceEntry>>;
};

const dbCache: {
  factory: IDBFactory | null;
  promise: Promise<IDBDatabase | null> | null;
} = { factory: null, promise: null };

const resetDbCache = (): void => {
  dbCache.factory = null;
  dbCache.promise = null;
};

// 保存のたびに接続を開き直すと閉じられない接続が溜まるため、1 本を使い回す
const openDatabase = (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === "undefined" || indexedDB === null) {
    return Promise.resolve(null);
  }
  if (dbCache.promise !== null && dbCache.factory === indexedDB) {
    return dbCache.promise;
  }
  dbCache.factory = indexedDB;
  dbCache.promise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
          db.createObjectStore(STORE_DRAFTS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_SNAPSHOT_BODIES)) {
          db.createObjectStore(STORE_SNAPSHOT_BODIES, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_RESOURCES)) {
          db.createObjectStore(STORE_RESOURCES, { keyPath: "hash" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          resetDbCache();
        };
        db.onclose = resetDbCache;
        resolve(db);
      };
      req.onerror = () => {
        resetDbCache();
        resolve(null);
      };
    } catch {
      resetDbCache();
      resolve(null);
    }
  });
  return dbCache.promise;
};

const idbGetAll = <T>(db: IDBDatabase, storeName: string): Promise<readonly T[]> =>
  new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as readonly T[]) ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });

const idbPut = <T>(db: IDBDatabase, storeName: string, value: T): Promise<boolean> =>
  new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });

const idbDelete = (db: IDBDatabase, storeName: string, key: string): Promise<void> =>
  new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });

const idbClearStore = (db: IDBDatabase, storeName: string): Promise<void> =>
  new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });

const isOlderThanDays = (isoDate: string, days: number, nowMs: number): boolean => {
  const time = Date.parse(isoDate);
  if (Number.isNaN(time)) {
    return true;
  }
  return nowMs - time > days * MS_PER_DAY;
};

export const loadInitialStorageBundle = async (
  nowMs = Date.now(),
): Promise<HydratedStorageBundle> => {
  const db = await openDatabase();
  if (db === null) {
    return {
      activeDraft: null,
      hasRecentCompletedDraft: false,
      snapshotBodies: {},
      resources: {},
    };
  }
  const drafts = await idbGetAll<DraftRecord>(db, STORE_DRAFTS);
  const expiredDrafts = drafts.filter((d) =>
    isOlderThanDays(d.updatedAt, DRAFT_EXPIRY_DAYS, nowMs),
  );
  await Promise.all(expiredDrafts.map((d) => idbDelete(db, STORE_DRAFTS, d.id)));

  const validDrafts = drafts.filter((d) => !isOlderThanDays(d.updatedAt, DRAFT_EXPIRY_DAYS, nowMs));
  const activeDraft = validDrafts.find((d) => d.id === "active") ?? null;
  const completedDraft = validDrafts.find((d) => d.id === "completed") ?? null;
  const hasRecentCompletedDraft =
    completedDraft !== null &&
    !isOlderThanDays(
      completedDraft.completedAt ?? completedDraft.updatedAt,
      RECENT_COMPLETED_DAYS,
      nowMs,
    );

  const rawBodies = await idbGetAll<{ readonly id: string; readonly base64: string }>(
    db,
    STORE_SNAPSHOT_BODIES,
  );
  const snapshotBodies = Object.fromEntries(rawBodies.map((b) => [b.id, b.base64]));

  const rawResources = await idbGetAll<ResourceEntry>(db, STORE_RESOURCES);
  const resources = Object.fromEntries(rawResources.map((r) => [r.hash, r]));

  return {
    activeDraft,
    hasRecentCompletedDraft,
    snapshotBodies,
    resources,
  };
};

type ReferencedAssetKeys = {
  readonly snapshotIds: ReadonlySet<string>;
  /** null のときは参照の分からない古いスナップショットがあるため、リソースを消さない */
  readonly resourceHashes: ReadonlySet<string> | null;
};

export const collectReferencedAssetKeys = (
  drafts: readonly (DraftRecord | undefined)[],
): ReferencedAssetKeys => {
  const present = drafts.flatMap((d) => (d !== undefined ? [d] : []));
  const snapshotIds = new Set(
    present.flatMap((d) =>
      d.items.flatMap((i) => (i.snapshotId !== undefined ? [i.snapshotId] : [])),
    ),
  );
  const attachmentIds = new Set(present.flatMap((d) => d.items.flatMap((i) => i.attachmentIds)));
  const snapshots = present.flatMap((d) => d.snapshots.filter((s) => snapshotIds.has(s.id)));
  if (snapshots.some((s) => s.resourceHashes === undefined)) {
    return { snapshotIds, resourceHashes: null };
  }
  const resourceHashes = new Set([
    ...snapshots.flatMap((s) => s.resourceHashes ?? []),
    ...present.flatMap((d) =>
      d.attachments.filter((a) => attachmentIds.has(a.id)).map((a) => a.resourceHash),
    ),
  ]);
  return { snapshotIds, resourceHashes };
};

// 既にあるキーは書き直さず（中身はハッシュで決まるので不変）、参照されなくなったキーは消す
const syncStoreEntries = (
  store: IDBObjectStore,
  wanted: ReadonlyMap<string, unknown>,
  keep: ReadonlySet<string> | null,
): void => {
  const keysReq = store.getAllKeys();
  keysReq.onsuccess = () => {
    const existing = new Set((keysReq.result as readonly IDBValidKey[]).map(String));
    Array.from(wanted.entries())
      .filter(([key]) => !existing.has(key) && (keep === null || keep.has(key)))
      .map(([, value]) => store.put(value));
    if (keep !== null) {
      Array.from(existing)
        .filter((key) => !keep.has(key))
        .map((key) => store.delete(key));
    }
  };
};

export const saveDraftAndAssetsToDb = async (
  draft: DraftRecord,
  snapshotBodies: Readonly<Record<string, string>>,
  resources: Readonly<Record<string, ResourceEntry>>,
): Promise<boolean> => {
  const db = await openDatabase();
  if (db === null) {
    return false;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(
        [STORE_DRAFTS, STORE_SNAPSHOT_BODIES, STORE_RESOURCES],
        "readwrite",
      );
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
      const draftStore = tx.objectStore(STORE_DRAFTS);
      draftStore.put(draft);
      // 「前回の続き」用の完了済み下書きが参照しているデータは消さない
      const completedReq = draftStore.get("completed");
      completedReq.onsuccess = () => {
        const completed = completedReq.result as DraftRecord | undefined;
        const keys = collectReferencedAssetKeys([draft, completed]);
        syncStoreEntries(
          tx.objectStore(STORE_SNAPSHOT_BODIES),
          new Map(Object.entries(snapshotBodies).map(([id, base64]) => [id, { id, base64 }])),
          keys.snapshotIds,
        );
        syncStoreEntries(
          tx.objectStore(STORE_RESOURCES),
          new Map(Object.entries(resources)),
          keys.resourceHashes,
        );
      };
    } catch {
      resolve(false);
    }
  });
};

export const markDraftAsCompletedInDb = async (draft: DraftRecord): Promise<void> => {
  const db = await openDatabase();
  if (db === null) {
    return;
  }
  const nowIso = new Date().toISOString();
  const completedRecord: DraftRecord = {
    ...draft,
    id: "completed",
    updatedAt: nowIso,
    completedAt: nowIso,
  };
  await idbPut(db, STORE_DRAFTS, completedRecord);
  await idbDelete(db, STORE_DRAFTS, "active");
};

export const promoteCompletedDraftToActiveInDb = async (): Promise<DraftRecord | null> => {
  const db = await openDatabase();
  if (db === null) {
    return null;
  }
  const drafts = await idbGetAll<DraftRecord>(db, STORE_DRAFTS);
  const completed = drafts.find((d) => d.id === "completed");
  if (completed === undefined) {
    return null;
  }
  const { completedAt: _removed, ...rest } = completed;
  const active: DraftRecord = {
    ...rest,
    id: "active",
    updatedAt: new Date().toISOString(),
  };
  await idbPut(db, STORE_DRAFTS, active);
  return active;
};

export const clearAllDraftDataInDb = async (): Promise<void> => {
  const db = await openDatabase();
  if (db === null) {
    return;
  }
  await Promise.all([
    idbClearStore(db, STORE_DRAFTS),
    idbClearStore(db, STORE_SNAPSHOT_BODIES),
    idbClearStore(db, STORE_RESOURCES),
  ]);
};

export const detectIncognitoMode = async (): Promise<boolean> => {
  if (
    typeof navigator === "undefined" ||
    !("storage" in navigator) ||
    !navigator.storage?.estimate
  ) {
    return false;
  }
  try {
    const { quota } = await navigator.storage.estimate();
    // Chrome incognito typically caps quota below ~250MB
    return quota !== undefined && quota < 250 * 1024 * 1024;
  } catch {
    return false;
  }
};
