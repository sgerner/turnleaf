import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type capTask,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import { toKavitaPageNumber } from '../sync/conflict';
import type { KavitaProgress } from '../kavita/types';
import { migrations } from './schema';

export interface ServerConfig {
  id: string;
  displayName: string;
  baseUrl: string;
  credentialRef: string;
  kavitaVersion: string | null;
  lastConnectedAt: string;
}

export interface BookRecord {
  id: string;
  serverId: string;
  libraryId: number;
  seriesId: number;
  volumeId: number;
  chapterId: number;
  title: string;
  author: string | null;
  series: string | null;
  descriptionHtml: string | null;
  format: string;
  pages: number;
  pagesRead: number;
  createdAt: string;
  lastReadAt: string | null;
  downloadPath: string | null;
  downloadStatus: string;
  fileSize: number | null;
  remoteFileSize?: number | null;
  downloadedBytes?: number | null;
  downloadedPages?: number | null;
  downloadOutdated?: boolean;
  hasLocalData?: boolean;
  chapterKey?: string | null;
  /** False means Kavita no longer advertises the book; local retention may keep it. */
  remoteAvailable?: boolean;
  /** False means Kavita omitted usable progress fields from this metadata snapshot. */
  remoteProgressKnown?: boolean;
  /** False means Kavita omitted a usable last-read date from this metadata snapshot. */
  remoteReadDateKnown?: boolean;
}

export const READER_PREFERENCE_PREFIXES = [
  'readerBookmarks:',
  'readerAnnotations:',
  'readerHistory:',
] as const;

export type ReaderPreferencePrefix = (typeof READER_PREFERENCE_PREFIXES)[number];

function hasNonEmptyPreferenceValue(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim() !== '' && value.trim() !== '[]';
}

export function mergeReaderPreferenceValue(
  prefix: ReaderPreferencePrefix,
  oldRaw: string | undefined,
  newRaw: string | undefined,
): string | undefined {
  if (oldRaw === undefined) return newRaw;
  if (newRaw === undefined) return oldRaw;
  if (!hasNonEmptyPreferenceValue(oldRaw)) return newRaw;
  if (!hasNonEmptyPreferenceValue(newRaw)) return oldRaw;
  try {
    const oldParsed: unknown = JSON.parse(oldRaw);
    const newParsed: unknown = JSON.parse(newRaw);
    if (!Array.isArray(oldParsed) || !Array.isArray(newParsed)) return newRaw;
    if (prefix === 'readerAnnotations:') {
      const merged = new Map<string, Record<string, unknown>>();
      const keyOf = (entry: unknown, index: number): string => {
        if (!entry || typeof entry !== 'object') return `idx:${index}`;
        const record = entry as Record<string, unknown>;
        if (typeof record.cfi === 'string' && record.cfi.trim()) return `cfi:${record.cfi.trim()}`;
        if (typeof record.id === 'string' && record.id) return `id:${record.id}`;
        return `json:${JSON.stringify(record)}`;
      };
      oldParsed.forEach((entry, index) => {
        if (entry && typeof entry === 'object') {
          merged.set(keyOf(entry, index), entry as Record<string, unknown>);
        }
      });
      newParsed.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        const next = entry as Record<string, unknown>;
        const key = keyOf(entry, oldParsed.length + index);
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, next);
          return;
        }
        const existingDate = typeof existing.createdAt === 'string' ? existing.createdAt : '';
        const nextDate = typeof next.createdAt === 'string' ? next.createdAt : '';
        const nextNote = typeof next.note === 'string' ? next.note.trim() : '';
        if (nextDate >= existingDate || nextNote) {
          merged.set(key, nextNote ? next : { ...next, note: existing.note ?? next.note });
        }
      });
      return JSON.stringify([...merged.values()].slice(-200));
    }
    const limit = prefix === 'readerHistory:' ? 12 : 100;
    const merged = new Map<string, Record<string, unknown>>();
    const keyOf = (entry: unknown, index: number): string => {
      if (!entry || typeof entry !== 'object') return `idx:${index}`;
      const record = entry as Record<string, unknown>;
      if (typeof record.id === 'string' && record.id) return record.id;
      return `${String(record.cfi ?? '')}|${String(record.href ?? '')}`;
    };
    for (const [index, entry] of [...newParsed, ...oldParsed].entries()) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const key = keyOf(entry, index);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, record);
        continue;
      }
      const existingSaved = typeof existing.savedAt === 'string' ? existing.savedAt : '';
      const nextSaved = typeof record.savedAt === 'string' ? record.savedAt : '';
      if (nextSaved > existingSaved) merged.set(key, record);
    }
    return JSON.stringify([...merged.values()].slice(0, limit));
  } catch {
    return newRaw;
  }
}

export function isBookDownloadOutdated(book: {
  downloadPath: string | null;
  downloadStatus: string;
  pages: number;
  remoteFileSize?: number | null;
  downloadedBytes?: number | null;
  downloadedPages?: number | null;
}): boolean {
  const hasDownload = Boolean(book.downloadPath) || book.downloadStatus === 'available';
  if (!hasDownload) return false;
  const sizeMismatch =
    book.downloadedBytes != null &&
    book.downloadedBytes > 0 &&
    book.remoteFileSize != null &&
    book.remoteFileSize > 0 &&
    book.downloadedBytes !== book.remoteFileSize;
  const pagesMismatch =
    book.downloadedPages != null &&
    book.downloadedPages > 0 &&
    book.pages > 0 &&
    book.downloadedPages !== book.pages;
  return sizeMismatch || pagesMismatch;
}

interface LineageCandidate {
  id: string;
  seriesId: number;
  chapterId: number;
  title: string;
  author: string | null;
  series: string | null;
  chapterKey?: string | null;
}

function normalizeLineageText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function semanticLineageTitle(book: Pick<LineageCandidate, 'title' | 'chapterId'>): string {
  const trimmed = book.title.trim();
  if (!trimmed || trimmed === `Book ${book.chapterId}`) return '';
  return normalizeLineageText(trimmed);
}

const LINEAGE_KEY_TIERS: ReadonlyArray<(book: LineageCandidate) => string | null> = [
  (book) => {
    const marker = book.chapterKey?.trim().toLowerCase();
    return marker?.startsWith('isbn:') ? `isbn|${marker}` : null;
  },
  (book) => {
    const marker = book.chapterKey?.trim().toLowerCase();
    return marker ? `series-marker|${book.seriesId}|${marker}` : null;
  },
  (book) => {
    const title = semanticLineageTitle(book);
    return title
      ? `series-title|${book.seriesId}|${title}|${normalizeLineageText(book.author)}`
      : null;
  },
  (book) => {
    const title = semanticLineageTitle(book);
    const series = normalizeLineageText(book.series);
    if (!title || !series) return null;
    const marker = book.chapterKey?.trim().toLowerCase() ?? '';
    return `named-series|${series}|${title}|${normalizeLineageText(book.author)}|${marker}`;
  },
  (book) => {
    const title = semanticLineageTitle(book);
    return title ? `work-title|${title}|${normalizeLineageText(book.author)}` : null;
  },
];

function matchBookLineage(
  existing: readonly LineageCandidate[],
  incoming: readonly LineageCandidate[],
): Map<string, string> {
  const existingIds = new Set(existing.map((book) => book.id));
  const incomingIds = new Set(incoming.map((book) => book.id));
  const matchedOld = new Set<string>();
  const matchedNew = new Set<string>();
  for (const id of existingIds) {
    if (incomingIds.has(id)) {
      matchedOld.add(id);
      matchedNew.add(id);
    }
  }
  const remapped = new Map<string, string>();
  if (matchedOld.size === existing.length || matchedNew.size === incoming.length) {
    return remapped;
  }

  for (const tierKey of LINEAGE_KEY_TIERS) {
    const oldByKey = new Map<string, LineageCandidate[]>();
    for (const book of existing) {
      const key = tierKey(book);
      if (!key) continue;
      const list = oldByKey.get(key);
      if (list) list.push(book);
      else oldByKey.set(key, [book]);
    }
    const newByKey = new Map<string, LineageCandidate[]>();
    for (const book of incoming) {
      const key = tierKey(book);
      if (!key) continue;
      const list = newByKey.get(key);
      if (list) list.push(book);
      else newByKey.set(key, [book]);
    }
    for (const [key, oldGroup] of oldByKey) {
      if (oldGroup.length !== 1) continue;
      const newGroup = newByKey.get(key);
      if (!newGroup || newGroup.length !== 1) continue;
      const oldBook = oldGroup[0]!;
      const newBook = newGroup[0]!;
      if (matchedOld.has(oldBook.id) || matchedNew.has(newBook.id)) continue;
      matchedOld.add(oldBook.id);
      matchedNew.add(newBook.id);
      remapped.set(oldBook.id, newBook.id);
    }
  }
  return remapped;
}

