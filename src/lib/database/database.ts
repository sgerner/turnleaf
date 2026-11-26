import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type capTask,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import { toKavitaPageNumber } from '../sync/conflict';
import type { KavitaAnnotation, KavitaPersonalTocItem, KavitaProgress } from '../kavita/types';
import { recordLocation, type StoredReaderLocation } from '../reader/bookmarks';
import type { StoredAnnotation, StudySyncState } from '../reader/annotations';
import { migrations } from './schema';
import {
  cfiFallbackLocator,
  disambiguateBookmarkLabel,
  isLegacyStudyPreferenceKey,
  migrateLegacyPreferenceEntries,
  reconcileAnnotationRecords,
  reconcileBookmarkRecords,
  toStoredAnnotation,
  toStoredBookmark,
  type StoredAnnotationRecord,
  type StoredBookmarkRecord,
} from './study-records';

export function createServerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `server_${crypto.randomUUID()}`;
  }
  return `server_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

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
  /** False means Kavita no longer advertises the book; local retention may keep it. */
  remoteAvailable?: boolean;
  /** False means Kavita omitted usable progress fields from this metadata snapshot. */
  remoteProgressKnown?: boolean;
  /** False means Kavita omitted a usable last-read date from this metadata snapshot. */
  remoteReadDateKnown?: boolean;
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
  annotations: Record<string, StoredAnnotationRecord[]>;
  bookmarks: Record<string, StoredBookmarkRecord[]>;
  readingHistory: Record<string, StoredReaderLocation[]>;
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
    annotations: {},
    bookmarks: {},
    readingHistory: {},
    preferences: {},
  };
}

function readBrowserState(): BrowserDatabaseState {
  if (typeof window === 'undefined') return createBrowserState();
  const raw = window.localStorage.getItem(BROWSER_STORAGE_KEY);
  if (!raw) return createBrowserState();
  try {
    const parsed = JSON.parse(raw) as Partial<BrowserDatabaseState>;
    const serverConfig = parsed.serverConfig ?? null;
    const books = Array.isArray(parsed.books)
      ? (parsed.books as BookRecord[]).map((book) => ({
          ...book,
          remoteAvailable: book.remoteAvailable !== false,
        }))
      : [];
    const booksById = new Map(books.map((book) => [book.id, book]));
    const annotations: Record<string, StoredAnnotationRecord[]> = {};
    for (const [bookId, list] of Object.entries(parsed.annotations ?? {})) {
      if (Array.isArray(list)) annotations[bookId] = list.map((item) => ({ ...item }));
    }
    const bookmarks: Record<string, StoredBookmarkRecord[]> = {};
    for (const [bookId, list] of Object.entries(parsed.bookmarks ?? {})) {
      if (Array.isArray(list)) bookmarks[bookId] = list.map((item) => ({ ...item }));
    }
    const readingHistory: Record<string, StoredReaderLocation[]> = {};
    for (const [bookId, list] of Object.entries(parsed.readingHistory ?? {})) {
      if (Array.isArray(list)) readingHistory[bookId] = list.map((item) => ({ ...item }));
    }
    const preferences: Record<string, string> = { ...(parsed.preferences ?? {}) };
    const state: BrowserDatabaseState = {
      serverConfig,
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
      annotations,
      bookmarks,
      readingHistory,
      preferences,
    };

    if (Object.keys(preferences).some(isLegacyStudyPreferenceKey)) {
      const activeBookIds = new Set(
        serverConfig
          ? books.filter((book) => book.serverId === serverConfig.id).map((book) => book.id)
          : [],
      );
      const migrated = migrateLegacyPreferenceEntries(Object.entries(preferences), activeBookIds);
      for (const record of migrated.annotations) {
        const list = state.annotations[record.bookId] ?? [];
        if (!list.some((existing) => existing.id === record.id)) {
          list.push(record);
          state.annotations[record.bookId] = list;
        }
      }
      for (const record of migrated.bookmarks) {
        const list = state.bookmarks[record.bookId] ?? [];
        if (!list.some((existing) => existing.id === record.id)) {
          list.push(record);
          state.bookmarks[record.bookId] = list;
        }
      }
      for (const { bookId, entry } of migrated.history) {
        const list = state.readingHistory[bookId] ?? [];
        if (!list.some((existing) => existing.id === entry.id)) {
          list.push(entry);
          list.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
          state.readingHistory[bookId] = list.slice(0, 15);
        }
      }
      for (const key of migrated.keysToRemove) {
        delete state.preferences[key];
      }
      try {
        writeBrowserState(state);
      } catch {
        // Best-effort persistence on read; callers writing state will retry.
      }
    }

    return state;
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

async function buildLegacyStudyMigrationTasks(
  db: Pick<SQLiteDBConnection, 'query'>,
): Promise<capTask[]> {
  let preferencesRows: Record<string, unknown>[];
  try {
    preferencesRows =
      (
        await db.query(
          `SELECT key, value FROM preferences
           WHERE key LIKE 'readerAnnotations:%'
              OR key LIKE 'readerBookmarks:%'
              OR key LIKE 'readerHistory:%'`,
        )
      ).values ?? [];
  } catch {
    return [];
  }
  if (preferencesRows.length === 0) return [];

  let bookRows: Record<string, unknown>[];
  try {
    bookRows =
      (
        await db.query(
          `SELECT books.id FROM books
           WHERE EXISTS (SELECT 1 FROM server_config WHERE server_config.id = books.server_id)`,
        )
      ).values ?? [];
  } catch {
    try {
      bookRows = (await db.query('SELECT id FROM books')).values ?? [];
    } catch {
      return [];
    }
  }
  const activeBookIds = new Set(bookRows.map((row) => String(row.id)));
  const entries = preferencesRows.map(
    (row) => [String(row.key), String(row.value)] as [string, string],
  );
  if (entries.length === 0 || activeBookIds.size === 0) return [];
  const migrated = migrateLegacyPreferenceEntries(entries, activeBookIds);
  const tasks: capTask[] = [];
  for (const record of migrated.annotations) {
    tasks.push(insertAnnotationRecordTask(record, true));
  }
  for (const record of migrated.bookmarks) {
    tasks.push(insertBookmarkRecordTask(record, true));
  }
  for (const { bookId, entry } of migrated.history) {
    tasks.push({
      statement: `INSERT OR IGNORE INTO reading_history
        (book_id, id, cfi, href, percentage, label, saved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      values: [
        bookId,
        entry.id,
        entry.cfi,
        entry.href,
        entry.percentage,
        entry.label,
        entry.savedAt,
      ],
    });
  }
  return tasks;
}

