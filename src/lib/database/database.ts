import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  type CapacitorSQLitePlugin,
  type capSQLiteChanges,
  type capTask,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import { toKavitaPageNumber } from '../sync/conflict';
import type { KavitaProgress } from '../kavita/types';
import {
  clearBootThemeCache,
  mirrorBootThemePreferences,
  readBootThemeCache,
} from '../themes/themes';

export const LATEST_SCHEMA_VERSION = 7;

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

export type NativeSQLiteConnection = Pick<
  SQLiteDBConnection,
  'close' | 'execute' | 'executeTransaction' | 'getVersion' | 'open' | 'query' | 'run'
>;

type NativeSQLiteClient = Pick<
  CapacitorSQLitePlugin,
  | 'beginTransaction'
  | 'checkConnectionsConsistency'
  | 'close'
  | 'commitTransaction'
  | 'createConnection'
  | 'deleteDatabase'
  | 'execute'
  | 'getVersion'
  | 'open'
  | 'query'
  | 'rollbackTransaction'
  | 'run'
> &
  Partial<Pick<CapacitorSQLitePlugin, 'closeConnection'>>;

const NATIVE_DATABASE = 'turnleaf';
const sqlitePlugin: NativeSQLiteClient = CapacitorSQLite;

let connection: NativeSQLiteConnection | null = null;
let connectionGeneration = 0;
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

function withNativeDatabase<T>(operation: (db: NativeSQLiteConnection) => Promise<T>): Promise<T> {
  return enqueueNativeWrite(async () => operation(await ensureNativeDatabase()));
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

export async function openDatabase(): Promise<NativeSQLiteConnection> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('Browser preview uses localStorage-backed storage.');
  }
  return enqueueNativeWrite(() => ensureNativeDatabase());
}

function normalizeQueryRows(
  values: Record<string, unknown>[] | undefined,
): Record<string, unknown>[] {
  if (!values?.length || typeof values[0] !== 'object' || values[0] === null) {
    return values ?? [];
  }
  if (!('ios_columns' in values[0]) || !Array.isArray(values[0].ios_columns)) {
    return values;
  }
  const columns = values[0].ios_columns as string[];
  return values.slice(1).map((row) => {
    const ordered: Record<string, unknown> = {};
    for (const column of columns) {
      ordered[column] = row[column];
    }
    return ordered;
  });
}

function createNativeConnection(database: string, generation: number): NativeSQLiteConnection {
  const dbRef = { database, readonly: false as const };
  const assertActive = (): void => {
    if (generation !== connectionGeneration) {
      throw new Error(`Connection to ${database} is closed`);
    }
  };
  return {
    open: async () => {
      assertActive();
      await sqlitePlugin.open(dbRef);
    },
    close: async () => {
      if (generation === connectionGeneration) {
        connectionGeneration += 1;
        connection = null;
      }
      await sqlitePlugin.close(dbRef);
    },
    getVersion: async () => {
      assertActive();
      return sqlitePlugin.getVersion(dbRef);
    },
    execute: async (statements, transaction = true, isSQL92 = true) => {
      assertActive();
      return sqlitePlugin.execute({ ...dbRef, statements, transaction, isSQL92 });
    },
    async query(statement, values, isSQL92 = true) {
      assertActive();
      const queryValues = values && values.length > 0 ? values : [];
      const result = await sqlitePlugin.query({
        ...dbRef,
        statement,
        values: queryValues,
        isSQL92: queryValues.length > 0 ? true : isSQL92,
      });
      return {
        ...result,
        values: normalizeQueryRows(result.values as Record<string, unknown>[] | undefined),
      };
    },
    async run(statement, values, transaction = true, returnMode = 'no', isSQL92 = true) {
      assertActive();
      const runValues = values && values.length > 0 ? values : [];
      const result = await sqlitePlugin.run({
        ...dbRef,
        statement,
        values: runValues,
        transaction,
        returnMode: returnMode as 'all' | 'one' | 'no',
        isSQL92: runValues.length > 0 ? true : isSQL92,
      });
      if (!result.changes?.values) return result;
      return {
        ...result,
        changes: {
          ...result.changes,
          values: normalizeQueryRows(result.changes.values as Record<string, unknown>[]),
        },
      };
    },
    async executeTransaction(tasks, isSQL92 = true): Promise<capSQLiteChanges> {
      assertActive();
      await sqlitePlugin.beginTransaction({ database });
      let changes = 0;
      try {
        for (const task of tasks) {
          assertActive();
          if (task.values && task.values.length > 0) {
            const returnMode = task.statement.toUpperCase().includes('RETURNING') ? 'all' : 'no';
            const result = await sqlitePlugin.run({
              ...dbRef,
              statement: task.statement,
              values: task.values,
              transaction: false,
              returnMode,
              isSQL92,
            });
            const count = result.changes?.changes ?? 0;
            if (count < 0) throw new Error('Error in transaction method run');
            changes += count;
          } else {
            const result = await sqlitePlugin.execute({
              ...dbRef,
              statements: task.statement,
              transaction: false,
              isSQL92,
            });
            const count = result.changes?.changes ?? 0;
            if (count < 0) throw new Error('Error in transaction method execute');
            changes += count;
          }
        }
        const committed = await sqlitePlugin.commitTransaction({ database });
        changes += committed.changes?.changes ?? 0;
        return { changes: { changes } };
      } catch (error) {
        await sqlitePlugin.rollbackTransaction({ database }).catch(() => {});
        throw error;
      }
    },
  };
}