function hasBrowserReaderPreferences(
  preferences: Readonly<Record<string, string>>,
  bookId: string,
): boolean {
  return READER_PREFERENCE_PREFIXES.some((prefix) =>
    hasNonEmptyPreferenceValue(preferences[`${prefix}${bookId}`]),
  );
}

function hasBrowserLocalData(state: BrowserDatabaseState, book: BookRecord): boolean {
  return (
    Boolean(book.downloadPath) ||
    book.downloadStatus === 'available' ||
    Boolean(state.syncQueue[book.id]) ||
    Boolean(state.readingState[book.id]) ||
    hasBrowserReaderPreferences(state.preferences, book.id)
  );
}

function withoutRemoteProgressMarkers(book: BookRecord): BookRecord {
  const record = { ...book };
  delete record.remoteProgressKnown;
  delete record.remoteReadDateKnown;
  return record;
}

let connection: SQLiteDBConnection | null = null;
let opening: Promise<SQLiteDBConnection> | null = null;
let nativeTransactionQueue: Promise<void> = Promise.resolve();

interface BrowserDatabaseState {
  serverConfig: ServerConfig | null;
  books: BookRecord[];
  readingState: Record<string, StoredReadingState>;
  syncQueue: Record<string, BrowserSyncQueueRow>;
  preferences: Record<string, string>;
}

interface BrowserSyncQueueRow {
  bookId: string;
  serverId: string;
  payloadJson: string;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

const BROWSER_STORAGE_KEY = 'turnleaf_browser_database_v1';

function enqueueNativeWrite<T>(operation: () => Promise<T>): Promise<T> {
  const next = nativeTransactionQueue.then(operation);
  nativeTransactionQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function executeNativeTransaction(
  db: Pick<SQLiteDBConnection, 'executeTransaction'>,
  tasks: capTask[],
): Promise<void> {
  await enqueueNativeWrite(() => db.executeTransaction(tasks).then(() => undefined));
}

async function executeNativeRun(
  db: Pick<SQLiteDBConnection, 'run'>,
  statement: string,
  values: unknown[] = [],
): Promise<void> {
  await enqueueNativeWrite(() => db.run(statement, values).then(() => undefined));
}

async function executeNativeStatement(
  db: Pick<SQLiteDBConnection, 'execute'>,
  statement: string,
): Promise<void> {
  await enqueueNativeWrite(() => db.execute(statement).then(() => undefined));
}

function createBrowserState(): BrowserDatabaseState {
  return {
    serverConfig: null,
    books: [],
    readingState: {},
    syncQueue: {},
    preferences: {},
  };
}

function readBrowserState(): BrowserDatabaseState {
  if (typeof window === 'undefined') return createBrowserState();
  const raw = window.localStorage.getItem(BROWSER_STORAGE_KEY);
  if (!raw) return createBrowserState();
  try {
    const parsed = JSON.parse(raw) as Partial<BrowserDatabaseState>;
    const books = Array.isArray(parsed.books)
      ? (parsed.books as BookRecord[]).map((book) => ({
          ...book,
          remoteAvailable: book.remoteAvailable !== false,
        }))
      : [];
    const booksById = new Map(books.map((book) => [book.id, book]));
    return {
      serverConfig: parsed.serverConfig ?? null,
      books,
      readingState: parsed.readingState ?? {},
      syncQueue: Object.fromEntries(
        Object.entries(parsed.syncQueue ?? {}).map(([bookId, row]) => [
          bookId,
          {
            ...row,
            serverId: row.serverId ?? booksById.get(bookId)?.serverId ?? '',
            revision: Number(row.revision ?? 0),
          },
        ]),
      ),
      preferences: parsed.preferences ?? {},
    };
  } catch {
    return createBrowserState();
  }
}

function writeBrowserState(state: BrowserDatabaseState): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(state));
}

/**
 * Browser preview commits the complete local snapshot in one storage write.
 * Keeping the read/modify/write boundary here mirrors a native transaction:
 * if setItem fails, the previous serialized snapshot remains available for a
 * retry instead of leaving progress and its queue row out of sync.
 */
function updateBrowserState(mutate: (state: BrowserDatabaseState) => boolean | void): boolean {
  const state = readBrowserState();
  if (mutate(state) === false) return false;
  writeBrowserState(state);
  return true;
}

export async function openDatabase(): Promise<SQLiteDBConnection> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('Browser preview uses localStorage-backed storage.');
  }
  if (connection) return connection;

  if (opening) return opening;
  opening = openNativeDatabase();
  try {
    connection = await opening;
    return connection;
  } finally {
    opening = null;
  }
}

async function openNativeDatabase(): Promise<SQLiteDBConnection> {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const consistency = await sqlite.checkConnectionsConsistency();
  const existing = (await sqlite.isConnection('turnleaf', false)).result;
  const db =
    consistency.result && existing
      ? await sqlite.retrieveConnection('turnleaf', false)
      : await sqlite.createConnection('turnleaf', false, 'no-encryption', 1, false);
  await db.open();
  await executeNativeStatement(db, 'PRAGMA foreign_keys = ON;');
  await migrate(db);
  return db;
}

export async function resetLocalDatabase(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    writeBrowserState(createBrowserState());
    return;
  }

  try {
    if (connection) {
      try {
        await connection.close();
      } catch {
        // Best effort only; a broken connection can still be removed.
      }
    }
    connection = null;
    opening = null;
    await CapacitorSQLite.deleteDatabase({ database: 'turnleaf', readonly: false });
  } catch (error) {
    throw new Error(`Could not reset local storage: ${String(error)}`, { cause: error });
  }
}

async function migrate(db: SQLiteDBConnection): Promise<void> {
  const current = await db.getVersion();
  for (const migration of migrations) {
    if (migration.version <= (current.version ?? 0)) continue;
    await executeNativeTransaction(db, [
      { statement: migration.statements },
      { statement: `PRAGMA user_version = ${migration.version};` },
    ]);
  }
}