async function migrate(db: SQLiteDBConnection): Promise<void> {
  const current = await db.getVersion();
  const currentVersion = current.version ?? 0;
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    const legacyTasks =
      currentVersion >= 3 && migration.version === 8
        ? await buildLegacyStudyMigrationTasks(db)
        : [];
    await executeNativeTransaction(db, [
      { statement: migration.statements },
      ...legacyTasks,
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
    `INSERT INTO server_config
      (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name=excluded.display_name,
        base_url=excluded.base_url,
        credential_ref=excluded.credential_ref,
        kavita_version=excluded.kavita_version,
        last_connected_at=excluded.last_connected_at`,
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
    const matchedServer = state.serverConfig?.id === serverId;
    const hasServerBooks = state.books.some((book) => book.serverId === serverId);
    const hasServerQueue = Object.values(state.syncQueue).some((row) => row.serverId === serverId);
    const serverPrefix = `${serverId}:`;
    const hasPrefixedRecords =
      Object.keys(state.annotations).some((id) => id.startsWith(serverPrefix)) ||
      Object.keys(state.bookmarks).some((id) => id.startsWith(serverPrefix)) ||
      Object.keys(state.readingHistory).some((id) => id.startsWith(serverPrefix)) ||
      Object.keys(state.readingState).some((id) => id.startsWith(serverPrefix));
    if (!matchedServer && !hasServerBooks && !hasServerQueue && !hasPrefixedRecords) return;

    if (matchedServer) {
      state.serverConfig = null;
    }
    state.books = state.books.filter((book) => book.serverId !== serverId);
    const remainingBookIds = new Set(state.books.map((book) => book.id));
    for (const bookId of Object.keys(state.readingState)) {
      if (!remainingBookIds.has(bookId) || bookId.startsWith(serverPrefix)) {
        delete state.readingState[bookId];
      }
    }
    for (const [bookId, row] of Object.entries(state.syncQueue)) {
      if (
        !remainingBookIds.has(bookId) ||
        row.serverId === serverId ||
        bookId.startsWith(serverPrefix)
      ) {
        delete state.syncQueue[bookId];
      }
    }
    for (const bookId of Object.keys(state.annotations)) {
      if (!remainingBookIds.has(bookId) || bookId.startsWith(serverPrefix)) {
        delete state.annotations[bookId];
      }
    }
    for (const bookId of Object.keys(state.bookmarks)) {
      if (!remainingBookIds.has(bookId) || bookId.startsWith(serverPrefix)) {
        delete state.bookmarks[bookId];
      }
    }
    for (const bookId of Object.keys(state.readingHistory)) {
      if (!remainingBookIds.has(bookId) || bookId.startsWith(serverPrefix)) {
        delete state.readingHistory[bookId];
      }
    }
    for (const key of Object.keys(state.preferences)) {
      if (isLegacyStudyPreferenceKey(key)) delete state.preferences[key];
    }
    writeBrowserState(state);
    return;
  }
  const db = await openDatabase();
  await executeNativeTransaction(db, [
    { statement: 'DELETE FROM books WHERE server_id=?', values: [serverId] },
    { statement: 'DELETE FROM server_config WHERE id=?', values: [serverId] },
    {
      statement: `DELETE FROM preferences
        WHERE key LIKE 'readerAnnotations:%'
           OR key LIKE 'readerBookmarks:%'
           OR key LIKE 'readerHistory:%'`,
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
): Promise<void> {
  const preserveMissing = options.preserveMissing === true;
  const snapshotStartedAt = options.snapshotStartedAt ?? null;
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
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
    const unmatched = existing.filter((book) => !incoming.has(book.id));
    const retained = preserveMissing
      ? unmatched
      : unmatched
          .filter(
            (book) =>
              Boolean(book.downloadPath) ||
              book.downloadStatus === 'available' ||
              Boolean(state.syncQueue[book.id]) ||
              Boolean(state.readingState[book.id]) ||
              (state.annotations[book.id] ?? []).some(
                (item) => item.syncState !== 'pending_delete',
              ) ||
              (state.bookmarks[book.id] ?? []).some((item) => item.syncState !== 'pending_delete'),
          )
          .map((book) => ({ ...withoutRemoteProgressMarkers(book), remoteAvailable: false }));
    const began = snapshotStartedAt ? Date.parse(snapshotStartedAt) : Infinity;
    const merged = [...incoming.values()].map((book) => {
      const previous = existingById.get(book.id);
      if (!previous) return { ...book, remoteAvailable: true };
      const reading = state.readingState[book.id];
      const pending = Boolean(state.syncQueue[book.id]) || reading?.pendingSync === true;
      const changedDuringRefresh =
        reading &&
        (Date.parse(reading.localUpdatedAt) >= began ||
          Date.parse(reading.serverUpdatedAt ?? '') >= began);
      const preserveProgress = pending || changedDuringRefresh || unknownProgress.has(book.id);
      const preserveReadDate = preserveProgress || unknownReadDate.has(book.id);
      return {
        ...withoutRemoteProgressMarkers(previous),
        ...book,
        serverId,
        remoteAvailable: true,
        downloadPath: previous.downloadPath,
        downloadStatus: previous.downloadStatus,
        fileSize: previous.fileSize,
        pagesRead: preserveProgress ? previous.pagesRead : book.pagesRead,
        lastReadAt: preserveReadDate ? previous.lastReadAt : book.lastReadAt,
      };
    });
    state.books = [
      ...state.books.filter((book) => book.serverId !== serverId),
      ...merged,
      ...retained,
    ];
    writeBrowserState(state);
    return;
  }
  await reconcileBooksInTransaction(
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
   pages, pages_read, created_at, last_read_at, remote_available)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
   library_id=excluded.library_id, series_id=excluded.series_id,
   volume_id=excluded.volume_id, chapter_id=excluded.chapter_id,
   title=excluded.title, author=excluded.author, series=excluded.series,
   description_html=excluded.description_html, format=excluded.format,
   metadata_refreshed_at=excluded.metadata_refreshed_at, pages=excluded.pages,
   pages_read=CASE WHEN ?=0 OR ${preserveReadingProgress} THEN books.pages_read ELSE excluded.pages_read END,
   created_at=excluded.created_at,
   last_read_at=CASE WHEN ?=0 OR ?=0 OR ${preserveReadingProgress} THEN books.last_read_at ELSE excluded.last_read_at END,
   remote_available=excluded.remote_available`;

function replaceBookTask(
  serverId: string,
  book: BookRecord,
  refreshedAt: string,
  snapshotStartedAt: string | null = null,
): capTask {
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
  OR EXISTS (SELECT 1 FROM annotations WHERE annotations.book_id=books.id AND annotations.sync_state!='pending_delete')
  OR EXISTS (SELECT 1 FROM bookmarks WHERE bookmarks.book_id=books.id AND bookmarks.sync_state!='pending_delete'))`;

/** Apply metadata and optional removal reconciliation atomically on native SQLite. */
export async function reconcileBooksInTransaction(
  db: Pick<SQLiteDBConnection, 'executeTransaction'>,
  serverId: string,
  books: BookRecord[],
  refreshedAt = new Date().toISOString(),
  preserveMissing = false,
  snapshotStartedAt: string | null = null,
): Promise<void> {
  const tasks: capTask[] = [];
  if (!preserveMissing) {
    tasks.push({
      statement: 'UPDATE books SET remote_available=0 WHERE server_id=? AND remote_available=1',
      values: [serverId],
    });
  }
  for (const book of books) {
    tasks.push(
      replaceBookTask(serverId, { ...book, remoteAvailable: true }, refreshedAt, snapshotStartedAt),
    );
  }
  if (!preserveMissing) {
    tasks.push({
      statement: `DELETE FROM books WHERE server_id=? AND remote_available=0
        AND NOT ${retainedBookCondition}`,
      values: [serverId],
    });
  }
  if (!tasks.length) return;
  await executeNativeTransaction(db, tasks);
}

export async function getBooks(
  serverId: string,
  { includeDescription = true } = {},
): Promise<BookRecord[]> {
  if (!Capacitor.isNativePlatform()) {
    const books = readBrowserState().books.filter((book) => book.serverId === serverId);
    return includeDescription ? books : books.map((book) => ({ ...book, descriptionHtml: null }));
  }
  const db = await openDatabase();
  const result = await db.query(
    `SELECT id, server_id, library_id, series_id, volume_id, chapter_id, title, author, series,
      format, pages, pages_read, created_at, last_read_at, download_path, download_status,
      file_size, remote_available${includeDescription ? ', description_html' : ''}
      FROM books WHERE server_id = ? ORDER BY title`,
    [serverId],
  );
  return (result.values ?? []).map((row) => ({
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
    pages: Number(row.pages ?? 0),
    pagesRead: Number(row.pages_read ?? 0),
    createdAt: String(row.created_at ?? ''),
    lastReadAt: row.last_read_at ? String(row.last_read_at) : null,
    downloadPath: row.download_path ? String(row.download_path) : null,
    downloadStatus: String(row.download_status),
    fileSize: row.file_size == null ? null : Number(row.file_size),
    remoteAvailable: Number(row.remote_available ?? 1) !== 0,
  }));
}

export async function markDownloaded(bookId: string, path: string, size: number): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    state.books = state.books.map((book) =>
      book.id === bookId
        ? { ...book, downloadPath: path, downloadStatus: 'available', fileSize: size }
        : book,
    );
    writeBrowserState(state);
    return;
  }
  const db = await openDatabase();
  await executeNativeRun(
    db,
    "UPDATE books SET download_path=?, download_status='available', file_size=? WHERE id=?",
    [path, size, bookId],
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
  const pagesRead = toKavitaPageNumber(percentage, book.pages, spineIndex);
  const now = new Date().toISOString();
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
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
          libraryId: book.libraryId,
          seriesId: book.seriesId,
          volumeId: book.volumeId,
          chapterId: book.chapterId,
          pageNum: pagesRead,
          bookScrollId: xpath,
        }),
        serverId: book.serverId,
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
  const payload = {
    libraryId: book.libraryId,
    seriesId: book.seriesId,
    volumeId: book.volumeId,
    chapterId: book.chapterId,
    pageNum: pagesRead,
    bookScrollId: xpath,
  };
  await executeNativeTransaction(db, [
    createReadingStateTask(book.id, cfi, xpath, percentage, now),
    createSyncQueueTask(book.id, payload, now),
    {
      statement: 'UPDATE books SET pages_read=?, last_read_at=? WHERE id=?',
      values: [pagesRead, now, book.id],
    },
  ]);
}

export async function markBookCompleted(book: BookRecord): Promise<void> {
  const now = new Date().toISOString();
  const payload: PendingProgressPayload = {
    libraryId: book.libraryId,
    seriesId: book.seriesId,
    volumeId: book.volumeId,
    chapterId: book.chapterId,
    pageNum: book.pages,
    bookScrollId: null,
  };
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      const syncRevision =
        Math.max(
          Number(state.readingState[book.id]?.syncRevision ?? 0),
          Number(state.syncQueue[book.id]?.revision ?? 0),
        ) + 1;
      state.books = state.books.map((item) =>
        item.id === book.id
          ? {
              ...item,
              pagesRead: book.pages,
              lastReadAt: now,
            }
          : item,
      );
      state.readingState[book.id] = {
        cfi: '',
        xpath: null,
        percentage: 1,
        localUpdatedAt: now,
        syncedLocalUpdatedAt: state.readingState[book.id]?.syncedLocalUpdatedAt ?? null,
        serverUpdatedAt: state.readingState[book.id]?.serverUpdatedAt ?? null,
        pendingSync: true,
        syncRevision,
      };
      state.syncQueue[book.id] = {
        bookId: book.id,
        payloadJson: JSON.stringify(payload),
        serverId: book.serverId,
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
  const tasks: capTask[] = [
    {
      statement: 'UPDATE books SET pages_read=?, last_read_at=? WHERE id=?',
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

type BookProgressRouting = Pick<BookRecord, 'libraryId' | 'seriesId' | 'volumeId' | 'chapterId'>;

function updatePendingProgressRouting(payloadJson: string, book: BookProgressRouting): string {
  try {
    const payload: unknown = JSON.parse(payloadJson);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payloadJson;
    return JSON.stringify({
      ...(payload as Record<string, unknown>),
      libraryId: book.libraryId,
      seriesId: book.seriesId,
      volumeId: book.volumeId,
      chapterId: book.chapterId,
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
    const activeBookIds = new Set(
      state.books
        .filter((book) => book.serverId === serverId && book.remoteAvailable !== false)
        .map((book) => book.id),
    );
    const entries: Array<{ updatedAt: string; lastError: string | null }> = [
      ...getBrowserSyncRows(state, serverId).map(({ row }) => ({
        updatedAt: row.updatedAt,
        lastError: row.lastError,
      })),
    ];
    for (const bookId of activeBookIds) {
      for (const item of state.annotations[bookId] ?? []) {
        if (item.syncState !== 'synced') {
          entries.push({ updatedAt: item.updatedAt, lastError: item.lastError });
        }
      }
      for (const item of state.bookmarks[bookId] ?? []) {
        if (item.syncState !== 'synced') {
          entries.push({ updatedAt: item.updatedAt, lastError: item.lastError });
        }
      }
    }
    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      pendingCount: entries.length,
      failedCount: entries.filter((row) => Boolean(row.lastError)).length,
      lastError: entries.find((row) => row.lastError)?.lastError ?? null,
      lastUpdatedAt: entries[0]?.updatedAt ?? null,
    };
  }
  const db = await openDatabase();
  const result = await db.query(
    `SELECT updated_at, last_error FROM (
      SELECT sync_queue.updated_at AS updated_at, sync_queue.last_error AS last_error
        FROM sync_queue CROSS JOIN books ON books.id=sync_queue.book_id
        WHERE books.server_id=? AND books.remote_available=1
      UNION ALL
      SELECT annotations.updated_at AS updated_at, annotations.last_error AS last_error
        FROM annotations CROSS JOIN books ON books.id=annotations.book_id
        WHERE books.server_id=? AND books.remote_available=1 AND annotations.sync_state!='synced'
      UNION ALL
      SELECT bookmarks.updated_at AS updated_at, bookmarks.last_error AS last_error
        FROM bookmarks CROSS JOIN books ON books.id=bookmarks.book_id
        WHERE books.server_id=? AND books.remote_available=1 AND bookmarks.sync_state!='synced'
    ) ORDER BY updated_at DESC`,
    [serverId, serverId, serverId],
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
    const state = readBrowserState();
    state.books = state.books.map((book) =>
      book.id === bookId
        ? { ...book, downloadPath: null, downloadStatus: 'none', fileSize: null }
        : book,
    );
    writeBrowserState(state);
    return;
  }
  const db = await openDatabase();
  await executeNativeRun(
    db,
    "UPDATE books SET download_path=NULL,download_status='none',file_size=NULL WHERE id=?",
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

function createStudyId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function mapAnnotationRow(row: Record<string, unknown>): StoredAnnotationRecord {
  const syncState = String(row.sync_state ?? 'synced');
  return {
    id: String(row.id),
    bookId: String(row.book_id),
    remoteId: row.remote_id == null ? null : Number(row.remote_id),
    cfi: String(row.cfi ?? ''),
    xpath: String(row.xpath ?? ''),
    endingXPath: row.ending_xpath == null ? null : String(row.ending_xpath),
    pageNumber: Number(row.page_number ?? 0),
    slotIndex: Number(row.slot_index ?? 0),
    containsSpoiler: Number(row.contains_spoiler ?? 0) !== 0,
    context: row.context == null ? null : String(row.context),
    chapterTitle: row.chapter_title == null ? null : String(row.chapter_title),
    excerpt: String(row.excerpt ?? ''),
    note: String(row.note ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    remoteUpdatedAt: row.remote_updated_at == null ? null : String(row.remote_updated_at),
    syncState:
      syncState === 'pending_create' ||
      syncState === 'pending_update' ||
      syncState === 'pending_delete'
        ? syncState
        : 'synced',
    syncRevision: Number(row.sync_revision ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
    lastAttemptAt: row.last_attempt_at == null ? null : String(row.last_attempt_at),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

function mapBookmarkRow(row: Record<string, unknown>): StoredBookmarkRecord {
  const syncState = String(row.sync_state ?? 'synced');
  return {
    id: String(row.id),
    bookId: String(row.book_id),
    remoteId: row.remote_id == null ? null : Number(row.remote_id),
    cfi: String(row.cfi ?? ''),
    xpath: row.xpath == null ? null : String(row.xpath),
    href: String(row.href ?? ''),
    percentage: Number(row.percentage ?? 0),
    pageNumber: Number(row.page_number ?? 0),
    label: String(row.label ?? 'Bookmark'),
    excerpt: String(row.excerpt ?? ''),
    remoteTitle: row.remote_title == null ? null : String(row.remote_title),
    remotePageNumber: row.remote_page_number == null ? null : Number(row.remote_page_number),
    savedAt: String(row.saved_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    syncState:
      syncState === 'pending_create' ||
      syncState === 'pending_update' ||
      syncState === 'pending_delete'
        ? syncState
        : 'synced',
    syncRevision: Number(row.sync_revision ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
    lastAttemptAt: row.last_attempt_at == null ? null : String(row.last_attempt_at),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

function insertAnnotationRecordTask(record: StoredAnnotationRecord, orIgnore = false): capTask {
  return {
    statement: `INSERT ${orIgnore ? 'OR IGNORE' : 'OR REPLACE'} INTO annotations
      (id, book_id, remote_id, cfi, xpath, ending_xpath, page_number, slot_index,
       contains_spoiler, context, chapter_title, excerpt, note, created_at, updated_at,
       remote_updated_at, sync_state, sync_revision, attempt_count, last_attempt_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: [
      record.id,
      record.bookId,
      record.remoteId,
      record.cfi,
      record.xpath,
      record.endingXPath,
      record.pageNumber,
      record.slotIndex,
      record.containsSpoiler ? 1 : 0,
      record.context,
      record.chapterTitle,
      record.excerpt,
      record.note,
      record.createdAt,
      record.updatedAt,
      record.remoteUpdatedAt,
      record.syncState,
      record.syncRevision,
      record.attemptCount,
      record.lastAttemptAt,
      record.lastError,
    ],
  };
}

function insertBookmarkRecordTask(record: StoredBookmarkRecord, orIgnore = false): capTask {
  return {
    statement: `INSERT ${orIgnore ? 'OR IGNORE' : 'OR REPLACE'} INTO bookmarks
      (id, book_id, remote_id, cfi, xpath, href, percentage, page_number, label, excerpt,
       remote_title, remote_page_number, saved_at, updated_at, sync_state, sync_revision,
       attempt_count, last_attempt_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: [
      record.id,
      record.bookId,
      record.remoteId,
      record.cfi,
      record.xpath,
      record.href,
      record.percentage,
      record.pageNumber,
      record.label,
      record.excerpt,
      record.remoteTitle,
      record.remotePageNumber,
      record.savedAt,
      record.updatedAt,
      record.syncState,
      record.syncRevision,
      record.attemptCount,
      record.lastAttemptAt,
      record.lastError,
    ],
  };
}

export interface BookAnnotationsGroup {
  book: BookRecord;
  annotations: StoredAnnotation[];
}

export interface SaveAnnotationInput {
  cfi: string;
  excerpt: string;
  note: string;
  xpath?: string | null | undefined;
  endingXPath?: string | null | undefined;
  pageNumber?: number | undefined;
  context?: string | null | undefined;
  chapterTitle?: string | null | undefined;
  slotIndex?: number | undefined;
  containsSpoiler?: boolean | undefined;
}

export interface SaveBookmarkInput {
  cfi: string;
  href: string;
  percentage: number;
  label: string;
  xpath?: string | null | undefined;
  pageNumber?: number | undefined;
  excerpt?: string | undefined;
}

export interface PendingAnnotationSyncItem {
  id: string;
  bookId: string;
  libraryId: number;
  seriesId: number;
  volumeId: number;
  chapterId: number;
  remoteId: number | null;
  xpath: string;
  endingXPath: string | null;
  pageNumber: number;
  slotIndex: number;
  containsSpoiler: boolean;
  context: string | null;
  chapterTitle: string | null;
  excerpt: string;
  note: string;
  syncState: Exclude<StudySyncState, 'synced'>;
  syncRevision: number;
  updatedAt: string;
}

export interface PendingBookmarkSyncItem {
  id: string;
  bookId: string;
  libraryId: number;
  seriesId: number;
  volumeId: number;
  chapterId: number;
  remoteId: number | null;
  xpath: string | null;
  pageNumber: number;
  label: string;
  excerpt: string;
  remoteTitle: string | null;
  remotePageNumber: number | null;
  syncState: Exclude<StudySyncState, 'synced'>;
  syncRevision: number;
  updatedAt: string;
}

export async function getBookAnnotations(bookId: string): Promise<StoredAnnotation[]> {
  if (!Capacitor.isNativePlatform()) {
    const records = readBrowserState().annotations[bookId] ?? [];
    return records
      .filter((record) => record.syncState !== 'pending_delete')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(toStoredAnnotation);
  }
  const db = await openDatabase();
  const result = await db.query(
    `SELECT * FROM annotations
     WHERE book_id=? AND sync_state!='pending_delete'
     ORDER BY created_at ASC, id ASC`,
    [bookId],
  );
  return (result.values ?? []).map((row) =>
    toStoredAnnotation(mapAnnotationRow(row as Record<string, unknown>)),
  );
}

export async function getServerAnnotations(serverId: string): Promise<BookAnnotationsGroup[]> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    const books = state.books
      .filter((book) => book.serverId === serverId)
      .sort((a, b) => a.title.localeCompare(b.title));
    const groups: BookAnnotationsGroup[] = [];
    for (const book of books) {
      const annotations = (state.annotations[book.id] ?? [])
        .filter((record) => record.syncState !== 'pending_delete')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map(toStoredAnnotation);
      if (annotations.length > 0) {
        groups.push({ book: { ...book, descriptionHtml: null }, annotations });
      }
    }
    return groups;
  }
  const db = await openDatabase();
  const [books, rowsResult] = await Promise.all([
    getBooks(serverId, { includeDescription: false }),
    db.query(
      `SELECT annotations.* FROM annotations
       CROSS JOIN books ON books.id = annotations.book_id
       WHERE books.server_id = ? AND annotations.sync_state != 'pending_delete'
       ORDER BY annotations.created_at ASC, annotations.id ASC`,
      [serverId],
    ),
  ]);
  const byBook = new Map<string, StoredAnnotation[]>();
  for (const raw of rowsResult.values ?? []) {
    const record = mapAnnotationRow(raw as Record<string, unknown>);
    const list = byBook.get(record.bookId) ?? [];
    list.push(toStoredAnnotation(record));
    byBook.set(record.bookId, list);
  }
  return books.flatMap((book) => {
    const annotations = byBook.get(book.id);
    return annotations && annotations.length > 0 ? [{ book, annotations }] : [];
  });
}

export async function getBookAnnotationCounts(serverId: string): Promise<Map<string, number>> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    const counts = new Map<string, number>();
    for (const book of state.books) {
      if (book.serverId !== serverId) continue;
      const count = (state.annotations[book.id] ?? []).filter(
        (item) => item.syncState !== 'pending_delete',
      ).length;
      if (count > 0) counts.set(book.id, count);
    }
    return counts;
  }
  const db = await openDatabase();
  const result = await db.query(
    `SELECT annotations.book_id AS book_id, COUNT(*) AS total
     FROM annotations CROSS JOIN books ON books.id = annotations.book_id
     WHERE books.server_id = ? AND annotations.sync_state != 'pending_delete'
     GROUP BY annotations.book_id`,
    [serverId],
  );
  return new Map((result.values ?? []).map((row) => [String(row.book_id), Number(row.total ?? 0)]));
}

export async function saveBookAnnotation(
  bookId: string,
  input: SaveAnnotationInput,
): Promise<StoredAnnotation | null> {
  const excerpt = input.excerpt.trim().slice(0, 500);
  if (!excerpt) return null;
  const now = new Date().toISOString();
  const fallback = cfiFallbackLocator(input.cfi);
  const xpath = input.xpath?.trim() || fallback.xpath;
  const endingXPath = input.endingXPath?.trim() || xpath;
  const pageNumber =
    typeof input.pageNumber === 'number' &&
    Number.isFinite(input.pageNumber) &&
    input.pageNumber >= 0
      ? Math.floor(input.pageNumber)
      : fallback.pageNumber;
  const record: StoredAnnotationRecord = {
    id: createStudyId(),
    bookId,
    remoteId: null,
    cfi: input.cfi,
    xpath,
    endingXPath,
    pageNumber,
    slotIndex:
      typeof input.slotIndex === 'number' && Number.isFinite(input.slotIndex)
        ? Math.max(0, Math.floor(input.slotIndex))
        : 0,
    containsSpoiler: Boolean(input.containsSpoiler),
    context: input.context?.trim().slice(0, 500) || excerpt,
    chapterTitle: input.chapterTitle?.trim().slice(0, 240) || null,
    excerpt,
    note: input.note.trim().slice(0, 2000),
    createdAt: now,
    updatedAt: now,
    remoteUpdatedAt: null,
    syncState: 'pending_create',
    syncRevision: 1,
    attemptCount: 0,
    lastAttemptAt: null,
    lastError: null,
  };

  if (!Capacitor.isNativePlatform()) {
    let savedRecord: StoredAnnotationRecord | null = null;
    const trimmedCfi = input.cfi.trim();
    const saved = updateBrowserState((state) => {
      if (!state.books.some((book) => book.id === bookId)) return false;
      const list = state.annotations[bookId] ?? [];
      const existingIndex = trimmedCfi
        ? list.findIndex(
            (item) => item.syncState !== 'pending_delete' && item.cfi.trim() === trimmedCfi,
          )
        : -1;
      if (existingIndex >= 0) {
        const current = list[existingIndex]!;
        const updated: StoredAnnotationRecord = {
          ...current,
          xpath: input.xpath?.trim() || current.xpath,
          endingXPath: input.endingXPath?.trim() || current.endingXPath,
          pageNumber: input.pageNumber !== undefined ? pageNumber : current.pageNumber,
          context: input.context?.trim().slice(0, 500) || current.context,
          chapterTitle: input.chapterTitle?.trim().slice(0, 240) || current.chapterTitle,
          note: record.note,
          updatedAt: now,
          syncState:
            current.remoteId !== null && current.syncState !== 'pending_create'
              ? 'pending_update'
              : 'pending_create',
          syncRevision: current.syncRevision + 1,
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
        };
        list[existingIndex] = updated;
        savedRecord = updated;
        return;
      }
      list.push(record);
      state.annotations[bookId] = list;
      savedRecord = record;
    });
    return saved && savedRecord ? toStoredAnnotation(savedRecord) : null;
  }
  const db = await openDatabase();
  return enqueueNativeWrite(async () => {
    const trimmedCfi = input.cfi.trim();
    if (trimmedCfi) {
      const existingRow = (
        await db.query(
          "SELECT * FROM annotations WHERE book_id=? AND cfi=? AND sync_state!='pending_delete' LIMIT 1",
          [bookId, trimmedCfi],
        )
      ).values?.[0];
      if (existingRow) {
        const current = mapAnnotationRow(existingRow as Record<string, unknown>);
        const nextState: StudySyncState =
          current.remoteId !== null && current.syncState !== 'pending_create'
            ? 'pending_update'
            : 'pending_create';
        const nextRevision = current.syncRevision + 1;
        const nextXpath = input.xpath?.trim() || current.xpath;
        const nextEndingXPath = input.endingXPath?.trim() || current.endingXPath;
        const nextPageNumber = input.pageNumber !== undefined ? pageNumber : current.pageNumber;
        const nextContext = input.context?.trim().slice(0, 500) || current.context;
        const nextChapterTitle = input.chapterTitle?.trim().slice(0, 240) || current.chapterTitle;
        await db.run(
          `UPDATE annotations SET xpath=?, ending_xpath=?, page_number=?, context=?,
           chapter_title=?, note=?, updated_at=?, sync_state=?, sync_revision=?,
           attempt_count=0, last_attempt_at=NULL, last_error=NULL
           WHERE id=? AND book_id=?`,
          [
            nextXpath,
            nextEndingXPath,
            nextPageNumber,
            nextContext,
            nextChapterTitle,
            record.note,
            now,
            nextState,
            nextRevision,
            current.id,
            bookId,
          ],
        );
        return toStoredAnnotation({
          ...current,
          xpath: nextXpath,
          endingXPath: nextEndingXPath,
          pageNumber: nextPageNumber,
          context: nextContext,
          chapterTitle: nextChapterTitle,
          note: record.note,
          updatedAt: now,
          syncState: nextState,
          syncRevision: nextRevision,
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
        });
      }
    }
    const task = insertAnnotationRecordTask(record);
    await db.run(task.statement, task.values);
    return toStoredAnnotation(record);
  });
}

export async function updateBookAnnotationNote(
  bookId: string,
  annotationId: string,
  note: string,
): Promise<StoredAnnotation | null> {
  const cleaned = note.trim().slice(0, 2000);
  const now = new Date().toISOString();
  if (!Capacitor.isNativePlatform()) {
    let updated: StoredAnnotationRecord | null = null;
    updateBrowserState((state) => {
      const list = state.annotations[bookId];
      if (!list) return false;
      const index = list.findIndex(
        (item) => item.id === annotationId && item.syncState !== 'pending_delete',
      );
      if (index < 0) return false;
      const current = list[index]!;
      const next: StoredAnnotationRecord = {
        ...current,
        note: cleaned,
        updatedAt: now,
        syncState:
          current.remoteId !== null && current.syncState !== 'pending_create'
            ? 'pending_update'
            : 'pending_create',
        syncRevision: current.syncRevision + 1,
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
      };
      list[index] = next;
      updated = next;
    });
    return updated ? toStoredAnnotation(updated) : null;
  }
  const db = await openDatabase();
  return enqueueNativeWrite(async () => {
    const existing = (
      await db.query(
        "SELECT * FROM annotations WHERE id=? AND book_id=? AND sync_state!='pending_delete'",
        [annotationId, bookId],
      )
    ).values?.[0];
    if (!existing) return null;
    const current = mapAnnotationRow(existing as Record<string, unknown>);
    const nextState: StudySyncState =
      current.remoteId !== null && current.syncState !== 'pending_create'
        ? 'pending_update'
        : 'pending_create';
    const nextRevision = current.syncRevision + 1;
    await db.run(
      `UPDATE annotations SET note=?, updated_at=?, sync_state=?, sync_revision=?,
       attempt_count=0, last_attempt_at=NULL, last_error=NULL
       WHERE id=? AND book_id=?`,
      [cleaned, now, nextState, nextRevision, annotationId, bookId],
    );
    return toStoredAnnotation({
      ...current,
      note: cleaned,
      updatedAt: now,
      syncState: nextState,
      syncRevision: nextRevision,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
    });
  });
}

export async function deleteBookAnnotation(bookId: string, annotationId: string): Promise<void> {
  const now = new Date().toISOString();
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      const list = state.annotations[bookId];
      if (!list) return false;
      const index = list.findIndex((item) => item.id === annotationId);
      if (index < 0) return false;
      const current = list[index]!;
      if (current.remoteId === null) {
        list.splice(index, 1);
        if (list.length === 0) delete state.annotations[bookId];
      } else {
        list[index] = {
          ...current,
          updatedAt: now,
          syncState: 'pending_delete',
          syncRevision: current.syncRevision + 1,
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
        };
      }
    });
    return;
  }
  const db = await openDatabase();
  await executeNativeTransaction(db, [
    {
      statement: 'DELETE FROM annotations WHERE id=? AND book_id=? AND remote_id IS NULL',
      values: [annotationId, bookId],
    },
    {
      statement: `UPDATE annotations SET updated_at=?, sync_state='pending_delete',
        sync_revision=sync_revision+1, attempt_count=0, last_attempt_at=NULL, last_error=NULL
        WHERE id=? AND book_id=? AND remote_id IS NOT NULL`,
      values: [now, annotationId, bookId],
    },
  ]);
}

export async function saveResolvedBookAnnotations(
  bookId: string,
  resolved: ReadonlyArray<{ id: string; cfi: string }>,
): Promise<void> {
  const valid = resolved.filter((item) => item.cfi.trim());
  if (valid.length === 0) return;
  if (!Capacitor.isNativePlatform()) {
    const byId = new Map(valid.map((item) => [item.id, item.cfi]));
    updateBrowserState((state) => {
      const list = state.annotations[bookId];
      if (!list) return false;
      let changed = false;
      for (const item of list) {
        const cfi = byId.get(item.id);
        if (cfi && item.cfi !== cfi) {
          item.cfi = cfi;
          changed = true;
        }
      }
      return changed;
    });
    return;
  }
  const db = await openDatabase();
  await executeNativeTransaction(
    db,
    valid.map((item) => ({
      statement: 'UPDATE annotations SET cfi=? WHERE id=? AND book_id=?',
      values: [item.cfi, item.id, bookId],
    })),
  );
}

export async function reconcileBookAnnotations(
  bookId: string,
  remote: readonly KavitaAnnotation[],
): Promise<StoredAnnotation[]> {
  const now = new Date().toISOString();
  if (!Capacitor.isNativePlatform()) {
    let visible: StoredAnnotation[] = [];
    updateBrowserState((state) => {
      if (!state.books.some((book) => book.id === bookId)) return false;
      const next = reconcileAnnotationRecords(bookId, state.annotations[bookId] ?? [], remote, now);
      if (next.length > 0) state.annotations[bookId] = next;
      else delete state.annotations[bookId];
      visible = next
        .filter((record) => record.syncState !== 'pending_delete')
        .map(toStoredAnnotation);
    });
    return visible;
  }
  const db = await openDatabase();
  return enqueueNativeWrite(async () => {
    const bookRow = (await db.query('SELECT 1 FROM books WHERE id=?', [bookId])).values?.[0];
    if (!bookRow) return [];
    const currentRows =
      (
        await db.query(
          'SELECT * FROM annotations WHERE book_id=? ORDER BY created_at ASC, id ASC',
          [bookId],
        )
      ).values ?? [];
    const current = currentRows.map((row) => mapAnnotationRow(row as Record<string, unknown>));
    const next = reconcileAnnotationRecords(bookId, current, remote, now);
    await db.executeTransaction([
      { statement: 'DELETE FROM annotations WHERE book_id=?', values: [bookId] },
      ...next.map((record) => insertAnnotationRecordTask(record)),
    ]);
    return next.filter((record) => record.syncState !== 'pending_delete').map(toStoredAnnotation);
  });
}

export async function reconcileSeriesAnnotations(
  serverId: string,
  seriesId: number,
  remote: readonly KavitaAnnotation[],
): Promise<void> {
  const byChapter = new Map<number, KavitaAnnotation[]>();
  for (const item of remote) {
    const list = byChapter.get(item.chapterId) ?? [];
    list.push(item);
    byChapter.set(item.chapterId, list);
  }
  const now = new Date().toISOString();

  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      const seriesBooks = state.books.filter(
        (book) =>
          book.serverId === serverId &&
          book.seriesId === seriesId &&
          book.remoteAvailable !== false,
      );
      if (seriesBooks.length === 0) return false;
      for (const book of seriesBooks) {
        const next = reconcileAnnotationRecords(
          book.id,
          state.annotations[book.id] ?? [],
          byChapter.get(book.chapterId) ?? [],
          now,
        );
        if (next.length > 0) state.annotations[book.id] = next;
        else delete state.annotations[book.id];
      }
    });
    return;
  }

  const db = await openDatabase();
  await enqueueNativeWrite(async () => {
    const booksResult = await db.query(
      'SELECT id, chapter_id FROM books WHERE server_id=? AND series_id=? AND remote_available=1',
      [serverId, seriesId],
    );
    const seriesBooks = (booksResult.values ?? []).map((row) => ({
      id: String(row.id),
      chapterId: Number(row.chapter_id),
    }));
    if (seriesBooks.length === 0) return;
    const placeholders = seriesBooks.map(() => '?').join(', ');
    const currentResult = await db.query(
      `SELECT * FROM annotations WHERE book_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
      seriesBooks.map((book) => book.id),
    );
    const currentByBook = new Map<string, StoredAnnotationRecord[]>();
    for (const raw of currentResult.values ?? []) {
      const record = mapAnnotationRow(raw as Record<string, unknown>);
      const list = currentByBook.get(record.bookId) ?? [];
      list.push(record);
      currentByBook.set(record.bookId, list);
    }
    const tasks: capTask[] = [];
    for (const book of seriesBooks) {
      tasks.push({ statement: 'DELETE FROM annotations WHERE book_id=?', values: [book.id] });
      const next = reconcileAnnotationRecords(
        book.id,
        currentByBook.get(book.id) ?? [],
        byChapter.get(book.chapterId) ?? [],
        now,
      );
      for (const record of next) {
        tasks.push(insertAnnotationRecordTask(record));
      }
    }
    if (tasks.length > 0) await db.executeTransaction(tasks);
  });
}

export async function getBookBookmarks(bookId: string): Promise<StoredReaderLocation[]> {
  if (!Capacitor.isNativePlatform()) {
    const records = readBrowserState().bookmarks[bookId] ?? [];
    return records
      .filter((record) => record.syncState !== 'pending_delete')
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id))
      .map(toStoredBookmark);
  }
  const db = await openDatabase();
  const result = await db.query(
    `SELECT * FROM bookmarks
     WHERE book_id=? AND sync_state!='pending_delete'
     ORDER BY saved_at DESC, id ASC`,
    [bookId],
  );
  return (result.values ?? []).map((row) =>
    toStoredBookmark(mapBookmarkRow(row as Record<string, unknown>)),
  );
}

export async function getBookBookmarkCounts(serverId: string): Promise<Map<string, number>> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    const counts = new Map<string, number>();
    for (const book of state.books) {
      if (book.serverId !== serverId) continue;
      const count = (state.bookmarks[book.id] ?? []).filter(
        (item) => item.syncState !== 'pending_delete',
      ).length;
      if (count > 0) counts.set(book.id, count);
    }
    return counts;
  }
  const db = await openDatabase();
  const result = await db.query(
    `SELECT bookmarks.book_id AS book_id, COUNT(*) AS total
     FROM bookmarks CROSS JOIN books ON books.id = bookmarks.book_id
     WHERE books.server_id = ? AND bookmarks.sync_state != 'pending_delete'
     GROUP BY bookmarks.book_id`,
    [serverId],
  );
  return new Map((result.values ?? []).map((row) => [String(row.book_id), Number(row.total ?? 0)]));
}

export async function saveBookBookmark(
  bookId: string,
  input: SaveBookmarkInput,
): Promise<StoredReaderLocation | null> {
  const now = new Date().toISOString();
  const fallback = cfiFallbackLocator(input.cfi);
  const xpath = input.xpath?.trim() || fallback.xpath;
  const pageNumber =
    typeof input.pageNumber === 'number' &&
    Number.isFinite(input.pageNumber) &&
    input.pageNumber >= 0
      ? Math.floor(input.pageNumber)
      : fallback.pageNumber;

  if (!Capacitor.isNativePlatform()) {
    let created: StoredBookmarkRecord | null = null;
    updateBrowserState((state) => {
      if (!state.books.some((book) => book.id === bookId)) return false;
      const existing = state.bookmarks[bookId] ?? [];
      const label = disambiguateBookmarkLabel(existing, pageNumber, input.label);
      const record: StoredBookmarkRecord = {
        id: createStudyId(),
        bookId,
        remoteId: null,
        cfi: input.cfi,
        xpath,
        href: input.href,
        percentage: Math.max(0, Math.min(1, input.percentage)),
        pageNumber,
        label,
        excerpt: input.excerpt?.trim().slice(0, 500) ?? '',
        remoteTitle: null,
        remotePageNumber: null,
        savedAt: now,
        updatedAt: now,
        syncState: 'pending_create',
        syncRevision: 1,
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
      };
      state.bookmarks[bookId] = [record, ...existing];
      created = record;
    });
    return created ? toStoredBookmark(created) : null;
  }

  const db = await openDatabase();
  return enqueueNativeWrite(async () => {
    const existingRows =
      (await db.query('SELECT * FROM bookmarks WHERE book_id=?', [bookId])).values ?? [];
    const existing = existingRows.map((row) => mapBookmarkRow(row as Record<string, unknown>));
    const label = disambiguateBookmarkLabel(existing, pageNumber, input.label);
    const record: StoredBookmarkRecord = {
      id: createStudyId(),
      bookId,
      remoteId: null,
      cfi: input.cfi,
      xpath,
      href: input.href,
      percentage: Math.max(0, Math.min(1, input.percentage)),
      pageNumber,
      label,
      excerpt: input.excerpt?.trim().slice(0, 500) ?? '',
      remoteTitle: null,
      remotePageNumber: null,
      savedAt: now,
      updatedAt: now,
      syncState: 'pending_create',
      syncRevision: 1,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
    };
    const task = insertBookmarkRecordTask(record);
    await db.run(task.statement, task.values);
    return toStoredBookmark(record);
  });
}

export async function renameBookBookmark(
  bookId: string,
  bookmarkId: string,
  desiredLabel: string,
): Promise<StoredReaderLocation | null> {
  const now = new Date().toISOString();
  if (!Capacitor.isNativePlatform()) {
    let result: StoredBookmarkRecord | null = null;
    updateBrowserState((state) => {
      const list = state.bookmarks[bookId];
      if (!list) return false;
      const index = list.findIndex(
        (item) => item.id === bookmarkId && item.syncState !== 'pending_delete',
      );
      if (index < 0) return false;
      const current = list[index]!;
      const label = disambiguateBookmarkLabel(list, current.pageNumber, desiredLabel, bookmarkId);
      if (label === current.label) {
        result = current;
        return false;
      }
      const next: StoredBookmarkRecord = {
        ...current,
        label,
        updatedAt: now,
        syncState:
          (current.remoteTitle !== null || current.remoteId !== null) &&
          current.syncState !== 'pending_create'
            ? 'pending_update'
            : 'pending_create',
        syncRevision: current.syncRevision + 1,
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
      };
      list[index] = next;
      result = next;
    });
    return result ? toStoredBookmark(result) : null;
  }

  const db = await openDatabase();
  return enqueueNativeWrite(async () => {
    const rows = (await db.query('SELECT * FROM bookmarks WHERE book_id=?', [bookId])).values ?? [];
    const list = rows.map((row) => mapBookmarkRow(row as Record<string, unknown>));
    const current = list.find(
      (item) => item.id === bookmarkId && item.syncState !== 'pending_delete',
    );
    if (!current) return null;
    const label = disambiguateBookmarkLabel(list, current.pageNumber, desiredLabel, bookmarkId);
    if (label === current.label) return toStoredBookmark(current);
    const nextState: StudySyncState =
      (current.remoteTitle !== null || current.remoteId !== null) &&
      current.syncState !== 'pending_create'
        ? 'pending_update'
        : 'pending_create';
    const nextRevision = current.syncRevision + 1;
    await db.run(
      `UPDATE bookmarks SET label=?, updated_at=?, sync_state=?, sync_revision=?,
       attempt_count=0, last_attempt_at=NULL, last_error=NULL
       WHERE id=? AND book_id=?`,
      [label, now, nextState, nextRevision, bookmarkId, bookId],
    );
    return toStoredBookmark({
      ...current,
      label,
      updatedAt: now,
      syncState: nextState,
      syncRevision: nextRevision,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
    });
  });
}

export async function deleteBookBookmark(bookId: string, bookmarkId: string): Promise<void> {
  const now = new Date().toISOString();
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      const list = state.bookmarks[bookId];
      if (!list) return false;
      const index = list.findIndex((item) => item.id === bookmarkId);
      if (index < 0) return false;
      const current = list[index]!;
      if (current.remoteTitle === null && current.remoteId === null) {
        list.splice(index, 1);
        if (list.length === 0) delete state.bookmarks[bookId];
      } else {
        list[index] = {
          ...current,
          updatedAt: now,
          syncState: 'pending_delete',
          syncRevision: current.syncRevision + 1,
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
        };
      }
    });
    return;
  }
  const db = await openDatabase();
  await executeNativeTransaction(db, [
    {
      statement:
        'DELETE FROM bookmarks WHERE id=? AND book_id=? AND remote_title IS NULL AND remote_id IS NULL',
      values: [bookmarkId, bookId],
    },
    {
      statement: `UPDATE bookmarks SET updated_at=?, sync_state='pending_delete',
        sync_revision=sync_revision+1, attempt_count=0, last_attempt_at=NULL, last_error=NULL
        WHERE id=? AND book_id=? AND (remote_title IS NOT NULL OR remote_id IS NOT NULL)`,
      values: [now, bookmarkId, bookId],
    },
  ]);
}

export async function saveResolvedBookBookmarks(
  bookId: string,
  resolved: ReadonlyArray<{ id: string; cfi: string; href: string; percentage: number }>,
): Promise<void> {
  const valid = resolved.filter((item) => item.cfi.trim());
  if (valid.length === 0) return;
  if (!Capacitor.isNativePlatform()) {
    const byId = new Map(valid.map((item) => [item.id, item]));
    updateBrowserState((state) => {
      const list = state.bookmarks[bookId];
      if (!list) return false;
      let changed = false;
      for (const item of list) {
        const next = byId.get(item.id);
        if (next && (item.cfi !== next.cfi || item.href !== next.href)) {
          item.cfi = next.cfi;
          item.href = next.href;
          item.percentage = next.percentage;
          changed = true;
        }
      }
      return changed;
    });
    return;
  }
  const db = await openDatabase();
  await executeNativeTransaction(
    db,
    valid.map((item) => ({
      statement: 'UPDATE bookmarks SET cfi=?, href=?, percentage=? WHERE id=? AND book_id=?',
      values: [item.cfi, item.href, item.percentage, item.id, bookId],
    })),
  );
}

export async function reconcileBookBookmarks(
  bookId: string,
  remote: readonly KavitaPersonalTocItem[],
): Promise<StoredReaderLocation[]> {
  const now = new Date().toISOString();
  if (!Capacitor.isNativePlatform()) {
    let visible: StoredReaderLocation[] = [];
    updateBrowserState((state) => {
      if (!state.books.some((book) => book.id === bookId)) return false;
      const next = reconcileBookmarkRecords(bookId, state.bookmarks[bookId] ?? [], remote, now);
      if (next.length > 0) state.bookmarks[bookId] = next;
      else delete state.bookmarks[bookId];
      visible = next
        .filter((record) => record.syncState !== 'pending_delete')
        .map(toStoredBookmark);
    });
    return visible;
  }
  const db = await openDatabase();
  return enqueueNativeWrite(async () => {
    const bookRow = (await db.query('SELECT 1 FROM books WHERE id=?', [bookId])).values?.[0];
    if (!bookRow) return [];
    const currentRows =
      (
        await db.query('SELECT * FROM bookmarks WHERE book_id=? ORDER BY saved_at DESC, id ASC', [
          bookId,
        ])
      ).values ?? [];
    const current = currentRows.map((row) => mapBookmarkRow(row as Record<string, unknown>));
    const next = reconcileBookmarkRecords(bookId, current, remote, now);
    await db.executeTransaction([
      { statement: 'DELETE FROM bookmarks WHERE book_id=?', values: [bookId] },
      ...next.map((record) => insertBookmarkRecordTask(record)),
    ]);
    return next.filter((record) => record.syncState !== 'pending_delete').map(toStoredBookmark);
  });
}

export async function getBookHistory(bookId: string): Promise<StoredReaderLocation[]> {
  if (!Capacitor.isNativePlatform()) {
    return [...(readBrowserState().readingHistory[bookId] ?? [])]
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      .slice(0, 15);
  }
  const db = await openDatabase();
  const result = await db.query(
    'SELECT id, cfi, href, percentage, label, saved_at FROM reading_history WHERE book_id=? ORDER BY saved_at DESC LIMIT 15',
    [bookId],
  );
  return (result.values ?? []).map((row) => ({
    id: String(row.id),
    cfi: String(row.cfi),
    href: String(row.href),
    percentage: Number(row.percentage ?? 0),
    label: String(row.label),
    savedAt: String(row.saved_at),
  }));
}

export async function recordBookHistory(
  bookId: string,
  location: Omit<StoredReaderLocation, 'id' | 'savedAt' | 'label'> & { label?: string },
): Promise<StoredReaderLocation[]> {
  if (!Capacitor.isNativePlatform()) {
    let updated: StoredReaderLocation[] = [];
    updateBrowserState((state) => {
      if (!state.books.some((book) => book.id === bookId)) return false;
      updated = recordLocation(state.readingHistory[bookId] ?? [], location);
      state.readingHistory[bookId] = updated;
    });
    return updated;
  }
  const db = await openDatabase();
  return enqueueNativeWrite(async () => {
    const existingResult = await db.query(
      'SELECT id, cfi, href, percentage, label, saved_at FROM reading_history WHERE book_id=? ORDER BY saved_at DESC LIMIT 15',
      [bookId],
    );
    const existing: StoredReaderLocation[] = (existingResult.values ?? []).map((row) => ({
      id: String(row.id),
      cfi: String(row.cfi),
      href: String(row.href),
      percentage: Number(row.percentage ?? 0),
      label: String(row.label),
      savedAt: String(row.saved_at),
    }));
    const updated = recordLocation(existing, location);
    await db.executeTransaction([
      { statement: 'DELETE FROM reading_history WHERE book_id=?', values: [bookId] },
      ...updated.map((entry) => ({
        statement: `INSERT INTO reading_history
          (book_id, id, cfi, href, percentage, label, saved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        values: [
          bookId,
          entry.id,
          entry.cfi,
          entry.href,
          entry.percentage,
          entry.label,
          entry.savedAt,
        ],
      })),
    ]);
    return updated;
  });
}

export async function getPendingAnnotationSync(
  serverId: string,
): Promise<PendingAnnotationSyncItem[]> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    const booksById = new Map(
      state.books
        .filter((book) => book.serverId === serverId && book.remoteAvailable !== false)
        .map((book) => [book.id, book]),
    );
    const items: PendingAnnotationSyncItem[] = [];
    for (const [bookId, list] of Object.entries(state.annotations)) {
      const book = booksById.get(bookId);
      if (!book) continue;
      for (const record of list) {
        if (record.syncState === 'synced') continue;
        items.push({
          id: record.id,
          bookId: record.bookId,
          libraryId: book.libraryId,
          seriesId: book.seriesId,
          volumeId: book.volumeId,
          chapterId: book.chapterId,
          remoteId: record.remoteId,
          xpath: record.xpath,
          endingXPath: record.endingXPath,
          pageNumber: record.pageNumber,
          slotIndex: record.slotIndex,
          containsSpoiler: record.containsSpoiler,
          context: record.context,
          chapterTitle: record.chapterTitle,
          excerpt: record.excerpt,
          note: record.note,
          syncState: record.syncState,
          syncRevision: record.syncRevision,
          updatedAt: record.updatedAt,
        });
      }
    }
    return items.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  }

  const db = await openDatabase();
  const result = await db.query(
    `SELECT annotations.*, books.library_id, books.series_id, books.volume_id, books.chapter_id
     FROM annotations CROSS JOIN books ON books.id = annotations.book_id
     WHERE books.server_id = ? AND books.remote_available = 1 AND annotations.sync_state != 'synced'
     ORDER BY annotations.updated_at ASC, annotations.id ASC`,
    [serverId],
  );
  return (result.values ?? []).flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const record = mapAnnotationRow(row);
    if (record.syncState === 'synced') return [];
    return [
      {
        id: record.id,
        bookId: record.bookId,
        libraryId: Number(row.library_id),
        seriesId: Number(row.series_id),
        volumeId: Number(row.volume_id),
        chapterId: Number(row.chapter_id),
        remoteId: record.remoteId,
        xpath: record.xpath,
        endingXPath: record.endingXPath,
        pageNumber: record.pageNumber,
        slotIndex: record.slotIndex,
        containsSpoiler: record.containsSpoiler,
        context: record.context,
        chapterTitle: record.chapterTitle,
        excerpt: record.excerpt,
        note: record.note,
        syncState: record.syncState,
        syncRevision: record.syncRevision,
        updatedAt: record.updatedAt,
      },
    ];
  });
}

