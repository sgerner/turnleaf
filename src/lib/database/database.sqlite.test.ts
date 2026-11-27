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
} from './database';
import { migrations, STUDY_STORAGE_MIGRATION_VERSION } from './schema';

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
    const withAnnotation = {
      ...baseBook,
      id: 'server:1:13',
      chapterId: 13,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
    };
    const withBookmark = {
      ...baseBook,
      id: 'server:1:14',
      chapterId: 14,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
    };
    const cfi = 'epubcfi(/6/4!/4/2/1:12)';
    await replaceBooksInTransaction(adapter, 'server', [
      retained,
      removable,
      withSyncedProgress,
      withAnnotation,
      withBookmark,
    ]);
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
    db.prepare(
      `INSERT INTO annotations (id, book_id, cfi, xpath, excerpt, note, created_at, updated_at)
       VALUES ('ann-1', ?, 'epubcfi(/6/2!/4/2)', '//body/DocFragment[1]/body/p[1]', 'Saved quote', 'Saved note', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z')`,
    ).run(withAnnotation.id);
    db.prepare(
      `INSERT INTO bookmarks (id, book_id, cfi, href, percentage, label, saved_at, updated_at)
       VALUES ('bm-1', ?, 'epubcfi(/6/2!/4/2)', 'ch1.xhtml', 0.1, 'Saved bookmark', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z')`,
    ).run(withBookmark.id);

    await reconcileBooksInTransaction(adapter, 'server', [], '2026-09-10T00:00:00.000Z');

    expect(readBook(db, retained.id)).toMatchObject({ remote_available: 0 });
    expect(readBook(db, withSyncedProgress.id)).toMatchObject({ remote_available: 0 });
    expect(readBook(db, withAnnotation.id)).toMatchObject({ remote_available: 0 });
    expect(readBook(db, withBookmark.id)).toMatchObject({ remote_available: 0 });
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
});

function createMigrationAdapter(db: DatabaseSync): Parameters<typeof migrateDatabase>[0] {
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

function createV7Database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const migration of migrations.slice(0, 7)) {
    db.exec(migration.statements);
    db.exec(`PRAGMA user_version = ${migration.version};`);
  }
  return db;
}