async function ensureNativeDatabase(): Promise<NativeSQLiteConnection> {
  if (connection) return connection;
  const generation = connectionGeneration;
  await sqlitePlugin.checkConnectionsConsistency({ dbNames: [], openModes: [] });
  await sqlitePlugin.createConnection({
    database: NATIVE_DATABASE,
    encrypted: false,
    mode: 'no-encryption',
    version: 1,
    readonly: false,
  });
  const db = createNativeConnection(NATIVE_DATABASE, generation);
  try {
    await db.open();
    await db.execute('PRAGMA foreign_keys = ON;');
    await migrate(db);
    connection = db;
    return db;
  } catch (error) {
    await db.close().catch(() => {});
    await sqlitePlugin
      .closeConnection?.({ database: NATIVE_DATABASE, readonly: false })
      .catch(() => {});
    throw error;
  }
}

async function deleteNativeDatabase(): Promise<void> {
  try {
    await sqlitePlugin.deleteDatabase({ database: NATIVE_DATABASE, readonly: false });
  } catch (error) {
    const message = String(error);
    if (
      !message.includes(`No available connection for database ${NATIVE_DATABASE}`) &&
      !message.includes(`Connection to ${NATIVE_DATABASE} not available`)
    ) {
      throw error;
    }
    await sqlitePlugin.createConnection({
      database: NATIVE_DATABASE,
      encrypted: false,
      mode: 'no-encryption',
      version: 1,
      readonly: false,
    });
    await sqlitePlugin.deleteDatabase({ database: NATIVE_DATABASE, readonly: false });
  }
  await sqlitePlugin
    .closeConnection?.({ database: NATIVE_DATABASE, readonly: false })
    .catch(() => {});
}

export async function resetLocalDatabase(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    writeBrowserState(createBrowserState());
    clearBootThemeCache();
    return;
  }

  await enqueueNativeWrite(async () => {
    const active = connection;
    connectionGeneration += 1;
    connection = null;
    try {
      if (active) {
        try {
          await active.close();
        } catch {
          // Best effort only; a broken connection can still be removed.
        }
      }
      await deleteNativeDatabase();
      clearBootThemeCache();
    } catch (error) {
      throw new Error(`Could not reset local storage: ${String(error)}`, { cause: error });
    }
  });
}

