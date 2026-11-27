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
import {
  hasNonEmptyReaderPreferenceValue,
  mergeReaderPreferenceValue,
  READER_PREFERENCE_PREFIXES,
  type ReaderPreferencePrefix,
} from '../reader/bookmarks';
import { clearBootThemeCache, mirrorBootThemePreferences } from '../themes/themes';
import {
  migrations,
  V8_BOOK_COLUMNS,
  V8_BOOK_INDEX_NAME,
  V8_BOOK_INDEX_SQL,
  V8_MIGRATION_VERSION,
} from './schema';

export { mergeReaderPreferenceValue, READER_PREFERENCE_PREFIXES, type ReaderPreferencePrefix };

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
  downloadedBytes?: number | null;
  downloadedPages?: number | null;
  downloadOutdated?: boolean;
  hasLocalData?: boolean;
  chapterKey?: string | null;
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
  syncProgress?: boolean;
}

function normalizeLineageText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function semanticLineageTitle(book: Pick<LineageCandidate, 'title' | 'chapterId'>): string {
  const trimmed = book.title.trim();
  if (!trimmed || trimmed === `Book ${book.chapterId}`) return '';
  return normalizeLineageText(trimmed);
}

function normalizedChapterMarker(book: Pick<LineageCandidate, 'chapterKey'>): string | null {
  const raw = book.chapterKey?.trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith('isbn:')) {
    const isbn = raw.slice('isbn:'.length).replace(/[\s-]+/g, '');
    return isbn ? `isbn:${isbn}` : null;
  }
  return raw;
}

function extractNormalizedIsbn(book: Pick<LineageCandidate, 'chapterKey'>): string | null {
  const marker = normalizedChapterMarker(book);
  return marker?.startsWith('isbn:') ? marker.slice('isbn:'.length) : null;
}

function hasConflictingChapterIdentity(a: LineageCandidate, b: LineageCandidate): boolean {
  if ((a.syncProgress === false) !== (b.syncProgress === false)) return true;
  const isbnA = extractNormalizedIsbn(a);
  const isbnB = extractNormalizedIsbn(b);
  if (isbnA !== null && isbnB !== null && isbnA !== isbnB) return true;
  const markerA = normalizedChapterMarker(a);
  const markerB = normalizedChapterMarker(b);
  if (
    markerA?.startsWith('number:') &&
    markerB?.startsWith('number:') &&
    markerA !== 'number:0' &&
    markerB !== 'number:0' &&
    markerA !== markerB
  ) {
    return true;
  }
  if (markerA?.startsWith('range:') && markerB?.startsWith('range:') && markerA !== markerB) {
    return true;
  }
  return false;
}

const LINEAGE_KEY_TIERS: ReadonlyArray<(book: LineageCandidate) => string | null> = [
  (book) => {
    const isbn = extractNormalizedIsbn(book);
    return isbn ? `isbn|isbn:${isbn}` : null;
  },
  (book) => {
    const marker = normalizedChapterMarker(book);
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
    const marker = normalizedChapterMarker(book) ?? '';
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
      if (hasConflictingChapterIdentity(oldBook, newBook)) continue;
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
    hasNonEmptyReaderPreferenceValue(preferences[`${prefix}${bookId}`]),
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
const recentLineageRemaps = new Map<string, string>();

function recordLineageRemaps(
  serverId: string,
  incomingBooks: readonly Pick<BookRecord, 'id'>[],
  remapped: ReadonlyMap<string, string>,
): void {
  for (const book of incomingBooks) {
    recentLineageRemaps.delete(book.id);
  }
  for (const [oldId, newId] of remapped) {
    if (oldId !== newId) {
      recentLineageRemaps.set(oldId, newId);
    }
  }
  const prefix = `${serverId}:`;
  for (const [oldId, targetId] of recentLineageRemaps) {
    if (!oldId.startsWith(prefix)) continue;
    let current = targetId;
    const seen = new Set([oldId]);
    while (recentLineageRemaps.has(current) && !seen.has(current)) {
      seen.add(current);
      current = recentLineageRemaps.get(current)!;
    }
    if (current !== targetId) recentLineageRemaps.set(oldId, current);
  }
}

function clearServerLineageRemaps(serverId?: string): void {
  if (!serverId) {
    recentLineageRemaps.clear();
    return;
  }
  const prefix = `${serverId}:`;
  for (const [oldId, newId] of recentLineageRemaps) {
    if (oldId.startsWith(prefix) || newId.startsWith(prefix)) {
      recentLineageRemaps.delete(oldId);
    }
  }
}

function resolveRemappedBookId(bookId: string): string {
  let current = bookId;
  const seen = new Set<string>();
  while (recentLineageRemaps.has(current) && !seen.has(current)) {
    seen.add(current);
    current = recentLineageRemaps.get(current)!;
  }
  return current;
}

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
    clearServerLineageRemaps();
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
    clearServerLineageRemaps();
    clearBootThemeCache();
  } catch (error) {
    throw new Error(`Could not reset local storage: ${String(error)}`, { cause: error });
  }
}