export async function confirmAnnotationSync(params: {
  id: string;
  bookId: string;
  expectedState: Exclude<StudySyncState, 'synced'>;
  expectedRevision: number;
  remote?: KavitaAnnotation | null;
}): Promise<{ deletedDuringCreate: boolean }> {
  const now = new Date().toISOString();
  if (!Capacitor.isNativePlatform()) {
    let deletedDuringCreate = false;
    updateBrowserState((state) => {
      const list = state.annotations[params.bookId];
      if (!list) {
        if (params.expectedState === 'pending_create' && params.remote?.id) {
          deletedDuringCreate = true;
        }
        return false;
      }
      const index = list.findIndex((item) => item.id === params.id);
      if (index < 0) {
        if (params.expectedState === 'pending_create' && params.remote?.id) {
          deletedDuringCreate = true;
        }
        return false;
      }
      const current = list[index]!;
      if (params.expectedState === 'pending_delete') {
        if (
          current.syncState !== 'pending_delete' ||
          current.syncRevision !== params.expectedRevision
        ) {
          return false;
        }
        list.splice(index, 1);
        if (list.length === 0) delete state.annotations[params.bookId];
        return;
      }

      if (current.syncState === 'pending_delete') {
        if (params.expectedState === 'pending_create' && params.remote?.id) {
          list.splice(index, 1);
          if (list.length === 0) delete state.annotations[params.bookId];
          deletedDuringCreate = true;
          return;
        }
        return false;
      }

      const remoteId = params.remote?.id ?? current.remoteId;
      const remoteUpdatedAt = params.remote?.lastModifiedUtc ?? current.remoteUpdatedAt ?? now;
      if (current.syncRevision === params.expectedRevision) {
        list[index] = {
          ...current,
          remoteId,
          remoteUpdatedAt,
          syncState: 'synced',
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
        };
        return;
      }

      if (params.expectedState === 'pending_create' && remoteId !== null) {
        list[index] = {
          ...current,
          remoteId,
          remoteUpdatedAt,
          syncState: 'pending_update',
        };
        return;
      }
      return false;
    });
    return { deletedDuringCreate };
  }

  const db = await openDatabase();
  return enqueueNativeWrite(async () => {
    const existing = (
      await db.query('SELECT * FROM annotations WHERE id=? AND book_id=?', [
        params.id,
        params.bookId,
      ])
    ).values?.[0];
    if (!existing) {
      return {
        deletedDuringCreate: Boolean(
          params.expectedState === 'pending_create' && params.remote?.id,
        ),
      };
    }
    const current = mapAnnotationRow(existing as Record<string, unknown>);
    if (params.expectedState === 'pending_delete') {
      if (
        current.syncState === 'pending_delete' &&
        current.syncRevision === params.expectedRevision
      ) {
        await db.run('DELETE FROM annotations WHERE id=? AND book_id=?', [
          params.id,
          params.bookId,
        ]);
      }
      return { deletedDuringCreate: false };
    }

    if (current.syncState === 'pending_delete') {
      if (params.expectedState === 'pending_create' && params.remote?.id) {
        await db.run('DELETE FROM annotations WHERE id=? AND book_id=?', [
          params.id,
          params.bookId,
        ]);
        return { deletedDuringCreate: true };
      }
      return { deletedDuringCreate: false };
    }

    const remoteId = params.remote?.id ?? current.remoteId;
    const remoteUpdatedAt = params.remote?.lastModifiedUtc ?? current.remoteUpdatedAt ?? now;
    if (current.syncRevision === params.expectedRevision) {
      await db.run(
        `UPDATE annotations SET remote_id=?, remote_updated_at=?, sync_state='synced',
         attempt_count=0, last_attempt_at=NULL, last_error=NULL
         WHERE id=? AND book_id=?`,
        [remoteId, remoteUpdatedAt, params.id, params.bookId],
      );
    } else if (params.expectedState === 'pending_create' && remoteId !== null) {
      await db.run(
        `UPDATE annotations SET remote_id=?, remote_updated_at=?, sync_state='pending_update'
         WHERE id=? AND book_id=?`,
        [remoteId, remoteUpdatedAt, params.id, params.bookId],
      );
    }
    return { deletedDuringCreate: false };
  });
}

