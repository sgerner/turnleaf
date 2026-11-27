// @vitest-environment node

import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import type { capTask } from '@capacitor-community/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  migrateDatabase,
  reconcileBooksInTransaction,
  replaceBooksInTransaction,
  type BookRecord,
  type MigrationConnection,
} from './database';
import { parseAnnotations } from '../reader/annotations';
import { parseBookmarks, parseLocationHistory } from '../reader/bookmarks';
import { migrations, V8_BOOK_COLUMNS, V8_BOOK_INDEX_SQL } from './schema';

const baseBook: BookRecord = {
  id: 'server:1:10',
  serverId: 'server',
  libraryId: 1,
  seriesId: 1,
  volumeId: 10,
  chapterId: 10,
  title: 'Book',
  author: 'Author',
  series: 'Series',
  descriptionHtml: '<p>Description</p>',
  format: 'epub',
  pages: 100,
  pagesRead: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-01-02T00:00:00.000Z',
  downloadPath: 'books/book.epub',
  downloadStatus: 'available',
  fileSize: 1234,
};

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const migration of migrations) db.exec(migration.statements);
  db.prepare(
    `INSERT INTO server_config
      (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'server',
    'Test server',
    'https://books.example.com',
    'credential',
    null,
    baseBook.createdAt,
  );
  return db;
}

function createAdapter(
  db: DatabaseSync,
): Pick<Parameters<typeof replaceBooksInTransaction>[0], 'executeTransaction'> {
  return {
    executeTransaction(tasks: capTask[]): Promise<{ changes: { changes: number } }> {
      db.exec('BEGIN');
      try {
        for (const task of tasks) {
          const statement = db.prepare(task.statement);
          statement.run(...((task.values ?? []) as SQLInputValue[]));
        }
        db.exec('COMMIT');
        return Promise.resolve({ changes: { changes: tasks.length } });
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function readBook(db: DatabaseSync, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM books WHERE id=?').get(id) as
    Record<string, unknown> | undefined;
}

describe('native metadata transactions against SQLite', () => {
  let db: DatabaseSync;

  afterEach(() => db.close());

  it('commits a refresh while retaining local download columns', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    await replaceBooksInTransaction(adapter, 'server', [baseBook], '2026-09-08T00:00:00.000Z');
    const refreshed = {
      ...baseBook,
      title: 'Updated title',
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
    };

    await replaceBooksInTransaction(adapter, 'server', [refreshed], '2026-09-09T00:00:00.000Z');

    expect(readBook(db, baseBook.id)).toMatchObject({
      title: 'Updated title',
      download_path: baseBook.downloadPath,
      download_status: baseBook.downloadStatus,
      file_size: baseBook.fileSize,
      metadata_refreshed_at: '2026-09-09T00:00:00.000Z',
    });
  });

  it('preserves SQLite progress when a remote snapshot omits it, but applies a known zero', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    await replaceBooksInTransaction(adapter, 'server', [baseBook]);

    await replaceBooksInTransaction(adapter, 'server', [
      {
        ...baseBook,
        title: 'Updated with incomplete progress',
        pagesRead: 0,
        lastReadAt: null,
        remoteProgressKnown: false,
      },
    ]);

    expect(readBook(db, baseBook.id)).toMatchObject({
      title: 'Updated with incomplete progress',
      pages_read: baseBook.pagesRead,
      last_read_at: baseBook.lastReadAt,
    });

    await replaceBooksInTransaction(adapter, 'server', [
      {
        ...baseBook,
        pagesRead: 0,
        lastReadAt: '2026-02-02T00:00:00.000Z',
        remoteProgressKnown: true,
      },
    ]);

    expect(readBook(db, baseBook.id)).toMatchObject({
      pages_read: 0,
      last_read_at: '2026-02-02T00:00:00.000Z',
    });

    await replaceBooksInTransaction(adapter, 'server', [
      {
        ...baseBook,
        pagesRead: 7,
        lastReadAt: null,
        remoteProgressKnown: true,
        remoteReadDateKnown: false,
      },
    ]);

    expect(readBook(db, baseBook.id)).toMatchObject({
      pages_read: 7,
      last_read_at: '2026-02-02T00:00:00.000Z',
    });
  });

  it('rolls back every task when a later metadata row violates SQLite constraints', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    await replaceBooksInTransaction(adapter, 'server', [baseBook], '2026-09-08T00:00:00.000Z');
    const invalid = {
      ...baseBook,
      id: 'server:1:11',
      chapterId: 11,
      title: null as unknown as string,
    };

    await expect(
      replaceBooksInTransaction(adapter, 'server', [
        { ...baseBook, title: 'First update' },
        invalid,
      ]),
    ).rejects.toThrow();

    expect(readBook(db, baseBook.id)).toMatchObject({ title: 'Book' });
    expect(readBook(db, invalid.id)).toBeUndefined();
  });

  it('marks retained removals unavailable and deletes unretained removals atomically', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    const retained = { ...baseBook, id: 'server:1:10' };
    const removable = {
      ...baseBook,
      id: 'server:1:11',
      chapterId: 11,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
    };
    const withSyncedProgress = {
      ...baseBook,
      id: 'server:1:12',
      chapterId: 12,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
    };
    const cfi = 'epubcfi(/6/4!/4/2/1:12)';
    await replaceBooksInTransaction(adapter, 'server', [retained, removable, withSyncedProgress]);
    db.prepare(
      `INSERT INTO reading_state
      (book_id,cfi,kavita_xpath,percentage,local_updated_at,synced_local_updated_at,
       server_updated_at,pending_sync)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      withSyncedProgress.id,
      cfi,
      '/html/body/p[2]',
      0.25,
      '2026-09-07T00:00:00.000Z',
      '2026-09-07T00:00:00.000Z',
      '2026-09-07T00:00:00.000Z',
    );

    await reconcileBooksInTransaction(adapter, 'server', [], '2026-09-10T00:00:00.000Z');

    expect(readBook(db, retained.id)).toMatchObject({ remote_available: 0 });
    expect(readBook(db, withSyncedProgress.id)).toMatchObject({ remote_available: 0 });
    expect(
      db.prepare('SELECT cfi FROM reading_state WHERE book_id=?').get(withSyncedProgress.id),
    ).toEqual({
      cfi,
    });
    expect(readBook(db, removable.id)).toBeUndefined();
  });

  it('updates incoming SQLite books while preserving unmatched rows from a partial snapshot', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    const unmatched = {
      ...baseBook,
      id: 'server:1:11',
      chapterId: 11,
      title: 'Unmatched saved book',
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
      remoteAvailable: false,
    };
    await replaceBooksInTransaction(adapter, 'server', [baseBook, unmatched]);

    await reconcileBooksInTransaction(
      adapter,
      'server',
      [{ ...baseBook, title: 'Updated from partial snapshot' }],
      '2026-09-10T00:00:00.000Z',
      true,
    );

    expect(readBook(db, baseBook.id)).toMatchObject({ title: 'Updated from partial snapshot' });
    expect(readBook(db, unmatched.id)).toMatchObject({
      title: 'Unmatched saved book',
      remote_available: 0,
    });
  });

  it('reconciles a large snapshot with bounded SQL parameter counts', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    const downloaded = { ...baseBook, remoteAvailable: false };
    await replaceBooksInTransaction(adapter, 'server', [downloaded]);
    const snapshot = Array.from({ length: 1_001 }, (_, index) => ({
      ...baseBook,
      id: `server:2:${index}`,
      chapterId: index,
      downloadPath: null,
    }));

    await reconcileBooksInTransaction(
      {
        executeTransaction(tasks) {
          expect(Math.max(...tasks.map((task) => task.values?.length ?? 0))).toBeLessThan(999);
          return adapter.executeTransaction(tasks);
        },
      },
      'server',
      [downloaded, ...snapshot],
    );

    expect(readBook(db, downloaded.id)).toMatchObject({ remote_available: 1 });
    expect(db.prepare('SELECT COUNT(*) AS total FROM books').get()).toEqual({ total: 1_002 });
  });

  it('preserves every SQLite row and availability when a partial snapshot is empty', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    const unmatched = {
      ...baseBook,
      id: 'server:1:11',
      chapterId: 11,
      title: 'Unmatched saved book',
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
      remoteAvailable: false,
    };
    await replaceBooksInTransaction(adapter, 'server', [baseBook, unmatched]);
    const before = [readBook(db, baseBook.id), readBook(db, unmatched.id)];

    await reconcileBooksInTransaction(adapter, 'server', [], '2026-09-10T00:00:00.000Z', true);

    expect([readBook(db, baseBook.id), readBook(db, unmatched.id)]).toEqual(before);
  });

  it('persists per-file EPUB columns, strips server paths, and preserves secondary EPUB progress on refresh', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    await replaceBooksInTransaction(adapter, 'server', [baseBook], '2026-09-08T00:00:00.000Z');

    const primaryRefreshed: BookRecord = {
      ...baseBook,
      id: 'server:1:10:2114',
      fileId: 2114,
      fileName: '/var/kavita/books/edition-primary.epub',
      pages: 5,
      pagesRead: 2,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: 1955734,
      remoteFileSize: 1955734,
      chapterEpubIndex: 0,
      multiFileChapter: true,
      syncProgress: true,
    };
    const siblingBook: BookRecord = {
      ...baseBook,
      id: 'server:1:10:2115',
      fileId: 2115,
      fileName: 'C:\\Books\\Secret\\edition-secondary.epub',
      title: 'Book (edition-secondary)',
      pages: 4,
      pagesRead: 0,
      lastReadAt: null,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: 2169759,
      remoteFileSize: 2169759,
      chapterEpubIndex: 1,
      multiFileChapter: true,
      syncProgress: false,
    };

    await reconcileBooksInTransaction(adapter, 'server', [primaryRefreshed, siblingBook]);

    expect(readBook(db, baseBook.id)).toBeUndefined();
    expect(readBook(db, primaryRefreshed.id)).toMatchObject({
      download_path: baseBook.downloadPath,
      download_status: 'available',
      file_size: baseBook.fileSize,
      remote_file_size: 1955734,
      file_id: 2114,
      file_name: 'edition-primary.epub',
      chapter_epub_index: 0,
      multi_file_chapter: 1,
      sync_progress: 1,
      pages: 5,
    });
    expect(readBook(db, siblingBook.id)).toMatchObject({
      file_size: 2169759,
      remote_file_size: 2169759,
      file_id: 2115,
      file_name: 'edition-secondary.epub',
      chapter_epub_index: 1,
      multi_file_chapter: 1,
      sync_progress: 0,
      pages: 4,
      pages_read: 0,
    });

    db.prepare(
      'UPDATE books SET download_path=?, download_status=?, file_size=?, pages_read=3, last_read_at=? WHERE id=?',
    ).run(
      'books/sibling-2115.epub',
      'available',
      2169759,
      '2026-09-11T00:00:00.000Z',
      siblingBook.id,
    );
    await reconcileBooksInTransaction(adapter, 'server', [
      { ...siblingBook, chapterEpubIndex: 0 },
      { ...primaryRefreshed, chapterEpubIndex: 1 },
    ]);

    expect(readBook(db, primaryRefreshed.id)).toMatchObject({
      file_id: 2114,
      download_path: baseBook.downloadPath,
      file_size: baseBook.fileSize,
      chapter_epub_index: 1,
      pages_read: 2,
    });
    expect(readBook(db, siblingBook.id)).toMatchObject({
      file_id: 2115,
      download_path: 'books/sibling-2115.epub',
      file_size: 2169759,
      chapter_epub_index: 0,
      pages_read: 3,
      last_read_at: '2026-09-11T00:00:00.000Z',
    });
  });

  it('clears local download and reading state when fileId changes on an existing book ID', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    await replaceBooksInTransaction(
      adapter,
      'server',
      [{ ...baseBook, fileId: 2114 }],
      '2026-09-08T00:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO reading_state (book_id, cfi, percentage, local_updated_at, pending_sync, sync_revision)
       VALUES (?, 'epubcfi(/6/2)', 0.5, '2026-09-09T00:00:00.000Z', 1, 1)`,
    ).run(baseBook.id);
    db.prepare(
      `INSERT INTO sync_queue (book_id, payload_json, created_at, updated_at, revision)
       VALUES (?, '{"pageNum":50}', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z', 1)`,
    ).run(baseBook.id);
    db.prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)').run(
      `readerBookmarks:${baseBook.id}`,
      '["bm-old"]',
      '2026-09-09T00:00:00.000Z',
    );

    await reconcileBooksInTransaction(adapter, 'server', [
      {
        ...baseBook,
        fileId: 2199,
        pages: 80,
        pagesRead: 0,
        lastReadAt: null,
        downloadPath: null,
        downloadStatus: 'none',
        fileSize: 777777,
      },
    ]);

    expect(readBook(db, baseBook.id)).toMatchObject({
      file_id: 2199,
      download_path: null,
      download_status: 'none',
      file_size: 777777,
      pages: 80,
      pages_read: 0,
      last_read_at: null,
    });
    expect(
      db.prepare('SELECT * FROM reading_state WHERE book_id=?').get(baseBook.id),
    ).toBeUndefined();
    expect(db.prepare('SELECT * FROM sync_queue WHERE book_id=?').get(baseBook.id)).toBeUndefined();
    expect(
      db.prepare('SELECT * FROM preferences WHERE key=?').get(`readerBookmarks:${baseBook.id}`),
    ).toBeUndefined();
  });
});