export async function saveServer(config: ServerConfig): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    state.serverConfig = config;
    writeBrowserState(state);
    return;
  }
  const db = await openDatabase();
  await executeNativeRun(
    db,
    `INSERT OR REPLACE INTO server_config
      (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    [
      config.id,
      config.displayName,
      config.baseUrl,
      config.credentialRef,
      config.kavitaVersion,
      config.lastConnectedAt,
    ],
  );
}

export async function removeServer(serverId: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    if (state.serverConfig?.id === serverId) {
      for (const book of state.books) {
        for (const prefix of READER_PREFERENCE_PREFIXES) {
          delete state.preferences[`${prefix}${book.id}`];
        }
      }
      state.serverConfig = null;
      state.books = [];
      state.readingState = {};
      state.syncQueue = {};
      writeBrowserState(state);
    }
    return;
  }
  const db = await openDatabase();
  await executeNativeTransaction(db, [
    {
      statement: `DELETE FROM preferences WHERE key IN (
        SELECT 'readerBookmarks:' || id FROM books WHERE server_id=?
        UNION ALL
        SELECT 'readerAnnotations:' || id FROM books WHERE server_id=?
        UNION ALL
        SELECT 'readerHistory:' || id FROM books WHERE server_id=?
      )`,
      values: [serverId, serverId, serverId],
    },
    {
      statement: 'DELETE FROM server_config WHERE id=?',
      values: [serverId],
    },
  ]);
}

export async function getServer(): Promise<ServerConfig | null> {
  if (!Capacitor.isNativePlatform()) {
    return readBrowserState().serverConfig;
  }
  const db = await openDatabase();
  const result = await db.query(
    `SELECT id, display_name, base_url, credential_ref, kavita_version, last_connected_at
     FROM server_config ORDER BY last_connected_at DESC LIMIT 1`,
  );
  const row = result.values?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    baseUrl: String(row.base_url),
    credentialRef: String(row.credential_ref),
    kavitaVersion: row.kavita_version ? String(row.kavita_version) : null,
    lastConnectedAt: String(row.last_connected_at),
  };
}

/**
 * Reconcile a successful Kavita metadata snapshot. Complete snapshots remove
 * books that are gone remotely unless local state retains them; partial
 * snapshots set `preserveMissing` to leave unmatched rows untouched.
 */
export async function reconcileBooks(
  serverId: string,
  books: BookRecord[],
  options: { preserveMissing?: boolean; snapshotStartedAt?: string } = {},
): Promise<Map<string, string>> {
  const preserveMissing = options.preserveMissing === true;
  const snapshotStartedAt = options.snapshotStartedAt ?? null;
  if (!Capacitor.isNativePlatform()) {
    let remapped = new Map<string, string>();
    updateBrowserState((state) => {
      const unknownProgress = new Set(
        books.filter((book) => book.remoteProgressKnown === false).map((book) => book.id),
      );
      const unknownReadDate = new Set(
        books.filter((book) => book.remoteReadDateKnown === false).map((book) => book.id),
      );
      const incoming = new Map(
        books.map((book) => [book.id, { ...withoutRemoteProgressMarkers(book), serverId }]),
      );
      const existing = state.books.filter((book) => book.serverId === serverId);
      const existingById = new Map(existing.map((book) => [book.id, book]));
      remapped = preserveMissing
        ? new Map<string, string>()
        : matchBookLineage(existing, [...incoming.values()]);
      const remappedFromNewId = new Map<string, string>();
      for (const [oldId, newId] of remapped) remappedFromNewId.set(newId, oldId);

      for (const [oldId, newId] of remapped) {
        const newBook = incoming.get(newId);
        const oldBook = existingById.get(oldId);
        if (!newBook || !oldBook) continue;
        if (state.readingState[oldId]) {
          state.readingState[newId] = state.readingState[oldId];
          delete state.readingState[oldId];
        }
        const oldQueue = state.syncQueue[oldId];
        if (oldQueue) {
          const oldCompleted = oldBook.pages > 0 && oldBook.pagesRead >= oldBook.pages;
          const nextPagesRead =
            oldCompleted && newBook.pages > oldBook.pages ? newBook.pages : oldBook.pagesRead;
          state.syncQueue[newId] = {
            ...oldQueue,
            bookId: newId,
            serverId,
            payloadJson: updatePendingProgressRouting(oldQueue.payloadJson, {
              libraryId: newBook.libraryId,
              seriesId: newBook.seriesId,
              volumeId: newBook.volumeId,
              chapterId: newBook.chapterId,
              pages: newBook.pages,
              pagesRead: nextPagesRead,
            }),
            attemptCount: 0,
            lastAttemptAt: null,
            lastError: null,
          };
          delete state.syncQueue[oldId];
        }
        for (const prefix of READER_PREFERENCE_PREFIXES) {
          const oldKey = `${prefix}${oldId}`;
          const newKey = `${prefix}${newId}`;
          const mergedPref = mergeReaderPreferenceValue(
            prefix,
            state.preferences[oldKey],
            state.preferences[newKey],
          );
          if (mergedPref !== undefined) state.preferences[newKey] = mergedPref;
          delete state.preferences[oldKey];
        }
      }

      const unmatched = existing.filter((book) => !incoming.has(book.id) && !remapped.has(book.id));
      const retained = preserveMissing
        ? unmatched
        : unmatched
            .filter((book) => hasBrowserLocalData(state, book))
            .map((book) => ({ ...withoutRemoteProgressMarkers(book), remoteAvailable: false }));
      if (!preserveMissing) {
        const retainedIds = new Set(retained.map((book) => book.id));
        for (const book of unmatched) {
          if (retainedIds.has(book.id)) continue;
          for (const prefix of READER_PREFERENCE_PREFIXES) {
            delete state.preferences[`${prefix}${book.id}`];
          }
        }
      }

      const began = snapshotStartedAt ? Date.parse(snapshotStartedAt) : Infinity;
      const merged = [...incoming.values()].map((book) => {
        const sourceOldId = remappedFromNewId.get(book.id);
        const previous = existingById.get(sourceOldId ?? book.id);
        const incomingRemoteSize = book.remoteFileSize ?? book.fileSize;
        if (!previous) {
          const hasDownload = Boolean(book.downloadPath) || book.downloadStatus === 'available';
          return {
            ...book,
            remoteAvailable: true,
            remoteFileSize: incomingRemoteSize,
            ...(hasDownload
              ? {
                  downloadedBytes: book.downloadedBytes ?? book.fileSize,
                  downloadedPages: book.downloadedPages ?? (book.pages > 0 ? book.pages : null),
                }
              : {}),
          };
        }
        const reading = state.readingState[book.id];
        const pending = Boolean(state.syncQueue[book.id]) || reading?.pendingSync === true;
        const changedDuringRefresh =
          reading &&
          (Date.parse(reading.localUpdatedAt) >= began ||
            Date.parse(reading.serverUpdatedAt ?? '') >= began);
        const remappedWithLocalProgress =
          Boolean(sourceOldId) &&
          book.pagesRead === 0 &&
          !book.lastReadAt &&
          (previous.pagesRead > 0 || Boolean(reading));
        const preserveProgress =
          pending ||
          changedDuringRefresh ||
          unknownProgress.has(book.id) ||
          remappedWithLocalProgress;
        const preserveReadDate = preserveProgress || unknownReadDate.has(book.id);
        const previousHasDownload =
          Boolean(previous.downloadPath) || previous.downloadStatus === 'available';
        const downloadedBytes = previousHasDownload
          ? (previous.downloadedBytes ?? previous.fileSize)
          : null;
        const downloadedPages = previousHasDownload
          ? (previous.downloadedPages ?? (previous.pages > 0 ? previous.pages : null))
          : null;
        const remoteFileSize = incomingRemoteSize ?? previous.remoteFileSize ?? null;
        const preservedPagesRead =
          previous.pages > 0 && previous.pagesRead >= previous.pages && book.pages > previous.pages
            ? book.pages
            : previous.pagesRead;
        return {
          ...withoutRemoteProgressMarkers(previous),
          ...book,
          serverId,
          remoteAvailable: true,
          downloadPath: previous.downloadPath,
          downloadStatus: previous.downloadStatus,
          fileSize: previousHasDownload ? (downloadedBytes ?? previous.fileSize) : remoteFileSize,
          remoteFileSize,
          downloadedBytes,
          downloadedPages,
          chapterKey: book.chapterKey ?? previous.chapterKey ?? null,
          pagesRead: preserveProgress ? preservedPagesRead : book.pagesRead,
          lastReadAt: preserveReadDate ? previous.lastReadAt : book.lastReadAt,
        };
      });
      state.books = [
        ...state.books.filter((book) => book.serverId !== serverId),
        ...merged,
        ...retained,
      ];
    });
    return remapped;
  }
  return reconcileBooksInTransaction(
    await openDatabase(),
    serverId,
    books,
    undefined,
    preserveMissing,
    snapshotStartedAt,
  );
}

// An upload can finish while the catalog is in flight and clear pending_sync.
const preserveReadingProgress = `EXISTS (
  SELECT 1 FROM reading_state WHERE book_id=excluded.id AND (
    pending_sync=1 OR julianday(local_updated_at)>=julianday(?) OR
    julianday(server_updated_at)>=julianday(?)
  )
) OR EXISTS (SELECT 1 FROM sync_queue WHERE book_id=excluded.id)`;

const replaceBookStatement = `INSERT INTO books
  (id, server_id, library_id, series_id, volume_id, chapter_id, title, author, series,
   description_html, format, metadata_refreshed_at, download_path, download_status, file_size,
   pages, pages_read, created_at, last_read_at, remote_available,
   remote_file_size, downloaded_bytes, downloaded_pages, chapter_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
   library_id=excluded.library_id, series_id=excluded.series_id,
   volume_id=excluded.volume_id, chapter_id=excluded.chapter_id,
   title=excluded.title, author=excluded.author, series=excluded.series,
   description_html=excluded.description_html, format=excluded.format,
   metadata_refreshed_at=excluded.metadata_refreshed_at,
   file_size=CASE
     WHEN books.download_path IS NOT NULL OR books.download_status='available'
       THEN COALESCE(books.downloaded_bytes, books.file_size)
     ELSE COALESCE(excluded.remote_file_size, books.file_size)
   END,
   remote_file_size=COALESCE(excluded.remote_file_size, books.remote_file_size),
   downloaded_bytes=COALESCE(
     books.downloaded_bytes,
     CASE WHEN books.download_path IS NOT NULL OR books.download_status='available' THEN books.file_size ELSE NULL END
   ),
   downloaded_pages=COALESCE(
     books.downloaded_pages,
     CASE WHEN (books.download_path IS NOT NULL OR books.download_status='available') AND books.pages>0 THEN books.pages ELSE NULL END
   ),
   chapter_key=COALESCE(excluded.chapter_key, books.chapter_key),
   pages=excluded.pages,
   pages_read=CASE
     WHEN ?=0 OR ${preserveReadingProgress} THEN
       CASE
         WHEN books.pages>0 AND books.pages_read>=books.pages AND excluded.pages>books.pages THEN excluded.pages
         ELSE books.pages_read
       END
     ELSE excluded.pages_read
   END,
   created_at=excluded.created_at,
   last_read_at=CASE WHEN ?=0 OR ?=0 OR ${preserveReadingProgress} THEN books.last_read_at ELSE excluded.last_read_at END,
   remote_available=excluded.remote_available`;

function replaceBookTask(
  serverId: string,
  book: BookRecord,
  refreshedAt: string,
  snapshotStartedAt: string | null = null,
): capTask {
  const hasDownload = Boolean(book.downloadPath) || book.downloadStatus === 'available';
  const remoteFileSize = book.remoteFileSize !== undefined ? book.remoteFileSize : book.fileSize;
  const downloadedBytes = hasDownload
    ? book.downloadedBytes !== undefined
      ? book.downloadedBytes
      : book.fileSize
    : null;
  const downloadedPages = hasDownload
    ? book.downloadedPages !== undefined
      ? book.downloadedPages
      : book.pages > 0
        ? book.pages
        : null
    : null;
  return {
    statement: replaceBookStatement,
    values: [
      book.id,
      serverId,
      book.libraryId,
      book.seriesId,
      book.volumeId,
      book.chapterId,
      book.title,
      book.author,
      book.series,
      book.descriptionHtml,
      book.format,
      refreshedAt,
      book.downloadPath,
      book.downloadStatus,
      book.fileSize,
      book.pages,
      book.pagesRead,
      book.createdAt,
      book.lastReadAt,
      book.remoteAvailable !== false ? 1 : 0,
      remoteFileSize,
      downloadedBytes,
      downloadedPages,
      book.chapterKey ?? null,
      book.remoteProgressKnown === false ? 0 : 1,
      snapshotStartedAt,
      snapshotStartedAt,
      book.remoteProgressKnown === false ? 0 : 1,
      book.remoteReadDateKnown === false ? 0 : 1,
      snapshotStartedAt,
      snapshotStartedAt,
    ],
  };
}

/**
 * Apply a native library refresh as one SQLite transaction. The UPSERT only
 * changes metadata and progress columns on existing rows, leaving downloaded
 * file columns and related reading/sync rows intact.
 */
export async function replaceBooksInTransaction(
  db: Pick<SQLiteDBConnection, 'executeTransaction'>,
  serverId: string,
  books: BookRecord[],
  refreshedAt = new Date().toISOString(),
): Promise<void> {
  if (books.length === 0) return;
  await executeNativeTransaction(
    db,
    books.map((book) => replaceBookTask(serverId, book, refreshedAt)),
  );
}

const retainedBookCondition = `(download_path IS NOT NULL OR download_status='available'
  OR EXISTS (SELECT 1 FROM reading_state WHERE reading_state.book_id=books.id)
  OR EXISTS (SELECT 1 FROM sync_queue WHERE sync_queue.book_id=books.id)
  OR EXISTS (
    SELECT 1 FROM preferences
    WHERE preferences.key IN (
      'readerBookmarks:' || books.id,
      'readerAnnotations:' || books.id,
      'readerHistory:' || books.id
    )
    AND TRIM(preferences.value) NOT IN ('', '[]')
  ))`;

interface ExistingBookSnapshot extends LineageCandidate {
  libraryId: number;
  volumeId: number;
  pages: number;
  pagesRead: number;
  createdAt: string;
  lastReadAt: string | null;
  downloadPath: string | null;
  downloadStatus: string;
  fileSize: number | null;
  remoteFileSize: number | null;
  downloadedBytes: number | null;
  downloadedPages: number | null;
}

/** Apply metadata and optional removal reconciliation atomically on native SQLite. */
export async function reconcileBooksInTransaction(
  db: Pick<SQLiteDBConnection, 'executeTransaction'> & Partial<Pick<SQLiteDBConnection, 'query'>>,
  serverId: string,
  books: BookRecord[],
  refreshedAt = new Date().toISOString(),
  preserveMissing = false,
  snapshotStartedAt: string | null = null,
): Promise<Map<string, string>> {
  if (preserveMissing && books.length === 0) return new Map();
  return enqueueNativeWrite(async () => {
    let remapped = new Map<string, string>();
    const existingById = new Map<string, ExistingBookSnapshot>();
    const readingByBookId = new Map<
      string,
      { localUpdatedAt: string; serverUpdatedAt: string | null; pendingSync: boolean }
    >();
    const syncPayloadByBookId = new Map<string, string>();
    const readerPreferences = new Map<string, string>();

    if (!preserveMissing && typeof db.query === 'function') {
      const existingRows =
        (
          await db.query(
            `SELECT id, library_id, series_id, volume_id, chapter_id, title, author, series,
              pages, pages_read, created_at, last_read_at, download_path, download_status,
              file_size, remote_file_size, downloaded_bytes, downloaded_pages, chapter_key
            FROM books WHERE server_id=?`,
            [serverId],
          )
        ).values ?? [];
      for (const row of existingRows) {
        const snapshot: ExistingBookSnapshot = {
          id: String(row.id),
          libraryId: Number(row.library_id),
          seriesId: Number(row.series_id),
          volumeId: Number(row.volume_id),
          chapterId: Number(row.chapter_id),
          title: String(row.title),
          author: row.author ? String(row.author) : null,
          series: row.series ? String(row.series) : null,
          pages: Number(row.pages ?? 0),
          pagesRead: Number(row.pages_read ?? 0),
          createdAt: String(row.created_at ?? ''),
          lastReadAt: row.last_read_at ? String(row.last_read_at) : null,
          downloadPath: row.download_path ? String(row.download_path) : null,
          downloadStatus: String(row.download_status ?? 'none'),
          fileSize: row.file_size == null ? null : Number(row.file_size),
          remoteFileSize: row.remote_file_size == null ? null : Number(row.remote_file_size),
          downloadedBytes: row.downloaded_bytes == null ? null : Number(row.downloaded_bytes),
          downloadedPages: row.downloaded_pages == null ? null : Number(row.downloaded_pages),
          chapterKey: row.chapter_key ? String(row.chapter_key) : null,
        };
        existingById.set(snapshot.id, snapshot);
      }
      remapped = matchBookLineage([...existingById.values()], books);

      if (remapped.size > 0) {
        const [readingRows, queueRows, prefRows] = await Promise.all([
          db.query(
            `SELECT book_id, local_updated_at, server_updated_at, pending_sync
            FROM reading_state WHERE book_id IN (SELECT id FROM books WHERE server_id=?)`,
            [serverId],
          ),
          db.query(
            `SELECT book_id, payload_json
            FROM sync_queue WHERE book_id IN (SELECT id FROM books WHERE server_id=?)`,
            [serverId],
          ),
          db.query(
            `SELECT key, value FROM preferences
            WHERE key LIKE 'readerBookmarks:%'
               OR key LIKE 'readerAnnotations:%'
               OR key LIKE 'readerHistory:%'`,
          ),
        ]);
        for (const row of readingRows.values ?? []) {
          readingByBookId.set(String(row.book_id), {
            localUpdatedAt: String(row.local_updated_at),
            serverUpdatedAt: row.server_updated_at ? String(row.server_updated_at) : null,
            pendingSync: Number(row.pending_sync) === 1,
          });
        }
        for (const row of queueRows.values ?? []) {
          syncPayloadByBookId.set(String(row.book_id), String(row.payload_json));
        }
        for (const row of prefRows.values ?? []) {
          readerPreferences.set(String(row.key), String(row.value));
        }
      }
    }

    const remappedFromNewId = new Map<string, string>();
    for (const [oldId, newId] of remapped) remappedFromNewId.set(newId, oldId);
    const incomingById = new Map<string, BookRecord>();
    const began = snapshotStartedAt ? Date.parse(snapshotStartedAt) : Infinity;

    const tasks: capTask[] = [];
    if (!preserveMissing) {
      tasks.push({
        statement: 'UPDATE books SET remote_available=0 WHERE server_id=? AND remote_available=1',
        values: [serverId],
      });
    }

    const mergedPagesReadByNewId = new Map<string, number>();
    for (const book of books) {
      incomingById.set(book.id, book);
      const oldId = remappedFromNewId.get(book.id);
      const oldRow = oldId ? existingById.get(oldId) : undefined;
      if (!oldRow || !oldId) {
        tasks.push(
          replaceBookTask(
            serverId,
            { ...book, remoteAvailable: true },
            refreshedAt,
            snapshotStartedAt,
          ),
        );
        continue;
      }
      const oldReading = readingByBookId.get(oldId);
      const pending = syncPayloadByBookId.has(oldId) || oldReading?.pendingSync === true;
      const changedDuringRefresh =
        oldReading &&
        (Date.parse(oldReading.localUpdatedAt) >= began ||
          Date.parse(oldReading.serverUpdatedAt ?? '') >= began);
      const remappedWithLocalProgress =
        book.pagesRead === 0 && !book.lastReadAt && (oldRow.pagesRead > 0 || Boolean(oldReading));
      const preserveProgress =
        pending ||
        changedDuringRefresh ||
        book.remoteProgressKnown === false ||
        remappedWithLocalProgress;
      const preserveReadDate = preserveProgress || book.remoteReadDateKnown === false;
      const oldHasDownload = Boolean(oldRow.downloadPath) || oldRow.downloadStatus === 'available';
      const downloadedBytes = oldHasDownload ? (oldRow.downloadedBytes ?? oldRow.fileSize) : null;
      const downloadedPages = oldHasDownload
        ? (oldRow.downloadedPages ?? (oldRow.pages > 0 ? oldRow.pages : null))
        : null;
      const remoteFileSize = book.remoteFileSize ?? book.fileSize ?? oldRow.remoteFileSize ?? null;
      const scaledOldPagesRead =
        oldRow.pages > 0 && oldRow.pagesRead >= oldRow.pages && book.pages > oldRow.pages
          ? book.pages
          : oldRow.pagesRead;
      const nextPagesRead = preserveProgress ? scaledOldPagesRead : book.pagesRead;
      mergedPagesReadByNewId.set(book.id, nextPagesRead);
      tasks.push(
        replaceBookTask(
          serverId,
          {
            ...book,
            remoteAvailable: true,
            downloadPath: book.downloadPath ?? oldRow.downloadPath,
            downloadStatus: oldHasDownload ? 'available' : book.downloadStatus,
            fileSize: oldHasDownload ? (downloadedBytes ?? oldRow.fileSize) : remoteFileSize,
            remoteFileSize,
            downloadedBytes,
            downloadedPages,
            chapterKey: book.chapterKey ?? oldRow.chapterKey ?? null,
            pagesRead: nextPagesRead,
            lastReadAt: preserveReadDate ? oldRow.lastReadAt : book.lastReadAt,
          },
          refreshedAt,
          snapshotStartedAt,
        ),
      );
    }

    for (const [oldId, newId] of remapped) {
      const newBook = incomingById.get(newId);
      if (!newBook) continue;
      if (readingByBookId.has(oldId)) {
        tasks.push({
          statement: 'UPDATE reading_state SET book_id=? WHERE book_id=?',
          values: [newId, oldId],
        });
      }
      const oldPayloadJson = syncPayloadByBookId.get(oldId);
      if (oldPayloadJson !== undefined) {
        const rewrittenPayload = updatePendingProgressRouting(oldPayloadJson, {
          libraryId: newBook.libraryId,
          seriesId: newBook.seriesId,
          volumeId: newBook.volumeId,
          chapterId: newBook.chapterId,
          pages: newBook.pages,
          pagesRead: mergedPagesReadByNewId.get(newId) ?? newBook.pagesRead,
        });
        tasks.push({
          statement: `UPDATE sync_queue
            SET book_id=?, payload_json=?, attempt_count=0, last_attempt_at=NULL, last_error=NULL
            WHERE book_id=?`,
          values: [newId, rewrittenPayload, oldId],
        });
      }
      let hadOldPreference = false;
      for (const prefix of READER_PREFERENCE_PREFIXES) {
        const oldKey = `${prefix}${oldId}`;
        const newKey = `${prefix}${newId}`;
        if (readerPreferences.has(oldKey)) hadOldPreference = true;
        const mergedPref = mergeReaderPreferenceValue(
          prefix,
          readerPreferences.get(oldKey),
          readerPreferences.get(newKey),
        );
        if (mergedPref !== undefined && readerPreferences.has(oldKey)) {
          tasks.push({
            statement: `INSERT INTO preferences (key, value, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
            values: [newKey, mergedPref, refreshedAt],
          });
        }
      }
      if (hadOldPreference) {
        tasks.push({
          statement: 'DELETE FROM preferences WHERE key IN (?, ?, ?)',
          values: [
            `readerBookmarks:${oldId}`,
            `readerAnnotations:${oldId}`,
            `readerHistory:${oldId}`,
          ],
        });
      }
      tasks.push({
        statement: 'DELETE FROM books WHERE id=?',
        values: [oldId],
      });
    }

    if (!preserveMissing) {
      tasks.push({
        statement: `DELETE FROM preferences WHERE key IN (
          SELECT 'readerBookmarks:' || id FROM books
            WHERE server_id=? AND remote_available=0 AND NOT ${retainedBookCondition}
          UNION ALL
          SELECT 'readerAnnotations:' || id FROM books
            WHERE server_id=? AND remote_available=0 AND NOT ${retainedBookCondition}
          UNION ALL
          SELECT 'readerHistory:' || id FROM books
            WHERE server_id=? AND remote_available=0 AND NOT ${retainedBookCondition}
        )`,
        values: [serverId, serverId, serverId],
      });
      tasks.push({
        statement: `DELETE FROM books WHERE server_id=? AND remote_available=0
          AND NOT ${retainedBookCondition}`,
        values: [serverId],
      });
    }

    if (tasks.length > 0) {
      await db.executeTransaction(tasks);
    }
    return remapped;
  });
}