export async function markAnnotationSyncFailure(
  id: string,
  bookId: string,
  error: string,
  expectedRevision: number,
): Promise<void> {
  const now = new Date().toISOString();
  const message = error.slice(0, 240);
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      const item = state.annotations[bookId]?.find((entry) => entry.id === id);
      if (!item || item.syncRevision !== expectedRevision) return false;
      item.attemptCount += 1;
      item.lastAttemptAt = now;
      item.lastError = message;
    });
    return;
  }
  const db = await openDatabase();
  await executeNativeRun(
    db,
    `UPDATE annotations SET attempt_count=attempt_count+1, last_attempt_at=?, last_error=?
     WHERE id=? AND book_id=? AND sync_revision=?`,
    [now, message, id, bookId, expectedRevision],
  );
}

export async function getPendingBookmarkSync(serverId: string): Promise<PendingBookmarkSyncItem[]> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    const booksById = new Map(
      state.books
        .filter((book) => book.serverId === serverId && book.remoteAvailable !== false)
        .map((book) => [book.id, book]),
    );
    const items: PendingBookmarkSyncItem[] = [];
    for (const [bookId, list] of Object.entries(state.bookmarks)) {
      const book = booksById.get(bookId);
      if (!book) continue;
      for (const record of list) {
        if (record.syncState === 'synced') continue;
        items.push({
          id: record.id,
          bookId: record.bookId,
          libraryId: book.libraryId,
          seriesId: book.seriesId,
          volumeId: book.volumeId,
          chapterId: book.chapterId,
          remoteId: record.remoteId,
          xpath: record.xpath,
          pageNumber: record.pageNumber,
          label: record.label,
          excerpt: record.excerpt,
          remoteTitle: record.remoteTitle,
          remotePageNumber: record.remotePageNumber,
          syncState: record.syncState,
          syncRevision: record.syncRevision,
          updatedAt: record.updatedAt,
        });
      }
    }
    return items.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  }

  const db = await openDatabase();
  const result = await db.query(
    `SELECT bookmarks.*, books.library_id, books.series_id, books.volume_id, books.chapter_id
     FROM bookmarks CROSS JOIN books ON books.id = bookmarks.book_id
     WHERE books.server_id = ? AND books.remote_available = 1 AND bookmarks.sync_state != 'synced'
     ORDER BY bookmarks.updated_at ASC, bookmarks.id ASC`,
    [serverId],
  );
  return (result.values ?? []).flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const record = mapBookmarkRow(row);
    if (record.syncState === 'synced') return [];
    return [
      {
        id: record.id,
        bookId: record.bookId,
        libraryId: Number(row.library_id),
        seriesId: Number(row.series_id),
        volumeId: Number(row.volume_id),
        chapterId: Number(row.chapter_id),
        remoteId: record.remoteId,
        xpath: record.xpath,
        pageNumber: record.pageNumber,
        label: record.label,
        excerpt: record.excerpt,
        remoteTitle: record.remoteTitle,
        remotePageNumber: record.remotePageNumber,
        syncState: record.syncState,
        syncRevision: record.syncRevision,
        updatedAt: record.updatedAt,
      },
    ];
  });
}

