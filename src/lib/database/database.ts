import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type capTask,
  type DBSQLiteValues,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import { toKavitaPageNumber } from '../sync/conflict';
import { sanitizeEpubFileName } from '../kavita/normalization';
import type { KavitaProgress } from '../kavita/types';
import { clearBootThemeCache, mirrorBootThemePreferences } from '../themes/themes';
import { migrations, V8_BOOK_COLUMNS, V8_BOOK_INDEX_SQL } from './schema';

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
  fileId?: number | null;
  fileName?: string | null;
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
  chapterEpubIndex?: number;
  multiFileChapter?: boolean;
  /** False keeps progress local when Kavita shares chapter progress with another primary file. */
  syncProgress?: boolean;
  /** False means Kavita no longer advertises the book; local retention may keep it. */
  remoteAvailable?: boolean;
  /** False means Kavita omitted usable progress fields from this metadata snapshot. */
  remoteProgressKnown?: boolean;
  /** False means Kavita omitted a usable last-read date from this metadata snapshot. */
  remoteReadDateKnown?: boolean;
}

function withoutRemoteProgressMarkers(book: BookRecord): BookRecord {
  const record: BookRecord = {
    ...book,
    ...(book.fileName !== undefined ? { fileName: sanitizeEpubFileName(book.fileName) } : {}),
  };
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
const REKEY_TEMP_PREFIX = '__turnleaf_rekey__:';
const READER_PREFERENCE_PREFIXES = [
  'readerBookmarks:',
  'readerHistory:',
  'readerAnnotations:',
] as const;

function readerPreferenceKeys(bookId: string): [string, string, string] {
  return [`readerBookmarks:${bookId}`, `readerHistory:${bookId}`, `readerAnnotations:${bookId}`];
}

interface ExistingBookIdentity {
  id: string;
  chapterId: number;
  fileId?: number | null;
}

interface BookReconciliationPlan {
  matchedOldIdByIncomingId: Map<string, string>;
  claimedExistingIds: Set<string>;
  rekeys: Array<{ oldId: string; newId: string }>;
  evictedIds: string[];
}

function legacyChapterBookId(
  serverId: string,
  book: Pick<BookRecord, 'seriesId' | 'chapterId'>,
): string {
  return `${serverId}:${book.seriesId}:${book.chapterId}`;
}

function findMatchingExistingBook<T extends ExistingBookIdentity>(
  serverId: string,
  existingRows: readonly T[],
  claimedExistingIds: ReadonlySet<string>,
  book: BookRecord,
): T | undefined {
  const candidates = existingRows.filter((row) => !claimedExistingIds.has(row.id));
  if (book.fileId != null) {
    const exactMatches = candidates.filter((row) => row.fileId === book.fileId);
    if (exactMatches.length > 0) {
      return [...exactMatches].sort((left, right) => {
        const leftChapter = left.chapterId === book.chapterId ? 0 : 1;
        const rightChapter = right.chapterId === book.chapterId ? 0 : 1;
        if (leftChapter !== rightChapter) return leftChapter - rightChapter;
        const leftId = left.id === book.id ? 0 : 1;
        const rightId = right.id === book.id ? 0 : 1;
        return leftId - rightId;
      })[0];
    }
    if (book.syncProgress !== false) {
      const legacyId = legacyChapterBookId(serverId, book);
      const nullMatches = candidates.filter(
        (row) => row.fileId == null && (row.id === book.id || row.id === legacyId),
      );
      if (nullMatches.length > 0) {
        return [...nullMatches].sort((left, right) => {
          const leftId = left.id === book.id ? 0 : 1;
          const rightId = right.id === book.id ? 0 : 1;
          return leftId - rightId;
        })[0];
      }
    }
    return undefined;
  }
  return candidates.find((row) => row.id === book.id && row.fileId == null);
}

function planBookFileReconciliation<T extends ExistingBookIdentity>(
  serverId: string,
  existingRows: readonly T[],
  incomingBooks: readonly BookRecord[],
): BookReconciliationPlan {
  const incomingById = new Map(incomingBooks.map((book) => [book.id, book]));
  const matchedOldIdByIncomingId = new Map<string, string>();
  const claimedExistingIds = new Set<string>();
  const rekeys: Array<{ oldId: string; newId: string }> = [];

  for (const book of incomingById.values()) {
    const matched = findMatchingExistingBook(serverId, existingRows, claimedExistingIds, book);
    if (!matched) continue;
    claimedExistingIds.add(matched.id);
    matchedOldIdByIncomingId.set(book.id, matched.id);
    if (matched.id !== book.id) {
      rekeys.push({ oldId: matched.id, newId: book.id });
    }
  }

  const evictedIds = existingRows
    .filter((row) => !claimedExistingIds.has(row.id) && incomingById.has(row.id))
    .map((row) => row.id);

  return {
    matchedOldIdByIncomingId,
    claimedExistingIds,
    rekeys,
    evictedIds,
  };
}

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

async function executeNativeQuery(
  db: Pick<SQLiteDBConnection, 'query'>,
  statement: string,
  values?: unknown[],
): Promise<DBSQLiteValues> {
  return enqueueNativeWrite(() =>
    values === undefined ? db.query(statement) : db.query(statement, values),
  );
}

function parseReadingStateRow(row: Record<string, unknown> | undefined): StoredReadingState | null {
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

async function queryNativeReadingState(
  db: Pick<SQLiteDBConnection, 'query'>,
  bookId: string,
): Promise<StoredReadingState | null> {
  const result = await db.query('SELECT * FROM reading_state WHERE book_id=?', [bookId]);
  return parseReadingStateRow(result.values?.[0] as Record<string, unknown> | undefined);
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
          ...(book.fileName !== undefined ? { fileName: sanitizeEpubFileName(book.fileName) } : {}),
          ...(book.syncProgress !== undefined ? { syncProgress: book.syncProgress !== false } : {}),
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
  await migrateDatabase(db);
  return db;
}

export async function resetLocalDatabase(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    writeBrowserState(createBrowserState());
    clearBootThemeCache();
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
    clearBootThemeCache();
  } catch (error) {
    throw new Error(`Could not reset local storage: ${String(error)}`, { cause: error });
  }
}

export type MigrationConnection = Pick<
  SQLiteDBConnection,
  'executeTransaction' | 'getVersion' | 'query'
> &
  Partial<Pick<SQLiteDBConnection, 'execute'>>;

function isMissingColumnError(error: unknown): boolean {
  return String(error).toLowerCase().includes('no such column');
}

function isMissingTableError(error: unknown, tableName: string): boolean {
  return String(error).toLowerCase().includes(`no such table: ${tableName.toLowerCase()}`);
}

async function queryExistingBookColumns(
  db: Pick<SQLiteDBConnection, 'query'>,
): Promise<Set<string> | null> {
  const rows = (await executeNativeQuery(db, "PRAGMA table_info('books')")).values ?? [];
  if (rows.length === 0) return null;
  return new Set(rows.map((row) => String(row.name)));
}

async function hasBooksServerFileIndex(db: Pick<SQLiteDBConnection, 'query'>): Promise<boolean> {
  const rows = (await executeNativeQuery(db, "PRAGMA index_list('books')")).values ?? [];
  return rows.some((row) => String(row.name) === 'books_server_file_idx');
}

function buildV8ReconciliationTasks(
  existingColumns: ReadonlySet<string>,
  targetVersion: number,
): capTask[] {
  const missingColumns = V8_BOOK_COLUMNS.filter((column) => !existingColumns.has(column.name));
  return [
    ...(missingColumns.length > 0
      ? [
          {
            statement: missingColumns
              .map((column) => `ALTER TABLE books ADD COLUMN ${column.name} ${column.definition};`)
              .join('\n'),
          },
        ]
      : []),
    { statement: V8_BOOK_INDEX_SQL },
    { statement: `PRAGMA user_version = ${targetVersion};` },
  ];
}

export async function migrateDatabase(db: MigrationConnection): Promise<void> {
  const current = await db.getVersion();
  const currentVersion = current.version ?? 0;
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    if (migration.version === 8 && currentVersion >= 1) {
      const existingColumns = await queryExistingBookColumns(db);
      if (existingColumns) {
        await executeNativeTransaction(db, buildV8ReconciliationTasks(existingColumns, 8));
        continue;
      }
    }
    await executeNativeTransaction(db, [
      { statement: migration.statements },
      { statement: `PRAGMA user_version = ${migration.version};` },
    ]);
  }

  if (currentVersion >= 8) {
    if (typeof db.execute === 'function') {
      const executeDb = { execute: db.execute.bind(db) };
      const v8ProbeAssignments = V8_BOOK_COLUMNS.map(
        (column) => `${column.name} = ${column.name}`,
      ).join(', ');
      try {
        await executeNativeStatement(
          executeDb,
          `UPDATE books SET ${v8ProbeAssignments} WHERE 0;\n${V8_BOOK_INDEX_SQL}`,
        );
        return;
      } catch (error) {
        if (!isMissingColumnError(error)) {
          if (isMissingTableError(error, 'books')) return;
          throw error;
        }
      }
    }

    const existingColumns = await queryExistingBookColumns(db);
    if (!existingColumns) return;
    const missingColumns = V8_BOOK_COLUMNS.filter((column) => !existingColumns.has(column.name));
    const hasIndex = await hasBooksServerFileIndex(db);
    if (missingColumns.length === 0 && hasIndex) return;
    await executeNativeTransaction(db, buildV8ReconciliationTasks(existingColumns, currentVersion));
  }
}