async function migrate(db: NativeSQLiteConnection): Promise<void> {
  const current = await db.getVersion();
  if ((current.version ?? 0) >= LATEST_SCHEMA_VERSION) return;
  const { migrations } = await import('./schema');
  for (const migration of migrations) {
    if (migration.version <= (current.version ?? 0)) continue;
    await db.executeTransaction([
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
  await withNativeDatabase((db) =>
    db.run(
      'INSERT INTO server_config (id,display_name,base_url,credential_ref,kavita_version,last_connected_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,base_url=excluded.base_url,credential_ref=excluded.credential_ref,kavita_version=excluded.kavita_version,last_connected_at=excluded.last_connected_at',
      [
        config.id,
        config.displayName,
        config.baseUrl,
        config.credentialRef,
        config.kavitaVersion,
        config.lastConnectedAt,
      ],
    ),
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
  await withNativeDatabase((db) => db.run('DELETE FROM server_config WHERE id=?', [serverId]));
}

export async function getServer(): Promise<ServerConfig | null> {
  if (!Capacitor.isNativePlatform()) {
    return readBrowserState().serverConfig;
  }
  return withNativeDatabase(async (db) => {
    const result = await db.query(
      'SELECT id,display_name,base_url,credential_ref,kavita_version,last_connected_at FROM server_config ORDER BY last_connected_at DESC LIMIT 1',
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
  });
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
                Boolean(state.readingState[book.id]),
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
  const tasks = buildReconcileBookTasks(
    serverId,
    books,
    new Date().toISOString(),
    preserveMissing,
    snapshotStartedAt,
  );
  if (!tasks.length) return;
  await withNativeDatabase((db) => db.executeTransaction(tasks));
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
  OR EXISTS (SELECT 1 FROM sync_queue WHERE sync_queue.book_id=books.id))`;

function buildReconcileBookTasks(
  serverId: string,
  books: BookRecord[],
  refreshedAt: string,
  preserveMissing: boolean,
  snapshotStartedAt: string | null,
): capTask[] {
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
  return tasks;
}

/** Apply metadata and optional removal reconciliation atomically on native SQLite. */
export async function reconcileBooksInTransaction(
  db: Pick<SQLiteDBConnection, 'executeTransaction'>,
  serverId: string,
  books: BookRecord[],
  refreshedAt = new Date().toISOString(),
  preserveMissing = false,
  snapshotStartedAt: string | null = null,
): Promise<void> {
  const tasks = buildReconcileBookTasks(
    serverId,
    books,
    refreshedAt,
    preserveMissing,
    snapshotStartedAt,
  );
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
  return withNativeDatabase(async (db) => {
    const result = await db.query(
      `SELECT id,server_id,library_id,series_id,volume_id,chapter_id,title,author,series,format,pages,pages_read,created_at,last_read_at,download_path,download_status,file_size,remote_available${includeDescription ? ',description_html' : ''} FROM books WHERE server_id=? ORDER BY title`,
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
  });
}

async function updateBookDownloadState(
  bookId: string,
  downloadPath: string | null,
  downloadStatus: string,
  fileSize: number | null,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      if (!state.books.some((book) => book.id === bookId)) return false;
      state.books = state.books.map((book) =>
        book.id === bookId ? { ...book, downloadPath, downloadStatus, fileSize } : book,
      );
    });
    return;
  }
  await withNativeDatabase((db) =>
    db.run('UPDATE books SET download_path=?, download_status=?, file_size=? WHERE id=?', [
      downloadPath,
      downloadStatus,
      fileSize,
      bookId,
    ]),
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
  return withNativeDatabase((db) => queryNativeReadingState(db, bookId));
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
      if (!state.books.some((item) => item.id === book.id)) return false;
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
  const payload = {
    libraryId: book.libraryId,
    seriesId: book.seriesId,
    volumeId: book.volumeId,
    chapterId: book.chapterId,
    pageNum: pagesRead,
    bookScrollId: xpath,
  };
  await withNativeDatabase((db) =>
    db.executeTransaction([
      createReadingStateTask(book.id, cfi, xpath, percentage, now),
      createSyncQueueTask(book.id, payload, now),
      {
        statement: 'UPDATE books SET pages_read=?, last_read_at=? WHERE id=?',
        values: [pagesRead, now, book.id],
      },
    ]),
  );
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
      if (!state.books.some((item) => item.id === book.id)) return false;
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
  const tasks: capTask[] = [
    {
      statement: 'UPDATE books SET pages_read=?, last_read_at=? WHERE id=?',
      values: [book.pages, now, book.id],
    },
    createReadingStateTask(book.id, '', null, 1, now),
    createSyncQueueTask(book.id, payload, now),
  ];
  await withNativeDatabase((db) => db.executeTransaction(tasks));
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
  return withNativeDatabase(async (db) => {
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
  return withNativeDatabase(async (db) => {
    const result = await db.query(
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
  });
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

  return withNativeDatabase(async (db) => {
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

  return withNativeDatabase(async (db) => {
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
  await withNativeDatabase((db) =>
    db.executeTransaction([
      {
        statement:
          'UPDATE reading_state SET pending_sync=0,synced_local_updated_at=?,server_updated_at=? WHERE book_id=? AND local_updated_at=? AND EXISTS (SELECT 1 FROM sync_queue WHERE book_id=? AND updated_at=? AND revision=?)',
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
    ]),
  );
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
  await withNativeDatabase((db) =>
    db.run(
      'UPDATE sync_queue SET attempt_count=attempt_count+1,last_attempt_at=?,last_error=? WHERE book_id=? AND updated_at=? AND revision=?',
      [new Date().toISOString(), error.slice(0, 240), bookId, expectedUpdatedAt, expectedRevision],
    ),
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
  return withNativeDatabase(async (db) => {
    const result = await db.query(
      `SELECT key, value FROM preferences WHERE key IN (${keys.map(() => '?').join(', ')})`,
      [...keys],
    );
    return new Map((result.values ?? []).map((row) => [String(row.key), String(row.value)]));
  });
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
  await withNativeDatabase(async (db) => {
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO preferences (key,value,updated_at)
      VALUES ${Array.from(preferences, () => '(?,?,?)').join(', ')}
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
      Array.from(preferences, ([key, value]) => [key, value, now]).flat(),
    );
    let fallback: { theme?: string | undefined; mode?: string | undefined } | undefined;
    if (
      typeof window !== 'undefined' &&
      window.localStorage &&
      preferences.has('uiTheme') !== preferences.has('uiMode') &&
      readBootThemeCache() === null
    ) {
      const saved = await db.query(
        "SELECT key, value FROM preferences WHERE key IN ('uiTheme', 'uiMode')",
      );
      const byKey = new Map(
        (saved.values ?? []).map((row) => [String(row.key), String(row.value)]),
      );
      fallback = {
        theme: byKey.get('uiTheme'),
        mode: byKey.get('uiMode'),
      };
    }
    mirrorBootThemePreferences(preferences, fallback);
  });
}
