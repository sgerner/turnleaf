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
import { migrations, V8_BOOK_COLUMNS, V8_BOOK_INDEX_NAME } from './schema';

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
  db.prepare(
    `INSERT INTO server_config
      (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'primary',
    'Primary server',
    'https://primary.example.com',
    'primary-credential',
    null,
    baseBook.createdAt,
  );
  return db;
}

function createAdapter(
  db: DatabaseSync,
): Parameters<typeof reconcileBooksInTransaction>[0] & Parameters<typeof migrateDatabase>[0] {
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
      db.exec('BEGIN');
      try {
        for (const task of tasks) {
          if (task.values && task.values.length > 0) {
            const statement = db.prepare(task.statement);
            statement.run(...(task.values as SQLInputValue[]));
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

  it('migrates local state atomically across chapter and series remaps (primary:42:100 -> primary:42:101 -> primary:43:102)', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    const updatedAt = '2026-09-08T12:00:00.000Z';
    const original: BookRecord = {
      ...baseBook,
      id: 'primary:42:100',
      serverId: 'primary',
      libraryId: 1,
      seriesId: 42,
      volumeId: 420,
      chapterId: 100,
      title: 'The Left Hand of Darkness',
      author: 'Ursula K. Le Guin',
      series: 'Hainish Cycle',
      pages: 10,
      pagesRead: 4,
      downloadPath: 'epubs/primary-42-100.epub',
      downloadStatus: 'available',
      fileSize: 153_600,
      remoteFileSize: 153_600,
      downloadedBytes: 153_600,
      downloadedPages: 10,
      chapterKey: 'isbn:9780441478125',
    };
    await replaceBooksInTransaction(adapter, 'primary', [original], updatedAt);

    db.prepare(
      `INSERT INTO reading_state
        (book_id, cfi, kavita_xpath, percentage, local_updated_at, pending_sync, sync_revision)
        VALUES (?, ?, ?, ?, ?, 1, 3)`,
    ).run(original.id, 'epubcfi(/6/8!/4/2/1:0)', '//body/DocFragment[4]/body/p[2]', 0.4, updatedAt);
    db.prepare(
      `INSERT INTO sync_queue
        (book_id, payload_json, attempt_count, last_attempt_at, last_error, created_at, updated_at, revision)
        VALUES (?, ?, 2, ?, 'HTTP 404', ?, ?, 3)`,
    ).run(
      original.id,
      JSON.stringify({
        libraryId: 1,
        seriesId: 42,
        volumeId: 420,
        chapterId: 100,
        pageNum: 4,
        bookScrollId: '//body/DocFragment[4]/body/p[2]',
      }),
      updatedAt,
      updatedAt,
      updatedAt,
    );
    const bookmarkJson = JSON.stringify([
      {
        id: 'epubcfi(/6/8!/4/2/1:0)|chapter4.xhtml',
        cfi: 'epubcfi(/6/8!/4/2/1:0)',
        href: 'chapter4.xhtml',
        percentage: 0.4,
        label: 'Winter parade',
        savedAt: updatedAt,
      },
    ]);
    const annotationJson = JSON.stringify([
      {
        id: 'note-1',
        cfi: 'epubcfi(/6/8!/4/2/1:0)',
        excerpt: 'Light is the left hand of darkness',
        note: 'Opening epigraph',
        createdAt: updatedAt,
      },
    ]);
    const historyJson = JSON.stringify([
      {
        id: 'epubcfi(/6/8!/4/2/1:0)|chapter4.xhtml',
        cfi: 'epubcfi(/6/8!/4/2/1:0)',
        href: 'chapter4.xhtml',
        percentage: 0.4,
        label: '40%',
        savedAt: updatedAt,
      },
    ]);
    const insertPref = db.prepare(
      'INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)',
    );
    insertPref.run(`readerBookmarks:${original.id}`, bookmarkJson, updatedAt);
    insertPref.run(`readerAnnotations:${original.id}`, annotationJson, updatedAt);
    insertPref.run(`readerHistory:${original.id}`, historyJson, updatedAt);

    // Step 1: chapter remap within the same series (primary:42:100 -> primary:42:101)
    const chapterReplacement: BookRecord = {
      ...original,
      id: 'primary:42:101',
      chapterId: 101,
      volumeId: 421,
      pagesRead: 0,
      lastReadAt: null,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: 153_600,
      remoteFileSize: 153_600,
    };
    const chapterRemap = await reconcileBooksInTransaction(
      adapter,
      'primary',
      [chapterReplacement],
      '2026-09-09T00:00:00.000Z',
    );

    expect(chapterRemap).toEqual(new Map([['primary:42:100', 'primary:42:101']]));
    expect(readBook(db, 'primary:42:100')).toBeUndefined();
    expect(readBook(db, 'primary:42:101')).toMatchObject({
      series_id: 42,
      volume_id: 421,
      chapter_id: 101,
      pages_read: 4,
      download_path: 'epubs/primary-42-100.epub',
      download_status: 'available',
      downloaded_bytes: 153_600,
      downloaded_pages: 10,
      remote_available: 1,
    });
    expect(
      db.prepare('SELECT * FROM reading_state WHERE book_id=?').get('primary:42:101'),
    ).toMatchObject({
      cfi: 'epubcfi(/6/8!/4/2/1:0)',
      pending_sync: 1,
      sync_revision: 3,
    });
    const chapterQueue = db
      .prepare('SELECT * FROM sync_queue WHERE book_id=?')
      .get('primary:42:101') as Record<string, unknown>;
    expect(chapterQueue).toMatchObject({
      attempt_count: 0,
      last_attempt_at: null,
      last_error: null,
      revision: 3,
      updated_at: updatedAt,
    });
    expect(JSON.parse(String(chapterQueue.payload_json))).toMatchObject({
      libraryId: 1,
      seriesId: 42,
      volumeId: 421,
      chapterId: 101,
      pageNum: 4,
    });
    expect(
      db.prepare('SELECT value FROM preferences WHERE key=?').get('readerBookmarks:primary:42:100'),
    ).toBeUndefined();
    expect(
      db.prepare('SELECT value FROM preferences WHERE key=?').get('readerBookmarks:primary:42:101'),
    ).toEqual({ value: bookmarkJson });

    // Pre-populate a distinct annotation on the upcoming target key to verify lossless merge
    insertPref.run(
      'readerAnnotations:primary:43:102',
      JSON.stringify([
        {
          id: 'note-2',
          cfi: 'epubcfi(/6/12!/4/2/1:0)',
          excerpt: 'To learn which questions are unanswerable',
          note: 'Second note',
          createdAt: '2026-09-09T01:00:00.000Z',
        },
      ]),
      '2026-09-09T01:00:00.000Z',
    );

    // Step 2: series + chapter remap on full rescan (primary:42:101 -> primary:43:102)
    const seriesReplacement: BookRecord = {
      ...chapterReplacement,
      id: 'primary:43:102',
      seriesId: 43,
      volumeId: 430,
      chapterId: 102,
      chapterKey: null,
      pages: 25,
      fileSize: 220_000,
      remoteFileSize: 220_000,
    };
    const seriesRemap = await reconcileBooksInTransaction(
      adapter,
      'primary',
      [seriesReplacement],
      '2026-09-10T00:00:00.000Z',
    );

    expect(seriesRemap).toEqual(new Map([['primary:42:101', 'primary:43:102']]));
    expect(readBook(db, 'primary:42:101')).toBeUndefined();
    expect(readBook(db, 'primary:43:102')).toMatchObject({
      series_id: 43,
      volume_id: 430,
      chapter_id: 102,
      pages: 25,
      pages_read: 4,
      download_path: 'epubs/primary-42-100.epub',
      download_status: 'available',
      file_size: 153_600,
      remote_file_size: 220_000,
      downloaded_bytes: 153_600,
      downloaded_pages: 10,
      remote_available: 1,
    });
    expect(
      db.prepare('SELECT * FROM reading_state WHERE book_id=?').get('primary:43:102'),
    ).toMatchObject({
      cfi: 'epubcfi(/6/8!/4/2/1:0)',
      pending_sync: 1,
      sync_revision: 3,
    });
    const seriesQueue = db
      .prepare('SELECT * FROM sync_queue WHERE book_id=?')
      .get('primary:43:102') as Record<string, unknown>;
    expect(JSON.parse(String(seriesQueue.payload_json))).toMatchObject({
      libraryId: 1,
      seriesId: 43,
      volumeId: 430,
      chapterId: 102,
      pageNum: 4,
    });
    const mergedAnnotations = JSON.parse(
      String(
        (
          db
            .prepare('SELECT value FROM preferences WHERE key=?')
            .get('readerAnnotations:primary:43:102') as { value: string }
        ).value,
      ),
    ) as Array<{ id: string }>;
    expect(mergedAnnotations.map((entry) => entry.id)).toEqual(['note-1', 'note-2']);
    expect(db.prepare('SELECT key FROM preferences WHERE key LIKE ?').all('%primary:42:%')).toEqual(
      [],
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('leaves ambiguous multi-book changes and partial snapshots unmerged', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    const first: BookRecord = {
      ...baseBook,
      id: 'primary:42:100',
      serverId: 'primary',
      seriesId: 42,
      chapterId: 100,
      title: 'Shared Omnibus Entry',
      downloadPath: 'epubs/first.epub',
      downloadStatus: 'available',
    };
    const second: BookRecord = {
      ...first,
      id: 'primary:42:101',
      chapterId: 101,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
    };
    await replaceBooksInTransaction(adapter, 'primary', [first, second]);

    const partialRemap = await reconcileBooksInTransaction(
      adapter,
      'primary',
      [
        {
          ...first,
          id: 'primary:42:200',
          chapterId: 200,
          downloadPath: null,
          downloadStatus: 'none',
        },
      ],
      '2026-09-10T00:00:00.000Z',
      true,
    );
    expect(partialRemap.size).toBe(0);
    expect(readBook(db, 'primary:42:100')).toBeDefined();

    const ambiguousRemap = await reconcileBooksInTransaction(
      adapter,
      'primary',
      [
        { ...second, id: 'primary:42:201', chapterId: 201 },
        { ...second, id: 'primary:42:202', chapterId: 202 },
      ],
      '2026-09-11T00:00:00.000Z',
      false,
    );
    expect(ambiguousRemap.size).toBe(0);
    expect(readBook(db, 'primary:42:100')).toMatchObject({
      remote_available: 0,
      download_path: 'epubs/first.epub',
    });
    expect(readBook(db, 'primary:42:101')).toBeUndefined();
  });

  it('disqualifies title-and-author lineage matches when both SQLite rows have different nonempty ISBNs', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    const updatedAt = '2026-09-08T12:00:00.000Z';
    const oldEdition: BookRecord = {
      ...baseBook,
      id: 'primary:42:100',
      serverId: 'primary',
      libraryId: 1,
      seriesId: 42,
      volumeId: 420,
      chapterId: 100,
      title: 'Dune',
      author: 'Frank Herbert',
      series: 'Dune Chronicles',
      pages: 412,
      pagesRead: 165,
      lastReadAt: updatedAt,
      downloadPath: 'epubs/dune-first-edition.epub',
      downloadStatus: 'available',
      fileSize: 180_000,
      remoteFileSize: 180_000,
      downloadedBytes: 180_000,
      downloadedPages: 412,
      chapterKey: 'isbn:978-0-441-17271-9',
    };
    await replaceBooksInTransaction(adapter, 'primary', [oldEdition], updatedAt);

    db.prepare(
      `INSERT INTO reading_state
        (book_id, cfi, kavita_xpath, percentage, local_updated_at, pending_sync, sync_revision)
        VALUES (?, 'epubcfi(/6/8!/4/2/1:0)', '//body/DocFragment[4]/body/p[2]', 0.4, ?, 1, 2)`,
    ).run(oldEdition.id, updatedAt);
    db.prepare(
      `INSERT INTO sync_queue
        (book_id, payload_json, attempt_count, created_at, updated_at, revision)
        VALUES (?, '{"libraryId":1,"seriesId":42,"volumeId":420,"chapterId":100,"pageNum":165}', 0, ?, ?, 2)`,
    ).run(oldEdition.id, updatedAt, updatedAt);

    const bookmarkJson =
      '[{"id":"bm-1","cfi":"epubcfi(/6/8)","href":"ch4.xhtml","percentage":0.4,"label":"40%","savedAt":"2026-09-08T12:00:00.000Z"}]';
    const annotationJson =
      '[{"id":"an-1","cfi":"epubcfi(/6/8)","excerpt":"Arrakis","note":"Desert planet","createdAt":"2026-09-08T12:00:00.000Z"}]';
    const historyJson =
      '[{"id":"hist-1","cfi":"epubcfi(/6/8)","href":"ch4.xhtml","percentage":0.4,"label":"40%","savedAt":"2026-09-08T12:00:00.000Z"}]';
    const insertPref = db.prepare(
      'INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)',
    );
    insertPref.run(`readerBookmarks:${oldEdition.id}`, bookmarkJson, updatedAt);
    insertPref.run(`readerAnnotations:${oldEdition.id}`, annotationJson, updatedAt);
    insertPref.run(`readerHistory:${oldEdition.id}`, historyJson, updatedAt);

    // Same-series replacement with same title & author, but a different nonempty ISBN
    const sameSeriesNewEdition: BookRecord = {
      ...oldEdition,
      id: 'primary:42:101',
      chapterId: 101,
      volumeId: 421,
      pages: 688,
      pagesRead: 0,
      lastReadAt: null,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: 260_000,
      remoteFileSize: 260_000,
      downloadedBytes: null,
      downloadedPages: null,
      chapterKey: 'isbn:9780441013593',
    };

    const sameSeriesRemap = await reconcileBooksInTransaction(
      adapter,
      'primary',
      [sameSeriesNewEdition],
      '2026-09-09T00:00:00.000Z',
    );
    expect(sameSeriesRemap.size).toBe(0);

    // Cross-series replacement with same title, author & series name, but a third distinct ISBN
    const crossSeriesNewEdition: BookRecord = {
      ...sameSeriesNewEdition,
      id: 'primary:43:102',
      seriesId: 43,
      volumeId: 430,
      chapterId: 102,
      chapterKey: 'isbn:9780593099322',
    };
    const crossSeriesRemap = await reconcileBooksInTransaction(
      adapter,
      'primary',
      [crossSeriesNewEdition],
      '2026-09-10T00:00:00.000Z',
    );
    expect(crossSeriesRemap.size).toBe(0);

    expect(readBook(db, sameSeriesNewEdition.id)).toBeUndefined();
    expect(readBook(db, oldEdition.id)).toMatchObject({
      remote_available: 0,
      pages: 412,
      pages_read: 165,
      download_path: 'epubs/dune-first-edition.epub',
      download_status: 'available',
      downloaded_bytes: 180_000,
      downloaded_pages: 412,
      chapter_key: 'isbn:978-0-441-17271-9',
    });
    expect(readBook(db, crossSeriesNewEdition.id)).toMatchObject({
      remote_available: 1,
      pages: 688,
      pages_read: 0,
      last_read_at: null,
      download_path: null,
      download_status: 'none',
      downloaded_bytes: null,
      downloaded_pages: null,
      chapter_key: 'isbn:9780593099322',
    });
    expect(
      db.prepare('SELECT * FROM reading_state WHERE book_id=?').get(oldEdition.id),
    ).toBeDefined();
    expect(
      db.prepare('SELECT * FROM reading_state WHERE book_id=?').get(crossSeriesNewEdition.id),
    ).toBeUndefined();
    expect(db.prepare('SELECT * FROM sync_queue WHERE book_id=?').get(oldEdition.id)).toBeDefined();
    expect(
      db.prepare('SELECT * FROM sync_queue WHERE book_id=?').get(crossSeriesNewEdition.id),
    ).toBeUndefined();
    expect(
      db
        .prepare('SELECT value FROM preferences WHERE key=?')
        .get(`readerBookmarks:${oldEdition.id}`),
    ).toEqual({ value: bookmarkJson });
    expect(
      db
        .prepare('SELECT value FROM preferences WHERE key=?')
        .get(`readerAnnotations:${oldEdition.id}`),
    ).toEqual({ value: annotationJson });
    expect(
      db.prepare('SELECT value FROM preferences WHERE key=?').get(`readerHistory:${oldEdition.id}`),
    ).toEqual({ value: historyJson });
    expect(
      db
        .prepare('SELECT key FROM preferences WHERE key LIKE ?')
        .all(`%${crossSeriesNewEdition.id}%`),
    ).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // Title fallback remains active when only one edition exists and the incoming replacement lacks an ISBN
    await reconcileBooksInTransaction(adapter, 'primary', [], '2026-09-11T00:00:00.000Z');
    expect(readBook(db, crossSeriesNewEdition.id)).toBeUndefined();
    expect(readBook(db, oldEdition.id)).toBeDefined();

    const singleEditionFallback = await reconcileBooksInTransaction(
      adapter,
      'primary',
      [
        {
          ...crossSeriesNewEdition,
          id: 'primary:45:104',
          seriesId: 45,
          volumeId: 450,
          chapterId: 104,
          chapterKey: null,
        },
      ],
      '2026-09-12T00:00:00.000Z',
    );
    expect(singleEditionFallback).toEqual(new Map([['primary:42:100', 'primary:45:104']]));
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('retains non-downloaded unmapped books that hold only bookmarks or annotations', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    const withBookmarks: BookRecord = {
      ...baseBook,
      id: 'primary:50:500',
      serverId: 'primary',
      seriesId: 50,
      chapterId: 500,
      title: 'Bookmarked Only',
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
    };
    const withAnnotations: BookRecord = {
      ...withBookmarks,
      id: 'primary:50:501',
      chapterId: 501,
      title: 'Annotated Only',
    };
    const withEmptyPrefs: BookRecord = {
      ...withBookmarks,
      id: 'primary:50:502',
      chapterId: 502,
      title: 'Empty Preferences Only',
    };
    await replaceBooksInTransaction(adapter, 'primary', [
      withBookmarks,
      withAnnotations,
      withEmptyPrefs,
    ]);

    const insertPref = db.prepare(
      'INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)',
    );
    insertPref.run(
      `readerBookmarks:${withBookmarks.id}`,
      '[{"id":"bm-1","cfi":"epubcfi(/6/2)","href":"ch1.xhtml","percentage":0.2,"label":"20%","savedAt":"2026-09-01T00:00:00.000Z"}]',
      '2026-09-01T00:00:00.000Z',
    );
    insertPref.run(
      `readerAnnotations:${withAnnotations.id}`,
      '[{"id":"an-1","cfi":"epubcfi(/6/4)","excerpt":"Quote","note":"Thought","createdAt":"2026-09-01T00:00:00.000Z"}]',
      '2026-09-01T00:00:00.000Z',
    );
    insertPref.run(`readerBookmarks:${withEmptyPrefs.id}`, '[]', '2026-09-01T00:00:00.000Z');

    await reconcileBooksInTransaction(adapter, 'primary', [], '2026-09-10T00:00:00.000Z');

    expect(readBook(db, withBookmarks.id)).toMatchObject({
      remote_available: 0,
      download_path: null,
    });
    expect(readBook(db, withAnnotations.id)).toMatchObject({
      remote_available: 0,
      download_path: null,
    });
    expect(readBook(db, withEmptyPrefs.id)).toBeUndefined();
    expect(
      db
        .prepare('SELECT value FROM preferences WHERE key=?')
        .get(`readerBookmarks:${withEmptyPrefs.id}`),
    ).toBeUndefined();
    expect(
      db
        .prepare('SELECT value FROM preferences WHERE key=?')
        .get(`readerBookmarks:${withBookmarks.id}`),
    ).toBeDefined();
    expect(
      db
        .prepare('SELECT value FROM preferences WHERE key=?')
        .get(`readerAnnotations:${withAnnotations.id}`),
    ).toBeDefined();
  });

  it.each(['sync_queue', 'preferences', 'DELETE FROM books'] as const)(
    'rolls back every table change completely on SQLITE_IOERR during %s task',
    async (faultTarget) => {
      db = createDatabase();
      const baseAdapter = createAdapter(db);
      const updatedAt = '2026-09-08T12:00:00.000Z';
      const original: BookRecord = {
        ...baseBook,
        id: 'primary:42:100',
        serverId: 'primary',
        seriesId: 42,
        chapterId: 100,
        title: 'Rollback Target',
        chapterKey: 'isbn:9780000000100',
      };
      await replaceBooksInTransaction(baseAdapter, 'primary', [original], updatedAt);
      db.prepare(
        `INSERT INTO reading_state
          (book_id, cfi, kavita_xpath, percentage, local_updated_at, pending_sync, sync_revision)
          VALUES (?, 'epubcfi(/6/2)', '/p[1]', 0.2, ?, 1, 1)`,
      ).run(original.id, updatedAt);
      db.prepare(
        `INSERT INTO sync_queue
          (book_id, payload_json, created_at, updated_at, revision)
          VALUES (?, '{"pageNum":10}', ?, ?, 1)`,
      ).run(original.id, updatedAt, updatedAt);
      db.prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)').run(
        `readerBookmarks:${original.id}`,
        '[{"id":"bm-1"}]',
        updatedAt,
      );

      const snapshot = () => ({
        books: db.prepare('SELECT * FROM books ORDER BY id').all(),
        reading: db.prepare('SELECT * FROM reading_state ORDER BY book_id').all(),
        queue: db.prepare('SELECT * FROM sync_queue ORDER BY book_id').all(),
        prefs: db.prepare('SELECT * FROM preferences ORDER BY key').all(),
      });
      const before = snapshot();

      const failingAdapter: Parameters<typeof reconcileBooksInTransaction>[0] = {
        query: baseAdapter.query!,
        executeTransaction(tasks: capTask[]) {
          db.exec('BEGIN');
          try {
            for (const task of tasks) {
              if (task.statement.includes(faultTarget)) {
                throw Object.assign(new Error(`SQLITE_IOERR on ${faultTarget}`), {
                  code: 'SQLITE_IOERR',
                });
              }
              db.prepare(task.statement).run(...((task.values ?? []) as SQLInputValue[]));
            }
            db.exec('COMMIT');
            return Promise.resolve({ changes: { changes: tasks.length } });
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        },
      };

      await expect(
        reconcileBooksInTransaction(
          failingAdapter,
          'primary',
          [
            {
              ...original,
              id: 'primary:43:102',
              seriesId: 43,
              chapterId: 102,
              downloadPath: null,
              downloadStatus: 'none',
            },
          ],
          '2026-09-09T00:00:00.000Z',
        ),
      ).rejects.toThrow(`SQLITE_IOERR on ${faultTarget}`);

      expect(snapshot()).toEqual(before);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    },
  );

  it('keeps same-title chapters with different explicit chapter numbers separate in SQLite', async () => {
    db = createDatabase();
    const adapter = createAdapter(db);
    const updatedAt = '2026-09-08T12:00:00.000Z';
    const chapterOne: BookRecord = {
      ...baseBook,
      id: 'primary:42:100',
      serverId: 'primary',
      seriesId: 42,
      chapterId: 100,
      title: 'The Expanse',
      author: 'James S. A. Corey',
      series: null,
      pages: 300,
      pagesRead: 150,
      downloadPath: '/books/expanse-1.epub',
      downloadStatus: 'available',
      fileSize: 400_000,
      remoteFileSize: 400_000,
      downloadedBytes: 400_000,
      downloadedPages: 300,
      chapterKey: 'number:1',
    };
    await reconcileBooksInTransaction(adapter, 'primary', [chapterOne], updatedAt);
    db.prepare(
      `INSERT INTO reading_state
        (book_id, cfi, kavita_xpath, percentage, local_updated_at, pending_sync, sync_revision)
        VALUES (?, 'epubcfi(/6/8)', '/p[2]', 0.5, ?, 1, 1)`,
    ).run(chapterOne.id, updatedAt);

    const chapterTwo: BookRecord = {
      ...chapterOne,
      id: 'primary:42:101',
      chapterId: 101,
      pages: 340,
      pagesRead: 0,
      lastReadAt: null,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: 450_000,
      remoteFileSize: 450_000,
      chapterKey: 'number:2',
    };
    delete chapterTwo.downloadedBytes;
    delete chapterTwo.downloadedPages;

    const remapped = await reconcileBooksInTransaction(
      adapter,
      'primary',
      [chapterTwo],
      '2026-09-09T00:00:00.000Z',
    );
    expect(remapped.size).toBe(0);
    const rows = db
      .prepare('SELECT id, pages_read, download_path, remote_available FROM books ORDER BY id')
      .all();
    expect(rows).toEqual([
      {
        id: 'primary:42:100',
        pages_read: 150,
        download_path: '/books/expanse-1.epub',
        remote_available: 0,
      },
      {
        id: 'primary:42:101',
        pages_read: 0,
        download_path: null,
        remote_available: 1,
      },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('coordinated v7 -> v8 -> v9 -> v10 upgrades across predecessor shapes and merge orders', () => {
  let db: DatabaseSync;

  afterEach(() => db.close());

  const PREDECESSOR_328_V8_SQL = `
    ALTER TABLE books ADD COLUMN file_id INTEGER;
    ALTER TABLE books ADD COLUMN file_name TEXT;
    ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
    ALTER TABLE books ADD COLUMN chapter_epub_index INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE books ADD COLUMN multi_file_chapter INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE books ADD COLUMN sync_progress INTEGER NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS books_server_file_idx ON books(server_id, file_id);
    PRAGMA user_version = 8;
  `;

  const PREDECESSOR_330_V8_SQL = `
    ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
    ALTER TABLE books ADD COLUMN downloaded_bytes INTEGER;
    ALTER TABLE books ADD COLUMN downloaded_pages INTEGER;
    ALTER TABLE books ADD COLUMN chapter_key TEXT;
    PRAGMA user_version = 8;
  `;

  const PREDECESSOR_339_UNCOORDINATED_V8_SQL = `
    ALTER TABLE books ADD COLUMN sort_order REAL;
    ALTER TABLE books ADD COLUMN min_number REAL;
    ALTER TABLE books ADD COLUMN volume_number REAL;
    PRAGMA user_version = 8;
  `;

  function applyCoordinatedV9(target: DatabaseSync): void {
    const cols = new Set(
      (target.prepare("PRAGMA table_info('books')").all() as Array<{ name: string }>).map(
        (col) => col.name,
      ),
    );
    target.exec('BEGIN');
    try {
      for (const col of ['sort_order', 'min_number', 'volume_number']) {
        if (!cols.has(col)) {
          target.exec(`ALTER TABLE books ADD COLUMN ${col} REAL;`);
        }
      }
      const current = Number(
        (target.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      );
      if (current < 9) {
        target.exec('PRAGMA user_version = 9;');
      }
      target.exec('COMMIT');
    } catch (error) {
      target.exec('ROLLBACK');
      throw error;
    }
  }

  function applyCoordinatedV10(target: DatabaseSync): void {
    const activeBookIds = new Set(
      (target.prepare('SELECT id FROM books').all() as Array<{ id: string }>).map((row) => row.id),
    );
    const legacyPrefs = target
      .prepare(
        `SELECT key, value FROM preferences
          WHERE key LIKE 'readerAnnotations:%'
             OR key LIKE 'readerBookmarks:%'
             OR key LIKE 'readerHistory:%'`,
      )
      .all() as Array<{ key: string; value: string }>;

    target.exec('BEGIN');
    try {
      target.exec(`
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
      `);

      for (const pref of legacyPrefs) {
        const separator = pref.key.indexOf(':');
        const prefix = pref.key.slice(0, separator + 1);
        const bookId = pref.key.slice(separator + 1);
        if (!activeBookIds.has(bookId)) continue;
        const parsed = JSON.parse(pref.value) as Array<Record<string, unknown>>;
        if (prefix === 'readerAnnotations:') {
          for (const item of parsed) {
            target
              .prepare(
                `INSERT INTO annotations
                  (id, book_id, cfi, excerpt, note, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                `${bookId}:${String(item.id)}`,
                bookId,
                String(item.cfi ?? ''),
                String(item.excerpt ?? ''),
                String(item.note ?? ''),
                String(item.createdAt ?? '2026-08-01T00:00:00.000Z'),
                String(item.createdAt ?? '2026-08-01T00:00:00.000Z'),
              );
          }
        } else if (prefix === 'readerBookmarks:') {
          for (const item of parsed) {
            target
              .prepare(
                `INSERT INTO bookmarks
                  (id, book_id, cfi, href, percentage, label, saved_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                `${bookId}:${String(item.id)}`,
                bookId,
                String(item.cfi ?? ''),
                String(item.href ?? ''),
                Number(item.percentage ?? 0),
                String(item.label ?? 'Bookmark'),
                String(item.savedAt ?? '2026-08-01T00:00:00.000Z'),
                String(item.savedAt ?? '2026-08-01T00:00:00.000Z'),
              );
          }
        } else if (prefix === 'readerHistory:') {
          for (const item of parsed) {
            target
              .prepare(
                `INSERT INTO reading_history
                  (book_id, id, cfi, href, percentage, label, saved_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                bookId,
                String(item.id),
                String(item.cfi ?? ''),
                String(item.href ?? ''),
                Number(item.percentage ?? 0),
                String(item.label ?? '0%'),
                String(item.savedAt ?? '2026-08-01T00:00:00.000Z'),
              );
          }
        }
      }

      target.exec(`
        DELETE FROM preferences
          WHERE key LIKE 'readerAnnotations:%'
             OR key LIKE 'readerBookmarks:%'
             OR key LIKE 'readerHistory:%';
        PRAGMA user_version = 10;
      `);
      target.exec('COMMIT');
    } catch (error) {
      target.exec('ROLLBACK');
      throw error;
    }
  }

  function createPopulatedV7Database(): DatabaseSync {
    const v7 = new DatabaseSync(':memory:');
    v7.exec('PRAGMA foreign_keys = ON;');
    for (const migration of migrations.slice(0, 7)) {
      v7.exec(migration.statements);
      v7.exec(`PRAGMA user_version = ${migration.version};`);
    }
    const ts = '2026-08-01T00:00:00.000Z';
    v7.prepare(
      `INSERT INTO server_config
        (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
        VALUES ('primary', 'Primary Kavita', 'https://primary.example.com', 'cred-1', '0.8.4', ?)`,
    ).run(ts);

    v7.prepare(
      `INSERT INTO books
        (id, server_id, library_id, series_id, volume_id, chapter_id, title, author, series,
         description_html, format, metadata_refreshed_at, download_path, download_status, file_size,
         pages, pages_read, created_at, last_read_at, remote_available)
        VALUES (?, 'primary', 1, 42, 10, 100, 'Dune', 'Frank Herbert', 'Dune Chronicles',
         '<p>Arrakis</p>', 'epub', ?, 'books/dune-1.epub', 'available', 512000,
         200, 120, ?, ?, 1)`,
    ).run('primary:42:100', ts, ts, ts);

    v7.prepare(
      `INSERT INTO books
        (id, server_id, library_id, series_id, volume_id, chapter_id, title, author, series,
         description_html, format, metadata_refreshed_at, download_path, download_status, file_size,
         pages, pages_read, created_at, last_read_at, remote_available)
        VALUES (?, 'primary', 1, 99, 90, 900, 'Children of Dune', 'Frank Herbert', 'Dune Chronicles',
         NULL, 'epub', ?, NULL, 'none', 320000,
         180, 0, ?, NULL, 1)`,
    ).run('primary:99:900', ts, ts);

    v7.prepare(
      `INSERT INTO reading_state
        (book_id, cfi, kavita_xpath, percentage, local_updated_at, pending_sync, sync_revision)
        VALUES ('primary:42:100', 'epubcfi(/6/4!/4/2)', '/body/p[4]', 0.6, ?, 1, 3)`,
    ).run(ts);

    v7.prepare(
      `INSERT INTO sync_queue
        (book_id, payload_json, created_at, updated_at, revision)
        VALUES ('primary:42:100', ?, ?, ?, 3)`,
    ).run(
      JSON.stringify({
        libraryId: 1,
        seriesId: 42,
        volumeId: 10,
        chapterId: 100,
        pageNum: 120,
        bookScrollId: '/body/p[4]',
      }),
      ts,
      ts,
    );

    const insertPref = v7.prepare(
      'INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)',
    );
    insertPref.run('uiTheme', 'eink', ts);
    insertPref.run(
      'readerAnnotations:primary:42:100',
      JSON.stringify([
        {
          id: 'ann-dune',
          cfi: 'epubcfi(/6/4!/4/2/1:0)',
          excerpt: 'Fear is the mind-killer',
          note: 'Litany',
          createdAt: ts,
        },
      ]),
      ts,
    );
    insertPref.run(
      'readerBookmarks:primary:42:100',
      JSON.stringify([
        {
          id: 'bm-dune',
          cfi: 'epubcfi(/6/4!/4/2)',
          href: 'ch2.xhtml',
          percentage: 0.6,
          label: 'Chapter 2',
          savedAt: ts,
        },
      ]),
      ts,
    );
    insertPref.run(
      'readerHistory:primary:42:100',
      JSON.stringify([
        {
          id: 'hist-dune',
          cfi: 'epubcfi(/6/4!/4/2)',
          href: 'ch2.xhtml',
          percentage: 0.6,
          label: '60%',
          savedAt: ts,
        },
      ]),
      ts,
    );
    insertPref.run(
      'readerAnnotations:primary:99:900',
      JSON.stringify([
        {
          id: 'ann-children',
          cfi: 'epubcfi(/6/2!/4/2/1:0)',
          excerpt: 'Golden Path',
          note: 'Keep when removed remotely',
          createdAt: ts,
        },
      ]),
      ts,
    );
    insertPref.run(
      'readerAnnotations:deleted-server:1:1',
      JSON.stringify([
        {
          id: 'orphan-ann',
          cfi: 'epubcfi(/6/2)',
          excerpt: 'Orphan',
          note: 'Drop during v10',
          createdAt: ts,
        },
      ]),
      ts,
    );

    return v7;
  }

  it.each([
    {
      name: 'v7 with pre-existing remote_file_size (< 8 partial v8) -> migrateDatabase -> #339 v9 -> #345 v10',
      runUpgrade: async (target: DatabaseSync) => {
        target.exec('ALTER TABLE books ADD COLUMN remote_file_size INTEGER;');
        target.prepare("UPDATE books SET remote_file_size=512000 WHERE id='primary:42:100'").run();
        const adapter = createAdapter(target);
        await migrateDatabase(adapter);
        expect(
          (target.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        ).toBe(8);
        target
          .prepare(
            `UPDATE books SET file_id=2114, file_name='dune-1.epub', sync_progress=1
              WHERE id='primary:42:100'`,
          )
          .run();
        applyCoordinatedV9(target);
        target
          .prepare('UPDATE books SET sort_order=1, min_number=1, volume_number=1 WHERE id=?')
          .run('primary:42:100');
        applyCoordinatedV10(target);
      },
    },
    {
      name: 'clean v7 -> coordinated v8 -> #339 v9 -> #345 v10',
      runUpgrade: async (target: DatabaseSync) => {
        const adapter = createAdapter(target);
        await migrateDatabase(adapter);
        expect(
          (target.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        ).toBe(8);
        target
          .prepare(
            `UPDATE books SET file_id=2114, file_name='dune-1.epub', sync_progress=1
              WHERE id='primary:42:100'`,
          )
          .run();
        applyCoordinatedV9(target);
        target
          .prepare('UPDATE books SET sort_order=1, min_number=1, volume_number=1 WHERE id=?')
          .run('primary:42:100');
        applyCoordinatedV10(target);
      },
    },
    {
      name: '#328-only v8 -> #330 migrateDatabase -> #339 v9 -> #345 v10 (#328 before #330)',
      runUpgrade: async (target: DatabaseSync) => {
        target.exec(PREDECESSOR_328_V8_SQL);
        target
          .prepare(
            `UPDATE books
              SET file_id=2114, file_name='dune-1.epub', remote_file_size=512000,
                  chapter_epub_index=0, multi_file_chapter=1, sync_progress=1
              WHERE id='primary:42:100'`,
          )
          .run();
        const adapter = createAdapter(target);
        await migrateDatabase(adapter);
        expect(
          (target.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        ).toBe(8);
        applyCoordinatedV9(target);
        target
          .prepare('UPDATE books SET sort_order=1, min_number=1, volume_number=1 WHERE id=?')
          .run('primary:42:100');
        applyCoordinatedV10(target);
      },
    },
    {
      name: '#330-only v8 -> coordinated #328/#330 migrateDatabase -> #339 v9 -> #345 v10 (#330 before #328)',
      runUpgrade: async (target: DatabaseSync) => {
        target.exec(PREDECESSOR_330_V8_SQL);
        target
          .prepare(
            `UPDATE books
              SET remote_file_size=512000, downloaded_bytes=512000, downloaded_pages=200,
                  chapter_key='isbn:9780441172719'
              WHERE id='primary:42:100'`,
          )
          .run();
        const adapter = createAdapter(target);
        await migrateDatabase(adapter);
        expect(
          (target.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        ).toBe(8);
        target
          .prepare(
            `UPDATE books SET file_id=2114, file_name='dune-1.epub', sync_progress=1
              WHERE id='primary:42:100'`,
          )
          .run();
        applyCoordinatedV9(target);
        target
          .prepare('UPDATE books SET sort_order=1, min_number=1, volume_number=1 WHERE id=?')
          .run('primary:42:100');
        applyCoordinatedV10(target);
      },
    },
    {
      name: '#339-only uncoordinated v8 -> coordinated v8 -> #339 v9 -> #345 v10',
      runUpgrade: async (target: DatabaseSync) => {
        target.exec(PREDECESSOR_339_UNCOORDINATED_V8_SQL);
        target
          .prepare('UPDATE books SET sort_order=1, min_number=1, volume_number=1 WHERE id=?')
          .run('primary:42:100');
        const adapter = createAdapter(target);
        await migrateDatabase(adapter);
        target
          .prepare(
            `UPDATE books SET file_id=2114, file_name='dune-1.epub', sync_progress=1
              WHERE id='primary:42:100'`,
          )
          .run();
        applyCoordinatedV9(target);
        applyCoordinatedV10(target);
      },
    },
    {
      name: 'reverse merge order: #328-only v8 -> #339 v9 -> #345 v10 -> #330 migrateDatabase',
      runUpgrade: async (target: DatabaseSync) => {
        target.exec(PREDECESSOR_328_V8_SQL);
        target
          .prepare(
            `UPDATE books
              SET file_id=2114, file_name='dune-1.epub', remote_file_size=512000,
                  chapter_epub_index=0, multi_file_chapter=1, sync_progress=1
              WHERE id='primary:42:100'`,
          )
          .run();
        applyCoordinatedV9(target);
        target
          .prepare('UPDATE books SET sort_order=1, min_number=1, volume_number=1 WHERE id=?')
          .run('primary:42:100');
        applyCoordinatedV10(target);
        const adapter = createAdapter(target);
        await migrateDatabase(adapter);
      },
    },
    {
      name: 'reverse merge order: #330-only v8 -> #339 v9 -> #345 v10 -> coordinated #328/#330 migrateDatabase',
      runUpgrade: async (target: DatabaseSync) => {
        target.exec(PREDECESSOR_330_V8_SQL);
        target
          .prepare(
            `UPDATE books
              SET remote_file_size=512000, downloaded_bytes=512000, downloaded_pages=200,
                  chapter_key='isbn:9780441172719'
              WHERE id='primary:42:100'`,
          )
          .run();
        applyCoordinatedV9(target);
        target
          .prepare('UPDATE books SET sort_order=1, min_number=1, volume_number=1 WHERE id=?')
          .run('primary:42:100');
        applyCoordinatedV10(target);
        const adapter = createAdapter(target);
        await migrateDatabase(adapter);
        target
          .prepare(
            `UPDATE books SET file_id=2114, file_name='dune-1.epub', sync_progress=1
              WHERE id='primary:42:100'`,
          )
          .run();
      },
    },
  ])('upgrades populated v7 database cleanly for $name', async ({ runUpgrade }) => {
    db = createPopulatedV7Database();
    await runUpgrade(db);

    const adapter = createAdapter(db);
    // Re-running migrateDatabase on the combined v10 database must be a complete no-op.
    await migrateDatabase(adapter);

    const userVersion = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    expect(userVersion).toBe(10);

    const columns = db.prepare("PRAGMA table_info('books')").all() as Array<{ name: string }>;
    const columnNames = columns.map((col) => col.name);
    expect(columns.filter((col) => col.name === 'remote_file_size')).toHaveLength(1);
    for (const v8Col of V8_BOOK_COLUMNS) {
      expect(columnNames).toContain(v8Col.name);
    }
    expect(columnNames).toEqual(
      expect.arrayContaining(['sort_order', 'min_number', 'volume_number']),
    );

    const indexes = db.prepare("PRAGMA index_list('books')").all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain(V8_BOOK_INDEX_NAME);

    expect(db.prepare('SELECT key, value FROM preferences ORDER BY key').all()).toEqual([
      { key: 'uiTheme', value: 'eink' },
    ]);

    expect(db.prepare('SELECT id, book_id, note FROM annotations ORDER BY id').all()).toEqual([
      { id: 'primary:42:100:ann-dune', book_id: 'primary:42:100', note: 'Litany' },
      {
        id: 'primary:99:900:ann-children',
        book_id: 'primary:99:900',
        note: 'Keep when removed remotely',
      },
    ]);

    // Verify chapter lineage remap + v10 study retention on the combined v10 database.
    const remapped = await reconcileBooksInTransaction(
      adapter,
      'primary',
      [
        {
          id: 'primary:42:101',
          serverId: 'primary',
          libraryId: 1,
          seriesId: 42,
          volumeId: 10,
          chapterId: 101,
          title: 'Dune',
          author: 'Frank Herbert',
          series: 'Dune Chronicles',
          descriptionHtml: '<p>Arrakis revised</p>',
          format: 'epub',
          pages: 260,
          pagesRead: 0,
          createdAt: '2026-08-01T00:00:00.000Z',
          lastReadAt: null,
          downloadPath: null,
          downloadStatus: 'none',
          fileSize: 640000,
          remoteFileSize: 640000,
          chapterKey: 'isbn:9780441172719',
        },
      ],
      '2026-08-02T00:00:00.000Z',
    );
    expect(remapped).toEqual(new Map([['primary:42:100', 'primary:42:101']]));

    const remappedBook = db
      .prepare(
        `SELECT id, file_id, file_name, download_path, download_status, file_size,
          remote_file_size, downloaded_bytes, downloaded_pages, pages, pages_read,
          sort_order, min_number, volume_number, sync_progress, remote_available
         FROM books WHERE id='primary:42:101'`,
      )
      .get();
    expect(remappedBook).toEqual({
      id: 'primary:42:101',
      file_id: 2114,
      file_name: 'dune-1.epub',
      download_path: 'books/dune-1.epub',
      download_status: 'available',
      file_size: 512000,
      remote_file_size: 640000,
      downloaded_bytes: 512000,
      downloaded_pages: 200,
      pages: 260,
      pages_read: 120,
      sort_order: 1,
      min_number: 1,
      volume_number: 1,
      sync_progress: 1,
      remote_available: 1,
    });

    const retainedStudyBook = db
      .prepare('SELECT id, remote_available FROM books WHERE id=?')
      .get('primary:99:900');
    expect(retainedStudyBook).toEqual({
      id: 'primary:99:900',
      remote_available: 0,
    });

    expect(db.prepare('SELECT id, book_id, note FROM annotations ORDER BY id').all()).toEqual([
      { id: 'primary:42:101:ann-dune', book_id: 'primary:42:101', note: 'Litany' },
      {
        id: 'primary:99:900:ann-children',
        book_id: 'primary:99:900',
        note: 'Keep when removed remotely',
      },
    ]);
    expect(db.prepare('SELECT id, book_id, label FROM bookmarks ORDER BY id').all()).toEqual([
      { id: 'primary:42:101:bm-dune', book_id: 'primary:42:101', label: 'Chapter 2' },
    ]);
    expect(
      db.prepare('SELECT book_id, id, label FROM reading_history ORDER BY book_id').all(),
    ).toEqual([{ book_id: 'primary:42:101', id: 'hist-dune', label: '60%' }]);
    expect(db.prepare('SELECT book_id FROM reading_state').all()).toEqual([
      { book_id: 'primary:42:101' },
    ]);
    const queueRow = db.prepare('SELECT book_id, payload_json FROM sync_queue').get() as {
      book_id: string;
      payload_json: string;
    };
    expect(queueRow.book_id).toBe('primary:42:101');
    expect(JSON.parse(queueRow.payload_json)).toMatchObject({
      seriesId: 42,
      chapterId: 101,
      pageNum: 120,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
