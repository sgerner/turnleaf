import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
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
}

let connection: SQLiteDBConnection | null = null;

export async function openDatabase(): Promise<SQLiteDBConnection> {
  if (connection) return connection;
  if (!Capacitor.isNativePlatform())
    throw new Error('Native database unavailable in browser preview.');

  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const consistency = await sqlite.checkConnectionsConsistency();
  const existing = (await sqlite.isConnection('turnleaf', false)).result;
  connection =
    consistency.result && existing
      ? await sqlite.retrieveConnection('turnleaf', false)
      : await sqlite.createConnection('turnleaf', false, 'no-encryption', 1, false);
  await connection.open();
  await connection.execute('PRAGMA foreign_keys = ON;');
  await migrate(connection);
  return connection;
}

async function migrate(db: SQLiteDBConnection): Promise<void> {
  const current = await db.getVersion();
  for (const migration of migrations) {
    if (migration.version <= (current.version ?? 0)) continue;
    await db.execute(migration.statements, true);
    await db.execute(`PRAGMA user_version = ${migration.version};`);
  }
}

export async function saveServer(config: ServerConfig): Promise<void> {
  const db = await openDatabase();
  await db.run(
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

export async function getServer(): Promise<ServerConfig | null> {
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

export async function replaceBooks(serverId: string, books: BookRecord[]): Promise<void> {
  const db = await openDatabase();
  for (const book of books) {
    await db.run(
      `INSERT INTO books
       (id, server_id, library_id, series_id, volume_id, chapter_id, title, author, series,
        description_html, format, metadata_refreshed_at, download_path, download_status, file_size,
        pages, pages_read, created_at, last_read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, author=excluded.author, series=excluded.series,
        description_html=excluded.description_html, format=excluded.format,
        metadata_refreshed_at=excluded.metadata_refreshed_at, pages=excluded.pages,
        pages_read=excluded.pages_read, created_at=excluded.created_at, last_read_at=excluded.last_read_at`,
      [
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
        new Date().toISOString(),
        book.downloadPath,
        book.downloadStatus,
        book.fileSize,
        book.pages,
        book.pagesRead,
        book.createdAt,
        book.lastReadAt,
      ],
    );
  }
}

export async function getBooks(serverId: string): Promise<BookRecord[]> {
  const db = await openDatabase();
  const result = await db.query('SELECT * FROM books WHERE server_id = ? ORDER BY title', [
    serverId,
  ]);
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
  }));
}

export async function markDownloaded(bookId: string, path: string, size: number): Promise<void> {
  const db = await openDatabase();
  await db.run(
    "UPDATE books SET download_path=?, download_status='available', file_size=? WHERE id=?",
    [path, size, bookId],
  );
}

export interface StoredReadingState {
  cfi: string;
  xpath: string | null;
  percentage: number;
  localUpdatedAt: string;
  serverUpdatedAt: string | null;
  pendingSync: boolean;
}

export async function getReadingState(bookId: string): Promise<StoredReadingState | null> {
  const db = await openDatabase();
  const row = (await db.query('SELECT * FROM reading_state WHERE book_id=?', [bookId])).values?.[0];
  if (!row) return null;
  return {
    cfi: String(row.cfi),
    xpath: row.kavita_xpath ? String(row.kavita_xpath) : null,
    percentage: Number(row.percentage),
    localUpdatedAt: String(row.local_updated_at),
    serverUpdatedAt: row.server_updated_at ? String(row.server_updated_at) : null,
    pendingSync: Number(row.pending_sync) === 1,
  };
}

export async function saveLocalProgress(
  book: BookRecord,
  cfi: string,
  xpath: string | null,
  percentage: number,
): Promise<void> {
  const db = await openDatabase();
  const now = new Date().toISOString();
  const payload = {
    libraryId: book.libraryId,
    seriesId: book.seriesId,
    volumeId: book.volumeId,
    chapterId: book.chapterId,
    pageNum: Math.min(book.pages, Math.max(0, Math.round(percentage * book.pages))),
    bookScrollId: xpath,
  };
  await db.run(
    `INSERT INTO reading_state (book_id,cfi,kavita_xpath,percentage,local_updated_at,pending_sync)
    VALUES (?,?,?,?,?,1) ON CONFLICT(book_id) DO UPDATE SET cfi=excluded.cfi,
    kavita_xpath=excluded.kavita_xpath,percentage=excluded.percentage,
    local_updated_at=excluded.local_updated_at,pending_sync=1`,
    [book.id, cfi, xpath, percentage, now],
  );
  await db.run(
    `INSERT INTO sync_queue (book_id,payload_json,created_at,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(book_id) DO UPDATE SET payload_json=excluded.payload_json,
    updated_at=excluded.updated_at`,
    [book.id, JSON.stringify(payload), now, now],
  );
}

export async function getPendingSync(): Promise<Array<{ bookId: string; payload: string }>> {
  const db = await openDatabase();
  const result = await db.query('SELECT book_id,payload_json FROM sync_queue ORDER BY updated_at');
  return (result.values ?? []).map((row) => ({
    bookId: String(row.book_id),
    payload: String(row.payload_json),
  }));
}

export async function confirmSync(bookId: string, serverUpdatedAt: string): Promise<void> {
  const db = await openDatabase();
  await db.run('DELETE FROM sync_queue WHERE book_id=?', [bookId]);
  await db.run(
    `UPDATE reading_state SET pending_sync=0,synced_local_updated_at=local_updated_at,
    server_updated_at=? WHERE book_id=?`,
    [serverUpdatedAt, bookId],
  );
}

export async function markSyncFailure(bookId: string, error: string): Promise<void> {
  const db = await openDatabase();
  await db.run(
    `UPDATE sync_queue SET attempt_count=attempt_count+1,last_attempt_at=?,last_error=?
    WHERE book_id=?`,
    [new Date().toISOString(), error.slice(0, 240), bookId],
  );
}

export async function removeDownload(bookId: string): Promise<void> {
  const db = await openDatabase();
  await db.run(
    "UPDATE books SET download_path=NULL,download_status='none',file_size=NULL WHERE id=?",
    [bookId],
  );
}

export async function getPreference(key: string): Promise<string | null> {
  const db = await openDatabase();
  const row = (await db.query('SELECT value FROM preferences WHERE key=?', [key])).values?.[0];
  return row ? String(row.value) : null;
}

export async function setPreference(key: string, value: string): Promise<void> {
  const db = await openDatabase();
  await db.run(
    `INSERT INTO preferences (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    [key, value, new Date().toISOString()],
  );
}