export async function getBooks(
  serverId: string,
  { includeDescription = true } = {},
): Promise<BookRecord[]> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    const books = state.books
      .filter((book) => book.serverId === serverId)
      .map((book) => {
        const hasDownload = Boolean(book.downloadPath) || book.downloadStatus === 'available';
        const remoteFileSize = book.remoteFileSize ?? book.fileSize ?? null;
        const downloadedBytes = hasDownload
          ? (book.downloadedBytes ?? book.fileSize ?? null)
          : null;
        const downloadedPages = hasDownload
          ? (book.downloadedPages ?? (book.pages > 0 ? book.pages : null))
          : null;
        return {
          ...book,
          descriptionHtml: includeDescription ? book.descriptionHtml : null,
          remoteFileSize,
          downloadedBytes,
          downloadedPages,
          downloadOutdated: isBookDownloadOutdated({
            downloadPath: book.downloadPath,
            downloadStatus: book.downloadStatus,
            pages: book.pages,
            remoteFileSize,
            downloadedBytes,
            downloadedPages,
          }),
          hasLocalData: hasBrowserLocalData(state, book),
        };
      });
    return books;
  }
  const db = await openDatabase();
  const result = await db.query(
    `SELECT id, server_id, library_id, series_id, volume_id, chapter_id, title, author, series,
      format, pages, pages_read, created_at, last_read_at, download_path, download_status,
      file_size, remote_file_size, downloaded_bytes, downloaded_pages, chapter_key,
      remote_available,
      CASE WHEN ${retainedBookCondition} THEN 1 ELSE 0 END AS has_local_data${includeDescription ? ', description_html' : ''}
      FROM books WHERE server_id = ? ORDER BY title`,
    [serverId],
  );
  return (result.values ?? []).map((row) => {
    const downloadPath = row.download_path ? String(row.download_path) : null;
    const downloadStatus = String(row.download_status);
    const hasDownload = Boolean(downloadPath) || downloadStatus === 'available';
    const pages = Number(row.pages ?? 0);
    const fileSize = row.file_size == null ? null : Number(row.file_size);
    const remoteFileSize = row.remote_file_size == null ? fileSize : Number(row.remote_file_size);
    const downloadedBytes =
      row.downloaded_bytes == null ? (hasDownload ? fileSize : null) : Number(row.downloaded_bytes);
    const downloadedPages =
      row.downloaded_pages == null
        ? hasDownload && pages > 0
          ? pages
          : null
        : Number(row.downloaded_pages);
    return {
      id: String(row.id),
      serverId: String(row.server_id),
      libraryId: Number(row.library_id),
      seriesId: Number(row.series_id),
      volumeId: Number(row.volume_id),
      chapterId: Number(row.chapter_id),
      title: String(row.title),
      author: row.author ? String(row.author) : null,
      series: row.series ? String(row.series) : null,
      descriptionHtml: row.description_html ? String(row.description_html) : null,
      format: String(row.format),
      pages,
      pagesRead: Number(row.pages_read ?? 0),
      createdAt: String(row.created_at ?? ''),
      lastReadAt: row.last_read_at ? String(row.last_read_at) : null,
      downloadPath,
      downloadStatus,
      fileSize,
      remoteFileSize,
      downloadedBytes,
      downloadedPages,
      downloadOutdated: isBookDownloadOutdated({
        downloadPath,
        downloadStatus,
        pages,
        remoteFileSize,
        downloadedBytes,
        downloadedPages,
      }),
      hasLocalData: Number(row.has_local_data ?? 0) !== 0,
      ...(row.chapter_key ? { chapterKey: String(row.chapter_key) } : {}),
      remoteAvailable: Number(row.remote_available ?? 1) !== 0,
    };
  });
}