export async function saveServer(config: ServerConfig): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      state.serverConfig = config;
    });
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
    updateBrowserState((state) => {
      if (state.serverConfig?.id !== serverId) return false;
      state.serverConfig = null;
      state.books = [];
      state.readingState = {};
      state.syncQueue = {};
    });
    return;
  }
  const db = await openDatabase();
  await executeNativeRun(db, 'DELETE FROM server_config WHERE id=?', [serverId]);
}

export async function getServer(): Promise<ServerConfig | null> {
  if (!Capacitor.isNativePlatform()) {
    return readBrowserState().serverConfig;
  }
  const db = await openDatabase();
  const result = await executeNativeQuery(
    db,
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
      const incomingList = [...incoming.values()];
      const existing = state.books.filter((book) => book.serverId === serverId);
      const existingById = new Map(existing.map((book) => [book.id, book]));
      const plan = planBookFileReconciliation(serverId, existing, incomingList);

      const previousReadingState = { ...state.readingState };
      const previousSyncQueue = { ...state.syncQueue };
      const previousPreferences = { ...state.preferences };

      const clearBookLocalArtifacts = (bookId: string): void => {
        delete state.readingState[bookId];
        delete state.syncQueue[bookId];
        for (const prefix of READER_PREFERENCE_PREFIXES) {
          delete state.preferences[`${prefix}${bookId}`];
        }
      };

      for (const evictedId of plan.evictedIds) {
        clearBookLocalArtifacts(evictedId);
      }
      for (const { oldId, newId } of plan.rekeys) {
        if (!incoming.has(oldId)) {
          clearBookLocalArtifacts(oldId);
        }
        clearBookLocalArtifacts(newId);
      }
      for (const book of incomingList) {
        const matchedOldId = plan.matchedOldIdByIncomingId.get(book.id);
        if (!matchedOldId) {
          clearBookLocalArtifacts(book.id);
          continue;
        }
        if (matchedOldId === book.id) continue;
        const migratedReading = previousReadingState[matchedOldId];
        if (migratedReading) {
          state.readingState[book.id] = { ...migratedReading };
        }
        const migratedQueue = previousSyncQueue[matchedOldId];
        if (migratedQueue) {
          state.syncQueue[book.id] = {
            ...migratedQueue,
            bookId: book.id,
          };
        }
        for (const prefix of READER_PREFERENCE_PREFIXES) {
          const oldKey = `${prefix}${matchedOldId}`;
          if (Object.prototype.hasOwnProperty.call(previousPreferences, oldKey)) {
            state.preferences[`${prefix}${book.id}`] = previousPreferences[oldKey]!;
          }
        }
      }

      const unmatched = existing.filter(
        (book) => !plan.claimedExistingIds.has(book.id) && !incoming.has(book.id),
      );
      const retained = preserveMissing
        ? unmatched
        : unmatched
            .filter(
              (book) =>
                Boolean(book.downloadPath) ||
                book.downloadStatus === 'available' ||
                Boolean(previousSyncQueue[book.id]) ||
                Boolean(previousReadingState[book.id]),
            )
            .map((book) => ({ ...withoutRemoteProgressMarkers(book), remoteAvailable: false }));
      const began = snapshotStartedAt ? Date.parse(snapshotStartedAt) : Infinity;
      const merged = incomingList.map((book) => {
        const matchedOldId = plan.matchedOldIdByIncomingId.get(book.id);
        const previous = matchedOldId ? existingById.get(matchedOldId) : undefined;
        if (!previous) {
          return {
            ...book,
            downloadPath: book.downloadPath ?? null,
            downloadStatus: book.downloadStatus ?? 'none',
            remoteFileSize: book.remoteFileSize ?? book.fileSize,
            syncProgress: book.syncProgress !== false,
            remoteAvailable: true,
          };
        }
        const reading = previousReadingState[previous.id];
        const pending = Boolean(previousSyncQueue[previous.id]) || reading?.pendingSync === true;
        const changedDuringRefresh =
          reading &&
          (Date.parse(reading.localUpdatedAt) >= began ||
            Date.parse(reading.serverUpdatedAt ?? '') >= began);
        const localOnlyProgress = book.syncProgress === false || previous.syncProgress === false;
        const preserveProgress =
          localOnlyProgress || pending || changedDuringRefresh || unknownProgress.has(book.id);
        const preserveReadDate = preserveProgress || unknownReadDate.has(book.id);
        const hasLocalDownload =
          Boolean(previous.downloadPath) || previous.downloadStatus === 'available';
        return {
          ...withoutRemoteProgressMarkers(previous),
          ...book,
          id: book.id,
          serverId,
          fileId: book.fileId ?? previous.fileId ?? null,
          syncProgress: book.syncProgress !== false,
          remoteAvailable: true,
          downloadPath: previous.downloadPath,
          downloadStatus: previous.downloadStatus,
          fileSize: hasLocalDownload ? previous.fileSize : (book.fileSize ?? previous.fileSize),
          remoteFileSize: book.remoteFileSize ?? book.fileSize ?? previous.remoteFileSize ?? null,
          pagesRead: preserveProgress ? previous.pagesRead : book.pagesRead,
          lastReadAt: preserveReadDate ? previous.lastReadAt : book.lastReadAt,
        };
      });
      state.books = [
        ...state.books.filter((book) => book.serverId !== serverId),
        ...merged,
        ...retained,
      ];
    });
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
   pages, pages_read, created_at, last_read_at, remote_available,
   file_id, file_name, remote_file_size, chapter_epub_index, multi_file_chapter, sync_progress)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
   library_id=excluded.library_id, series_id=excluded.series_id,
   volume_id=excluded.volume_id, chapter_id=excluded.chapter_id,
   title=excluded.title, author=excluded.author, series=excluded.series,
   description_html=excluded.description_html, format=excluded.format,
   metadata_refreshed_at=excluded.metadata_refreshed_at,
   file_size=CASE WHEN books.download_path IS NOT NULL OR books.download_status='available'
     THEN books.file_size ELSE COALESCE(excluded.file_size, books.file_size) END,
   pages=excluded.pages,
   pages_read=CASE WHEN books.sync_progress=0 OR excluded.sync_progress=0 OR ?=0 OR ${preserveReadingProgress}
     THEN books.pages_read ELSE excluded.pages_read END,
   created_at=excluded.created_at,
   last_read_at=CASE WHEN books.sync_progress=0 OR excluded.sync_progress=0 OR ?=0 OR ?=0 OR ${preserveReadingProgress}
     THEN books.last_read_at ELSE excluded.last_read_at END,
   remote_available=excluded.remote_available,
   file_id=COALESCE(excluded.file_id, books.file_id), file_name=excluded.file_name,
   remote_file_size=COALESCE(excluded.remote_file_size, books.remote_file_size),
   chapter_epub_index=excluded.chapter_epub_index,
   multi_file_chapter=excluded.multi_file_chapter,
   sync_progress=excluded.sync_progress`;

const BASE_BOOK_COLUMNS_WITHOUT_ID = [
  'server_id',
  'library_id',
  'series_id',
  'volume_id',
  'chapter_id',
  'title',
  'author',
  'series',
  'description_html',
  'cover_path',
  'format',
  'metadata_refreshed_at',
  'download_path',
  'download_status',
  'file_size',
  'pages',
  'pages_read',
  'created_at',
  'last_read_at',
  'remote_available',
  'file_id',
  'file_name',
  'remote_file_size',
  'downloaded_bytes',
  'downloaded_pages',
  'chapter_key',
  'chapter_epub_index',
  'multi_file_chapter',
  'sync_progress',
] as const;

const bookColumnsWithoutId = BASE_BOOK_COLUMNS_WITHOUT_ID.join(', ');

const OPTIONAL_STUDY_TABLES = ['annotations', 'bookmarks', 'reading_history'] as const;

interface IdentityMigrationSchema {
  bookColumnsCsv: string;
  studyTables: ReadonlySet<string>;
}

const DEFAULT_IDENTITY_MIGRATION_SCHEMA: IdentityMigrationSchema = {
  bookColumnsCsv: bookColumnsWithoutId,
  studyTables: new Set(),
};

const SAFE_SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

async function queryIdentityMigrationSchema(
  db: Pick<SQLiteDBConnection, 'query'>,
): Promise<IdentityMigrationSchema> {
  const [tableInfo, studyTableInfo] = await Promise.all([
    db.query("PRAGMA table_info('books')"),
    db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('annotations', 'bookmarks', 'reading_history')",
    ),
  ]);
  const knownColumns = new Set<string>(['id', ...BASE_BOOK_COLUMNS_WITHOUT_ID]);
  const extraBookColumns = (tableInfo.values ?? [])
    .map((row) => String(row.name))
    .filter((name) => SAFE_SQL_IDENTIFIER.test(name) && !knownColumns.has(name));
  const allColumns =
    extraBookColumns.length > 0
      ? [...BASE_BOOK_COLUMNS_WITHOUT_ID, ...extraBookColumns].join(', ')
      : bookColumnsWithoutId;
  const studyTables = new Set(
    (studyTableInfo.values ?? [])
      .map((row) => String(row.name))
      .filter((name) => (OPTIONAL_STUDY_TABLES as readonly string[]).includes(name)),
  );
  return {
    bookColumnsCsv: allColumns,
    studyTables,
  };
}

function moveBookIdentityTasks(
  sourceId: string,
  targetId: string,
  clearTargetPreferences: boolean,
  schema: IdentityMigrationSchema = DEFAULT_IDENTITY_MIGRATION_SCHEMA,
): capTask[] {
  const tasks: capTask[] = [];
  if (clearTargetPreferences) {
    tasks.push({
      statement: `DELETE FROM preferences WHERE key IN (?, ?, ?)
        AND EXISTS (SELECT 1 FROM books WHERE id = ?)`,
      values: [...readerPreferenceKeys(targetId), sourceId],
    });
  }
  tasks.push(
    {
      statement: `INSERT INTO books (id, ${schema.bookColumnsCsv})
        SELECT ?, ${schema.bookColumnsCsv} FROM books WHERE id = ?`,
      values: [targetId, sourceId],
    },
    {
      statement: 'UPDATE reading_state SET book_id = ? WHERE book_id = ?',
      values: [targetId, sourceId],
    },
    {
      statement: 'UPDATE sync_queue SET book_id = ? WHERE book_id = ?',
      values: [targetId, sourceId],
    },
    {
      statement: `UPDATE OR REPLACE preferences
        SET key = substr(key, 1, instr(key, ':')) || ?
        WHERE key IN (?, ?, ?)`,
      values: [targetId, ...readerPreferenceKeys(sourceId)],
    },
  );
  for (const studyTable of OPTIONAL_STUDY_TABLES) {
    if (schema.studyTables.has(studyTable)) {
      tasks.push({
        statement: `UPDATE ${studyTable} SET book_id = ? WHERE book_id = ?`,
        values: [targetId, sourceId],
      });
    }
  }
  tasks.push({
    statement: 'DELETE FROM books WHERE id = ? AND EXISTS (SELECT 1 FROM books WHERE id = ?)',
    values: [sourceId, targetId],
  });
  return tasks;
}

function evictBookIdentityTasks(serverId: string, bookId: string): capTask[] {
  return [
    {
      statement: `DELETE FROM preferences WHERE key IN (?, ?, ?)
        AND EXISTS (SELECT 1 FROM books WHERE id = ? AND server_id = ?)`,
      values: [...readerPreferenceKeys(bookId), bookId, serverId],
    },
    {
      statement: 'DELETE FROM books WHERE id = ? AND server_id = ?',
      values: [bookId, serverId],
    },
  ];
}

function plannedNativeIdentityTasks(
  serverId: string,
  plan: BookReconciliationPlan,
  schema: IdentityMigrationSchema = DEFAULT_IDENTITY_MIGRATION_SCHEMA,
): capTask[] {
  const tasks: capTask[] = [];
  plan.rekeys.forEach(({ oldId }, index) => {
    tasks.push(...moveBookIdentityTasks(oldId, `${REKEY_TEMP_PREFIX}${index}`, false, schema));
  });
  for (const evictedId of plan.evictedIds) {
    tasks.push(...evictBookIdentityTasks(serverId, evictedId));
  }
  plan.rekeys.forEach(({ newId }, index) => {
    tasks.push(...moveBookIdentityTasks(`${REKEY_TEMP_PREFIX}${index}`, newId, true, schema));
  });
  return tasks;
}

function sqlOnlyIdentityTasks(serverId: string, incomingBooks: readonly BookRecord[]): capTask[] {
  const uniqueBooks = [...new Map(incomingBooks.map((book) => [book.id, book])).values()];
  const tasks: capTask[] = [];

  uniqueBooks.forEach((book, index) => {
    const tempId = `${REKEY_TEMP_PREFIX}${index}`;
    let matchSubquery: string;
    let matchParams: unknown[];
    if (book.fileId != null) {
      const legacyId = legacyChapterBookId(serverId, book);
      const allowNull = book.syncProgress === false ? 0 : 1;
      matchSubquery = `(SELECT id FROM books
        WHERE server_id = ?
          AND id NOT LIKE '${REKEY_TEMP_PREFIX}%'
          AND (file_id = ? OR (? = 1 AND file_id IS NULL AND (id = ? OR id = ?)))
        ORDER BY
          CASE WHEN file_id = ? THEN 0 ELSE 1 END,
          CASE WHEN chapter_id = ? THEN 0 ELSE 1 END,
          CASE WHEN id = ? THEN 0 ELSE 1 END
        LIMIT 1)`;
      matchParams = [
        serverId,
        book.fileId,
        allowNull,
        book.id,
        legacyId,
        book.fileId,
        book.chapterId,
        book.id,
      ];
    } else {
      matchSubquery = `(SELECT id FROM books
        WHERE server_id = ? AND id = ? AND file_id IS NULL
        LIMIT 1)`;
      matchParams = [serverId, book.id];
    }
    tasks.push(
      {
        statement: `INSERT INTO books (id, ${bookColumnsWithoutId})
          SELECT ?, ${bookColumnsWithoutId} FROM books WHERE id = ${matchSubquery}`,
        values: [tempId, ...matchParams],
      },
      {
        statement: `UPDATE reading_state SET book_id = ? WHERE book_id = ${matchSubquery}`,
        values: [tempId, ...matchParams],
      },
      {
        statement: `UPDATE sync_queue SET book_id = ? WHERE book_id = ${matchSubquery}`,
        values: [tempId, ...matchParams],
      },
      {
        statement: `UPDATE OR REPLACE preferences
          SET key = substr(key, 1, instr(key, ':')) || ?
          WHERE key IN (
            SELECT prefix || matched.id
            FROM (
              SELECT 'readerBookmarks:' AS prefix
              UNION ALL SELECT 'readerHistory:'
              UNION ALL SELECT 'readerAnnotations:'
            )
            JOIN (SELECT id FROM books WHERE id = ${matchSubquery}) AS matched
          )`,
        values: [tempId, ...matchParams],
      },
      {
        statement: `DELETE FROM books WHERE id = ${matchSubquery}
          AND EXISTS (SELECT 1 FROM books WHERE id = ?)`,
        values: [...matchParams, tempId],
      },
    );
  });

  uniqueBooks.forEach((book, index) => {
    const tempId = `${REKEY_TEMP_PREFIX}${index}`;
    tasks.push(
      ...evictBookIdentityTasks(serverId, book.id),
      ...moveBookIdentityTasks(tempId, book.id, true),
    );
  });

  return tasks;
}

function parseNullableInteger(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

async function queryExistingBookIdentities(
  db: Pick<SQLiteDBConnection, 'query'>,
  serverId: string,
): Promise<ExistingBookIdentity[]> {
  const result = await db.query('SELECT id, chapter_id, file_id FROM books WHERE server_id = ?', [
    serverId,
  ]);
  return (result.values ?? []).map((row) => ({
    id: String(row.id),
    chapterId: Number(row.chapter_id),
    fileId: parseNullableInteger(row.file_id),
  }));
}

function replaceBookTask(
  serverId: string,
  book: BookRecord,
  refreshedAt: string,
  snapshotStartedAt: string | null = null,
): capTask {
  const remoteFileSize = book.remoteFileSize ?? (book.downloadPath ? null : book.fileSize);
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
      book.fileId ?? null,
      sanitizeEpubFileName(book.fileName),
      remoteFileSize,
      book.chapterEpubIndex ?? 0,
      book.multiFileChapter ? 1 : 0,
      book.syncProgress === false ? 0 : 1,
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
  db: Pick<SQLiteDBConnection, 'executeTransaction'> & Partial<Pick<SQLiteDBConnection, 'query'>>,
  serverId: string,
  books: BookRecord[],
  refreshedAt = new Date().toISOString(),
): Promise<void> {
  if (books.length === 0) return;
  if (books.every((book) => book.fileId == null)) {
    await executeNativeTransaction(
      db,
      books.map((book) => replaceBookTask(serverId, book, refreshedAt)),
    );
    return;
  }
  await enqueueNativeWrite(async () => {
    let identityTasks: capTask[];
    if (typeof db.query === 'function') {
      const queryDb = { query: db.query.bind(db) };
      const plan = planBookFileReconciliation(
        serverId,
        await queryExistingBookIdentities(queryDb, serverId),
        books,
      );
      const schema =
        plan.rekeys.length > 0
          ? await queryIdentityMigrationSchema(queryDb)
          : DEFAULT_IDENTITY_MIGRATION_SCHEMA;
      identityTasks = plannedNativeIdentityTasks(serverId, plan, schema);
    } else {
      identityTasks = sqlOnlyIdentityTasks(serverId, books);
    }
    const tasks = [
      ...identityTasks,
      ...books.map((book) => replaceBookTask(serverId, book, refreshedAt)),
    ];
    await db.executeTransaction(tasks);
  });
}

const retainedBookCondition = `(download_path IS NOT NULL OR download_status='available'
  OR EXISTS (SELECT 1 FROM reading_state WHERE reading_state.book_id=books.id)
  OR EXISTS (SELECT 1 FROM sync_queue WHERE sync_queue.book_id=books.id))`;

/** Apply metadata and optional removal reconciliation atomically on native SQLite. */
export async function reconcileBooksInTransaction(
  db: Pick<SQLiteDBConnection, 'executeTransaction'> & Partial<Pick<SQLiteDBConnection, 'query'>>,
  serverId: string,
  books: BookRecord[],
  refreshedAt = new Date().toISOString(),
  preserveMissing = false,
  snapshotStartedAt: string | null = null,
): Promise<void> {
  const hasFileIds = books.some((book) => book.fileId != null);
  await enqueueNativeWrite(async () => {
    let identityTasks: capTask[] = [];
    if (hasFileIds) {
      if (typeof db.query === 'function') {
        const queryDb = { query: db.query.bind(db) };
        const plan = planBookFileReconciliation(
          serverId,
          await queryExistingBookIdentities(queryDb, serverId),
          books,
        );
        const schema =
          plan.rekeys.length > 0
            ? await queryIdentityMigrationSchema(queryDb)
            : DEFAULT_IDENTITY_MIGRATION_SCHEMA;
        identityTasks = plannedNativeIdentityTasks(serverId, plan, schema);
      } else {
        identityTasks = sqlOnlyIdentityTasks(serverId, books);
      }
    }

    const tasks: capTask[] = [];
    if (!preserveMissing) {
      tasks.push({
        statement: 'UPDATE books SET remote_available=0 WHERE server_id=? AND remote_available=1',
        values: [serverId],
      });
    }
    tasks.push(...identityTasks);
    for (const book of books) {
      tasks.push(
        replaceBookTask(
          serverId,
          { ...book, remoteAvailable: true },
          refreshedAt,
          snapshotStartedAt,
        ),
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
    await db.executeTransaction(tasks);
  });
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
  const result = await executeNativeQuery(
    db,
    `SELECT id, server_id, library_id, series_id, volume_id, chapter_id, file_id, file_name,
      title, author, series, format, pages, pages_read, created_at, last_read_at, download_path,
      download_status, file_size, remote_file_size, chapter_epub_index, multi_file_chapter,
      sync_progress, remote_available${includeDescription ? ', description_html' : ''}
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
    fileId: parseNullableInteger(row.file_id),
    fileName: sanitizeEpubFileName(row.file_name),
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
    fileSize: parseNullableInteger(row.file_size),
    remoteFileSize: parseNullableInteger(row.remote_file_size),
    chapterEpubIndex: Number(row.chapter_epub_index ?? 0),
    multiFileChapter: Number(row.multi_file_chapter ?? 0) !== 0,
    syncProgress: Number(row.sync_progress ?? 1) !== 0,
    remoteAvailable: Number(row.remote_available ?? 1) !== 0,
  }));
}