const INSPECT_BOOKS_V8_SCHEMA_SQL = `
  SELECT 'column' AS kind, name FROM pragma_table_info('books')
  UNION ALL
  SELECT 'index' AS kind, name FROM pragma_index_list('books')
`;

const FULL_V8_MIGRATION_STATEMENTS = [
  ...V8_BOOK_COLUMNS.map(
    (column) => `ALTER TABLE books ADD COLUMN ${column.name} ${column.definition};`,
  ),
  V8_BOOK_INDEX_SQL,
].join('\n');

async function buildV8ReconciliationStatements(
  db: Partial<Pick<SQLiteDBConnection, 'query'>>,
  currentVersion: number,
): Promise<string | null> {
  if (typeof db.query !== 'function') {
    return currentVersion < V8_MIGRATION_VERSION ? FULL_V8_MIGRATION_STATEMENTS : null;
  }
  const result = await executeNativeQuery(
    { query: db.query.bind(db) },
    INSPECT_BOOKS_V8_SCHEMA_SQL,
  );
  const existingColumns = new Set<string>();
  const existingIndexes = new Set<string>();
  for (const row of result.values ?? []) {
    const name = typeof row.name === 'string' ? row.name : '';
    if (!name) continue;
    if (row.kind === 'index') {
      existingIndexes.add(name);
    } else {
      existingColumns.add(name);
    }
  }
  if (existingColumns.size === 0) {
    return currentVersion < V8_MIGRATION_VERSION ? FULL_V8_MIGRATION_STATEMENTS : null;
  }
  const missingColumns = V8_BOOK_COLUMNS.filter((column) => !existingColumns.has(column.name));
  const missingIndex = !existingIndexes.has(V8_BOOK_INDEX_NAME);
  if (missingColumns.length === 0 && !missingIndex) {
    return null;
  }
  return [
    ...missingColumns.map(
      (column) => `ALTER TABLE books ADD COLUMN ${column.name} ${column.definition};`,
    ),
    V8_BOOK_INDEX_SQL,
  ].join('\n');
}