export async function markDownloaded(
  bookId: string,
  path: string,
  size: number,
  baseline?: { downloadedBytes?: number | null; downloadedPages?: number | null },
): Promise<void> {
  const baselineBytes = baseline?.downloadedBytes ?? size;
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      state.books = state.books.map((book) => {
        if (book.id !== bookId) return book;
        const downloadedPages =
          baseline?.downloadedPages !== undefined
            ? baseline.downloadedPages
            : book.pages > 0
              ? book.pages
              : null;
        return {
          ...book,
          downloadPath: path,
          downloadStatus: 'available',
          fileSize: size,
          remoteFileSize: book.remoteFileSize ?? book.fileSize ?? baselineBytes,
          downloadedBytes: baselineBytes,
          downloadedPages,
          downloadOutdated: false,
        };
      });
    });
    return;
  }
  const db = await openDatabase();
  await executeNativeRun(
    db,
    `UPDATE books SET
      download_path=?,
      download_status='available',
      file_size=?,
      remote_file_size=COALESCE(remote_file_size, ?),
      downloaded_bytes=?,
      downloaded_pages=COALESCE(?, CASE WHEN pages>0 THEN pages ELSE NULL END)
    WHERE id=?`,
    [path, size, baselineBytes, baselineBytes, baseline?.downloadedPages ?? null, bookId],
  );
}

