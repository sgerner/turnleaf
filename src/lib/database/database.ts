import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type capTask,
  type DBSQLiteValues,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import { toKavitaPageNumber } from '../sync/conflict';
import type { KavitaProgress } from '../kavita/types';
import { hasNativeSqliteResetPlugin, SqliteReset } from '../native/sqlite-reset';
import {
  hasSavedNotesInPreferences,
  READING_NOTE_PREFERENCE_PREFIXES,
  type BookNoteMetadata,
} from '../reader/notes-backup';
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
let resetting: Promise<void> | null = null;
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

async function waitForActiveReset(): Promise<void> {
  while (resetting) {
    await resetting.catch(() => undefined);
  }
}

function isResetting(): boolean {
  return resetting !== null;
}

export async function openDatabase(): Promise<SQLiteDBConnection> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('Browser preview uses localStorage-backed storage.');
  }
  await waitForActiveReset();
  if (connection) return connection;

  if (opening) return opening;
  const pendingOpen = openNativeDatabase();
  opening = pendingOpen;
  try {
    const db = await pendingOpen;
    if (isResetting()) {
      await waitForActiveReset();
      return openDatabase();
    }
    connection = db;
    return db;
  } finally {
    if (opening === pendingOpen) {
      opening = null;
    }
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

  if (resetting) {
    return resetting;
  }

  const pendingReset = performNativeDatabaseReset();
  resetting = pendingReset;
  try {
    await pendingReset;
  } finally {
    if (resetting === pendingReset) {
      resetting = null;
    }
  }
}

async function performNativeDatabaseReset(): Promise<void> {
  const inflightOpen = opening;
  const openedDuringInflight = await inflightOpen?.catch(() => null);

  await enqueueNativeWrite(async () => {
    try {
      const handlesToClose = new Set<SQLiteDBConnection>();
      if (connection) handlesToClose.add(connection);
      if (openedDuringInflight) handlesToClose.add(openedDuringInflight);
      connection = null;
      opening = null;

      for (const handle of handlesToClose) {
        try {
          await handle.close();
        } catch {
          // Best effort only; a broken connection can still be removed.
        }
      }
      try {
        await CapacitorSQLite.closeConnection?.({ database: 'turnleaf', readonly: false });
      } catch {
        // Best effort only; no native connection may be registered yet.
      }
      if (hasNativeSqliteResetPlugin()) {
        await SqliteReset.deleteDatabase({ database: 'turnleaf' });
      } else {
        await CapacitorSQLite.deleteDatabase({ database: 'turnleaf', readonly: false });
      }
    } catch (error) {
      throw new Error(`Could not reset local storage: ${String(error)}`, { cause: error });
    }
  });
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
                hasSavedNotesInPreferences(state.preferences, book.id),
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
  OR EXISTS (
    SELECT 1 FROM preferences
    WHERE preferences.key IN ('readerBookmarks:' || books.id, 'readerAnnotations:' || books.id)
      AND TRIM(preferences.value) NOT IN ('', '[]', 'null')
  ))`;

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
  const result = await executeNativeQuery(
    db,
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
      updateBrowserBookProgress(state, book.id, pagesRead, now);
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
      updateBrowserBookProgress(state, book.id, book.pages, now);
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
  const result = await executeNativeQuery(
    db,
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
    WHERE books.server_id=? AND books.remote_available=1 ORDER BY sync_queue.updated_at DESC`,
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

function escapeSqlLikePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
}

async function queryPreferencesByPrefixOnConnection(
  db: Pick<SQLiteDBConnection, 'query'>,
  prefixes: readonly string[],
): Promise<Map<string, string>> {
  const clauses = prefixes.map(() => "key LIKE ? ESCAPE '\\'").join(' OR ');
  const result = await executeNativeQuery(
    db,
    `SELECT key, value FROM preferences WHERE ${clauses}`,
    prefixes.map(escapeSqlLikePrefix),
  );
  return new Map((result.values ?? []).map((row) => [String(row.key), String(row.value)]));
}

export async function getPreferencesByPrefix(
  prefixes: readonly string[],
): Promise<Map<string, string>> {
  if (prefixes.length === 0) return new Map();
  if (!Capacitor.isNativePlatform()) {
    const { preferences } = readBrowserState();
    const values = new Map<string, string>();
    for (const [key, value] of Object.entries(preferences)) {
      if (typeof value === 'string' && prefixes.some((prefix) => key.startsWith(prefix))) {
        values.set(key, value);
      }
    }
    return values;
  }
  const db = await openDatabase();
  return queryPreferencesByPrefixOnConnection(db, prefixes);
}

async function queryBookNoteMetadataOnConnection(
  db: Pick<SQLiteDBConnection, 'query'>,
): Promise<BookNoteMetadata[]> {
  const result = await executeNativeQuery(
    db,
    'SELECT id, title, author, series FROM books ORDER BY title',
  );
  return (result.values ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title),
    author: row.author ? String(row.author) : null,
    series: row.series ? String(row.series) : null,
  }));
}

export async function getAllBookNoteMetadata(): Promise<BookNoteMetadata[]> {
  if (!Capacitor.isNativePlatform()) {
    return readBrowserState().books.map((book) => ({
      id: book.id,
      title: book.title,
      author: book.author,
      series: book.series,
    }));
  }
  const db = await openDatabase();
  return queryBookNoteMetadataOnConnection(db);
}

export async function salvageOpenReadingNotePreferences(): Promise<{
  preferences: Map<string, string>;
  books: BookNoteMetadata[];
} | null> {
  if (!Capacitor.isNativePlatform()) {
    const preferences = await getPreferencesByPrefix(READING_NOTE_PREFERENCE_PREFIXES);
    const books = await getAllBookNoteMetadata();
    return { preferences, books };
  }
  if (!connection || resetting) return null;
  try {
    const preferences = await queryPreferencesByPrefixOnConnection(
      connection,
      READING_NOTE_PREFERENCE_PREFIXES,
    );
    const books = await queryBookNoteMetadataOnConnection(connection).catch(() => []);
    return { preferences, books };
  } catch {
    return null;
  }
}

export async function setPreference(key: string, value: string): Promise<void> {
  await setPreferences(new Map([[key, value]]));
}

export async function setPreferences(preferences: ReadonlyMap<string, string>): Promise<void> {
  if (preferences.size === 0) return;
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      for (const [key, value] of preferences) state.preferences[key] = value;
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
}