export async function migrateDatabase(
  db: Pick<SQLiteDBConnection, 'executeTransaction' | 'getVersion'> &
    Partial<Pick<SQLiteDBConnection, 'query'>>,
): Promise<void> {
  const current = await db.getVersion();
  const currentVersion = current.version ?? 0;
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    if (migration.version === V8_MIGRATION_VERSION && currentVersion > 0) {
      const statements = await buildV8ReconciliationStatements(db, currentVersion);
      await executeNativeTransaction(db, [
        ...(statements ? [{ statement: statements }] : []),
        { statement: `PRAGMA user_version = ${migration.version};` },
      ]);
      continue;
    }
    await executeNativeTransaction(db, [
      { statement: migration.statements },
      { statement: `PRAGMA user_version = ${migration.version};` },
    ]);
  }
  if (currentVersion >= V8_MIGRATION_VERSION) {
    const statements = await buildV8ReconciliationStatements(db, currentVersion);
    if (statements) {
      await executeNativeTransaction(db, [{ statement: statements }]);
    }
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
      for (const book of state.books) {
        for (const prefix of READER_PREFERENCE_PREFIXES) {
          delete state.preferences[`${prefix}${book.id}`];
        }
      }
      state.serverConfig = null;
      state.books = [];
      state.readingState = {};
      state.syncQueue = {};
    });
    clearServerLineageRemaps(serverId);
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
  clearServerLineageRemaps(serverId);
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
    recordLineageRemaps(serverId, books, remapped);
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
   remote_file_size, downloaded_bytes, downloaded_pages, chapter_key,
   file_id, file_name, chapter_epub_index, multi_file_chapter, sync_progress)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
   file_id=COALESCE(excluded.file_id, books.file_id),
   file_name=COALESCE(excluded.file_name, books.file_name),
   chapter_epub_index=CASE WHEN ?=1 THEN excluded.chapter_epub_index ELSE books.chapter_epub_index END,
   multi_file_chapter=CASE WHEN ?=1 THEN excluded.multi_file_chapter ELSE books.multi_file_chapter END,
   sync_progress=CASE WHEN ?=1 THEN excluded.sync_progress ELSE books.sync_progress END,
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
      book.fileId ?? null,
      book.fileName ?? null,
      book.chapterEpubIndex ?? 0,
      book.multiFileChapter ? 1 : 0,
      book.syncProgress === false ? 0 : 1,
      book.chapterEpubIndex !== undefined ? 1 : 0,
      book.multiFileChapter !== undefined ? 1 : 0,
      book.syncProgress !== undefined ? 1 : 0,
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
  fileId: number | null;
  fileName: string | null;
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
  chapterEpubIndex: number;
  multiFileChapter: boolean;
  syncProgress: boolean;
  hasSequenceColumns: boolean;
  sortOrder: number | null;
  minNumber: number | null;
  volumeNumber: number | null;
}

const STUDY_TABLE_NAMES = ['annotations', 'bookmarks', 'reading_history'] as const;

