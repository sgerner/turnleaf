// @vitest-environment node

import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import type * as CapacitorSQLiteModule from '@capacitor-community/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQLiteTestBridge } from './sqlite-test-bridge';

const hoisted = vi.hoisted(() => ({
  bridge: null as SQLiteTestBridge | null,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
  registerPlugin: () => ({}),
}));

vi.mock('@capacitor-community/sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof CapacitorSQLiteModule>();
  const { createSQLiteTestBridge } = await import('./sqlite-test-bridge');
  hoisted.bridge ??= createSQLiteTestBridge('turnleaf-meta-');
  return {
    ...actual,
    CapacitorSQLite: hoisted.bridge.plugin as unknown as typeof actual.CapacitorSQLite,
  };
});

import {
  openDatabase,
  reconcileBooksInTransaction,
  replaceBooksInTransaction,
  resetLocalDatabase,
  saveServer,
  type BookRecord,
} from './database';

function getBridge(): SQLiteTestBridge {
  if (!hoisted.bridge) {
    throw new Error('SQLite test bridge was not initialized');
  }
  return hoisted.bridge;
}

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

async function createDatabase(): Promise<SQLiteDBConnection> {
  const db = await openDatabase();
  expect(db).toBeInstanceOf(SQLiteDBConnection);
  await saveServer({
    id: 'server',
    displayName: 'Test server',
    baseUrl: 'https://books.example.com',
    credentialRef: 'credential',
    kavitaVersion: null,
    lastConnectedAt: baseBook.createdAt,
  });
  return db;
}

async function readBook(
  db: SQLiteDBConnection,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await db.query('SELECT * FROM books WHERE id=?', [id]);
  return result.values?.[0] as Record<string, unknown> | undefined;
}