const STUDY_STORAGE_MIGRATION_VERSION = 10;

const LEGACY_PR328_ONLY_V8_STATEMENTS = `
  ALTER TABLE books ADD COLUMN file_id INTEGER;
  ALTER TABLE books ADD COLUMN file_name TEXT;
  ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
  ALTER TABLE books ADD COLUMN chapter_epub_index INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE books ADD COLUMN multi_file_chapter INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE books ADD COLUMN sync_progress INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX IF NOT EXISTS books_server_file_idx ON books(server_id, file_id);
`;

const LEGACY_PR330_ONLY_V8_STATEMENTS = `
  ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
  ALTER TABLE books ADD COLUMN downloaded_bytes INTEGER;
  ALTER TABLE books ADD COLUMN downloaded_pages INTEGER;
  ALTER TABLE books ADD COLUMN chapter_key TEXT;
`;

const PR339_V9_STATEMENTS = `
  ALTER TABLE books ADD COLUMN sort_order REAL;
  ALTER TABLE books ADD COLUMN min_number REAL;
  ALTER TABLE books ADD COLUMN volume_number REAL;
`;

const PR345_V10_STATEMENTS = `
  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    remote_id INTEGER,
    cfi TEXT NOT NULL DEFAULT '',
    xpath TEXT NOT NULL DEFAULT '',
    ending_xpath TEXT,
    page_number INTEGER NOT NULL DEFAULT 0,
    slot_index INTEGER NOT NULL DEFAULT 0,
    contains_spoiler INTEGER NOT NULL DEFAULT 0,
    context TEXT,
    chapter_title TEXT,
    excerpt TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    remote_updated_at TEXT,
    sync_state TEXT NOT NULL DEFAULT 'synced',
    sync_revision INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_error TEXT,
    FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS annotations_book_created_idx
    ON annotations(book_id, created_at, id);
  CREATE INDEX IF NOT EXISTS annotations_sync_state_idx
    ON annotations(sync_state, book_id);

  CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    remote_id INTEGER,
    cfi TEXT NOT NULL DEFAULT '',
    xpath TEXT,
    href TEXT NOT NULL DEFAULT '',
    percentage REAL NOT NULL DEFAULT 0,
    page_number INTEGER NOT NULL DEFAULT 0,
    label TEXT NOT NULL,
    excerpt TEXT NOT NULL DEFAULT '',
    remote_title TEXT,
    remote_page_number INTEGER,
    saved_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sync_state TEXT NOT NULL DEFAULT 'synced',
    sync_revision INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_error TEXT,
    FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS bookmarks_book_saved_idx
    ON bookmarks(book_id, saved_at DESC, id);
  CREATE INDEX IF NOT EXISTS bookmarks_sync_state_idx
    ON bookmarks(sync_state, book_id);

  CREATE TABLE IF NOT EXISTS reading_history (
    book_id TEXT NOT NULL,
    id TEXT NOT NULL,
    cfi TEXT NOT NULL,
    href TEXT NOT NULL,
    percentage REAL NOT NULL,
    label TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY(book_id, id),
    FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS reading_history_book_saved_idx
    ON reading_history(book_id, saved_at DESC);

  CREATE TABLE IF NOT EXISTS preferences (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const DELETE_LEGACY_STUDY_PREFERENCES_SQL = `
  DELETE FROM preferences
    WHERE key LIKE 'readerAnnotations:%'
       OR key LIKE 'readerBookmarks:%'
       OR key LIKE 'readerHistory:%';