function buildRetainedBookCondition(presentStudyTables: ReadonlySet<string>): string {
  const studyClauses = STUDY_TABLE_NAMES.filter((table) => presentStudyTables.has(table)).map(
    (table) => `OR EXISTS (SELECT 1 FROM ${table} WHERE ${table}.book_id=books.id)`,
  );
  if (studyClauses.length === 0) return retainedBookCondition;
  return `${retainedBookCondition.slice(0, -1)}\n  ${studyClauses.join('\n  ')})`;
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
    const presentStudyTables = new Set<string>();
    const readingByBookId = new Map<
      string,
      { localUpdatedAt: string; serverUpdatedAt: string | null; pendingSync: boolean }
    >();
    const syncPayloadByBookId = new Map<string, string>();
    const readerPreferences = new Map<string, string>();

    if (!preserveMissing && typeof db.query === 'function') {
      const [existingResult, studyTableResult] = await Promise.all([
        db.query('SELECT * FROM books WHERE server_id=?', [serverId]),
        db.query(
          `SELECT name FROM sqlite_master
            WHERE type='table' AND name IN ('annotations', 'bookmarks', 'reading_history')`,
        ),
      ]);
      for (const row of studyTableResult.values ?? []) {
        if (typeof row.name === 'string') presentStudyTables.add(row.name);
      }
      const existingRows = existingResult.values ?? [];
      for (const row of existingRows) {
        const hasSequenceColumns =
          Object.prototype.hasOwnProperty.call(row, 'sort_order') &&
          Object.prototype.hasOwnProperty.call(row, 'min_number') &&
          Object.prototype.hasOwnProperty.call(row, 'volume_number');
        const snapshot: ExistingBookSnapshot = {
          id: String(row.id),
          libraryId: Number(row.library_id),
          seriesId: Number(row.series_id),
          volumeId: Number(row.volume_id),
          chapterId: Number(row.chapter_id),
          fileId: row.file_id == null || row.file_id === '' ? null : Number(row.file_id),
          fileName: row.file_name ? String(row.file_name) : null,
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
          chapterEpubIndex: Number(row.chapter_epub_index ?? 0),
          multiFileChapter: Number(row.multi_file_chapter ?? 0) !== 0,
          syncProgress: Number(row.sync_progress ?? 1) !== 0,
          hasSequenceColumns,
          sortOrder: row.sort_order == null ? null : Number(row.sort_order),
          minNumber: row.min_number == null ? null : Number(row.min_number),
          volumeNumber: row.volume_number == null ? null : Number(row.volume_number),
        };
        existingById.set(snapshot.id, snapshot);
      }
      remapped = matchBookLineage([...existingById.values()], books);

      if (remapped.size > 0) {
        const prefKeysToLoad: string[] = [];
        for (const [oldId, newId] of remapped) {
          for (const prefix of READER_PREFERENCE_PREFIXES) {
            prefKeysToLoad.push(`${prefix}${oldId}`, `${prefix}${newId}`);
          }
        }
        const prefChunks: Promise<DBSQLiteValues>[] = [];
        for (let offset = 0; offset < prefKeysToLoad.length; offset += 450) {
          const chunk = prefKeysToLoad.slice(offset, offset + 450);
          prefChunks.push(
            db.query(
              `SELECT key, value FROM preferences WHERE key IN (${chunk.map(() => '?').join(', ')})`,
              chunk,
            ),
          );
        }
        const [readingRows, queueRows, ...prefResults] = await Promise.all([
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
          ...prefChunks,
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
        for (const prefRows of prefResults) {
          for (const row of prefRows.values ?? []) {
            readerPreferences.set(String(row.key), String(row.value));
          }
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
            fileId: book.fileId !== undefined ? book.fileId : oldRow.fileId,
            fileName: book.fileName !== undefined ? book.fileName : oldRow.fileName,
            chapterEpubIndex:
              book.chapterEpubIndex !== undefined ? book.chapterEpubIndex : oldRow.chapterEpubIndex,
            multiFileChapter:
              book.multiFileChapter !== undefined ? book.multiFileChapter : oldRow.multiFileChapter,
            syncProgress: book.syncProgress !== undefined ? book.syncProgress : oldRow.syncProgress,
            pagesRead: nextPagesRead,
            lastReadAt: preserveReadDate ? oldRow.lastReadAt : book.lastReadAt,
          },
          refreshedAt,
          snapshotStartedAt,
        ),
      );
      if (
        oldRow.hasSequenceColumns &&
        (oldRow.sortOrder !== null || oldRow.minNumber !== null || oldRow.volumeNumber !== null)
      ) {
        tasks.push({
          statement: `UPDATE books
            SET sort_order=COALESCE(sort_order, ?),
                min_number=COALESCE(min_number, ?),
                volume_number=COALESCE(volume_number, ?)
            WHERE id=?`,
          values: [oldRow.sortOrder, oldRow.minNumber, oldRow.volumeNumber, book.id],
        });
      }
    }

    for (const [oldId, newId] of remapped) {
      const newBook = incomingById.get(newId);
      if (!newBook) continue;
      if (readingByBookId.has(oldId)) {
        tasks.push({
          statement: 'UPDATE OR REPLACE reading_state SET book_id=? WHERE book_id=?',
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
          statement: `UPDATE OR REPLACE sync_queue
            SET book_id=?, payload_json=?, attempt_count=0, last_attempt_at=NULL, last_error=NULL
            WHERE book_id=?`,
          values: [newId, rewrittenPayload, oldId],
        });
      }
      if (presentStudyTables.has('annotations')) {
        tasks.push({
          statement: `UPDATE OR IGNORE annotations
            SET id = CASE WHEN id LIKE ? THEN ? || substr(id, ?) ELSE id END,
                book_id = ?
            WHERE book_id = ?`,
          values: [`${oldId}:%`, `${newId}:`, oldId.length + 2, newId, oldId],
        });
      }
      if (presentStudyTables.has('bookmarks')) {
        tasks.push({
          statement: `UPDATE OR IGNORE bookmarks
            SET id = CASE WHEN id LIKE ? THEN ? || substr(id, ?) ELSE id END,
                book_id = ?
            WHERE book_id = ?`,
          values: [`${oldId}:%`, `${newId}:`, oldId.length + 2, newId, oldId],
        });
      }
      if (presentStudyTables.has('reading_history')) {
        tasks.push({
          statement: 'UPDATE OR IGNORE reading_history SET book_id = ? WHERE book_id = ?',
          values: [newId, oldId],
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
      const activeRetainedCondition = buildRetainedBookCondition(presentStudyTables);
      tasks.push({
        statement: `DELETE FROM preferences WHERE key IN (
          SELECT 'readerBookmarks:' || id FROM books
            WHERE server_id=? AND remote_available=0 AND NOT ${activeRetainedCondition}
          UNION ALL
          SELECT 'readerAnnotations:' || id FROM books
            WHERE server_id=? AND remote_available=0 AND NOT ${activeRetainedCondition}
          UNION ALL
          SELECT 'readerHistory:' || id FROM books
            WHERE server_id=? AND remote_available=0 AND NOT ${activeRetainedCondition}
        )`,
        values: [serverId, serverId, serverId],
      });
      tasks.push({
        statement: `DELETE FROM books WHERE server_id=? AND remote_available=0
          AND NOT ${activeRetainedCondition}`,
        values: [serverId],
      });
    }

    if (tasks.length > 0) {
      await db.executeTransaction(tasks);
    }
    recordLineageRemaps(serverId, books, remapped);
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
        const remoteFileSize =
          book.remoteFileSize !== undefined ? book.remoteFileSize : (book.fileSize ?? null);
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
  const result = await executeNativeQuery(
    db,
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
    const remoteFileSize =
      row.remote_file_size == null
        ? row.downloaded_bytes == null
          ? fileSize
          : null
        : Number(row.remote_file_size);
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
      const targetId = state.books.some((item) => item.id === bookId)
        ? bookId
        : resolveRemappedBookId(bookId);
      state.books = state.books.map((book) => {
        if (book.id !== targetId) return book;
        const previouslyUndownloaded = !book.downloadPath && book.downloadStatus === 'none';
        const remoteFileSize =
          book.remoteFileSize !== undefined
            ? book.remoteFileSize
            : previouslyUndownloaded
              ? (book.fileSize ?? null)
              : null;
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
          remoteFileSize,
          downloadedBytes: baselineBytes,
          downloadedPages,
          downloadOutdated: isBookDownloadOutdated({
            downloadPath: path,
            downloadStatus: 'available',
            pages: book.pages,
            remoteFileSize,
            downloadedBytes: baselineBytes,
            downloadedPages,
          }),
        };
      });
    });
    return;
  }
  const db = await openDatabase();
  await enqueueNativeWrite(async () => {
    const effectiveId = await resolveNativeRemappedBookId(db, bookId);
    await db.run(
      `UPDATE books SET
        download_path=?,
        download_status='available',
        file_size=?,
        remote_file_size=COALESCE(
          remote_file_size,
          CASE WHEN download_path IS NULL AND download_status='none' THEN file_size ELSE NULL END
        ),
        downloaded_bytes=?,
        downloaded_pages=COALESCE(?, CASE WHEN pages>0 THEN pages ELSE NULL END)
      WHERE id=?`,
      [path, size, baselineBytes, baseline?.downloadedPages ?? null, effectiveId],
    );
  });
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

async function resolveNativeRemappedBookId(
  db: Pick<SQLiteDBConnection, 'query'>,
  bookId: string,
): Promise<string> {
  const candidateId = resolveRemappedBookId(bookId);
  if (candidateId === bookId) return bookId;
  const existingOriginal = await db.query('SELECT 1 FROM books WHERE id=?', [bookId]);
  if (existingOriginal.values?.length) return bookId;
  const existingRemapped = await db.query('SELECT 1 FROM books WHERE id=?', [candidateId]);
  return existingRemapped.values?.length ? candidateId : bookId;
}

async function resolveNativeRemappedTargetBook(
  db: Pick<SQLiteDBConnection, 'query'>,
  book: BookRecord,
): Promise<BookRecord> {
  const candidateId = resolveRemappedBookId(book.id);
  if (candidateId === book.id) return book;
  const existingOriginal = await db.query('SELECT 1 FROM books WHERE id=?', [book.id]);
  if (existingOriginal.values?.length) return book;
  const remappedRow = (
    await db.query(
      `SELECT id, server_id, library_id, series_id, volume_id, chapter_id,
        pages, download_path, download_status, downloaded_pages
      FROM books WHERE id=?`,
      [candidateId],
    )
  ).values?.[0];
  if (!remappedRow) return book;
  const hasRemappedDownload =
    Boolean(remappedRow.download_path) ||
    String(remappedRow.download_status ?? 'none') === 'available';
  return {
    ...book,
    id: String(remappedRow.id),
    serverId: String(remappedRow.server_id),
    libraryId: Number(remappedRow.library_id),
    seriesId: Number(remappedRow.series_id),
    volumeId: Number(remappedRow.volume_id),
    chapterId: Number(remappedRow.chapter_id),
    pages: Number(remappedRow.pages ?? 0) || book.pages,
    downloadPath: remappedRow.download_path ? String(remappedRow.download_path) : null,
    downloadStatus: String(remappedRow.download_status ?? 'none'),
    downloadedPages:
      hasRemappedDownload && remappedRow.downloaded_pages != null
        ? Number(remappedRow.downloaded_pages)
        : null,
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
      const candidateId = state.books.some((item) => item.id === book.id)
        ? book.id
        : resolveRemappedBookId(book.id);
      const stored = state.books.find((item) => item.id === candidateId);
      const effectiveId = stored ? stored.id : book.id;
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
          Number(state.readingState[effectiveId]?.syncRevision ?? 0),
          Number(state.syncQueue[effectiveId]?.revision ?? 0),
        ) + 1;
      state.readingState[effectiveId] = {
        cfi,
        xpath,
        percentage,
        localUpdatedAt: now,
        syncedLocalUpdatedAt: state.readingState[effectiveId]?.syncedLocalUpdatedAt ?? null,
        serverUpdatedAt: state.readingState[effectiveId]?.serverUpdatedAt ?? null,
        pendingSync: true,
        syncRevision,
      };
      state.syncQueue[effectiveId] = {
        bookId: effectiveId,
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
        createdAt: state.syncQueue[effectiveId]?.createdAt ?? now,
        updatedAt: now,
        revision: syncRevision,
      };
      updateBrowserBookProgress(state, effectiveId, pagesRead, now);
    });
    return;
  }
  const db = await openDatabase();
  await enqueueNativeWrite(async () => {
    const targetBook = await resolveNativeRemappedTargetBook(db, book);
    let totalPages = targetBook.pages;
    let hasDownload = Boolean(targetBook.downloadPath) || targetBook.downloadStatus === 'available';
    let downloadedPages = hasDownload ? (targetBook.downloadedPages ?? null) : null;
    if (targetBook.downloadedPages === undefined && spineIndex !== undefined) {
      const row = (
        await db.query(
          'SELECT pages, download_path, download_status, downloaded_pages FROM books WHERE id=?',
          [targetBook.id],
        )
      ).values?.[0];
      if (row) {
        totalPages = Number(row.pages ?? 0) || targetBook.pages;
        hasDownload =
          Boolean(row.download_path) || String(row.download_status ?? 'none') === 'available';
        downloadedPages =
          hasDownload && row.downloaded_pages != null ? Number(row.downloaded_pages) : null;
      }
    }
    const pagesRead = toKavitaPageNumber(percentage, totalPages, spineIndex, downloadedPages);
    const payload = {
      libraryId: targetBook.libraryId,
      seriesId: targetBook.seriesId,
      volumeId: targetBook.volumeId,
      chapterId: targetBook.chapterId,
      pageNum: pagesRead,
      bookScrollId: xpath,
    };
    await db.executeTransaction([
      createReadingStateTask(targetBook.id, cfi, xpath, percentage, now),
      createSyncQueueTask(targetBook.id, payload, now),
      {
        statement: 'UPDATE books SET pages_read=?, last_read_at=? WHERE id=?',
        values: [pagesRead, now, targetBook.id],
      },
    ]);
  });
}