async function runSimpleMigrations(
  adapter: Parameters<typeof migrateDatabase>[0],
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

function seedV7StudyPreferencesFixture(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO server_config
      (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
      VALUES ('srv_active', 'Active Kavita', 'https://active.example', 'server_srv_active_api_key', '0.8.8', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO books
      (id, server_id, library_id, series_id, volume_id, chapter_id, title, format, metadata_refreshed_at, download_path, download_status, file_size, pages, pages_read, created_at)
      VALUES ('srv_active:1:10', 'srv_active', 1, 1, 10, 10, 'Book Ten', 'epub', '2026-01-01T00:00:00.000Z', 'books/srv-active-10.epub', 'available', 20480, 100, 35, '2026-01-01T00:00:00.000Z'),
             ('srv_active:1:11', 'srv_active', 1, 1, 11, 11, 'Book Eleven', 'epub', '2026-01-01T00:00:00.000Z', NULL, 'none', NULL, 80, 0, '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO reading_state
      (book_id, cfi, kavita_xpath, percentage, local_updated_at, synced_local_updated_at, server_updated_at, pending_sync, sync_revision)
      VALUES ('srv_active:1:10', 'epubcfi(/6/4!/4/2)', '//body/DocFragment[2]/body/p[1]', 0.35, '2026-01-05T00:00:00.000Z', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z', 1, 2)`,
  ).run();
  db.prepare(
    `INSERT INTO sync_queue
      (book_id, payload_json, attempt_count, created_at, updated_at, revision)
      VALUES ('srv_active:1:10', '{"chapterId":10,"pageNum":35}', 0, '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z', 2)`,
  ).run();

  const insertPref = db.prepare(
    'INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)',
  );
  insertPref.run('uiTheme', 'eink', '2026-01-01T00:00:00.000Z');
  insertPref.run('readerFontScale', '1.15', '2026-01-01T00:00:00.000Z');

  insertPref.run(
    'readerAnnotations:srv_active:1:10',
    JSON.stringify([
      {
        id: 'ann-minimal',
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        excerpt: 'Minimal legacy highlight',
        note: 'Minimal note',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'ann-extended',
        cfi: 'epubcfi(/6/6!/4/8/1:4)',
        excerpt: 'Extended legacy highlight',
        note: 'Extended note',
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z',
        remoteId: 77,
        xpath: '//body/DocFragment[3]/body/p[4]',
        endingXPath: '//body/DocFragment[3]/body/p[5]',
        pageNumber: 2,
        context: 'Extended surrounding context',
        chapterTitle: 'Chapter Three',
        slotIndex: 2,
        containsSpoiler: true,
        syncState: 'synced',
      },
    ]),
    '2026-01-04T00:00:00.000Z',
  );

  insertPref.run(
    'readerBookmarks:srv_active:1:10',
    JSON.stringify([
      {
        id: 'bm-minimal',
        cfi: 'epubcfi(/6/4!/4/2)',
        href: 'Text/ch2.xhtml',
        percentage: 0.25,
        label: 'Chapter Two',
        savedAt: '2026-01-02T10:00:00.000Z',
      },
      {
        id: 'bm-duplicate-label',
        cfi: 'epubcfi(/6/4!/4/6)',
        href: 'Text/ch2.xhtml',
        percentage: 0.3,
        label: 'Chapter Two',
        savedAt: '2026-01-02T11:00:00.000Z',
      },
      {
        id: 'bm-extended',
        cfi: 'epubcfi(/6/8!/4/2)',
        href: 'Text/ch4.xhtml',
        percentage: 0.75,
        label: 'Synced PToC Mark',
        savedAt: '2026-01-03T10:00:00.000Z',
        updatedAt: '2026-01-03T12:00:00.000Z',
        remoteId: 91,
        xpath: '//body/DocFragment[4]/body/h2[1]',
        pageNumber: 3,
        excerpt: 'Heading excerpt',
        remoteTitle: 'Synced PToC Mark',
        remotePageNumber: 3,
        syncState: 'synced',
      },
    ]),
    '2026-01-04T00:00:00.000Z',
  );

  const historyEntries = Array.from({ length: 14 }, (_, index) => ({
    id: `hist-${index + 1}`,
    cfi: `epubcfi(/6/4!/4/${(index + 1) * 2})`,
    href: 'Text/ch2.xhtml',
    percentage: (index + 1) / 20,
    label: `${(index + 1) * 5}% · ch2.xhtml`,
    savedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  }));
  insertPref.run(
    'readerHistory:srv_active:1:11',
    JSON.stringify(historyEntries),
    '2026-01-14T00:00:00.000Z',
  );

  insertPref.run(
    'readerAnnotations:srv_deleted:9:99',
    JSON.stringify([
      {
        id: 'orphan-ann',
        cfi: 'epubcfi(/6/2!/4/2)',
        excerpt: 'Deleted server highlight',
        note: 'Should be purged',
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
        label: 'Deleted server bookmark',
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
}

describe('coordinated schema v8-v11 migrations and legacy study-data rollback against SQLite', () => {
  let db: DatabaseSync | undefined;

  afterEach(() => db?.close());

  const expectedFinalBookColumns = [
    'id',
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
    'remote_file_size',
    'downloaded_bytes',
    'downloaded_pages',
    'chapter_key',
    'file_id',
    'file_name',
    'chapter_epub_index',
    'multi_file_chapter',
    'sync_progress',
    'sort_order',
    'min_number',
    'volume_number',
  ] as const;

  const expectedAnnotationColumns = [
    'id',
    'book_id',
    'remote_id',
    'cfi',
    'xpath',
    'ending_xpath',
    'page_number',
    'slot_index',
    'contains_spoiler',
    'context',
    'chapter_title',
    'excerpt',
    'note',
    'created_at',
    'updated_at',
    'remote_updated_at',
    'sync_state',
    'sync_revision',
    'attempt_count',
    'last_attempt_at',
    'last_error',
  ] as const;

  const expectedBookmarkColumns = [
    'id',
    'book_id',
    'remote_id',
    'cfi',
    'xpath',
    'href',
    'percentage',
    'page_number',
    'label',
    'excerpt',
    'remote_title',
    'remote_page_number',
    'saved_at',
    'updated_at',
    'sync_state',
    'sync_revision',
    'attempt_count',
    'last_attempt_at',
    'last_error',
  ] as const;

  const expectedReadingHistoryColumns = [
    'book_id',
    'id',
    'cfi',
    'href',
    'percentage',
    'label',
    'saved_at',
  ] as const;

  const pr330V8Migration = {
    version: 8,
    statements: `
      ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
      ALTER TABLE books ADD COLUMN downloaded_bytes INTEGER;
      ALTER TABLE books ADD COLUMN downloaded_pages INTEGER;
      ALTER TABLE books ADD COLUMN chapter_key TEXT;
    `,
  } as const;

  const pr328V9Migration = {
    version: 9,
    statements: `
      ALTER TABLE books ADD COLUMN file_id INTEGER;
      ALTER TABLE books ADD COLUMN file_name TEXT;
      ALTER TABLE books ADD COLUMN chapter_epub_index INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE books ADD COLUMN multi_file_chapter INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE books ADD COLUMN sync_progress INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS books_server_file_idx ON books(server_id, file_id);
    `,
  } as const;

  const pr339V10Migration = {
    version: 10,
    statements: `
      ALTER TABLE books ADD COLUMN sort_order REAL;
      ALTER TABLE books ADD COLUMN min_number REAL;
      ALTER TABLE books ADD COLUMN volume_number REAL;
    `,
  } as const;

  const pr328LegacyV8Migration = {
    version: 8,
    statements: `
      ALTER TABLE books ADD COLUMN file_id INTEGER;
      ALTER TABLE books ADD COLUMN file_name TEXT;
      ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
      ALTER TABLE books ADD COLUMN chapter_epub_index INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE books ADD COLUMN multi_file_chapter INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE books ADD COLUMN sync_progress INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS books_server_file_idx ON books(server_id, file_id);
    `,
  } as const;

  const pr328And330CombinedV8Migration = {
    version: 8,
    statements: `
      ALTER TABLE books ADD COLUMN file_id INTEGER;
      ALTER TABLE books ADD COLUMN file_name TEXT;
      ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
      ALTER TABLE books ADD COLUMN chapter_epub_index INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE books ADD COLUMN multi_file_chapter INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE books ADD COLUMN sync_progress INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE books ADD COLUMN downloaded_bytes INTEGER;
      ALTER TABLE books ADD COLUMN downloaded_pages INTEGER;
      ALTER TABLE books ADD COLUMN chapter_key TEXT;
      CREATE INDEX IF NOT EXISTS books_server_file_idx ON books(server_id, file_id);
    `,
  } as const;

  const pr339LegacyV9Migration = {
    version: 9,
    statements: pr339V10Migration.statements,
  } as const;

  const pr330OnlyMigrations = [...migrations.slice(0, 7), pr330V8Migration] as const;
  const pr330And328OrderedMigrations = [
    ...migrations.slice(0, 7),
    pr330V8Migration,
    pr328V9Migration,
  ] as const;
  const pr330And328And339OrderedMigrations = [
    ...migrations.slice(0, 7),
    pr330V8Migration,
    pr328V9Migration,
    pr339V10Migration,
  ] as const;

  const pr328OnlyMigrations = [...migrations.slice(0, 7), pr328LegacyV8Migration] as const;
  const pr328And330CombinedV8Migrations = [
    ...migrations.slice(0, 7),
    pr328And330CombinedV8Migration,
  ] as const;
  const pr328And339SequentialMigrations = [
    ...migrations.slice(0, 7),
    pr328LegacyV8Migration,
    pr339LegacyV9Migration,
  ] as const;
  const pr330And339SequentialMigrations = [
    ...migrations.slice(0, 7),
    pr330V8Migration,
    pr339LegacyV9Migration,
  ] as const;
  const pr328And330And339CombinedMigrations = [
    ...migrations.slice(0, 7),
    pr328And330CombinedV8Migration,
    pr339LegacyV9Migration,
  ] as const;

  const pr330And339CombinedV8Migrations = [
    ...migrations.slice(0, 7),
    {
      version: 8,
      statements: `
        ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
        ALTER TABLE books ADD COLUMN downloaded_bytes INTEGER;
        ALTER TABLE books ADD COLUMN downloaded_pages INTEGER;
        ALTER TABLE books ADD COLUMN chapter_key TEXT;
        ALTER TABLE books ADD COLUMN sort_order REAL;
        ALTER TABLE books ADD COLUMN min_number REAL;
        ALTER TABLE books ADD COLUMN volume_number REAL;
      `,
    },
  ] as const;

  const pr339OnlyV8Migrations = [
    ...migrations.slice(0, 7),
    {
      version: 8,
      statements: pr339V10Migration.statements,
    },
  ] as const;

  const expectedCoordinatedBookColumns = [
    'remote_file_size',
    'downloaded_bytes',
    'downloaded_pages',
    'chapter_key',
    'file_id',
    'file_name',
    'chapter_epub_index',
    'multi_file_chapter',
    'sync_progress',
    'sort_order',
    'min_number',
    'volume_number',
  ] as const;

  function assertV7StatePreserved(targetDb: DatabaseSync): void {
    expect(
      targetDb
        .prepare(
          'SELECT download_path, download_status, file_size, pages, pages_read FROM books WHERE id = ?',
        )
        .get('srv_active:1:10'),
    ).toEqual({
      download_path: 'books/srv-active-10.epub',
      download_status: 'available',
      file_size: 20480,
      pages: 100,
      pages_read: 35,
    });
    expect(
      targetDb
        .prepare(
          'SELECT cfi, percentage, pending_sync, sync_revision FROM reading_state WHERE book_id = ?',
        )
        .get('srv_active:1:10'),
    ).toEqual({
      cfi: 'epubcfi(/6/4!/4/2)',
      percentage: 0.35,
      pending_sync: 1,
      sync_revision: 2,
    });
    expect(
      targetDb
        .prepare('SELECT payload_json, revision FROM sync_queue WHERE book_id = ?')
        .get('srv_active:1:10'),
    ).toEqual({
      payload_json: '{"chapterId":10,"pageNum":35}',
      revision: 2,
    });
  }

  function assertCoordinatedBookSchemaAndIndex(targetDb: DatabaseSync): void {
    const bookColumns = listColumnNames(targetDb, 'books');
    for (const column of expectedCoordinatedBookColumns) {
      expect(bookColumns).toContain(column);
    }
    expect(bookColumns.filter((column) => column === 'remote_file_size')).toHaveLength(1);
    expect(listIndexNames(targetDb, 'books')).toEqual(
      expect.arrayContaining(['books_server_title_idx', 'books_server_file_idx']),
    );
  }

  function seedPopulatedPredecessorFields(
    targetDb: DatabaseSync,
    options: { has328: boolean; has330: boolean; has339: boolean },
  ): void {
    if (options.has328) {
      targetDb
        .prepare(
          `UPDATE books
           SET file_id = 1001,
               file_name = 'book-ten.epub',
               remote_file_size = 24576,
               chapter_epub_index = 0,
               multi_file_chapter = 0,
               sync_progress = 1
           WHERE id = 'srv_active:1:10'`,
        )
        .run();
      targetDb
        .prepare(
          `INSERT INTO books
            (id, server_id, library_id, series_id, volume_id, chapter_id, file_id, file_name, remote_file_size, chapter_epub_index, multi_file_chapter, sync_progress, title, format, metadata_refreshed_at, download_path, download_status, file_size, pages, pages_read, created_at)
            VALUES ('srv_active:1:11:2115', 'srv_active', 1, 1, 11, 11, 2115, 'book-eleven-part2.epub', 65536, 1, 1, 0, 'Book Eleven (Part 2)', 'epub', '2026-01-01T00:00:00.000Z', NULL, 'none', NULL, 64, 12, '2026-01-01T00:00:00.000Z')`,
        )
        .run();

      const insertPref = targetDb.prepare(
        'INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)',
      );
      insertPref.run(
        'readerAnnotations:srv_active:1:11:2115',
        JSON.stringify([
          {
            id: 'ann-multifile',
            cfi: 'epubcfi(/6/2!/4/2/1:0)',
            excerpt: 'Multi-file chapter highlight',
            note: 'Multi-file note',
            createdAt: '2026-01-06T00:00:00.000Z',
          },
        ]),
        '2026-01-06T00:00:00.000Z',
      );
      insertPref.run(
        'readerBookmarks:srv_active:1:11:2115',
        JSON.stringify([
          {
            id: 'bm-multifile',
            cfi: 'epubcfi(/6/2!/4/4)',
            href: 'Text/part2.xhtml',
            percentage: 0.5,
            label: 'Part Two Midpoint',
            savedAt: '2026-01-06T01:00:00.000Z',
          },
        ]),
        '2026-01-06T01:00:00.000Z',
      );
      insertPref.run(
        'readerHistory:srv_active:1:11:2115',
        JSON.stringify([
          {
            id: 'hist-multifile',
            cfi: 'epubcfi(/6/2!/4/6)',
            href: 'Text/part2.xhtml',
            percentage: 0.55,
            label: '55% · part2.xhtml',
            savedAt: '2026-01-06T02:00:00.000Z',
          },
        ]),
        '2026-01-06T02:00:00.000Z',
      );
    }

    if (options.has330) {
      targetDb
        .prepare(
          `UPDATE books
           SET remote_file_size = 24576,
               downloaded_bytes = 20480,
               downloaded_pages = 100,
               chapter_key = '10:24576'
           WHERE id = 'srv_active:1:10'`,
        )
        .run();
    }

    if (options.has339) {
      targetDb
        .prepare(
          `UPDATE books
           SET sort_order = 1.5,
               min_number = 1,
               volume_number = 2
           WHERE id = 'srv_active:1:10'`,
        )
        .run();
    }
  }

  function installReconciliationAndCopyOrderTrigger(
    targetDb: DatabaseSync,
    counts: { annotations: number; bookmarks: number; history: number },
  ): void {
    const quotedColumns = expectedCoordinatedBookColumns.map((name) => `'${name}'`).join(', ');
    targetDb.exec(`
      CREATE TRIGGER assert_reconciled_and_copied_before_preference_delete
      BEFORE DELETE ON preferences
      WHEN OLD.key LIKE 'readerAnnotations:%'
        OR OLD.key LIKE 'readerBookmarks:%'
        OR OLD.key LIKE 'readerHistory:%'
      BEGIN
        SELECT CASE
          WHEN (
            SELECT COUNT(*) FROM pragma_table_info('books')
            WHERE name IN (${quotedColumns})
          ) < ${expectedCoordinatedBookColumns.length}
          THEN RAISE(ABORT, 'legacy preference deleted before coordinated books columns were reconciled')
          WHEN (
            SELECT COUNT(*) FROM pragma_index_list('books')
            WHERE name = 'books_server_file_idx'
          ) < 1
          THEN RAISE(ABORT, 'legacy preference deleted before books_server_file_idx was reconciled')
          WHEN (SELECT COUNT(*) FROM annotations) < ${counts.annotations}
            OR (SELECT COUNT(*) FROM bookmarks) < ${counts.bookmarks}
            OR (SELECT COUNT(*) FROM reading_history) < ${counts.history}
          THEN RAISE(ABORT, 'legacy preference deleted before all study records were copied')
        END;
      END;
    `);
  }

  function createOrderRecordingAdapter(
    baseAdapter: Parameters<typeof migrateDatabase>[0],
    executedStatements: string[],
  ): Parameters<typeof migrateDatabase>[0] {
    return {
      ...baseAdapter,
      executeTransaction(tasks) {
        for (const task of tasks) executedStatements.push(task.statement.trim());
        return baseAdapter.executeTransaction(tasks);
      },
    };
  }

  function assertReconciliationPrecededStudyCopyAndDelete(executedStatements: string[]): void {
    const firstStudyCopyIndex = executedStatements.findIndex(
      (sql) =>
        sql.startsWith('INSERT INTO annotations') ||
        sql.startsWith('INSERT INTO bookmarks') ||
        sql.startsWith('INSERT INTO reading_history'),
    );
    const deleteLegacyPrefsIndex = executedStatements.findIndex((sql) =>
      sql.startsWith('DELETE FROM preferences'),
    );
    expect(firstStudyCopyIndex).toBeGreaterThan(-1);
    expect(deleteLegacyPrefsIndex).toBeGreaterThan(firstStudyCopyIndex);

    for (let index = 0; index < executedStatements.length; index += 1) {
      const sql = executedStatements[index] ?? '';
      if (
        sql.includes('ALTER TABLE books ADD COLUMN') ||
        sql.includes('CREATE INDEX IF NOT EXISTS books_server_file_idx')
      ) {
        expect(index).toBeLessThan(firstStudyCopyIndex);
        expect(index).toBeLessThan(deleteLegacyPrefsIndex);
      }
    }
  }

  it('upgrades a database from every earlier version (v7 through v11, and v1 through v6) and asserts the final column set and idempotent PRAGMA table_info checks', async () => {
    for (let startVersion = 1; startVersion <= STUDY_STORAGE_MIGRATION_VERSION; startVersion += 1) {
      const candidateDb = new DatabaseSync(':memory:');
      try {
        candidateDb.exec('PRAGMA foreign_keys = ON;');
        for (const migration of migrations.slice(0, startVersion)) {
          candidateDb.exec(migration.statements);
          candidateDb.exec(`PRAGMA user_version = ${migration.version};`);
        }

        if (startVersion >= 7 && startVersion < STUDY_STORAGE_MIGRATION_VERSION) {
          seedV7StudyPreferencesFixture(candidateDb);
          seedPopulatedPredecessorFields(candidateDb, {
            has330: startVersion >= 8,
            has328: startVersion >= 9,
            has339: startVersion >= 10,
          });
        }

        const adapter = createMigrationAdapter(candidateDb);
        await migrateDatabase(adapter);
        // Re-running migrateDatabase at v11 is an idempotent no-op.
        await migrateDatabase(adapter);

        expect(await adapter.getVersion(), `startVersion=v${startVersion}`).toEqual({
          version: STUDY_STORAGE_MIGRATION_VERSION,
        });
        expect(
          listColumnNames(candidateDb, 'books'),
          `books columns from v${startVersion}`,
        ).toEqual([...expectedFinalBookColumns]);
        expect(
          listColumnNames(candidateDb, 'annotations'),
          `annotations columns from v${startVersion}`,
        ).toEqual([...expectedAnnotationColumns]);
        expect(
          listColumnNames(candidateDb, 'bookmarks'),
          `bookmarks columns from v${startVersion}`,
        ).toEqual([...expectedBookmarkColumns]);
        expect(
          listColumnNames(candidateDb, 'reading_history'),
          `reading_history columns from v${startVersion}`,
        ).toEqual([...expectedReadingHistoryColumns]);
        expect(listIndexNames(candidateDb, 'books')).toEqual(
          expect.arrayContaining(['books_server_title_idx', 'books_server_file_idx']),
        );

        if (startVersion >= 7 && startVersion < STUDY_STORAGE_MIGRATION_VERSION) {
          assertV7StatePreserved(candidateDb);
          const has328 = startVersion >= 9;
          expect(candidateDb.prepare('SELECT COUNT(*) AS total FROM annotations').get()).toEqual({
            total: has328 ? 3 : 2,
          });
          expect(candidateDb.prepare('SELECT COUNT(*) AS total FROM bookmarks').get()).toEqual({
            total: has328 ? 4 : 3,
          });
          expect(
            candidateDb.prepare('SELECT COUNT(*) AS total FROM reading_history').get(),
          ).toEqual({
            total: has328 ? 13 : 12,
          });
          expect(
            candidateDb.prepare('SELECT key, value FROM preferences ORDER BY key ASC').all(),
          ).toEqual([
            { key: 'readerFontScale', value: '1.15' },
            { key: 'uiTheme', value: 'eink' },
          ]);
        }
      } finally {
        candidateDb.close();
      }
    }

    // Verify idempotent PRAGMA table_info checks when target columns ALREADY exist before v2..v10 run.
    for (const startVersion of [1, 7, 8, 9, 10] as const) {
      const preAddedDb = new DatabaseSync(':memory:');
      try {
        preAddedDb.exec('PRAGMA foreign_keys = ON;');
        for (const migration of migrations.slice(0, startVersion)) {
          preAddedDb.exec(migration.statements);
          preAddedDb.exec(`PRAGMA user_version = ${migration.version};`);
        }
        if (startVersion === 1) {
          preAddedDb.exec('ALTER TABLE books ADD COLUMN pages INTEGER NOT NULL DEFAULT 0;');
          preAddedDb.exec('ALTER TABLE sync_queue ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;');
          preAddedDb.exec(
            'ALTER TABLE reading_state ADD COLUMN sync_revision INTEGER NOT NULL DEFAULT 0;',
          );
        }
        if (startVersion <= 8) {
          if (!listColumnNames(preAddedDb, 'books').includes('remote_file_size')) {
            preAddedDb.exec('ALTER TABLE books ADD COLUMN remote_file_size INTEGER;');
          }
          if (!listColumnNames(preAddedDb, 'books').includes('downloaded_bytes')) {
            preAddedDb.exec('ALTER TABLE books ADD COLUMN downloaded_bytes INTEGER;');
          }
        }
        if (startVersion <= 9 && !listColumnNames(preAddedDb, 'books').includes('file_id')) {
          preAddedDb.exec('ALTER TABLE books ADD COLUMN file_id INTEGER;');
        }
        if (startVersion <= 10 && !listColumnNames(preAddedDb, 'books').includes('sort_order')) {
          preAddedDb.exec('ALTER TABLE books ADD COLUMN sort_order REAL;');
        }

        const adapter = createMigrationAdapter(preAddedDb);
        await migrateDatabase(adapter);
        expect(await adapter.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
        expect(new Set(listColumnNames(preAddedDb, 'books'))).toEqual(
          new Set(expectedFinalBookColumns),
        );
        expect(listColumnNames(preAddedDb, 'books')).toHaveLength(expectedFinalBookColumns.length);
      } finally {
        preAddedDb.close();
      }
    }
    db = undefined;
  });

  it('upgrades populated v7 databases cleanly across the #330 v8 -> #328 v9 -> #339 v10 -> #345 v11 merge sequence and compatibility matrix, reconciling before copying/deleting legacy study preferences', async () => {
    const scenarios = [
      {
        label: 'ordered #330 v8',
        priorMigrations: pr330OnlyMigrations,
        followupMigrations: pr330And328And339OrderedMigrations,
        has328: false,
        has330: true,
        has339: false,
      },
      {
        label: 'ordered #330 v8 + #328 v9',
        priorMigrations: pr330And328OrderedMigrations,
        followupMigrations: pr330And328And339OrderedMigrations,
        has328: true,
        has330: true,
        has339: false,
      },
      {
        label: 'ordered #330 v8 + #328 v9 + #339 v10',
        priorMigrations: pr330And328And339OrderedMigrations,
        followupMigrations: pr330And328And339OrderedMigrations,
        has328: true,
        has330: true,
        has339: true,
      },
      {
        label: '#328-only v8',
        priorMigrations: pr328OnlyMigrations,
        followupMigrations: pr330And328And339OrderedMigrations,
        has328: true,
        has330: false,
        has339: false,
      },
      {
        label: 'combined #328+#330 v8',
        priorMigrations: pr328And330CombinedV8Migrations,
        followupMigrations: pr330And328And339OrderedMigrations,
        has328: true,
        has330: true,
        has339: false,
      },
      {
        label: '#328 v8 + #339 v9',
        priorMigrations: pr328And339SequentialMigrations,
        followupMigrations: pr330And328And339OrderedMigrations,
        has328: true,
        has330: false,
        has339: true,
      },
      {
        label: '#330 v8 + #339 v9',
        priorMigrations: pr330And339SequentialMigrations,
        followupMigrations: pr330And328And339OrderedMigrations,
        has328: false,
        has330: true,
        has339: true,
      },
      {
        label: 'combined #328+#330 v8 + #339 v9',
        priorMigrations: pr328And330And339CombinedMigrations,
        followupMigrations: pr330And328And339OrderedMigrations,
        has328: true,
        has330: true,
        has339: true,
      },
      {
        label: 'uncoordinated #330+#339 combined v8',
        priorMigrations: pr330And339CombinedV8Migrations,
        followupMigrations: pr330And328And339OrderedMigrations,
        has328: false,
        has330: true,
        has339: true,
      },
    ] as const;

    for (const scenario of scenarios) {
      const candidateDb = createV7Database();
      try {
        seedV7StudyPreferencesFixture(candidateDb);
        const baseAdapter = createMigrationAdapter(candidateDb);

        await runSimpleMigrations(baseAdapter, scenario.priorMigrations);
        seedPopulatedPredecessorFields(candidateDb, scenario);

        const expectedAnnotations = scenario.has328 ? 3 : 2;
        const expectedBookmarks = scenario.has328 ? 4 : 3;
        const expectedHistory = scenario.has328 ? 13 : 12;
        installReconciliationAndCopyOrderTrigger(candidateDb, {
          annotations: expectedAnnotations,
          bookmarks: expectedBookmarks,
          history: expectedHistory,
        });

        const executedStatements: string[] = [];
        const recordingAdapter = createOrderRecordingAdapter(baseAdapter, executedStatements);
        await migrateDatabase(recordingAdapter);
        assertReconciliationPrecededStudyCopyAndDelete(executedStatements);

        // Any subsequent #328/#330/#339 migration sets are safe no-ops once at v10.
        await runSimpleMigrations(baseAdapter, scenario.followupMigrations);

        expect(await baseAdapter.getVersion(), scenario.label).toEqual({
          version: STUDY_STORAGE_MIGRATION_VERSION,
        });
        assertCoordinatedBookSchemaAndIndex(candidateDb);
        expect(listTableNames(candidateDb)).toEqual(
          expect.arrayContaining(['annotations', 'bookmarks', 'reading_history']),
        );
        assertV7StatePreserved(candidateDb);

        expect(
          candidateDb
            .prepare(
              `SELECT file_id, file_name, remote_file_size, chapter_epub_index, multi_file_chapter, sync_progress,
                      downloaded_bytes, downloaded_pages, chapter_key, sort_order, min_number, volume_number
               FROM books WHERE id = ?`,
            )
            .get('srv_active:1:10'),
          scenario.label,
        ).toEqual({
          file_id: scenario.has328 ? 1001 : null,
          file_name: scenario.has328 ? 'book-ten.epub' : null,
          remote_file_size: scenario.has328 || scenario.has330 ? 24576 : null,
          chapter_epub_index: 0,
          multi_file_chapter: 0,
          sync_progress: 1,
          downloaded_bytes: scenario.has330 ? 20480 : null,
          downloaded_pages: scenario.has330 ? 100 : null,
          chapter_key: scenario.has330 ? '10:24576' : null,
          sort_order: scenario.has339 ? 1.5 : null,
          min_number: scenario.has339 ? 1 : null,
          volume_number: scenario.has339 ? 2 : null,
        });

        if (scenario.has328) {
          expect(
            candidateDb
              .prepare(
                `SELECT file_id, file_name, remote_file_size, chapter_epub_index, multi_file_chapter, sync_progress
                 FROM books WHERE server_id = ? AND file_id = ?`,
              )
              .get('srv_active', 2115),
            scenario.label,
          ).toEqual({
            file_id: 2115,
            file_name: 'book-eleven-part2.epub',
            remote_file_size: 65536,
            chapter_epub_index: 1,
            multi_file_chapter: 1,
            sync_progress: 0,
          });
          expect(
            candidateDb
              .prepare('SELECT id FROM annotations WHERE book_id = ?')
              .get('srv_active:1:11:2115'),
          ).toEqual({ id: 'srv_active:1:11:2115:ann-multifile' });
          expect(
            candidateDb
              .prepare('SELECT id FROM bookmarks WHERE book_id = ?')
              .get('srv_active:1:11:2115'),
          ).toEqual({ id: 'srv_active:1:11:2115:bm-multifile' });
          expect(
            candidateDb
              .prepare('SELECT id FROM reading_history WHERE book_id = ?')
              .get('srv_active:1:11:2115'),
          ).toEqual({ id: 'hist-multifile' });
        }

        expect(candidateDb.prepare('SELECT COUNT(*) AS total FROM annotations').get()).toEqual({
          total: expectedAnnotations,
        });
        expect(candidateDb.prepare('SELECT COUNT(*) AS total FROM bookmarks').get()).toEqual({
          total: expectedBookmarks,
        });
        expect(candidateDb.prepare('SELECT COUNT(*) AS total FROM reading_history').get()).toEqual({
          total: expectedHistory,
        });
        expect(
          candidateDb.prepare('SELECT key, value FROM preferences ORDER BY key ASC').all(),
        ).toEqual([
          { key: 'readerFontScale', value: '1.15' },
          { key: 'uiTheme', value: 'eink' },
        ]);
      } finally {
        candidateDb.close();
      }
    }
    db = undefined;
  });

  it('upgrades populated v7 databases cleanly when #345 lands first (reconciling v8+v9 before copying/deleting legacy preferences) and #328/#330/#339 migrations run afterward', async () => {
    db = createV7Database();
    seedV7StudyPreferencesFixture(db);
    const baseAdapter = createMigrationAdapter(db);

    installReconciliationAndCopyOrderTrigger(db, {
      annotations: 2,
      bookmarks: 3,
      history: 12,
    });
    const executedStatements: string[] = [];
    const recordingAdapter = createOrderRecordingAdapter(baseAdapter, executedStatements);

    await migrateDatabase(recordingAdapter);
    assertReconciliationPrecededStudyCopyAndDelete(executedStatements);

    for (const subsequentMigrations of [
      pr330OnlyMigrations,
      pr330And328OrderedMigrations,
      pr330And328And339OrderedMigrations,
      pr328OnlyMigrations,
      pr328And330CombinedV8Migrations,
      pr328And339SequentialMigrations,
      pr330And339SequentialMigrations,
      pr328And330And339CombinedMigrations,
    ]) {
      await runSimpleMigrations(baseAdapter, subsequentMigrations);
    }
    await migrateDatabase(baseAdapter);

    expect(await baseAdapter.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
    assertCoordinatedBookSchemaAndIndex(db);
    expect(listTableNames(db)).toEqual(
      expect.arrayContaining(['annotations', 'bookmarks', 'reading_history']),
    );
    assertV7StatePreserved(db);
    expect(
      db
        .prepare(
          `SELECT file_id, file_name, remote_file_size, chapter_epub_index, multi_file_chapter, sync_progress,
                  downloaded_bytes, downloaded_pages, chapter_key, sort_order, min_number, volume_number
           FROM books WHERE id = ?`,
        )
        .get('srv_active:1:10'),
    ).toEqual({
      file_id: null,
      file_name: null,
      remote_file_size: null,
      chapter_epub_index: 0,
      multi_file_chapter: 0,
      sync_progress: 1,
      downloaded_bytes: null,
      downloaded_pages: null,
      chapter_key: null,
      sort_order: null,
      min_number: null,
      volume_number: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS total FROM annotations').get()).toEqual({ total: 2 });
    expect(db.prepare('SELECT COUNT(*) AS total FROM bookmarks').get()).toEqual({ total: 3 });
    expect(db.prepare('SELECT COUNT(*) AS total FROM reading_history').get()).toEqual({
      total: 12,
    });
  });

  it('reconciles missing #328 and #330 v8 books columns and index if an uncoordinated v8 migration added only #339 columns before #345 runs', async () => {
    db = createV7Database();
    seedV7StudyPreferencesFixture(db);
    const baseAdapter = createMigrationAdapter(db);

    await runSimpleMigrations(baseAdapter, pr339OnlyV8Migrations);
    seedPopulatedPredecessorFields(db, { has328: false, has330: false, has339: true });
    expect(await baseAdapter.getVersion()).toEqual({ version: 8 });

    installReconciliationAndCopyOrderTrigger(db, {
      annotations: 2,
      bookmarks: 3,
      history: 12,
    });
    const executedStatements: string[] = [];
    await migrateDatabase(createOrderRecordingAdapter(baseAdapter, executedStatements));
    assertReconciliationPrecededStudyCopyAndDelete(executedStatements);

    expect(await baseAdapter.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
    assertCoordinatedBookSchemaAndIndex(db);
    expect(
      db
        .prepare(
          'SELECT chapter_epub_index, multi_file_chapter, sync_progress, sort_order, min_number, volume_number FROM books WHERE id = ?',
        )
        .get('srv_active:1:10'),
    ).toEqual({
      chapter_epub_index: 0,
      multi_file_chapter: 0,
      sync_progress: 1,
      sort_order: 1.5,
      min_number: 1,
      volume_number: 2,
    });
    expect(db.prepare('SELECT COUNT(*) AS total FROM annotations').get()).toEqual({ total: 2 });
    expect(db.prepare('SELECT COUNT(*) AS total FROM bookmarks').get()).toEqual({ total: 3 });
    expect(db.prepare('SELECT COUNT(*) AS total FROM reading_history').get()).toEqual({
      total: 12,
    });
  });

  it('copies every supported legacy annotation, bookmark, and history record into study tables before deleting legacy preferences', async () => {
    db = createV7Database();
    seedV7StudyPreferencesFixture(db);
    const adapter = createMigrationAdapter(db);

    // SQLite trigger proves inside the database engine that when any legacy preference row is
    // deleted, all coordinated books columns, index, and active-server study records ALREADY exist.
    installReconciliationAndCopyOrderTrigger(db, {
      annotations: 2,
      bookmarks: 3,
      history: 12,
    });

    await migrateDatabase(adapter);

    const annotations = db
      .prepare('SELECT * FROM annotations ORDER BY created_at ASC')
      .all() as Array<Record<string, unknown>>;
    expect(annotations).toEqual([
      expect.objectContaining({
        id: 'srv_active:1:10:ann-minimal',
        book_id: 'srv_active:1:10',
        remote_id: null,
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        xpath: '//body/DocFragment[2]/body',
        ending_xpath: '//body/DocFragment[2]/body',
        page_number: 1,
        slot_index: 0,
        contains_spoiler: 0,
        context: 'Minimal legacy highlight',
        chapter_title: null,
        excerpt: 'Minimal legacy highlight',
        note: 'Minimal note',
        created_at: '2026-01-02T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        sync_state: 'pending_create',
      }),
      expect.objectContaining({
        id: 'srv_active:1:10:ann-extended',
        book_id: 'srv_active:1:10',
        remote_id: 77,
        cfi: 'epubcfi(/6/6!/4/8/1:4)',
        xpath: '//body/DocFragment[3]/body/p[4]',
        ending_xpath: '//body/DocFragment[3]/body/p[5]',
        page_number: 2,
        slot_index: 2,
        contains_spoiler: 1,
        context: 'Extended surrounding context',
        chapter_title: 'Chapter Three',
        excerpt: 'Extended legacy highlight',
        note: 'Extended note',
        created_at: '2026-01-03T00:00:00.000Z',
        updated_at: '2026-01-04T00:00:00.000Z',
        sync_state: 'synced',
      }),
    ]);

    const bookmarks = db
      .prepare('SELECT * FROM bookmarks ORDER BY saved_at ASC, id ASC')
      .all() as Array<Record<string, unknown>>;
    expect(bookmarks).toEqual([
      expect.objectContaining({
        id: 'srv_active:1:10:bm-minimal',
        book_id: 'srv_active:1:10',
        remote_id: null,
        cfi: 'epubcfi(/6/4!/4/2)',
        xpath: '//body/DocFragment[2]/body',
        href: 'Text/ch2.xhtml',
        percentage: 0.25,
        page_number: 1,
        label: 'Chapter Two',
        excerpt: '',
        sync_state: 'pending_create',
      }),
      expect.objectContaining({
        id: 'srv_active:1:10:bm-duplicate-label',
        book_id: 'srv_active:1:10',
        page_number: 1,
        label: 'Chapter Two (2)',
        sync_state: 'pending_create',
      }),
      expect.objectContaining({
        id: 'srv_active:1:10:bm-extended',
        book_id: 'srv_active:1:10',
        remote_id: 91,
        xpath: '//body/DocFragment[4]/body/h2[1]',
        page_number: 3,
        label: 'Synced PToC Mark',
        excerpt: 'Heading excerpt',
        remote_title: 'Synced PToC Mark',
        remote_page_number: 3,
        sync_state: 'synced',
      }),
    ]);

    const history = db
      .prepare('SELECT book_id, id FROM reading_history ORDER BY id ASC')
      .all() as Array<{ book_id: string; id: string }>;
    expect(history).toHaveLength(12);
    expect(history.every((entry) => entry.book_id === 'srv_active:1:11')).toBe(true);

    const remainingPrefs = db
      .prepare('SELECT key, value FROM preferences ORDER BY key ASC')
      .all() as Array<{ key: string; value: string }>;
    expect(remainingPrefs).toEqual([
      { key: 'readerFontScale', value: '1.15' },
      { key: 'uiTheme', value: 'eink' },
    ]);
  });

  it('rolls back the v11 migration and leaves all source preferences intact if any query or study insert fails across #330/#328/#339 v8-v10 predecessors, then succeeds on retry', async () => {
    for (const priorCase of [
      { migrations: pr330OnlyMigrations, has328: false, has330: true, has339: false },
      { migrations: pr330And328OrderedMigrations, has328: true, has330: true, has339: false },
      {
        migrations: pr330And328And339OrderedMigrations,
        has328: true,
        has330: true,
        has339: true,
      },
      { migrations: pr328OnlyMigrations, has328: true, has330: false, has339: false },
    ] as const) {
      const candidateDb = createV7Database();
      try {
        seedV7StudyPreferencesFixture(candidateDb);
        const adapter = createMigrationAdapter(candidateDb);

        await runSimpleMigrations(adapter, priorCase.migrations);
        const has328 = priorCase.has328;
        seedPopulatedPredecessorFields(candidateDb, {
          has328: priorCase.has328,
          has330: priorCase.has330,
          has339: priorCase.has339,
        });

        const preferencesBefore = candidateDb
          .prepare('SELECT key, value, updated_at FROM preferences ORDER BY key ASC')
          .all();

        // 1. Transient query error while reading legacy preferences aborts before touching preferences.
        const failingQueryAdapter: Parameters<typeof migrateDatabase>[0] = {
          ...adapter,
          query(statement, values) {
            if (statement.includes('FROM preferences')) {
              return Promise.reject(new Error('SQLITE_BUSY: database is locked'));
            }
            return adapter.query(statement, values);
          },
        };
        await expect(migrateDatabase(failingQueryAdapter)).rejects.toThrow(/SQLITE_BUSY/);
        expect(
          candidateDb
            .prepare('SELECT key, value, updated_at FROM preferences ORDER BY key ASC')
            .all(),
        ).toEqual(preferencesBefore);
        expect(await adapter.getVersion()).toEqual({ version: 10 });

        // 2. Inject NOT NULL violations on annotations, bookmarks, and reading_history inserts in turn.
        for (const targetInsert of [
          'INSERT INTO annotations',
          'INSERT INTO bookmarks',
          'INSERT INTO reading_history',
        ]) {
          const failingInsertAdapter: Parameters<typeof migrateDatabase>[0] = {
            ...adapter,
            executeTransaction(tasks) {
              let injected = false;
              const injectedTasks = tasks.map((task) => {
                if (!injected && task.statement.includes(targetInsert)) {
                  injected = true;
                  const values = [...(task.values ?? [])];
                  values[values.length - 1] =
                    targetInsert === 'INSERT INTO reading_history'
                      ? null
                      : values[values.length - 1];
                  if (targetInsert !== 'INSERT INTO reading_history') {
                    // Null out a NOT NULL column (created_at on annotations, saved_at on bookmarks)
                    const nullIndex = targetInsert === 'INSERT INTO annotations' ? 13 : 12;
                    values[nullIndex] = null;
                  }
                  return { statement: task.statement, values };
                }
                return task;
              });
              return adapter.executeTransaction(injectedTasks);
            },
          };

          await expect(migrateDatabase(failingInsertAdapter)).rejects.toThrow(/NOT NULL/i);

          const preferencesAfterRollback = candidateDb
            .prepare('SELECT key, value, updated_at FROM preferences ORDER BY key ASC')
            .all();
          expect(preferencesAfterRollback).toEqual(preferencesBefore);
          expect(await adapter.getVersion()).toEqual({ version: 10 });
          expect(listTableNames(candidateDb)).not.toContain('annotations');
          expect(listTableNames(candidateDb)).not.toContain('bookmarks');
          expect(listTableNames(candidateDb)).not.toContain('reading_history');
        }

        // 3. Inject a FOREIGN KEY violation on the final reading_history insert.
        const failingFinalFkAdapter: Parameters<typeof migrateDatabase>[0] = {
          ...adapter,
          executeTransaction(tasks) {
            const lastHistoryIndex = tasks.reduce(
              (found, task, index) =>
                task.statement.includes('INSERT INTO reading_history') ? index : found,
              -1,
            );
            const injectedTasks = tasks.map((task, index) => {
              if (index !== lastHistoryIndex) return task;
              const values = [...(task.values ?? [])];
              values[0] = 'srv_missing:999:999';
              return { statement: task.statement, values };
            });
            return adapter.executeTransaction(injectedTasks);
          },
        };
        await expect(migrateDatabase(failingFinalFkAdapter)).rejects.toThrow(/FOREIGN KEY/i);
        expect(
          candidateDb
            .prepare('SELECT key, value, updated_at FROM preferences ORDER BY key ASC')
            .all(),
        ).toEqual(preferencesBefore);
        expect(await adapter.getVersion()).toEqual({ version: 10 });
        expect(listTableNames(candidateDb)).not.toContain('annotations');
        expect(listTableNames(candidateDb)).not.toContain('bookmarks');
        expect(listTableNames(candidateDb)).not.toContain('reading_history');

        // 4. Retrying once the failure is cleared reconciles missing columns and migrates every supported record cleanly.
        await migrateDatabase(adapter);
        expect(await adapter.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
        assertCoordinatedBookSchemaAndIndex(candidateDb);
        expect(candidateDb.prepare('SELECT COUNT(*) AS total FROM annotations').get()).toEqual({
          total: has328 ? 3 : 2,
        });
        expect(candidateDb.prepare('SELECT COUNT(*) AS total FROM bookmarks').get()).toEqual({
          total: has328 ? 4 : 3,
        });
        expect(candidateDb.prepare('SELECT COUNT(*) AS total FROM reading_history').get()).toEqual({
          total: has328 ? 13 : 12,
        });
        expect(
          candidateDb
            .prepare(
              "SELECT key FROM preferences WHERE key LIKE 'readerAnnotations:%' OR key LIKE 'readerBookmarks:%' OR key LIKE 'readerHistory:%'",
            )
            .all(),
        ).toEqual([]);
      } finally {
        candidateDb.close();
      }
    }
    db = undefined;
  });
});