export interface StoredReadingState {
  cfi: string;
  xpath: string | null;
  percentage: number;
  localUpdatedAt: string;
  syncedLocalUpdatedAt: string | null;
  serverUpdatedAt: string | null;
  pendingSync: boolean;
  /** Monotonic reading revision, retained after the queue row is acknowledged. */
  syncRevision?: number | null;
}

export interface PendingProgressPayload {
  libraryId: number;
  seriesId: number;
  volumeId: number;
  chapterId: number;
  pageNum: number;
  bookScrollId?: string | null;
}

const readingStateUpsertStatement = `INSERT INTO reading_state
  (book_id,cfi,kavita_xpath,percentage,local_updated_at,pending_sync,sync_revision)
  VALUES (?,?,?,?,?,1,1) ON CONFLICT(book_id) DO UPDATE SET cfi=excluded.cfi,
  kavita_xpath=excluded.kavita_xpath,percentage=excluded.percentage,
  local_updated_at=excluded.local_updated_at,pending_sync=1,
  sync_revision=reading_state.sync_revision+1`;

const syncQueueUpsertStatement = `INSERT INTO sync_queue
  (book_id,payload_json,created_at,updated_at,revision)
  VALUES (?,?,?,?,COALESCE((SELECT sync_revision FROM reading_state WHERE book_id=?),1))
  ON CONFLICT(book_id) DO UPDATE SET payload_json=excluded.payload_json,
  attempt_count=0,last_attempt_at=NULL,last_error=NULL,
  updated_at=excluded.updated_at,revision=excluded.revision`;

function createReadingStateTask(
  bookId: string,
  cfi: string,
  xpath: string | null,
  percentage: number,
  updatedAt: string,
): capTask {
  return {
    statement: readingStateUpsertStatement,
    values: [bookId, cfi, xpath, percentage, updatedAt],
  };
}

function createSyncQueueTask(
  bookId: string,
  payload: PendingProgressPayload,
  updatedAt: string,
): capTask {
  return {
    statement: syncQueueUpsertStatement,
    values: [bookId, JSON.stringify(payload), updatedAt, updatedAt, bookId],
  };
}

export async function getReadingState(bookId: string): Promise<StoredReadingState | null> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    const readingState = state.readingState[bookId];
    if (!readingState) return null;
    return {
      ...readingState,
      syncRevision: Math.max(
        Number(readingState.syncRevision ?? 0),
        Number(state.syncQueue[bookId]?.revision ?? 0),
      ),
    };
  }
  const db = await openDatabase();
  const row = (await db.query('SELECT * FROM reading_state WHERE book_id=?', [bookId])).values?.[0];
  if (!row) return null;
  return {
    cfi: String(row.cfi),
    xpath: row.kavita_xpath ? String(row.kavita_xpath) : null,
    percentage: Number(row.percentage),
    localUpdatedAt: String(row.local_updated_at),
    syncedLocalUpdatedAt: row.synced_local_updated_at ? String(row.synced_local_updated_at) : null,
    serverUpdatedAt: row.server_updated_at ? String(row.server_updated_at) : null,
    pendingSync: Number(row.pending_sync) === 1,
    syncRevision: Number(row.sync_revision ?? 0),
  };
}

export async function saveLocalProgress(
  book: BookRecord,
  cfi: string,
  xpath: string | null,
  percentage: number,
  spineIndex?: number,
): Promise<void> {
  const now = new Date().toISOString();
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      const stored = state.books.find((item) => item.id === book.id);
      const target = stored ?? book;
      const hasDownload = Boolean(target.downloadPath) || target.downloadStatus === 'available';
      const downloadedPages = hasDownload
        ? (book.downloadedPages ?? stored?.downloadedPages ?? null)
        : null;
      const pagesRead = toKavitaPageNumber(
        percentage,
        target.pages || book.pages,
        spineIndex,
        downloadedPages,
      );
      const syncRevision =
        Math.max(
          Number(state.readingState[book.id]?.syncRevision ?? 0),
          Number(state.syncQueue[book.id]?.revision ?? 0),
        ) + 1;
      state.readingState[book.id] = {
        cfi,
        xpath,
        percentage,
        localUpdatedAt: now,
        syncedLocalUpdatedAt: state.readingState[book.id]?.syncedLocalUpdatedAt ?? null,
        serverUpdatedAt: state.readingState[book.id]?.serverUpdatedAt ?? null,
        pendingSync: true,
        syncRevision,
      };
      state.syncQueue[book.id] = {
        bookId: book.id,
        payloadJson: JSON.stringify({
          libraryId: target.libraryId,
          seriesId: target.seriesId,
          volumeId: target.volumeId,
          chapterId: target.chapterId,
          pageNum: pagesRead,
          bookScrollId: xpath,
        }),
        serverId: target.serverId,
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
        createdAt: state.syncQueue[book.id]?.createdAt ?? now,
        updatedAt: now,
        revision: syncRevision,
      };
      state.books = state.books.map((item) =>
        item.id === book.id
          ? {
              ...item,
              pagesRead,
              lastReadAt: now,
            }
          : item,
      );
    });
    return;
  }
  const db = await openDatabase();
  await enqueueNativeWrite(async () => {
    let totalPages = book.pages;
    let hasDownload = Boolean(book.downloadPath) || book.downloadStatus === 'available';
    let downloadedPages = hasDownload ? (book.downloadedPages ?? null) : null;
    if (book.downloadedPages === undefined && spineIndex !== undefined) {
      const row = (
        await db.query(
          'SELECT pages, download_path, download_status, downloaded_pages FROM books WHERE id=?',
          [book.id],
        )
      ).values?.[0];
      if (row) {
        totalPages = Number(row.pages ?? 0) || book.pages;
        hasDownload =
          Boolean(row.download_path) || String(row.download_status ?? 'none') === 'available';
        downloadedPages =
          hasDownload && row.downloaded_pages != null ? Number(row.downloaded_pages) : null;
      }
    }
    const pagesRead = toKavitaPageNumber(percentage, totalPages, spineIndex, downloadedPages);
    const payload = {
      libraryId: book.libraryId,
      seriesId: book.seriesId,
      volumeId: book.volumeId,
      chapterId: book.chapterId,
      pageNum: pagesRead,
      bookScrollId: xpath,
    };
    await db.executeTransaction([
      createReadingStateTask(book.id, cfi, xpath, percentage, now),
      createSyncQueueTask(book.id, payload, now),
      {
        statement: 'UPDATE books SET pages_read=?, last_read_at=? WHERE id=?',
        values: [pagesRead, now, book.id],
      },
    ]);
  });
}

