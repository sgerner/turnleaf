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
import { BOOKS_SERVER_FILE_INDEX_NAME, COORDINATED_BOOK_COLUMNS, migrations } from './schema';

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

function executePluginStatements(db: DatabaseSync, sqlBlock: string): void {
  const statements = sqlBlock
    .split(';\n')
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    db.exec(statement.endsWith(';') ? statement : `${statement};`);
  }
}

function createAdapter(
  db: DatabaseSync,
  options: { onTransaction?: () => void } = {},
): Pick<Parameters<typeof migrateDatabase>[0], 'executeTransaction' | 'getVersion' | 'query'> {
  return {
    getVersion(): Promise<{ version: number }> {
      const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
      return Promise.resolve({ version: Number(row?.user_version ?? 0) });
    },
    query(
      statement: string,
      values: unknown[] = [],
    ): Promise<{ values: Record<string, unknown>[] }> {
      const rows = db.prepare(statement).all(...(values as SQLInputValue[])) as
        Record<string, unknown>[] | undefined;
      return Promise.resolve({ values: rows ?? [] });
    },
    executeTransaction(tasks: capTask[]): Promise<{ changes: { changes: number } }> {
      options.onTransaction?.();
      db.exec('BEGIN');
      try {
        for (const task of tasks) {
          if (task.values && task.values.length > 0) {
            const statement = db.prepare(task.statement);
            statement.run(...(task.values as SQLInputValue[]));
          } else {
            executePluginStatements(db, task.statement);
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

  it('migrates a populated v7 database through v8 and v9 without losing downloads, reading state, or sync queue and persists sequence metadata', async () => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    for (const migration of migrations.filter((item) => item.version <= 7)) {
      db.exec(migration.statements);
    }
    db.exec('PRAGMA user_version = 7;');
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
    db.prepare(
      `INSERT INTO books
        (id, server_id, library_id, series_id, volume_id, chapter_id, title, author, series,
         description_html, format, download_path, download_status, file_size, pages, pages_read,
         created_at, last_read_at, metadata_refreshed_at, remote_available)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      baseBook.id,
      baseBook.serverId,
      baseBook.libraryId,
      baseBook.seriesId,
      baseBook.volumeId,
      baseBook.chapterId,
      baseBook.title,
      baseBook.author,
      baseBook.series,
      baseBook.descriptionHtml,
      baseBook.format,
      baseBook.downloadPath,
      baseBook.downloadStatus,
      baseBook.fileSize,
      baseBook.pages,
      baseBook.pagesRead,
      baseBook.createdAt,
      baseBook.lastReadAt,
      baseBook.createdAt,
    );
    db.prepare(
      `INSERT INTO reading_state
        (book_id, cfi, kavita_xpath, percentage, local_updated_at, synced_local_updated_at, server_updated_at, pending_sync)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, 1)`,
    ).run(baseBook.id, 'epubcfi(/6/2!/4/2/1:0)', '/body/div[1]/p[1]', 0.4, baseBook.createdAt);
    db.prepare(
      `INSERT INTO sync_queue
        (book_id, payload_json, attempt_count, last_attempt_at, last_error, created_at, updated_at, revision)
        VALUES (?, ?, 0, NULL, NULL, ?, ?, 1)`,
    ).run(baseBook.id, '{"pageNum":40}', baseBook.createdAt, baseBook.createdAt);

    const adapter = createAdapter(db);
    await migrateDatabase(adapter);

    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 });
    expect(readBook(db, baseBook.id)).toMatchObject({
      download_path: baseBook.downloadPath,
      download_status: 'available',
      file_size: baseBook.fileSize,
      file_id: null,
      file_name: null,
      remote_file_size: null,
      downloaded_bytes: null,
      downloaded_pages: null,
      chapter_key: null,
      chapter_epub_index: 0,
      multi_file_chapter: 0,
      sync_progress: 1,
      sort_order: null,
      min_number: null,
      volume_number: null,
    });
    const indexes = (db.prepare("PRAGMA index_list('books')").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(indexes).toContain(BOOKS_SERVER_FILE_INDEX_NAME);
    expect(
      db.prepare('SELECT cfi, pending_sync FROM reading_state WHERE book_id=?').get(baseBook.id),
    ).toEqual({
      cfi: 'epubcfi(/6/2!/4/2/1:0)',
      pending_sync: 1,
    });
    expect(
      db.prepare('SELECT payload_json FROM sync_queue WHERE book_id=?').get(baseBook.id),
    ).toEqual({
      payload_json: '{"pageNum":40}',
    });

    await replaceBooksInTransaction(adapter, 'server', [
      { ...baseBook, sortOrder: 2.5, minNumber: 2, volumeNumber: 2 },
    ]);
    expect(readBook(db, baseBook.id)).toMatchObject({
      download_path: baseBook.downloadPath,
      file_size: baseBook.fileSize,
      sort_order: 2.5,
      min_number: 2,
      volume_number: 2,
    });
  });

  it('upgrades populated v7 databases through #328 v8, #330 v8, legacy v8, or partial v9 idempotently without duplicate columns or lost state', async () => {
    const expectedColumns = COORDINATED_BOOK_COLUMNS.map((column) => column.name);

    function seedPopulatedV7Database(): DatabaseSync {
      const seeded = new DatabaseSync(':memory:');
      seeded.exec('PRAGMA foreign_keys = ON;');
      for (const migration of migrations.filter((item) => item.version <= 7)) {
        seeded.exec(migration.statements);
        seeded.exec(`PRAGMA user_version = ${migration.version};`);
      }
      seeded
        .prepare(
          `INSERT INTO server_config
            (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'server',
          'Test server',
          'https://books.example.com',
          'credential',
          null,
          baseBook.createdAt,
        );
      seeded
        .prepare(
          `INSERT INTO books
            (id, server_id, library_id, series_id, volume_id, chapter_id, title, author, series,
             description_html, format, download_path, download_status, file_size, pages, pages_read,
             created_at, last_read_at, metadata_refreshed_at, remote_available)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          baseBook.id,
          baseBook.serverId,
          baseBook.libraryId,
          baseBook.seriesId,
          baseBook.volumeId,
          baseBook.chapterId,
          baseBook.title,
          baseBook.author,
          baseBook.series,
          baseBook.descriptionHtml,
          baseBook.format,
          baseBook.downloadPath,
          baseBook.downloadStatus,
          baseBook.fileSize,
          baseBook.pages,
          baseBook.pagesRead,
          baseBook.createdAt,
          baseBook.lastReadAt,
          baseBook.createdAt,
        );
      seeded
        .prepare(
          `INSERT INTO reading_state
            (book_id, cfi, kavita_xpath, percentage, local_updated_at, pending_sync, sync_revision)
            VALUES (?, ?, ?, ?, ?, 1, 3)`,
        )
        .run(baseBook.id, 'epubcfi(/6/2!/4/2/1:0)', '/body/div[1]/p[1]', 0.4, baseBook.createdAt);
      seeded
        .prepare(
          `INSERT INTO sync_queue
            (book_id, payload_json, attempt_count, created_at, updated_at, revision)
            VALUES (?, ?, 0, ?, ?, 3)`,
        )
        .run(baseBook.id, '{"pageNum":40}', baseBook.createdAt, baseBook.createdAt);
      seeded
        .prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)')
        .run('librarySort', 'title', baseBook.createdAt);
      return seeded;
    }

    function assertCompleteSchema(target: DatabaseSync): void {
      expect(target.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 });
      const columns = (
        target.prepare("PRAGMA table_info('books')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining(expectedColumns));
      expect(columns.filter((name) => name === 'remote_file_size')).toHaveLength(1);
      const indexes = (
        target.prepare("PRAGMA index_list('books')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(indexes).toContain(BOOKS_SERVER_FILE_INDEX_NAME);
      expect(
        target
          .prepare('SELECT cfi, pending_sync, sync_revision FROM reading_state WHERE book_id=?')
          .get(baseBook.id),
      ).toEqual({
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        pending_sync: 1,
        sync_revision: 3,
      });
      expect(
        target
          .prepare('SELECT payload_json, revision FROM sync_queue WHERE book_id=?')
          .get(baseBook.id),
      ).toEqual({
        payload_json: '{"pageNum":40}',
        revision: 3,
      });
      expect(
        target.prepare('SELECT value FROM preferences WHERE key=?').get('librarySort'),
      ).toEqual({ value: 'title' });
    }

    // Case 1: Existing v8 database has PR #328's multi-EPUB columns + index and populated rows.
    const pr328Db = seedPopulatedV7Database();
    try {
      pr328Db.exec(`
        ALTER TABLE books ADD COLUMN file_id INTEGER;
        ALTER TABLE books ADD COLUMN file_name TEXT;
        ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
        ALTER TABLE books ADD COLUMN chapter_epub_index INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE books ADD COLUMN multi_file_chapter INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE books ADD COLUMN sync_progress INTEGER NOT NULL DEFAULT 1;
        CREATE INDEX IF NOT EXISTS books_server_file_idx ON books(server_id, file_id);
        PRAGMA user_version = 8;
      `);
      pr328Db
        .prepare(
          `UPDATE books
           SET file_id = ?, file_name = ?, remote_file_size = ?, chapter_epub_index = ?,
               multi_file_chapter = ?, sync_progress = ?
           WHERE id = ?`,
        )
        .run(501, 'vol-1-part-1.epub', 4096, 1, 1, 0, baseBook.id);

      const adapter = createAdapter(pr328Db);
      await migrateDatabase(adapter);
      assertCompleteSchema(pr328Db);

      await replaceBooksInTransaction(adapter, 'server', [
        { ...baseBook, sortOrder: 1.5, minNumber: 1, volumeNumber: 1 },
      ]);
      expect(readBook(pr328Db, baseBook.id)).toMatchObject({
        download_path: baseBook.downloadPath,
        download_status: 'available',
        file_size: baseBook.fileSize,
        file_id: 501,
        file_name: 'vol-1-part-1.epub',
        remote_file_size: 4096,
        downloaded_bytes: null,
        downloaded_pages: null,
        chapter_key: null,
        chapter_epub_index: 1,
        multi_file_chapter: 1,
        sync_progress: 0,
        sort_order: 1.5,
        min_number: 1,
        volume_number: 1,
      });

      let secondPassTransactions = 0;
      await migrateDatabase(
        createAdapter(pr328Db, {
          onTransaction: () => {
            secondPassTransactions += 1;
          },
        }),
      );
      expect(secondPassTransactions).toBe(0);
    } finally {
      pr328Db.close();
    }

    // Case 2: Existing v8 database has PR #330's download-lineage columns and populated rows.
    const pr330Db = seedPopulatedV7Database();
    try {
      pr330Db.exec(`
        ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
        ALTER TABLE books ADD COLUMN downloaded_bytes INTEGER;
        ALTER TABLE books ADD COLUMN downloaded_pages INTEGER;
        ALTER TABLE books ADD COLUMN chapter_key TEXT;
        PRAGMA user_version = 8;
      `);
      pr330Db
        .prepare(
          `UPDATE books
           SET remote_file_size = ?, downloaded_bytes = ?, downloaded_pages = ?, chapter_key = ?
           WHERE id = ?`,
        )
        .run(2048, 1234, 100, 'vol-1.epub', baseBook.id);

      const adapter = createAdapter(pr330Db);
      await migrateDatabase(adapter);
      assertCompleteSchema(pr330Db);

      await reconcileBooksInTransaction(adapter, 'server', [
        { ...baseBook, sortOrder: 2, minNumber: 2, volumeNumber: 2 },
      ]);
      expect(readBook(pr330Db, baseBook.id)).toMatchObject({
        download_path: baseBook.downloadPath,
        download_status: 'available',
        file_size: baseBook.fileSize,
        file_id: null,
        file_name: null,
        remote_file_size: 2048,
        downloaded_bytes: 1234,
        downloaded_pages: 100,
        chapter_key: 'vol-1.epub',
        chapter_epub_index: 0,
        multi_file_chapter: 0,
        sync_progress: 1,
        sort_order: 2,
        min_number: 2,
        volume_number: 2,
      });

      let secondPassTransactions = 0;
      await migrateDatabase(
        createAdapter(pr330Db, {
          onTransaction: () => {
            secondPassTransactions += 1;
          },
        }),
      );
      expect(secondPassTransactions).toBe(0);
    } finally {
      pr330Db.close();
    }

    // Case 3: Legacy #339 v8 (only series fields at v8) reconciles all #328 + #330 columns + index.
    const legacySeriesV8Db = seedPopulatedV7Database();
    try {
      legacySeriesV8Db.exec(`
        ALTER TABLE books ADD COLUMN sort_order REAL;
        ALTER TABLE books ADD COLUMN min_number REAL;
        ALTER TABLE books ADD COLUMN volume_number REAL;
        PRAGMA user_version = 8;
      `);
      legacySeriesV8Db
        .prepare('UPDATE books SET sort_order = ?, min_number = ?, volume_number = ? WHERE id = ?')
        .run(3, 3, 3, baseBook.id);

      await migrateDatabase(createAdapter(legacySeriesV8Db));
      assertCompleteSchema(legacySeriesV8Db);
      expect(readBook(legacySeriesV8Db, baseBook.id)).toMatchObject({
        sort_order: 3,
        min_number: 3,
        volume_number: 3,
        chapter_epub_index: 0,
        multi_file_chapter: 0,
        sync_progress: 1,
      });
    } finally {
      legacySeriesV8Db.close();
    }

    // Case 4: Partial v9 database (#330 + #339 before #328 coordination) heals missing #328 columns + index.
    db = seedPopulatedV7Database();
    db.exec(`
      ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
      ALTER TABLE books ADD COLUMN downloaded_bytes INTEGER;
      ALTER TABLE books ADD COLUMN downloaded_pages INTEGER;
      ALTER TABLE books ADD COLUMN chapter_key TEXT;
      ALTER TABLE books ADD COLUMN sort_order REAL;
      ALTER TABLE books ADD COLUMN min_number REAL;
      ALTER TABLE books ADD COLUMN volume_number REAL;
      PRAGMA user_version = 9;
    `);
    db.prepare(
      `UPDATE books
       SET remote_file_size = ?, downloaded_bytes = ?, sort_order = ?, volume_number = ?
       WHERE id = ?`,
    ).run(4096, 1234, 4, 4, baseBook.id);

    await migrateDatabase(createAdapter(db));
    assertCompleteSchema(db);
    expect(readBook(db, baseBook.id)).toMatchObject({
      remote_file_size: 4096,
      downloaded_bytes: 1234,
      file_id: null,
      file_name: null,
      chapter_epub_index: 0,
      multi_file_chapter: 0,
      sync_progress: 1,
      sort_order: 4,
      volume_number: 4,
    });

    let healedTransactions = 0;
    await migrateDatabase(
      createAdapter(db, {
        onTransaction: () => {
          healedTransactions += 1;
        },
      }),
    );
    expect(healedTransactions).toBe(0);
  });
});
