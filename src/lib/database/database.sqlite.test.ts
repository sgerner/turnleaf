// @vitest-environment node

import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import type { capTask } from '@capacitor-community/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  reconcileBooksInTransaction,
  replaceBooksInTransaction,
  type BookRecord,
} from './database';
import { migrations } from './schema';

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

function createAdapter(db: DatabaseSync): Parameters<typeof reconcileBooksInTransaction>[0] {
  return {
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
});
