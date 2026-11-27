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

describe('coordinated schema v8-v10 migrations and legacy study-data rollback against SQLite', () => {
  let db: DatabaseSync | undefined;

  afterEach(() => db?.close());

  const pr330And339SequentialMigrations = [
    ...migrations.slice(0, 7),
    {
      version: 8,
      statements: `
        ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
        ALTER TABLE books ADD COLUMN downloaded_bytes INTEGER;
        ALTER TABLE books ADD COLUMN downloaded_pages INTEGER;
        ALTER TABLE books ADD COLUMN chapter_key TEXT;
      `,
    },
    {
      version: 9,
      statements: `
        ALTER TABLE books ADD COLUMN sort_order REAL;
        ALTER TABLE books ADD COLUMN min_number REAL;
        ALTER TABLE books ADD COLUMN volume_number REAL;
      `,
    },
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

  const pr330OnlyMigrations = pr330And339SequentialMigrations.slice(0, 8);

  const expectedCoordinatedBookColumns = [
    'remote_file_size',
    'downloaded_bytes',
    'downloaded_pages',
    'chapter_key',
    'sort_order',
    'min_number',
    'volume_number',
  ];

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

  it('upgrades cleanly from v7 when #330/#339 schema migrations land first (#330 v8 only, sequential v8+v9, and combined v8) and #345 upgrades second', async () => {
    for (const priorMigrations of [
      pr330OnlyMigrations,
      pr330And339SequentialMigrations,
      pr330And339CombinedV8Migrations,
    ]) {
      const candidateDb = createV7Database();
      try {
        seedV7StudyPreferencesFixture(candidateDb);
        const adapter = createMigrationAdapter(candidateDb);

        await runSimpleMigrations(adapter, priorMigrations);
        await migrateDatabase(adapter);
        // If #339 lands after #330 + #345, its migrations are also a safe no-op at v10.
        await runSimpleMigrations(adapter, pr330And339SequentialMigrations);

        expect(await adapter.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
        const bookColumns = listColumnNames(candidateDb, 'books');
        for (const column of expectedCoordinatedBookColumns) {
          expect(bookColumns).toContain(column);
        }
        expect(listTableNames(candidateDb)).toEqual(
          expect.arrayContaining(['annotations', 'bookmarks', 'reading_history']),
        );
        assertV7StatePreserved(candidateDb);
        expect(candidateDb.prepare('SELECT COUNT(*) AS total FROM annotations').get()).toEqual({
          total: 2,
        });
        expect(candidateDb.prepare('SELECT COUNT(*) AS total FROM bookmarks').get()).toEqual({
          total: 3,
        });
        expect(candidateDb.prepare('SELECT COUNT(*) AS total FROM reading_history').get()).toEqual({
          total: 12,
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

  it('upgrades cleanly from v7 when #345 lands first and #330/#339 migrations run afterward without skipping columns or study tables', async () => {
    db = createV7Database();
    seedV7StudyPreferencesFixture(db);
    const adapter = createMigrationAdapter(db);

    await migrateDatabase(adapter);
    await runSimpleMigrations(adapter, pr330OnlyMigrations);
    await runSimpleMigrations(adapter, pr330And339SequentialMigrations);
    await migrateDatabase(adapter);

    expect(await adapter.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
    const bookColumns = listColumnNames(db, 'books');
    for (const column of expectedCoordinatedBookColumns) {
      expect(bookColumns).toContain(column);
    }
    expect(listTableNames(db)).toEqual(
      expect.arrayContaining(['annotations', 'bookmarks', 'reading_history']),
    );
    assertV7StatePreserved(db);
    expect(db.prepare('SELECT COUNT(*) AS total FROM annotations').get()).toEqual({ total: 2 });
    expect(db.prepare('SELECT COUNT(*) AS total FROM bookmarks').get()).toEqual({ total: 3 });
    expect(db.prepare('SELECT COUNT(*) AS total FROM reading_history').get()).toEqual({
      total: 12,
    });
  });

  it('reconciles missing v8 books columns if an uncoordinated v8 migration added only #339 columns before #345 runs', async () => {
    db = createV7Database();
    seedV7StudyPreferencesFixture(db);
    const adapter = createMigrationAdapter(db);

    await runSimpleMigrations(adapter, [
      ...migrations.slice(0, 7),
      {
        version: 8,
        statements: `
          ALTER TABLE books ADD COLUMN sort_order REAL;
          ALTER TABLE books ADD COLUMN min_number REAL;
          ALTER TABLE books ADD COLUMN volume_number REAL;
        `,
      },
    ]);
    expect(await adapter.getVersion()).toEqual({ version: 8 });

    await migrateDatabase(adapter);

    expect(await adapter.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
    const bookColumns = listColumnNames(db, 'books');
    for (const column of expectedCoordinatedBookColumns) {
      expect(bookColumns).toContain(column);
    }
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
    // deleted, all supported active-server study records have ALREADY been inserted.
    db.exec(`
      CREATE TRIGGER assert_study_rows_copied_before_preference_delete
      BEFORE DELETE ON preferences
      WHEN OLD.key LIKE 'readerAnnotations:%'
        OR OLD.key LIKE 'readerBookmarks:%'
        OR OLD.key LIKE 'readerHistory:%'
      BEGIN
        SELECT CASE
          WHEN (SELECT COUNT(*) FROM annotations) < 2
            OR (SELECT COUNT(*) FROM bookmarks) < 3
            OR (SELECT COUNT(*) FROM reading_history) < 12
          THEN RAISE(ABORT, 'legacy preference deleted before all study records were copied')
        END;
      END;
    `);

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

  it('rolls back the v10 migration and leaves all source preferences intact if any query or study insert fails, then succeeds on retry', async () => {
    db = createV7Database();
    seedV7StudyPreferencesFixture(db);
    const adapter = createMigrationAdapter(db);

    const preferencesBefore = db
      .prepare('SELECT key, value, updated_at FROM preferences ORDER BY key ASC')
      .all();

    await runSimpleMigrations(adapter, pr330And339SequentialMigrations);
    expect(await adapter.getVersion()).toEqual({ version: 9 });

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
      db.prepare('SELECT key, value, updated_at FROM preferences ORDER BY key ASC').all(),
    ).toEqual(preferencesBefore);
    expect(await adapter.getVersion()).toEqual({ version: 9 });

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
                targetInsert === 'INSERT INTO reading_history' ? null : values[values.length - 1];
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

      const preferencesAfterRollback = db
        .prepare('SELECT key, value, updated_at FROM preferences ORDER BY key ASC')
        .all();
      expect(preferencesAfterRollback).toEqual(preferencesBefore);
      expect(await adapter.getVersion()).toEqual({ version: 9 });
      expect(listTableNames(db)).not.toContain('annotations');
      expect(listTableNames(db)).not.toContain('bookmarks');
      expect(listTableNames(db)).not.toContain('reading_history');
    }

    // 3. Inject a FOREIGN KEY violation on the final reading_history insert (after 2 annotations,
    //    3 bookmarks, and 11 history rows have already inserted inside the transaction).
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
      db.prepare('SELECT key, value, updated_at FROM preferences ORDER BY key ASC').all(),
    ).toEqual(preferencesBefore);
    expect(await adapter.getVersion()).toEqual({ version: 9 });
    expect(listTableNames(db)).not.toContain('annotations');
    expect(listTableNames(db)).not.toContain('bookmarks');
    expect(listTableNames(db)).not.toContain('reading_history');

    // 4. Retrying once the failure is cleared migrates every supported record cleanly.
    await migrateDatabase(adapter);
    expect(await adapter.getVersion()).toEqual({ version: STUDY_STORAGE_MIGRATION_VERSION });
    expect(db.prepare('SELECT COUNT(*) AS total FROM annotations').get()).toEqual({ total: 2 });
    expect(db.prepare('SELECT COUNT(*) AS total FROM bookmarks').get()).toEqual({ total: 3 });
    expect(db.prepare('SELECT COUNT(*) AS total FROM reading_history').get()).toEqual({
      total: 12,
    });
    expect(
      db
        .prepare(
          "SELECT key FROM preferences WHERE key LIKE 'readerAnnotations:%' OR key LIKE 'readerBookmarks:%' OR key LIKE 'readerHistory:%'",
        )
        .all(),
    ).toEqual([]);
  });
});