export async function confirmBookmarkSync(params: {
  id: string;
  bookId: string;
  expectedState: Exclude<StudySyncState, 'synced'>;
  expectedRevision: number;
  syncedTitle?: string;
  syncedPageNumber?: number;
  remoteId?: number | null;
}): Promise<{ deletedDuringSync: boolean }> {
  if (!Capacitor.isNativePlatform()) {
    let deletedDuringSync = false;
    updateBrowserState((state) => {
      const list = state.bookmarks[params.bookId];
      if (!list) {
        if (params.expectedState !== 'pending_delete' && params.syncedTitle) {
          deletedDuringSync = true;
        }
        return false;
      }
      const index = list.findIndex((item) => item.id === params.id);
      if (index < 0) {
        if (params.expectedState !== 'pending_delete' && params.syncedTitle) {
          deletedDuringSync = true;
        }
        return false;
      }
      const current = list[index]!;
      if (params.expectedState === 'pending_delete') {
        if (
          current.syncState !== 'pending_delete' ||
          current.syncRevision !== params.expectedRevision
        ) {
          return false;
        }
        list.splice(index, 1);
        if (list.length === 0) delete state.bookmarks[params.bookId];
        return;
      }

      if (current.syncState === 'pending_delete') {
        list.splice(index, 1);
        if (list.length === 0) delete state.bookmarks[params.bookId];
        deletedDuringSync = Boolean(params.syncedTitle);
        return;
      }

      const remoteTitle = params.syncedTitle ?? current.label;
      const remotePageNumber = params.syncedPageNumber ?? current.pageNumber;
      const remoteId = params.remoteId !== undefined ? params.remoteId : current.remoteId;
      if (current.syncRevision === params.expectedRevision) {
        list[index] = {
          ...current,
          remoteId,
          remoteTitle,
          remotePageNumber,
          syncState: 'synced',
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
        };
        return;
      }

      list[index] = {
        ...current,
        remoteId,
        remoteTitle,
        remotePageNumber,
        syncState: 'pending_update',
      };
    });
    return { deletedDuringSync };
  }

  const db = await openDatabase();
  return enqueueNativeWrite(async () => {
    const existing = (
      await db.query('SELECT * FROM bookmarks WHERE id=? AND book_id=?', [params.id, params.bookId])
    ).values?.[0];
    if (!existing) {
      return {
        deletedDuringSync: Boolean(params.expectedState !== 'pending_delete' && params.syncedTitle),
      };
    }
    const current = mapBookmarkRow(existing as Record<string, unknown>);
    if (params.expectedState === 'pending_delete') {
      if (
        current.syncState === 'pending_delete' &&
        current.syncRevision === params.expectedRevision
      ) {
        await db.run('DELETE FROM bookmarks WHERE id=? AND book_id=?', [params.id, params.bookId]);
      }
      return { deletedDuringSync: false };
    }

    if (current.syncState === 'pending_delete') {
      await db.run('DELETE FROM bookmarks WHERE id=? AND book_id=?', [params.id, params.bookId]);
      return { deletedDuringSync: Boolean(params.syncedTitle) };
    }

    const remoteTitle = params.syncedTitle ?? current.label;
    const remotePageNumber = params.syncedPageNumber ?? current.pageNumber;
    const remoteId = params.remoteId !== undefined ? params.remoteId : current.remoteId;
    if (current.syncRevision === params.expectedRevision) {
      await db.run(
        `UPDATE bookmarks SET remote_id=?, remote_title=?, remote_page_number=?,
         sync_state='synced', attempt_count=0, last_attempt_at=NULL, last_error=NULL
         WHERE id=? AND book_id=?`,
        [remoteId, remoteTitle, remotePageNumber, params.id, params.bookId],
      );
    } else {
      await db.run(
        `UPDATE bookmarks SET remote_id=?, remote_title=?, remote_page_number=?,
         sync_state='pending_update'
         WHERE id=? AND book_id=?`,
        [remoteId, remoteTitle, remotePageNumber, params.id, params.bookId],
      );
    }
    return { deletedDuringSync: false };
  });
}

export async function markBookmarkSyncFailure(
  id: string,
  bookId: string,
  error: string,
  expectedRevision: number,
): Promise<void> {
  const now = new Date().toISOString();
  const message = error.slice(0, 240);
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      const item = state.bookmarks[bookId]?.find((entry) => entry.id === id);
      if (!item || item.syncRevision !== expectedRevision) return false;
      item.attemptCount += 1;
      item.lastAttemptAt = now;
      item.lastError = message;
    });
    return;
  }
  const db = await openDatabase();
  await executeNativeRun(
    db,
    `UPDATE bookmarks SET attempt_count=attempt_count+1, last_attempt_at=?, last_error=?
     WHERE id=? AND book_id=? AND sync_revision=?`,
    [now, message, id, bookId, expectedRevision],
  );
}