describe('native metadata transactions against SQLite', () => {
  beforeEach(() => {
    getBridge().useNewDirectory('turnleaf-meta-');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    getBridge().clearFaults();
    await resetLocalDatabase().catch(() => undefined);
    getBridge().cleanup();
  });

  it('commits a refresh while retaining local download columns', async () => {
    const db = await createDatabase();
    await replaceBooksInTransaction(db, 'server', [baseBook], '2026-09-08T00:00:00.000Z');
    const refreshed = {
      ...baseBook,
      title: 'Updated title',
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
    };

    await replaceBooksInTransaction(db, 'server', [refreshed], '2026-09-09T00:00:00.000Z');

    expect(await readBook(db, baseBook.id)).toMatchObject({
      title: 'Updated title',
      download_path: baseBook.downloadPath,
      download_status: baseBook.downloadStatus,
      file_size: baseBook.fileSize,
      metadata_refreshed_at: '2026-09-09T00:00:00.000Z',
    });
  });

  it('preserves SQLite progress when a remote snapshot omits it, but applies a known zero', async () => {
    const db = await createDatabase();
    await replaceBooksInTransaction(db, 'server', [baseBook]);

    await replaceBooksInTransaction(db, 'server', [
      {
        ...baseBook,
        title: 'Updated with incomplete progress',
        pagesRead: 0,
        lastReadAt: null,
        remoteProgressKnown: false,
      },
    ]);

    expect(await readBook(db, baseBook.id)).toMatchObject({
      title: 'Updated with incomplete progress',
      pages_read: baseBook.pagesRead,
      last_read_at: baseBook.lastReadAt,
    });

    await replaceBooksInTransaction(db, 'server', [
      {
        ...baseBook,
        pagesRead: 0,
        lastReadAt: '2026-02-02T00:00:00.000Z',
        remoteProgressKnown: true,
      },
    ]);

    expect(await readBook(db, baseBook.id)).toMatchObject({
      pages_read: 0,
      last_read_at: '2026-02-02T00:00:00.000Z',
    });

    await replaceBooksInTransaction(db, 'server', [
      {
        ...baseBook,
        pagesRead: 7,
        lastReadAt: null,
        remoteProgressKnown: true,
        remoteReadDateKnown: false,
      },
    ]);

    expect(await readBook(db, baseBook.id)).toMatchObject({
      pages_read: 7,
      last_read_at: '2026-02-02T00:00:00.000Z',
    });
  });

  it('rolls back every task when a later metadata row violates SQLite constraints', async () => {
    const db = await createDatabase();
    await replaceBooksInTransaction(db, 'server', [baseBook], '2026-09-08T00:00:00.000Z');
    const invalid = {
      ...baseBook,
      id: 'server:1:11',
      chapterId: 11,
      title: null as unknown as string,
    };

    await expect(
      replaceBooksInTransaction(db, 'server', [{ ...baseBook, title: 'First update' }, invalid]),
    ).rejects.toEqual(expect.stringMatching(/NOT NULL constraint failed: books\.title/i));

    expect(await readBook(db, baseBook.id)).toMatchObject({ title: 'Book' });
    expect(await readBook(db, invalid.id)).toBeUndefined();
  });

  it('marks retained removals unavailable and deletes unretained removals atomically', async () => {
    const db = await createDatabase();
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
    await replaceBooksInTransaction(db, 'server', [retained, removable, withSyncedProgress]);
    await db.run(
      `INSERT INTO reading_state
      (book_id,cfi,kavita_xpath,percentage,local_updated_at,synced_local_updated_at,
       server_updated_at,pending_sync)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        withSyncedProgress.id,
        cfi,
        '/html/body/p[2]',
        0.25,
        '2026-09-07T00:00:00.000Z',
        '2026-09-07T00:00:00.000Z',
        '2026-09-07T00:00:00.000Z',
      ],
    );

    await reconcileBooksInTransaction(db, 'server', [], '2026-09-10T00:00:00.000Z');

    expect(await readBook(db, retained.id)).toMatchObject({ remote_available: 0 });
    expect(await readBook(db, withSyncedProgress.id)).toMatchObject({ remote_available: 0 });
    expect(
      (await db.query('SELECT cfi FROM reading_state WHERE book_id=?', [withSyncedProgress.id]))
        .values,
    ).toEqual([{ cfi }]);
    expect(await readBook(db, removable.id)).toBeUndefined();
  });

  it('updates incoming SQLite books while preserving unmatched rows from a partial snapshot', async () => {
    const db = await createDatabase();
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
    await replaceBooksInTransaction(db, 'server', [baseBook, unmatched]);

    await reconcileBooksInTransaction(
      db,
      'server',
      [{ ...baseBook, title: 'Updated from partial snapshot' }],
      '2026-09-10T00:00:00.000Z',
      true,
    );

    expect(await readBook(db, baseBook.id)).toMatchObject({
      title: 'Updated from partial snapshot',
    });
    expect(await readBook(db, unmatched.id)).toMatchObject({
      title: 'Unmatched saved book',
      remote_available: 0,
    });
  });

  it('reconciles a large snapshot with bounded SQL parameter counts', async () => {
    const db = await createDatabase();
    const downloaded = { ...baseBook, remoteAvailable: false };
    await replaceBooksInTransaction(db, 'server', [downloaded]);
    const snapshot = Array.from({ length: 1_001 }, (_, index) => ({
      ...baseBook,
      id: `server:2:${index}`,
      chapterId: index,
      downloadPath: null,
    }));

    const txSpy = vi.spyOn(db, 'executeTransaction');
    await reconcileBooksInTransaction(db, 'server', [downloaded, ...snapshot]);

    expect(txSpy).toHaveBeenCalledOnce();
    const [tasks] = txSpy.mock.calls[0]!;
    expect(Math.max(...tasks.map((task) => task.values?.length ?? 0))).toBeLessThan(999);
    expect(await readBook(db, downloaded.id)).toMatchObject({ remote_available: 1 });
    expect((await db.query('SELECT COUNT(*) AS total FROM books')).values).toEqual([
      { total: 1_002 },
    ]);
  });

  it('preserves every SQLite row and availability when a partial snapshot is empty', async () => {
    const db = await createDatabase();
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
    await replaceBooksInTransaction(db, 'server', [baseBook, unmatched]);
    const before = [await readBook(db, baseBook.id), await readBook(db, unmatched.id)];

    await reconcileBooksInTransaction(db, 'server', [], '2026-09-10T00:00:00.000Z', true);

    expect([await readBook(db, baseBook.id), await readBook(db, unmatched.id)]).toEqual(before);
  });
});