async function updateBookDownloadState(
  bookId: string,
  downloadPath: string | null,
  downloadStatus: string,
  fileSize: number | null,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      state.books = state.books.map((book) =>
        book.id === bookId ? { ...book, downloadPath, downloadStatus, fileSize } : book,
      );
    });
    return;
  }
  const db = await openDatabase();
  await executeNativeRun(
    db,
    'UPDATE books SET download_path=?, download_status=?, file_size=? WHERE id=?',
    [downloadPath, downloadStatus, fileSize, bookId],
  );
}

export async function markDownloaded(bookId: string, path: string, size: number): Promise<void> {
  await updateBookDownloadState(bookId, path, 'available', size);
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

const localOnlyReadingStateUpsertStatement = `INSERT INTO reading_state
  (book_id,cfi,kavita_xpath,percentage,local_updated_at,pending_sync,sync_revision)
  VALUES (?,?,?,?,?,0,1) ON CONFLICT(book_id) DO UPDATE SET cfi=excluded.cfi,
  kavita_xpath=excluded.kavita_xpath,percentage=excluded.percentage,
  local_updated_at=excluded.local_updated_at,pending_sync=0,
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
  pendingSync = true,
): capTask {
  return {
    statement: pendingSync ? readingStateUpsertStatement : localOnlyReadingStateUpsertStatement,
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
  const result = await executeNativeQuery(db, 'SELECT * FROM reading_state WHERE book_id=?', [
    bookId,
  ]);
  return parseReadingStateRow(result.values?.[0] as Record<string, unknown> | undefined);
}

function updateBrowserBookProgress(
  state: BrowserDatabaseState,
  bookId: string,
  pagesRead: number,
  lastReadAt: string,
): void {
  state.books = state.books.map((item) =>
    item.id === bookId ? { ...item, pagesRead, lastReadAt } : item,
  );
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
  const shouldSync = book.syncProgress !== false;
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
        pendingSync: shouldSync,
        syncRevision,
      };
      if (shouldSync) {
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
      } else {
        delete state.syncQueue[book.id];
      }
      updateBrowserBookProgress(state, book.id, pagesRead, now);
    });
    return;
  }
  const db = await openDatabase();
  if (!shouldSync) {
    await executeNativeTransaction(db, [
      createReadingStateTask(book.id, cfi, xpath, percentage, now, false),
      {
        statement: 'DELETE FROM sync_queue WHERE book_id=?',
        values: [book.id],
      },
      {
        statement: 'UPDATE books SET pages_read=?, last_read_at=? WHERE id=?',
        values: [pagesRead, now, book.id],
      },
    ]);
    return;
  }
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
  const shouldSync = book.syncProgress !== false;
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
      updateBrowserBookProgress(state, book.id, book.pages, now);
      state.readingState[book.id] = {
        cfi: '',
        xpath: null,
        percentage: 1,
        localUpdatedAt: now,
        syncedLocalUpdatedAt: state.readingState[book.id]?.syncedLocalUpdatedAt ?? null,
        serverUpdatedAt: state.readingState[book.id]?.serverUpdatedAt ?? null,
        pendingSync: shouldSync,
        syncRevision,
      };
      if (shouldSync) {
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
      } else {
        delete state.syncQueue[book.id];
      }
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
  tasks.push(createReadingStateTask(book.id, '', null, 1, now, shouldSync));
  if (shouldSync) {
    tasks.push(createSyncQueueTask(book.id, payload, now));
  } else {
    tasks.push({
      statement: 'DELETE FROM sync_queue WHERE book_id=?',
      values: [book.id],
    });
  }
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
      book.syncProgress === false ||
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
  const result = await executeNativeQuery(
    db,
    `SELECT sync_queue.book_id,sync_queue.payload_json,sync_queue.updated_at,sync_queue.revision,
      books.library_id,books.series_id,books.volume_id,books.chapter_id
    FROM sync_queue CROSS JOIN books ON books.id=sync_queue.book_id
    WHERE books.server_id=? AND books.remote_available=1 AND books.sync_progress=1
    ORDER BY sync_queue.updated_at`,
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

function summarizeSyncRows(
  rows: ReadonlyArray<{ updatedAt: string | null; lastError: string | null }>,
): SyncStatus {
  const firstFailed = rows.find((row) => Boolean(row.lastError));
  return {
    pendingCount: rows.length,
    failedCount: rows.filter((row) => Boolean(row.lastError)).length,
    lastError: firstFailed?.lastError ?? null,
    lastUpdatedAt: rows[0]?.updatedAt ?? null,
  };
}

export async function getSyncStatus(serverId: string): Promise<SyncStatus> {
  if (!Capacitor.isNativePlatform()) {
    const state = readBrowserState();
    return summarizeSyncRows(
      getBrowserSyncRows(state, serverId)
        .sort((a, b) => b.row.updatedAt.localeCompare(a.row.updatedAt))
        .map(({ row }) => ({
          updatedAt: row.updatedAt,
          lastError: row.lastError || null,
        })),
    );
  }
  const db = await openDatabase();
  const result = await executeNativeQuery(
    db,
    `SELECT sync_queue.updated_at,sync_queue.last_error
    FROM sync_queue CROSS JOIN books ON books.id=sync_queue.book_id
    WHERE books.server_id=? AND books.remote_available=1 AND books.sync_progress=1
    ORDER BY sync_queue.updated_at DESC`,
    [serverId],
  );
  return summarizeSyncRows(
    (result.values ?? []).map((row) => ({
      updatedAt: row.updated_at ? String(row.updated_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
    })),
  );
}

interface NormalizedRemoteProgress {
  now: string;
  serverUpdatedAt: string;
  pagesRead: number;
  percentage: number;
  xpath: string | null;
  readingState: StoredReadingState;
}

function normalizeRemoteProgress(
  book: BookRecord,
  remote: KavitaProgress,
  syncRevision: number,
): NormalizedRemoteProgress {
  const now = new Date().toISOString();
  const serverUpdatedAt = remote.lastModifiedUtc ?? now;
  const pagesRead = Math.max(0, Math.min(book.pages, remote.pageNum));
  const percentage = book.pages > 0 ? Math.min(0.999, pagesRead / book.pages) : 0;
  const xpath = remote.bookScrollId ?? null;
  return {
    now,
    serverUpdatedAt,
    pagesRead,
    percentage,
    xpath,
    readingState: {
      cfi: '',
      xpath,
      percentage,
      localUpdatedAt: now,
      syncedLocalUpdatedAt: now,
      serverUpdatedAt,
      pendingSync: false,
      syncRevision,
    },
  };
}

function applyBrowserRemoteProgress(
  state: BrowserDatabaseState,
  bookId: string,
  normalized: NormalizedRemoteProgress,
): void {
  state.readingState[bookId] = normalized.readingState;
  updateBrowserBookProgress(state, bookId, normalized.pagesRead, normalized.serverUpdatedAt);
}

export async function saveRemoteProgress(
  book: BookRecord,
  remote: KavitaProgress,
  expected: StoredReadingState | null,
): Promise<boolean> {
  const normalized = normalizeRemoteProgress(book, remote, (expected?.syncRevision ?? 0) + 1);
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
      applyBrowserRemoteProgress(state, book.id, normalized);
    });
  }

  const db = await openDatabase();
  return enqueueNativeWrite(async () => {
    if (!matches(await queryNativeReadingState(db, book.id))) return false;
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
          normalized.xpath,
          normalized.percentage,
          normalized.now,
          normalized.now,
          remote.pageNum,
          normalized.xpath,
          normalized.serverUpdatedAt,
          normalized.readingState.syncRevision,
        ],
      },
      {
        statement: 'UPDATE books SET pages_read=?,last_read_at=? WHERE id=?',
        values: [normalized.pagesRead, normalized.serverUpdatedAt, book.id],
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
  const normalized = normalizeRemoteProgress(book, remote, expectedRevision);

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
      delete state.syncQueue[book.id];
      applyBrowserRemoteProgress(state, book.id, normalized);
    });
  }

  const db = await openDatabase();
  return enqueueNativeWrite(async () => {
    await db.executeTransaction([
      {
        statement: `UPDATE reading_state SET cfi='',kavita_xpath=?,percentage=?,local_updated_at=?,
          synced_local_updated_at=?,server_page_num=?,server_xpath=?,server_updated_at=?,pending_sync=0
          WHERE book_id=? AND pending_sync=1 AND local_updated_at=? AND sync_revision=?
          AND EXISTS (SELECT 1 FROM sync_queue WHERE book_id=? AND revision=? AND updated_at=?)`,
        values: [
          normalized.xpath,
          normalized.percentage,
          normalized.now,
          normalized.now,
          remote.pageNum,
          normalized.xpath,
          normalized.serverUpdatedAt,
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
        values: [book.id, expectedRevision, expectedUpdatedAt, book.id, normalized.now],
      },
      {
        statement: `UPDATE books SET pages_read=?,last_read_at=?
          WHERE id=? AND EXISTS (
            SELECT 1 FROM reading_state WHERE book_id=? AND cfi=''
            AND local_updated_at=? AND pending_sync=0
          )`,
        values: [
          normalized.pagesRead,
          normalized.serverUpdatedAt,
          book.id,
          book.id,
          normalized.now,
        ],
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
      String(adopted.local_updated_at) === normalized.now &&
      Number(adopted.pending_sync) === 0 &&
      String(adopted.server_updated_at) === normalized.serverUpdatedAt,
    );
  });
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
  await updateBookDownloadState(bookId, null, 'none', null);
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
  const result = await executeNativeQuery(
    db,
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
    let nextTheme: string | undefined;
    let nextMode: string | undefined;
    updateBrowserState((state) => {
      for (const [key, value] of preferences) state.preferences[key] = value;
      nextTheme = state.preferences.uiTheme;
      nextMode = state.preferences.uiMode;
    });
    mirrorBootThemePreferences(preferences, {
      theme: nextTheme,
      mode: nextMode,
    });
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
  mirrorBootThemePreferences(preferences);
}