`;

const EXPECTED_V8_AND_V9_BOOK_COLUMNS = [
  ...V8_BOOK_COLUMNS.map((column) => column.name),
  'sort_order',
  'min_number',
  'volume_number',
] as const;

function createMigrationAdapter(
  db: DatabaseSync,
): MigrationConnection &
  Pick<Parameters<typeof reconcileBooksInTransaction>[0], 'executeTransaction' | 'query'> {
  return {
    getVersion(): Promise<{ version: number }> {
      const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
      return Promise.resolve({ version: Number(row?.user_version ?? 0) });
    },
    query(statement: string, values?: unknown[]): Promise<{ values: Record<string, unknown>[] }> {
      const rows = db.prepare(statement).all(...((values ?? []) as SQLInputValue[])) as Record<
        string,
        unknown
      >[];
      return Promise.resolve({ values: rows });
    },
    executeTransaction(tasks: capTask[]): Promise<{ changes: { changes: number } }> {
      db.exec('BEGIN');
      try {
        for (const task of tasks) {
          if (task.values && task.values.length > 0) {
            db.prepare(task.statement).run(...(task.values as SQLInputValue[]));
          } else {
            db.exec(task.statement);
          }
        }
        db.exec('COMMIT');
        return Promise.resolve({ changes: { changes: tasks.length } });
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function createPopulatedV7Database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const migration of migrations.slice(0, 7)) {
    db.exec(migration.statements);
    db.exec(`PRAGMA user_version = ${migration.version};`);
  }

  db.prepare(
    `INSERT INTO server_config
      (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
      VALUES ('srv_active', 'Active Kavita', 'https://active.example', 'server_srv_active_api_key', '0.8.8', '2026-01-01T00:00:00.000Z')`,
  ).run();

  db.prepare(
    `INSERT INTO books
      (id, server_id, library_id, series_id, volume_id, chapter_id, title, author, series,
       format, metadata_refreshed_at, download_path, download_status, file_size, pages,
       pages_read, created_at, last_read_at, remote_available)
      VALUES
        ('srv_active:82:1406', 'srv_active', 1, 82, 188, 1406, 'Vol 3', 'Rawlinson', 'Ancient World',
         'epub', '2026-01-01T00:00:00.000Z', 'books/legacy-vol3.epub', 'available', 1955734, 9,
         3, '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z', 1),
        ('srv_active:1:10', 'srv_active', 1, 1, 10, 10, 'Book Ten', 'Author Ten', 'Series One',
         'epub', '2026-01-01T00:00:00.000Z', 'books/srv-active-10.epub', 'available', 20480, 100,
         35, '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z', 1),
        ('srv_active:1:11', 'srv_active', 1, 1, 11, 11, 'Book Eleven', 'Author Eleven', 'Series One',
         'epub', '2026-01-01T00:00:00.000Z', NULL, 'none', NULL, 80,
         0, '2026-01-01T00:00:00.000Z', NULL, 1)`,
  ).run();

  db.prepare(
    `INSERT INTO reading_state
      (book_id, cfi, kavita_xpath, percentage, local_updated_at, synced_local_updated_at, server_updated_at, pending_sync, sync_revision)
      VALUES
        ('srv_active:82:1406', 'epubcfi(/6/2!/4/8)', '//body/DocFragment[1]/body/p[8]', 0.6, '2026-01-05T00:00:00.000Z', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z', 1, 3),
        ('srv_active:1:10', 'epubcfi(/6/4!/4/2)', '//body/DocFragment[2]/body/p[1]', 0.35, '2026-01-05T00:00:00.000Z', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z', 1, 2)`,
  ).run();

  db.prepare(
    `INSERT INTO sync_queue
      (book_id, payload_json, attempt_count, created_at, updated_at, revision)
      VALUES
        ('srv_active:82:1406', '{"libraryId":1,"seriesId":82,"volumeId":188,"chapterId":1406,"pageNum":3}', 0, '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z', 3),
        ('srv_active:1:10', '{"libraryId":1,"seriesId":1,"volumeId":10,"chapterId":10,"pageNum":35}', 0, '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z', 2)`,
  ).run();

  const insertPref = db.prepare(
    'INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)',
  );
  insertPref.run('uiTheme', 'eink', '2026-01-01T00:00:00.000Z');
  insertPref.run('readerFontScale', '1.15', '2026-01-01T00:00:00.000Z');

  insertPref.run(
    'readerAnnotations:srv_active:82:1406',
    JSON.stringify([
      {
        id: 'ann-vol3',
        cfi: 'epubcfi(/6/2!/4/8/1:0)',
        excerpt: 'Media and Babylon',
        note: 'Primary edition note',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ]),
    '2026-01-03T00:00:00.000Z',
  );
  insertPref.run(
    'readerBookmarks:srv_active:82:1406',
    JSON.stringify([
      {
        id: 'bm-vol3',
        cfi: 'epubcfi(/6/2!/4/8)',
        href: 'Text/ch1.xhtml',
        percentage: 0.6,
        label: 'Vol 3 Bookmark',
        savedAt: '2026-01-03T01:00:00.000Z',
      },
    ]),
    '2026-01-03T01:00:00.000Z',
  );
  insertPref.run(
    'readerHistory:srv_active:82:1406',
    JSON.stringify([
      {
        id: 'hist-vol3',
        cfi: 'epubcfi(/6/2!/4/4)',
        href: 'Text/ch1.xhtml',
        percentage: 0.3,
        label: '30% · ch1.xhtml',
        savedAt: '2026-01-03T00:30:00.000Z',
      },
    ]),
    '2026-01-03T00:30:00.000Z',
  );

  insertPref.run(
    'readerAnnotations:srv_active:1:10',
    JSON.stringify([
      {
        id: 'ann-10',
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        excerpt: 'Book Ten highlight',
        note: 'Book Ten note',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ]),
    '2026-01-02T00:00:00.000Z',
  );
  insertPref.run(
    'readerBookmarks:srv_active:1:10',
    JSON.stringify([
      {
        id: 'bm-10',
        cfi: 'epubcfi(/6/4!/4/2)',
        href: 'Text/ch2.xhtml',
        percentage: 0.35,
        label: 'Chapter Two',
        savedAt: '2026-01-02T10:00:00.000Z',
      },
    ]),
    '2026-01-02T10:00:00.000Z',
  );
  insertPref.run(
    'readerHistory:srv_active:1:11',
    JSON.stringify([
      {
        id: 'hist-11-1',
        cfi: 'epubcfi(/6/4!/4/2)',
        href: 'Text/ch2.xhtml',
        percentage: 0.2,
        label: '20% · ch2.xhtml',
        savedAt: '2026-01-04T00:00:00.000Z',
      },
      {
        id: 'hist-11-2',
        cfi: 'epubcfi(/6/6!/4/2)',
        href: 'Text/ch3.xhtml',
        percentage: 0.5,
        label: '50% · ch3.xhtml',
        savedAt: '2026-01-05T00:00:00.000Z',
      },
    ]),
    '2026-01-05T00:00:00.000Z',
  );

  insertPref.run(
    'readerAnnotations:srv_deleted:9:99',
    JSON.stringify([
      {
        id: 'orphan-ann',
        cfi: 'epubcfi(/6/2!/4/2)',
        excerpt: 'Deleted server highlight',
        note: 'Must not copy',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
    '2026-01-01T00:00:00.000Z',
  );
  insertPref.run(
    'readerBookmarks:srv_deleted:9:99',
    JSON.stringify([
      {
        id: 'orphan-bm',
        cfi: 'epubcfi(/6/2!/4/2)',
        href: 'ch1.xhtml',
        percentage: 0.1,
        label: 'Orphan bookmark',
        savedAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
    '2026-01-01T00:00:00.000Z',
  );
  insertPref.run(
    'readerHistory:srv_deleted:9:99',
    JSON.stringify([
      {
        id: 'orphan-hist',
        cfi: 'epubcfi(/6/2!/4/2)',
        href: 'ch1.xhtml',
        percentage: 0.1,
        label: '10%',
        savedAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
    '2026-01-01T00:00:00.000Z',
  );

  return db;
}

async function runSimpleMigrations(
  adapter: MigrationConnection,
  customMigrations: ReadonlyArray<{ version: number; statements: string }>,
): Promise<void> {
  const current = await adapter.getVersion();
  const currentVersion = current.version ?? 0;
  for (const migration of customMigrations) {
    if (migration.version <= currentVersion) continue;
    await adapter.executeTransaction([
      { statement: migration.statements },
      { statement: `PRAGMA user_version = ${migration.version};` },
    ]);
  }
}

async function runCoordinatedV9AndV10Upgrade(
  adapter: MigrationConnection,
  options: { includePr330OnlyV8?: boolean } = {},
): Promise<void> {
  const current = await adapter.getVersion();
  const currentVersion = current.version ?? 0;
  const tableInfoRows = (await adapter.query("PRAGMA table_info('books')")).values ?? [];
  const existingColumns = new Set(tableInfoRows.map((row) => String(row.name)));

  const targetV8Columns = options.includePr330OnlyV8
    ? [
        { name: 'remote_file_size', definition: 'INTEGER' },
        { name: 'downloaded_bytes', definition: 'INTEGER' },
        { name: 'downloaded_pages', definition: 'INTEGER' },
        { name: 'chapter_key', definition: 'TEXT' },
      ]
    : V8_BOOK_COLUMNS;

  if (currentVersion < 8) {
    const missingV8 = targetV8Columns.filter((column) => !existingColumns.has(column.name));
    await adapter.executeTransaction([
      ...(missingV8.length > 0
        ? [
            {
              statement: missingV8
                .map(
                  (column) => `ALTER TABLE books ADD COLUMN ${column.name} ${column.definition};`,
                )
                .join('\n'),
            },
          ]
        : []),
      ...(options.includePr330OnlyV8 ? [] : [{ statement: V8_BOOK_INDEX_SQL }]),
      { statement: 'PRAGMA user_version = 8;' },
    ]);
    for (const column of missingV8) existingColumns.add(column.name);
  }

  if (currentVersion < 9) {
    const v9Columns = [
      { name: 'sort_order', definition: 'REAL' },
      { name: 'min_number', definition: 'REAL' },
      { name: 'volume_number', definition: 'REAL' },
    ].filter((column) => !existingColumns.has(column.name));
    await adapter.executeTransaction([
      ...(v9Columns.length > 0
        ? [
            {
              statement: v9Columns
                .map(
                  (column) => `ALTER TABLE books ADD COLUMN ${column.name} ${column.definition};`,
                )
                .join('\n'),
            },
          ]
        : []),
      { statement: 'PRAGMA user_version = 9;' },
    ]);
    for (const column of v9Columns) existingColumns.add(column.name);
  }

  if (currentVersion < STUDY_STORAGE_MIGRATION_VERSION) {
    const missingPreV10 = [
      ...(options.includePr330OnlyV8
        ? [
            { name: 'remote_file_size', definition: 'INTEGER' },
            { name: 'downloaded_bytes', definition: 'INTEGER' },
            { name: 'downloaded_pages', definition: 'INTEGER' },
            { name: 'chapter_key', definition: 'TEXT' },
          ]
        : V8_BOOK_COLUMNS),
      { name: 'sort_order', definition: 'REAL' },
      { name: 'min_number', definition: 'REAL' },
      { name: 'volume_number', definition: 'REAL' },
    ].filter((column) => !existingColumns.has(column.name));

    const prefRows =
      (
        await adapter.query(
          `SELECT key, value FROM preferences
           WHERE key LIKE 'readerAnnotations:%'
              OR key LIKE 'readerBookmarks:%'
              OR key LIKE 'readerHistory:%'`,
        )
      ).values ?? [];
    const activeBookRows =
      (
        await adapter.query(
          `SELECT books.id FROM books
           WHERE EXISTS (SELECT 1 FROM server_config WHERE server_config.id = books.server_id)`,
        )
      ).values ?? [];
    const activeBookIds = new Set(activeBookRows.map((row) => String(row.id)));

    const copyTasks: capTask[] = [];
    for (const row of prefRows) {
      const key = String(row.key);
      const raw = String(row.value);
      const sep = key.indexOf(':');
      if (sep < 0) continue;
      const prefix = key.slice(0, sep);
      const bookId = key.slice(sep + 1);
      if (!activeBookIds.has(bookId)) continue;

      if (prefix === 'readerAnnotations') {
        for (const item of parseAnnotations(raw)) {
          copyTasks.push({
            statement: `INSERT INTO annotations
              (id, book_id, cfi, xpath, ending_xpath, page_number, excerpt, note, created_at, updated_at, sync_state, sync_revision)
              VALUES (?, ?, ?, '//body/DocFragment[1]/body', '//body/DocFragment[1]/body', 0, ?, ?, ?, ?, 'pending_create', 1)`,
            values: [
              `${bookId}:${item.id}`,
              bookId,
              item.cfi,
              item.excerpt,
              item.note,
              item.createdAt,
              item.createdAt,
            ],
          });
        }
      } else if (prefix === 'readerBookmarks') {
        for (const item of parseBookmarks(raw)) {
          copyTasks.push({
            statement: `INSERT INTO bookmarks
              (id, book_id, cfi, xpath, href, percentage, page_number, label, saved_at, updated_at, sync_state, sync_revision)
              VALUES (?, ?, ?, '//body/DocFragment[1]/body', ?, ?, 0, ?, ?, ?, 'pending_create', 1)`,
            values: [
              `${bookId}:${item.id}`,
              bookId,
              item.cfi,
              item.href,
              item.percentage,
              item.label,
              item.savedAt,
              item.savedAt,
            ],
          });
        }
      } else if (prefix === 'readerHistory') {
        for (const entry of parseLocationHistory(raw)) {
          copyTasks.push({
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
          });
        }
      }
    }

    await adapter.executeTransaction([
      ...(missingPreV10.length > 0
        ? [
            {
              statement: missingPreV10
                .map(
                  (column) => `ALTER TABLE books ADD COLUMN ${column.name} ${column.definition};`,
                )
                .join('\n'),
            },
          ]
        : []),
      ...(options.includePr330OnlyV8 ? [] : [{ statement: V8_BOOK_INDEX_SQL }]),
      { statement: PR345_V10_STATEMENTS },
      ...copyTasks,
      { statement: DELETE_LEGACY_STUDY_PREFERENCES_SQL },
      { statement: `PRAGMA user_version = ${STUDY_STORAGE_MIGRATION_VERSION};` },
    ]);
  }
}

function listColumnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function listIndexNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function listTableNames(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

describe('coordinated v7-to-v10 SQLite schema upgrades across #328, #330, #339, and #345', () => {
  let db: DatabaseSync | undefined;

  afterEach(() => db?.close());

  function attachLegacyPreferenceDeleteGuard(targetDb: DatabaseSync): void {
    targetDb.exec(`
      CREATE TRIGGER assert_study_rows_copied_before_preference_delete
      BEFORE DELETE ON preferences
      WHEN OLD.key LIKE 'readerAnnotations:%'
        OR OLD.key LIKE 'readerBookmarks:%'
        OR OLD.key LIKE 'readerHistory:%'
      BEGIN
        SELECT CASE
          WHEN (SELECT COUNT(*) FROM annotations) < 2
            OR (SELECT COUNT(*) FROM bookmarks) < 2
            OR (SELECT COUNT(*) FROM reading_history) < 3
          THEN RAISE(ABORT, 'legacy study preference deleted before relational copy completed')
        END;
      END;
    `);
  }

  function assertCompleteV10Schema(targetDb: DatabaseSync): void {
    const bookColumns = listColumnNames(targetDb, 'books');
    for (const column of EXPECTED_V8_AND_V9_BOOK_COLUMNS) {
      expect(bookColumns).toContain(column);
    }
    expect(bookColumns.filter((name) => name === 'remote_file_size')).toHaveLength(1);
    expect(listIndexNames(targetDb, 'books')).toEqual(
      expect.arrayContaining(['books_server_title_idx', 'books_server_file_idx']),
    );
    expect(listTableNames(targetDb)).toEqual(
      expect.arrayContaining(['annotations', 'bookmarks', 'reading_history']),
    );
    expect(targetDb.prepare('SELECT key, value FROM preferences ORDER BY key ASC').all()).toEqual([
      { key: 'readerFontScale', value: '1.15' },
      { key: 'uiTheme', value: 'eink' },
    ]);
  }

  it('upgrades populated v7 databases with a #328-only v8 shape to v10 in both merge orders without duplicate columns or data loss', async () => {
    // Merge Order A: #328-only v8 -> coordinated #328/#330 migrateDatabase -> #339 v9 -> #345 v10
    const orderADb = createPopulatedV7Database();
    try {
      const adapter = createMigrationAdapter(orderADb);
      await runSimpleMigrations(adapter, [
        ...migrations.slice(0, 7),
        { version: 8, statements: LEGACY_PR328_ONLY_V8_STATEMENTS },
      ]);
      expect(await adapter.getVersion()).toEqual({ version: 8 });
      orderADb
        .prepare(
          `UPDATE books
           SET file_id = 2114, file_name = 'pg16163-images-3.epub', remote_file_size = 1955734,
               chapter_epub_index = 0, multi_file_chapter = 1, sync_progress = 1
           WHERE id = 'srv_active:82:1406'`,
        )
        .run();

      await migrateDatabase(adapter);
      // Must keep user_version at 8 so #339 v9 and #345 v10 still execute in sequence.
      expect(await adapter.getVersion()).toEqual({ version: 8 });
      expect(listColumnNames(orderADb, 'books')).toEqual(
        expect.arrayContaining(V8_BOOK_COLUMNS.map((column) => column.name)),
      );
      orderADb
        .prepare(
          `UPDATE books
           SET downloaded_bytes = 1955734, downloaded_pages = 5, chapter_key = 'number:3'
           WHERE id = 'srv_active:82:1406'`,
        )
        .run();

      await runSimpleMigrations(adapter, [{ version: 9, statements: PR339_V9_STATEMENTS }]);
      expect(await adapter.getVersion()).toEqual({ version: 9 });
      orderADb
        .prepare(
          `UPDATE books SET sort_order = 3, min_number = 3, volume_number = 3
           WHERE id = 'srv_active:82:1406'`,
        )
        .run();

      attachLegacyPreferenceDeleteGuard(orderADb);
      await runCoordinatedV9AndV10Upgrade(adapter);
      await migrateDatabase(adapter);

      expect(await adapter.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
      assertCompleteV10Schema(orderADb);
      expect(readBook(orderADb, 'srv_active:82:1406')).toMatchObject({
        download_path: 'books/legacy-vol3.epub',
        download_status: 'available',
        file_size: 1955734,
        file_id: 2114,
        file_name: 'pg16163-images-3.epub',
        remote_file_size: 1955734,
        downloaded_bytes: 1955734,
        downloaded_pages: 5,
        chapter_key: 'number:3',
        multi_file_chapter: 1,
        sync_progress: 1,
        sort_order: 3,
        min_number: 3,
        volume_number: 3,
        pages_read: 3,
      });
      expect(orderADb.prepare('SELECT COUNT(*) AS total FROM annotations').get()).toEqual({
        total: 2,
      });
      expect(orderADb.prepare('SELECT COUNT(*) AS total FROM bookmarks').get()).toEqual({
        total: 2,
      });
      expect(orderADb.prepare('SELECT COUNT(*) AS total FROM reading_history').get()).toEqual({
        total: 3,
      });
    } finally {
      orderADb.close();
    }

    // Merge Order B: #328-only v8 -> #339 v9 -> #345 v10 -> coordinated #328 migrateDatabase
    db = createPopulatedV7Database();
    const adapterB = createMigrationAdapter(db);
    await runSimpleMigrations(adapterB, [
      ...migrations.slice(0, 7),
      { version: 8, statements: LEGACY_PR328_ONLY_V8_STATEMENTS },
    ]);
    db.prepare(
      `UPDATE books
       SET file_id = 2114, file_name = 'pg16163-images-3.epub', remote_file_size = 1955734,
           multi_file_chapter = 1, sync_progress = 1
       WHERE id = 'srv_active:82:1406'`,
    ).run();
    await runSimpleMigrations(adapterB, [{ version: 9, statements: PR339_V9_STATEMENTS }]);
    db.prepare(
      `UPDATE books SET sort_order = 3, min_number = 3, volume_number = 3
       WHERE id = 'srv_active:82:1406'`,
    ).run();

    // Simulate #345 v10 running before #330/#328 coordinated v8 columns were reconciled:
    attachLegacyPreferenceDeleteGuard(db);
    await runSimpleMigrations(adapterB, [
      {
        version: STUDY_STORAGE_MIGRATION_VERSION,
        statements: `${PR345_V10_STATEMENTS}\nINSERT INTO annotations (id, book_id, cfi, xpath, excerpt, note, created_at, updated_at, sync_state, sync_revision) VALUES ('srv_active:82:1406:ann-vol3', 'srv_active:82:1406', 'epubcfi(/6/2!/4/8/1:0)', '//body/DocFragment[1]/body', 'Media and Babylon', 'Primary edition note', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', 'pending_create', 1), ('srv_active:1:10:ann-10', 'srv_active:1:10', 'epubcfi(/6/4!/4/2/1:0)', '//body/DocFragment[2]/body', 'Book Ten highlight', 'Book Ten note', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'pending_create', 1);\nINSERT INTO bookmarks (id, book_id, cfi, xpath, href, percentage, label, saved_at, updated_at, sync_state, sync_revision) VALUES ('srv_active:82:1406:bm-vol3', 'srv_active:82:1406', 'epubcfi(/6/2!/4/8)', '//body/DocFragment[1]/body', 'Text/ch1.xhtml', 0.6, 'Vol 3 Bookmark', '2026-01-03T01:00:00.000Z', '2026-01-03T01:00:00.000Z', 'pending_create', 1), ('srv_active:1:10:bm-10', 'srv_active:1:10', 'epubcfi(/6/4!/4/2)', '//body/DocFragment[2]/body', 'Text/ch2.xhtml', 0.35, 'Chapter Two', '2026-01-02T10:00:00.000Z', '2026-01-02T10:00:00.000Z', 'pending_create', 1);\nINSERT INTO reading_history (book_id, id, cfi, href, percentage, label, saved_at) VALUES ('srv_active:82:1406', 'hist-vol3', 'epubcfi(/6/2!/4/4)', 'Text/ch1.xhtml', 0.3, '30% · ch1.xhtml', '2026-01-03T00:30:00.000Z'), ('srv_active:1:11', 'hist-11-1', 'epubcfi(/6/4!/4/2)', 'Text/ch2.xhtml', 0.2, '20% · ch2.xhtml', '2026-01-04T00:00:00.000Z'), ('srv_active:1:11', 'hist-11-2', 'epubcfi(/6/6!/4/2)', 'Text/ch3.xhtml', 0.5, '50% · ch3.xhtml', '2026-01-05T00:00:00.000Z');\n${DELETE_LEGACY_STUDY_PREFERENCES_SQL}`,
      },
    ]);
    expect(await adapterB.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
    expect(listColumnNames(db, 'books')).not.toContain('downloaded_bytes');

    // Running #328's migrateDatabase at v10 reconciles missing #330 v8 columns without downgrading user_version.
    await migrateDatabase(adapterB);
    await migrateDatabase(adapterB);

    expect(await adapterB.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
    assertCompleteV10Schema(db);
    expect(readBook(db, 'srv_active:82:1406')).toMatchObject({
      file_id: 2114,
      file_name: 'pg16163-images-3.epub',
      remote_file_size: 1955734,
      sort_order: 3,
      min_number: 3,
      volume_number: 3,
    });
  });

  it('upgrades populated v7 databases with a #330-only v8 shape to v10 in both merge orders and preserves v8/v9/v10 data across multi-EPUB re-keying', async () => {
    const multiEpubBooks: BookRecord[] = [
      {
        id: 'srv_active:82:1406:2114',
        serverId: 'srv_active',
        libraryId: 1,
        seriesId: 82,
        volumeId: 188,
        chapterId: 1406,
        fileId: 2114,
        fileName: 'pg16163-images-3.epub',
        title: 'Vol 3 (pg16163-images-3)',
        author: 'Rawlinson',
        series: 'Ancient World',
        descriptionHtml: null,
        format: 'epub',
        pages: 5,
        pagesRead: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastReadAt: '2026-01-02T00:00:00.000Z',
        downloadPath: null,
        downloadStatus: 'none',
        fileSize: 1955734,
        remoteFileSize: 1955734,
        chapterEpubIndex: 0,
        multiFileChapter: true,
        syncProgress: true,
      },
      {
        id: 'srv_active:82:1406:2115',
        serverId: 'srv_active',
        libraryId: 1,
        seriesId: 82,
        volumeId: 188,
        chapterId: 1406,
        fileId: 2115,
        fileName: 'vol3-secondary.epub',
        title: 'Vol 3 (vol3-secondary)',
        author: 'Rawlinson',
        series: 'Ancient World',
        descriptionHtml: null,
        format: 'epub',
        pages: 4,
        pagesRead: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastReadAt: null,
        downloadPath: null,
        downloadStatus: 'none',
        fileSize: 2169759,
        remoteFileSize: 2169759,
        chapterEpubIndex: 1,
        multiFileChapter: true,
        syncProgress: false,
      },
    ];

    // Merge Order A: #330-only v8 -> #328 migrateDatabase + multi-EPUB reconcile -> #339 v9 -> #345 v10
    const orderADb = createPopulatedV7Database();
    try {
      const adapter = createMigrationAdapter(orderADb);
      await runSimpleMigrations(adapter, [
        ...migrations.slice(0, 7),
        { version: 8, statements: LEGACY_PR330_ONLY_V8_STATEMENTS },
      ]);
      expect(await adapter.getVersion()).toEqual({ version: 8 });
      orderADb
        .prepare(
          `UPDATE books
           SET remote_file_size = 1955734, downloaded_bytes = 1955734, downloaded_pages = 5, chapter_key = 'number:3'
           WHERE id = 'srv_active:82:1406'`,
        )
        .run();

      await migrateDatabase(adapter);
      expect(await adapter.getVersion()).toEqual({ version: 8 });
      expect(listColumnNames(orderADb, 'books')).toEqual(
        expect.arrayContaining(V8_BOOK_COLUMNS.map((column) => column.name)),
      );
      expect(listIndexNames(orderADb, 'books')).toContain('books_server_file_idx');

      await reconcileBooksInTransaction(adapter, 'srv_active', multiEpubBooks, undefined, true);
      expect(readBook(orderADb, 'srv_active:82:1406')).toBeUndefined();
      expect(readBook(orderADb, 'srv_active:82:1406:2114')).toMatchObject({
        file_id: 2114,
        download_path: 'books/legacy-vol3.epub',
        download_status: 'available',
        file_size: 1955734,
        remote_file_size: 1955734,
        downloaded_bytes: 1955734,
        downloaded_pages: 5,
        chapter_key: 'number:3',
        pages_read: 3,
      });

      attachLegacyPreferenceDeleteGuard(orderADb);
      await runCoordinatedV9AndV10Upgrade(adapter);
      expect(await adapter.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
      assertCompleteV10Schema(orderADb);
      expect(
        orderADb
          .prepare('SELECT book_id, excerpt FROM annotations WHERE book_id = ?')
          .get('srv_active:82:1406:2114'),
      ).toEqual({
        book_id: 'srv_active:82:1406:2114',
        excerpt: 'Media and Babylon',
      });
      expect(
        orderADb
          .prepare('SELECT book_id, label FROM bookmarks WHERE book_id = ?')
          .get('srv_active:82:1406:2114'),
      ).toEqual({
        book_id: 'srv_active:82:1406:2114',
        label: 'Vol 3 Bookmark',
      });
      expect(
        orderADb
          .prepare('SELECT book_id, id FROM reading_history WHERE book_id = ?')
          .get('srv_active:82:1406:2114'),
      ).toEqual({
        book_id: 'srv_active:82:1406:2114',
        id: 'hist-vol3',
      });
    } finally {
      orderADb.close();
    }

    // Merge Order B: #330-only v8 -> #339 v9 -> #345 v10 -> #328 migrateDatabase + multi-EPUB reconcile at v10
    db = createPopulatedV7Database();
    const adapterB = createMigrationAdapter(db);
    await runCoordinatedV9AndV10Upgrade(adapterB, { includePr330OnlyV8: true });
    expect(await adapterB.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
    expect(listColumnNames(db, 'books')).not.toContain('file_id');

    db.prepare(
      `UPDATE books
       SET remote_file_size = 1955734, downloaded_bytes = 1955734, downloaded_pages = 5,
           chapter_key = 'number:3', sort_order = 3, min_number = 3, volume_number = 3
       WHERE id = 'srv_active:82:1406'`,
    ).run();

    await migrateDatabase(adapterB);
    await migrateDatabase(adapterB);
    expect(await adapterB.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
    assertCompleteV10Schema(db);

    await reconcileBooksInTransaction(adapterB, 'srv_active', multiEpubBooks, undefined, true);
    expect(readBook(db, 'srv_active:82:1406')).toBeUndefined();
    expect(readBook(db, 'srv_active:82:1406:2114')).toMatchObject({
      file_id: 2114,
      file_name: 'pg16163-images-3.epub',
      download_path: 'books/legacy-vol3.epub',
      download_status: 'available',
      file_size: 1955734,
      remote_file_size: 1955734,
      downloaded_bytes: 1955734,
      downloaded_pages: 5,
      chapter_key: 'number:3',
      sort_order: 3,
      min_number: 3,
      volume_number: 3,
      pages_read: 3,
    });
    expect(
      db
        .prepare('SELECT cfi, sync_revision FROM reading_state WHERE book_id = ?')
        .get('srv_active:82:1406:2114'),
    ).toEqual({
      cfi: 'epubcfi(/6/2!/4/8)',
      sync_revision: 3,
    });
    expect(
      db
        .prepare('SELECT revision FROM sync_queue WHERE book_id = ?')
        .get('srv_active:82:1406:2114'),
    ).toEqual({ revision: 3 });
    expect(
      db
        .prepare('SELECT book_id, excerpt FROM annotations WHERE book_id = ?')
        .get('srv_active:82:1406:2114'),
    ).toEqual({
      book_id: 'srv_active:82:1406:2114',
      excerpt: 'Media and Babylon',
    });
    expect(
      db
        .prepare('SELECT book_id, label FROM bookmarks WHERE book_id = ?')
        .get('srv_active:82:1406:2114'),
    ).toEqual({
      book_id: 'srv_active:82:1406:2114',
      label: 'Vol 3 Bookmark',
    });
    expect(
      db
        .prepare('SELECT book_id, id FROM reading_history WHERE book_id = ?')
        .get('srv_active:82:1406:2114'),
    ).toEqual({
      book_id: 'srv_active:82:1406:2114',
      id: 'hist-vol3',
    });
  });

  it('upgrades populated v7 databases cleanly when coordinated #328 v8 lands before or after #330/#339/#345', async () => {
    // Merge Order 1: #328 coordinated v8 first -> #330 v8 (no-op) -> #339 v9 -> #345 v10
    const firstOrderDb = createPopulatedV7Database();
    try {
      const adapter = createMigrationAdapter(firstOrderDb);
      await migrateDatabase(adapter);
      expect(await adapter.getVersion()).toEqual({ version: 8 });
      // #330's v8 migration is skipped cleanly because user_version is 8 AND all #330 columns already exist.
      await runSimpleMigrations(adapter, [
        ...migrations.slice(0, 7),
        { version: 8, statements: LEGACY_PR330_ONLY_V8_STATEMENTS },
      ]);
      attachLegacyPreferenceDeleteGuard(firstOrderDb);
      await runCoordinatedV9AndV10Upgrade(adapter);

      expect(await adapter.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
      assertCompleteV10Schema(firstOrderDb);
      expect(firstOrderDb.prepare('SELECT COUNT(*) AS total FROM annotations').get()).toEqual({
        total: 2,
      });
      expect(firstOrderDb.prepare('SELECT COUNT(*) AS total FROM bookmarks').get()).toEqual({
        total: 2,
      });
      expect(firstOrderDb.prepare('SELECT COUNT(*) AS total FROM reading_history').get()).toEqual({
        total: 3,
      });
    } finally {
      firstOrderDb.close();
    }

    // Merge Order 2: coordinated #330/#339/#345 first -> #328 migrateDatabase afterward
    db = createPopulatedV7Database();
    const adapter2 = createMigrationAdapter(db);
    attachLegacyPreferenceDeleteGuard(db);
    await runCoordinatedV9AndV10Upgrade(adapter2);
    await migrateDatabase(adapter2);

    expect(await adapter2.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
    assertCompleteV10Schema(db);
  });
});
