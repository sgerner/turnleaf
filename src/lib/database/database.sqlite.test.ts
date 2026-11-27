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
import { BOOKS_SERVER_FILE_INDEX_NAME, migrations } from './schema';

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
  ];

  function seedDatabaseAtVersion(startVersion: 7 | 8 | 9 | 10): DatabaseSync {
    const seeded = new DatabaseSync(':memory:');
    seeded.exec('PRAGMA foreign_keys = ON;');
    for (const migration of migrations.filter((item) => item.version <= startVersion)) {
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
    if (startVersion >= 8) {
      seeded
        .prepare(
          `UPDATE books
           SET remote_file_size = ?, downloaded_bytes = ?, downloaded_pages = ?, chapter_key = ?
           WHERE id = ?`,
        )
        .run(2048, 1234, 100, 'vol-1.epub', baseBook.id);
    }
    if (startVersion >= 9) {
      seeded
        .prepare(
          `UPDATE books
           SET file_id = ?, file_name = ?, chapter_epub_index = ?, multi_file_chapter = ?, sync_progress = ?
           WHERE id = ?`,
        )
        .run(501, 'vol-1-part-1.epub', 1, 1, 0, baseBook.id);
    }
    if (startVersion >= 10) {
      seeded
        .prepare('UPDATE books SET sort_order = ?, min_number = ?, volume_number = ? WHERE id = ?')
        .run(1.5, 1, 1, baseBook.id);
    }
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

  it.each([7, 8, 9, 10] as const)(
    'upgrades a populated v%i database to v10 and asserts the exact final column set and preserved state',
    async (startVersion) => {
      db = seedDatabaseAtVersion(startVersion);
      const adapter = createAdapter(db);

      await migrateDatabase(adapter);

      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 });
      const columns = (
        db.prepare("PRAGMA table_info('books')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(columns).toEqual(expectedFinalBookColumns);
      const indexes = (
        db.prepare("PRAGMA index_list('books')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(indexes).toEqual(
        expect.arrayContaining(['books_server_title_idx', BOOKS_SERVER_FILE_INDEX_NAME]),
      );

      expect(readBook(db, baseBook.id)).toMatchObject({
        download_path: baseBook.downloadPath,
        download_status: 'available',
        file_size: baseBook.fileSize,
        remote_file_size: startVersion >= 8 ? 2048 : null,
        downloaded_bytes: startVersion >= 8 ? 1234 : null,
        downloaded_pages: startVersion >= 8 ? 100 : null,
        chapter_key: startVersion >= 8 ? 'vol-1.epub' : null,
        file_id: startVersion >= 9 ? 501 : null,
        file_name: startVersion >= 9 ? 'vol-1-part-1.epub' : null,
        chapter_epub_index: startVersion >= 9 ? 1 : 0,
        multi_file_chapter: startVersion >= 9 ? 1 : 0,
        sync_progress: startVersion >= 9 ? 0 : 1,
        sort_order: startVersion >= 10 ? 1.5 : null,
        min_number: startVersion >= 10 ? 1 : null,
        volume_number: startVersion >= 10 ? 1 : null,
      });
      expect(
        db
          .prepare('SELECT cfi, pending_sync, sync_revision FROM reading_state WHERE book_id=?')
          .get(baseBook.id),
      ).toEqual({
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        pending_sync: 1,
        sync_revision: 3,
      });
      expect(
        db
          .prepare('SELECT payload_json, revision FROM sync_queue WHERE book_id=?')
          .get(baseBook.id),
      ).toEqual({
        payload_json: '{"pageNum":40}',
        revision: 3,
      });
      expect(db.prepare('SELECT value FROM preferences WHERE key=?').get('librarySort')).toEqual({
        value: 'title',
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

      let repeatTransactions = 0;
      await migrateDatabase(
        createAdapter(db, {
          onTransaction: () => {
            repeatTransactions += 1;
          },
        }),
      );
      expect(repeatTransactions).toBe(0);
    },
  );

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const)(
    'upgrades a v%i schema to v10 with the exact final books column set',
    async (startVersion) => {
      db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON;');
      for (const migration of migrations.filter((item) => item.version <= startVersion)) {
        db.exec(migration.statements);
        db.exec(`PRAGMA user_version = ${migration.version};`);
      }

      await migrateDatabase(createAdapter(db));

      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 });
      const columns = (
        db.prepare("PRAGMA table_info('books')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(columns).toEqual(expectedFinalBookColumns);
    },
  );

  it('skips already-existing columns via PRAGMA table_info when migrations re-run from earlier user_version states', async () => {
    db = seedDatabaseAtVersion(7);
    db.exec(`
      ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
      ALTER TABLE books ADD COLUMN file_id INTEGER;
      ALTER TABLE books ADD COLUMN sort_order REAL;
    `);
    db.prepare(
      'UPDATE books SET remote_file_size = ?, file_id = ?, sort_order = ? WHERE id = ?',
    ).run(4096, 77, 3.5, baseBook.id);

    const adapter = createAdapter(db);
    await migrateDatabase(adapter);

    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 });
    const columnsAfterFirstUpgrade = (
      db.prepare("PRAGMA table_info('books')").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(new Set(columnsAfterFirstUpgrade)).toEqual(new Set(expectedFinalBookColumns));
    expect(columnsAfterFirstUpgrade).toHaveLength(expectedFinalBookColumns.length);
    expect(readBook(db, baseBook.id)).toMatchObject({
      remote_file_size: 4096,
      file_id: 77,
      sort_order: 3.5,
      min_number: null,
      volume_number: null,
    });

    // Resetting user_version back to 7 on a fully migrated v10 database must re-run v8..v10 idempotently.
    db.exec('PRAGMA user_version = 7;');
    await migrateDatabase(adapter);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 });
    const columnsAfterReplay = (
      db.prepare("PRAGMA table_info('books')").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columnsAfterReplay).toEqual(columnsAfterFirstUpgrade);
  });
});