export async function markBookCompleted(book: BookRecord): Promise<void> {
  const now = new Date().toISOString();
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      const candidateId = state.books.some((item) => item.id === book.id)
        ? book.id
        : resolveRemappedBookId(book.id);
      const stored = state.books.find((item) => item.id === candidateId);
      const effectiveId = stored ? stored.id : book.id;
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
          Number(state.readingState[effectiveId]?.syncRevision ?? 0),
          Number(state.syncQueue[effectiveId]?.revision ?? 0),
        ) + 1;
      updateBrowserBookProgress(state, effectiveId, completedPages, now);
      state.readingState[effectiveId] = {
        cfi: '',
        xpath: null,
        percentage: 1,
        localUpdatedAt: now,
        syncedLocalUpdatedAt: state.readingState[effectiveId]?.syncedLocalUpdatedAt ?? null,
        serverUpdatedAt: state.readingState[effectiveId]?.serverUpdatedAt ?? null,
        pendingSync: true,
        syncRevision,
      };
      state.syncQueue[effectiveId] = {
        bookId: effectiveId,
        payloadJson: JSON.stringify(payload),
        serverId: target.serverId,
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
        createdAt: state.syncQueue[effectiveId]?.createdAt ?? now,
        updatedAt: now,
        revision: syncRevision,
      };
    });
    return;
  }
  const db = await openDatabase();
  await enqueueNativeWrite(async () => {
    const targetBook = await resolveNativeRemappedTargetBook(db, book);
    const payload: PendingProgressPayload = {
      libraryId: targetBook.libraryId,
      seriesId: targetBook.seriesId,
      volumeId: targetBook.volumeId,
      chapterId: targetBook.chapterId,
      pageNum: targetBook.pages,
      bookScrollId: null,
    };
    const tasks: capTask[] = [
      {
        statement: 'UPDATE books SET pages_read=MAX(pages, ?), last_read_at=? WHERE id=?',
        values: [targetBook.pages, now, targetBook.id],
      },
    ];
    tasks.push(createReadingStateTask(targetBook.id, '', null, 1, now));
    tasks.push(createSyncQueueTask(targetBook.id, payload, now));
    await db.executeTransaction(tasks);
  });
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
  if (!Capacitor.isNativePlatform()) {
    updateBrowserState((state) => {
      const targetId = state.books.some((item) => item.id === bookId)
        ? bookId
        : resolveRemappedBookId(bookId);
      state.books = state.books.flatMap((book) => {
        if (book.id !== targetId) return [book];
        const updated: BookRecord = {
          ...book,
          downloadPath: null,
          downloadStatus: 'none',
          fileSize: book.remoteFileSize ?? null,
          downloadedBytes: null,
          downloadedPages: null,
          downloadOutdated: false,
        };
        if (updated.remoteAvailable === false && !hasBrowserLocalData(state, updated)) {
          for (const prefix of READER_PREFERENCE_PREFIXES) {
            delete state.preferences[`${prefix}${updated.id}`];
          }
          return [];
        }
        return [{ ...updated, hasLocalData: hasBrowserLocalData(state, updated) }];
      });
    });
    return;
  }
  const db = await openDatabase();
  await enqueueNativeWrite(async () => {
    const effectiveId = await resolveNativeRemappedBookId(db, bookId);
    await db.executeTransaction([
      {
        statement: `UPDATE books SET
          download_path=NULL,
          download_status='none',
          file_size=remote_file_size,
          downloaded_bytes=NULL,
          downloaded_pages=NULL
        WHERE id=?`,
        values: [effectiveId],
      },
      {
        statement: `DELETE FROM preferences WHERE key IN (
          'readerBookmarks:' || ?,
          'readerAnnotations:' || ?,
          'readerHistory:' || ?
        ) AND EXISTS (
          SELECT 1 FROM books WHERE id=? AND remote_available=0 AND NOT ${retainedBookCondition}
        )`,
        values: [effectiveId, effectiveId, effectiveId, effectiveId],
      },
      {
        statement: `DELETE FROM books WHERE id=? AND remote_available=0 AND NOT ${retainedBookCondition}`,
        values: [effectiveId],
      },
    ]);
  });
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