export async function markBookCompleted(
  book: BookRecord,
  readingState: StoredReadingState | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      const stored = state.books.find((item) => item.id === book.id);
      const target = stored ?? book;
      const completedPages = Math.max(book.pages, stored?.pages ?? 0);
      const payload: PendingProgressPayload = {
        libraryId: target.libraryId,
        seriesId: target.seriesId,
        volumeId: target.volumeId,
        chapterId: target.chapterId,
        pageNum: completedPages,
        bookScrollId: null,
      };
      const syncRevision =
        Math.max(
          Number(state.readingState[book.id]?.syncRevision ?? 0),
          Number(state.syncQueue[book.id]?.revision ?? 0),
        ) + 1;
      state.books = state.books.map((item) =>
        item.id === book.id
          ? {
              ...item,
              pagesRead: completedPages,
              lastReadAt: now,
            }
          : item,
      );
      state.readingState[book.id] = {
        cfi: '',
        xpath: null,
        percentage: 1,
        localUpdatedAt: now,
        syncedLocalUpdatedAt: readingState?.syncedLocalUpdatedAt ?? null,
        serverUpdatedAt: readingState?.serverUpdatedAt ?? null,
        pendingSync: true,
        syncRevision,
      };
      state.syncQueue[book.id] = {
        bookId: book.id,
        payloadJson: JSON.stringify(payload),
        serverId: target.serverId,
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
        createdAt: state.syncQueue[book.id]?.createdAt ?? now,
        updatedAt: now,
        revision: syncRevision,
      };
    });
    return;
  }
  const db = await openDatabase();
  const payload: PendingProgressPayload = {
    libraryId: book.libraryId,
    seriesId: book.seriesId,
    volumeId: book.volumeId,
    chapterId: book.chapterId,
    pageNum: book.pages,
    bookScrollId: null,
  };
  const tasks: capTask[] = [
    {
      statement: 'UPDATE books SET pages_read=MAX(pages, ?), last_read_at=? WHERE id=?',
      values: [book.pages, now, book.id],
    },
  ];
  tasks.push(createReadingStateTask(book.id, '', null, 1, now));
  tasks.push(createSyncQueueTask(book.id, payload, now));
  await executeNativeTransaction(db, tasks);
}

export interface PendingSyncItem {
  bookId: string;
  payload: string;
  updatedAt: string;
  revision: number;
}

type BookProgressRouting = Pick<BookRecord, 'libraryId' | 'seriesId' | 'volumeId' | 'chapterId'> &
  Partial<Pick<BookRecord, 'pages' | 'pagesRead'>>;

function updatePendingProgressRouting(payloadJson: string, book: BookProgressRouting): string {
  try {
    const payload: unknown = JSON.parse(payloadJson);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payloadJson;
    const record = payload as Record<string, unknown>;
    const completed =
      typeof book.pages === 'number' &&
      book.pages > 0 &&
      typeof book.pagesRead === 'number' &&
      book.pagesRead >= book.pages &&
      !record.bookScrollId &&
      typeof record.pageNum === 'number' &&
      record.pageNum > 0 &&
      record.pageNum < book.pages;
    return JSON.stringify({
      ...record,
      libraryId: book.libraryId,
      seriesId: book.seriesId,
      volumeId: book.volumeId,
      chapterId: book.chapterId,
      ...(completed ? { pageNum: book.pages } : {}),
    });
  } catch {
    return payloadJson;
  }
}

function getBrowserSyncRows(
  state: BrowserDatabaseState,
  serverId: string,
): Array<{ bookId: string; row: BrowserSyncQueueRow; book: BookRecord }> {
  const booksById = new Map(state.books.map((book) => [book.id, book]));
  return Object.entries(state.syncQueue).flatMap(([bookId, row]) => {
    const book = booksById.get(bookId);
    if (
      !book ||
      book.serverId !== serverId ||
      book.remoteAvailable === false ||
      row.serverId !== book.serverId
    ) {
      return [];
    }
    return [{ bookId, row, book }];
  });
}

export interface SyncStatus {
  pendingCount: number;
  failedCount: number;
  lastError: string | null;
  lastUpdatedAt: string | null;
}

export async function getPendingSync(serverId: string): Promise<PendingSyncItem[]> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    return getBrowserSyncRows(state, serverId)
      .sort((a, b) => a.row.updatedAt.localeCompare(b.row.updatedAt))
      .map(({ bookId, row, book }) => ({
        bookId,
        payload: updatePendingProgressRouting(row.payloadJson, book),
        updatedAt: row.updatedAt,
        revision: row.revision,
      }));
  }
  const db = await openDatabase();
  const result = await db.query(
    `SELECT sync_queue.book_id,sync_queue.payload_json,sync_queue.updated_at,sync_queue.revision,
      books.library_id,books.series_id,books.volume_id,books.chapter_id
    FROM sync_queue CROSS JOIN books ON books.id=sync_queue.book_id
    WHERE books.server_id=? AND books.remote_available=1 ORDER BY sync_queue.updated_at`,
    [serverId],
  );
  return (result.values ?? []).map((row) => {
    const bookId = String(row.book_id);
    return {
      bookId,
      payload: updatePendingProgressRouting(String(row.payload_json), {
        libraryId: Number(row.library_id),
        seriesId: Number(row.series_id),
        volumeId: Number(row.volume_id),
        chapterId: Number(row.chapter_id),
      }),
      updatedAt: String(row.updated_at),
      revision: Number(row.revision),
    };
  });
}

export async function getSyncStatus(serverId: string): Promise<SyncStatus> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    const rows = getBrowserSyncRows(state, serverId)
      .map(({ row }) => row)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      pendingCount: rows.length,
      failedCount: rows.filter((row) => Boolean(row.lastError)).length,
      lastError: rows.find((row) => row.lastError)?.lastError ?? null,
      lastUpdatedAt: rows[0]?.updatedAt ?? null,
    };
  }
  const db = await openDatabase();
  const result = await db.query(
    `SELECT sync_queue.updated_at,sync_queue.last_error
    FROM sync_queue CROSS JOIN books ON books.id=sync_queue.book_id
    WHERE books.server_id=? AND books.remote_available=1 ORDER BY sync_queue.updated_at DESC`,
    [serverId],
  );
  const rows = result.values ?? [];
  return {
    pendingCount: rows.length,
    failedCount: rows.filter((row) => row.last_error).length,
    lastError: rows.find((row) => row.last_error)?.last_error
      ? String(rows.find((row) => row.last_error)?.last_error)
      : null,
    lastUpdatedAt: rows[0]?.updated_at ? String(rows[0].updated_at) : null,
  };
}

export async function saveRemoteProgress(
  book: BookRecord,
  remote: KavitaProgress,
  expected: StoredReadingState | null,
): Promise<boolean> {
  const now = new Date().toISOString();
  const serverUpdatedAt = remote.lastModifiedUtc ?? now;
  const pagesRead = Math.max(0, Math.min(book.pages, remote.pageNum));
  const next: StoredReadingState = {
    cfi: '',
    xpath: remote.bookScrollId ?? null,
    percentage: book.pages > 0 ? Math.min(0.999, pagesRead / book.pages) : 0,
    localUpdatedAt: now,
    syncedLocalUpdatedAt: now,
    serverUpdatedAt,
    pendingSync: false,
    syncRevision: (expected?.syncRevision ?? 0) + 1,
  };
  const matches = (current: StoredReadingState | null) =>
    !expected?.pendingSync &&
    !current?.pendingSync &&
    current?.localUpdatedAt === expected?.localUpdatedAt &&
    (current?.syncRevision ?? 0) === (expected?.syncRevision ?? 0);

  if (!Capacitor.isNativePlatform()) {
    return updateBrowserState((state) => {
      if (
        state.syncQueue[book.id] ||
        !state.books.some((item) => item.id === book.id) ||
        !matches(state.readingState[book.id] ?? null)
      )
        return false;
      state.readingState[book.id] = next;
      state.books = state.books.map((item) =>
        item.id === book.id ? { ...item, pagesRead, lastReadAt: serverUpdatedAt } : item,
      );
    });
  }

  const db = await openDatabase();
  return enqueueNativeWrite(async () => {
    if (!matches(await getReadingState(book.id))) return false;
    const queue = await db.query('SELECT 1 FROM sync_queue WHERE book_id=?', [book.id]);
    if (queue.values?.length) return false;
    await db.executeTransaction([
      {
        statement: `INSERT INTO reading_state
          (book_id,cfi,kavita_xpath,percentage,local_updated_at,synced_local_updated_at,
          server_page_num,server_xpath,server_updated_at,pending_sync,sync_revision)
          VALUES (?,'',?,?,?,?,?,?,?,0,?) ON CONFLICT(book_id) DO UPDATE SET cfi='',
          kavita_xpath=excluded.kavita_xpath,percentage=excluded.percentage,
          local_updated_at=excluded.local_updated_at,synced_local_updated_at=excluded.synced_local_updated_at,
          server_page_num=excluded.server_page_num,server_xpath=excluded.server_xpath,
          server_updated_at=excluded.server_updated_at,pending_sync=0,sync_revision=excluded.sync_revision`,
        values: [
          book.id,
          next.xpath,
          next.percentage,
          now,
          now,
          remote.pageNum,
          next.xpath,
          serverUpdatedAt,
          next.syncRevision,
        ],
      },
      {
        statement: 'UPDATE books SET pages_read=?,last_read_at=? WHERE id=?',
        values: [pagesRead, serverUpdatedAt, book.id],
      },
    ]);
    return true;
  });
}

/**
 * Accept the server side of an open-progress conflict, but only if the exact
 * local queue revision shown to the user is still pending.
 */
export async function acceptRemoteProgress(
  book: BookRecord,
  remote: KavitaProgress,
  expectedRevision: number,
  expectedUpdatedAt: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const serverUpdatedAt = remote.lastModifiedUtc ?? now;
  const percentage = book.pages > 0 ? Math.max(0, Math.min(0.999, remote.pageNum / book.pages)) : 0;
  const pagesRead = Math.max(0, Math.min(book.pages, remote.pageNum));
  const xpath = remote.bookScrollId ?? null;

  if (!Capacitor.isNativePlatform()) {
    return updateBrowserState((state) => {
      const queue = state.syncQueue[book.id];
      const reading = state.readingState[book.id];
      if (
        !queue ||
        !reading ||
        !reading.pendingSync ||
        Math.max(Number(reading.syncRevision ?? 0), queue.revision) !== expectedRevision ||
        queue.revision !== expectedRevision ||
        queue.updatedAt !== expectedUpdatedAt ||
        reading.localUpdatedAt !== expectedUpdatedAt
      ) {
        return false;
      }
      state.readingState[book.id] = {
        ...reading,
        cfi: '',
        xpath,
        percentage,
        localUpdatedAt: now,
        syncedLocalUpdatedAt: now,
        serverUpdatedAt,
        pendingSync: false,
        syncRevision: expectedRevision,
      };
      delete state.syncQueue[book.id];
      state.books = state.books.map((item) =>
        item.id === book.id ? { ...item, pagesRead, lastReadAt: serverUpdatedAt } : item,
      );
    });
  }

  const db = await openDatabase();
  await executeNativeTransaction(db, [
    {
      statement: `UPDATE reading_state SET cfi='',kavita_xpath=?,percentage=?,local_updated_at=?,
        synced_local_updated_at=?,server_page_num=?,server_xpath=?,server_updated_at=?,pending_sync=0
        WHERE book_id=? AND pending_sync=1 AND local_updated_at=? AND sync_revision=?
        AND EXISTS (SELECT 1 FROM sync_queue WHERE book_id=? AND revision=? AND updated_at=?)`,
      values: [
        xpath,
        percentage,
        now,
        now,
        remote.pageNum,
        xpath,
        serverUpdatedAt,
        book.id,
        expectedUpdatedAt,
        expectedRevision,
        book.id,
        expectedRevision,
        expectedUpdatedAt,
      ],
    },
    {
      statement: `DELETE FROM sync_queue WHERE book_id=? AND revision=? AND updated_at=?
        AND EXISTS (SELECT 1 FROM reading_state WHERE book_id=? AND pending_sync=0
          AND cfi='' AND local_updated_at=?)`,
      values: [book.id, expectedRevision, expectedUpdatedAt, book.id, now],
    },
    {
      statement: `UPDATE books SET pages_read=?,last_read_at=?
        WHERE id=? AND EXISTS (
          SELECT 1 FROM reading_state WHERE book_id=? AND cfi=''
          AND local_updated_at=? AND pending_sync=0
        )`,
      values: [pagesRead, serverUpdatedAt, book.id, book.id, now],
    },
  ]);

  const adopted = (
    await db.query(
      'SELECT cfi,local_updated_at,pending_sync,server_updated_at FROM reading_state WHERE book_id=?',
      [book.id],
    )
  ).values?.[0];
  return Boolean(
    adopted &&
    String(adopted.cfi) === '' &&
    String(adopted.local_updated_at) === now &&
    Number(adopted.pending_sync) === 0 &&
    String(adopted.server_updated_at) === serverUpdatedAt,
  );
}

export async function confirmSync(
  bookId: string,
  serverUpdatedAt: string,
  expectedRevision: number,
  expectedUpdatedAt: string,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      if (
        state.syncQueue[bookId]?.revision !== expectedRevision ||
        state.syncQueue[bookId]?.updatedAt !== expectedUpdatedAt
      ) {
        return false;
      }
      delete state.syncQueue[bookId];
      if (state.readingState[bookId]) {
        state.readingState[bookId] = {
          ...state.readingState[bookId],
          pendingSync: false,
          syncedLocalUpdatedAt: expectedUpdatedAt,
          serverUpdatedAt,
          syncRevision: expectedRevision,
        };
      }
    });
    return;
  }
  const db = await openDatabase();
  await executeNativeTransaction(db, [
    {
      statement: `UPDATE reading_state SET pending_sync=0,synced_local_updated_at=?,
        server_updated_at=? WHERE book_id=? AND local_updated_at=?
        AND EXISTS (SELECT 1 FROM sync_queue WHERE book_id=? AND updated_at=? AND revision=?)`,
      values: [
        expectedUpdatedAt,
        serverUpdatedAt,
        bookId,
        expectedUpdatedAt,
        bookId,
        expectedUpdatedAt,
        expectedRevision,
      ],
    },
    {
      statement: 'DELETE FROM sync_queue WHERE book_id=? AND updated_at=? AND revision=?',
      values: [bookId, expectedUpdatedAt, expectedRevision],
    },
  ]);
}

export async function markSyncFailure(
  bookId: string,
  error: string,
  expectedRevision: number,
  expectedUpdatedAt: string,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      const row = state.syncQueue[bookId];
      if (row?.revision !== expectedRevision || row.updatedAt !== expectedUpdatedAt) return false;
      row.attemptCount += 1;
      row.lastAttemptAt = new Date().toISOString();
      row.lastError = error.slice(0, 240);
    });
    return;
  }
  const db = await openDatabase();
  await executeNativeRun(
    db,
    `UPDATE sync_queue SET attempt_count=attempt_count+1,last_attempt_at=?,last_error=?
    WHERE book_id=? AND updated_at=? AND revision=?`,
    [new Date().toISOString(), error.slice(0, 240), bookId, expectedUpdatedAt, expectedRevision],
  );
}

export async function removeDownload(bookId: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      state.books = state.books.map((book) =>
        book.id === bookId
          ? {
              ...book,
              downloadPath: null,
              downloadStatus: 'none',
              fileSize: book.remoteFileSize ?? null,
              downloadedBytes: null,
              downloadedPages: null,
              downloadOutdated: false,
            }
          : book,
      );
    });
    return;
  }
  const db = await openDatabase();
  await executeNativeRun(
    db,
    `UPDATE books SET
      download_path=NULL,
      download_status='none',
      file_size=remote_file_size,
      downloaded_bytes=NULL,
      downloaded_pages=NULL
    WHERE id=?`,
    [bookId],
  );
}

export async function getPreferences(keys: readonly string[]): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  if (!Capacitor.isNativePlatform()) {
    const { preferences } = readBrowserState();
    const values = new Map<string, string>();
    for (const key of keys) {
      const value = preferences[key];
      if (typeof value === 'string') values.set(key, value);
    }
    return values;
  }
  const db = await openDatabase();
  const result = await db.query(
    `SELECT key, value FROM preferences WHERE key IN (${keys.map(() => '?').join(', ')})`,
    [...keys],
  );
  return new Map((result.values ?? []).map((row) => [String(row.key), String(row.value)]));
}

export async function setPreference(key: string, value: string): Promise<void> {
  await setPreferences(new Map([[key, value]]));
}

export async function setPreferences(preferences: ReadonlyMap<string, string>): Promise<void> {
  if (preferences.size === 0) return;
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    for (const [key, value] of preferences) state.preferences[key] = value;
    writeBrowserState(state);
    return;
  }
  const db = await openDatabase();
  const now = new Date().toISOString();
  await executeNativeRun(
    db,
    `INSERT INTO preferences (key,value,updated_at)
    VALUES ${Array.from(preferences, () => '(?,?,?)').join(', ')}
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    Array.from(preferences, ([key, value]) => [key, value, now]).flat(),
  );
}
