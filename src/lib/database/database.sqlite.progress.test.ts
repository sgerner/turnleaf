// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import type { capTask } from '@capacitor-community/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  databasePath: '',
  database: null as DatabaseSync | null,
  isOpen: false,
  failTransactionAt: null as number | null,
  onTransactionTask: null as ((index: number) => void | Promise<void>) | null,
  createAdapter: null as (() => unknown) | null,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
}));

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {
    deleteDatabase: async () => {
      if (native.database) native.database.close();
      native.database = null;
      native.isOpen = false;
      rmSync(native.databasePath, { force: true });
    },
  },
  SQLiteConnection: class {
    async checkConnectionsConsistency(): Promise<{ result: boolean }> {
      return { result: true };
    }

    async isConnection(): Promise<{ result: boolean }> {
      return { result: native.isOpen };
    }

    async retrieveConnection(): Promise<unknown> {
      return native.createAdapter?.();
    }

    async createConnection(): Promise<unknown> {
      return native.createAdapter?.();
    }
  },
}));

const server = {
  id: 'server',
  displayName: 'Test server',
  baseUrl: 'https://books.example.com',
  credentialRef: 'credential',
  kavitaVersion: null,
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const book = {
  id: 'server:1:10',
  serverId: server.id,
  libraryId: 1,
  seriesId: 1,
  volumeId: 10,
  chapterId: 10,
  title: 'Book',
  author: null,
  series: null,
  descriptionHtml: null,
  format: 'epub',
  pages: 100,
  pagesRead: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: null,
  downloadPath: null,
  downloadStatus: 'none',
  fileSize: null,
};

function createAdapter() {
  return {
    async open(): Promise<void> {
      if (!native.database) native.database = new DatabaseSync(native.databasePath);
      native.isOpen = true;
    },
    async close(): Promise<void> {
      if (native.database) native.database.close();
      native.database = null;
      native.isOpen = false;
    },
    async getVersion(): Promise<{ version: number }> {
      const row = native.database?.prepare('PRAGMA user_version').get() as
        { user_version?: number } | undefined;
      return { version: Number(row?.user_version ?? 0) };
    },
    async execute(statement: string): Promise<{ changes: { changes: number } }> {
      native.database?.exec(statement);
      return { changes: { changes: 0 } };
    },
    async run(
      statement: string,
      values: unknown[] = [],
    ): Promise<{ changes: { changes: number } }> {
      const result = native.database?.prepare(statement).run(...(values as SQLInputValue[]));
      return { changes: { changes: Number(result?.changes ?? 0) } };
    },
    async query(
      statement: string,
      values: unknown[] = [],
    ): Promise<{ values: Record<string, unknown>[] }> {
      const rows = native.database?.prepare(statement).all(...(values as SQLInputValue[])) as
        Record<string, unknown>[] | undefined;
      return { values: rows ?? [] };
    },
    async executeTransaction(tasks: capTask[]): Promise<{ changes: { changes: number } }> {
      const database = native.database;
      if (!database) throw new Error('database is not open');
      const failAt = native.failTransactionAt;
      native.failTransactionAt = null;
      database.exec('BEGIN');
      await Promise.resolve();
      try {
        for (const [index, task] of tasks.entries()) {
          if (index === failAt) throw new Error(`injected transaction failure at ${index}`);
          if (task.values && task.values.length > 0) {
            database.prepare(task.statement).run(...(task.values as SQLInputValue[]));
          } else {
            database.exec(task.statement);
          }
          await Promise.resolve();
          await native.onTransactionTask?.(index);
        }
        await Promise.resolve();
        database.exec('COMMIT');
        return { changes: { changes: tasks.length } };
      } catch (error) {
        await Promise.resolve();
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

native.createAdapter = createAdapter;

async function importDatabase() {
  vi.resetModules();
  return import('./database');
}

async function reopenDatabase(database: Awaited<ReturnType<typeof importDatabase>>) {
  const connection = await database.openDatabase();
  await connection.close();
  return importDatabase();
}

async function seedDatabase(database: Awaited<ReturnType<typeof importDatabase>>) {
  await database.saveServer(server);
  await database.reconcileBooks(server.id, [book]);
  await database.saveLocalProgress(book, 'old-cfi', '/old', 0.25);
}

describe('native progress transactions against SQLite', () => {
  let directory = '';

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'turnleaf-r2-'));
    native.databasePath = join(directory, 'turnleaf.sqlite');
    native.database = null;
    native.isOpen = false;
    native.failTransactionAt = null;
    native.onTransactionTask = null;
  });

  afterEach(() => {
    if (native.database) native.database.close();
    native.database = null;
    native.isOpen = false;
    native.failTransactionAt = null;
    native.onTransactionTask = null;
    rmSync(directory, { recursive: true, force: true });
  });

  it('persists a remote-only position across reopen without scheduling an upload', async () => {
    const database = await importDatabase();
    await database.saveServer(server);
    await database.reconcileBooks(server.id, [book]);
    const remote = { ...book, pageNum: 41, bookScrollId: '/remote' };

    expect(await database.saveRemoteProgress(book, remote, null)).toBe(true);
    const reopened = await reopenDatabase(database);
    const saved = await reopened.getReadingState(book.id);
    expect(saved).toMatchObject({ xpath: '/remote', percentage: 0.41, pendingSync: false });
    expect((await reopened.getBooks(server.id))[0]?.pagesRead).toBe(41);
    expect(await reopened.getPendingSync(server.id)).toEqual([]);

    expect(await reopened.saveRemoteProgress(book, { ...remote, pageNum: 52 }, saved)).toBe(true);
    await reopened.saveLocalProgress(book, 'local-cfi', '/local', 0.63);
    expect(await reopened.saveRemoteProgress(book, remote, saved)).toBe(false);
    expect(await reopened.getReadingState(book.id)).toMatchObject({
      cfi: 'local-cfi',
      pendingSync: true,
    });
  });

  it('updates server_config in place without cascading deletes until removeServer runs', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    await database.markDownloaded(book.id, 'books/server-1-10.epub', 4096);

    const baselineBook = (await database.getBooks(server.id))[0];
    const baselineReading = await database.getReadingState(book.id);
    const baselineQueue = await database.getPendingSync(server.id);
    expect(baselineBook).toMatchObject({
      downloadPath: 'books/server-1-10.epub',
      downloadStatus: 'available',
      fileSize: 4096,
    });
    expect(baselineReading).toMatchObject({ cfi: 'old-cfi', pendingSync: true });
    expect(baselineQueue).toHaveLength(1);

    const updatedServer = {
      ...server,
      displayName: 'Moved server',
      baseUrl: 'https://moved.example.com',
      credentialRef: 'credential_rotated',
      kavitaVersion: '0.8.4',
      lastConnectedAt: '2026-01-03T00:00:00.000Z',
    };
    await database.saveServer(updatedServer);

    const reopened = await reopenDatabase(database);
    expect(await reopened.getServer()).toEqual(updatedServer);
    expect(await reopened.getBooks(server.id)).toEqual([baselineBook]);
    expect(await reopened.getReadingState(book.id)).toEqual(baselineReading);
    expect(await reopened.getPendingSync(server.id)).toEqual(baselineQueue);

    const clearedVersionServer = {
      ...updatedServer,
      kavitaVersion: null,
      lastConnectedAt: '2026-01-04T00:00:00.000Z',
    };
    await reopened.saveServer(clearedVersionServer);
    expect(await reopened.getServer()).toEqual(clearedVersionServer);

    await reopened.removeServer(server.id);
    expect(await reopened.getServer()).toBeNull();
    expect(await reopened.getBooks(server.id)).toEqual([]);
    expect(await reopened.getReadingState(book.id)).toBeNull();
    expect(await reopened.getPendingSync(server.id)).toEqual([]);
    expect(
      native.database
        ?.prepare(
          `SELECT
            (SELECT COUNT(*) FROM books) AS books_count,
            (SELECT COUNT(*) FROM reading_state) AS reading_state_count,
            (SELECT COUNT(*) FROM sync_queue) AS sync_queue_count`,
        )
        .get(),
    ).toEqual({
      books_count: 0,
      reading_state_count: 0,
      sync_queue_count: 0,
    });
  });

  it.each([0, 1, 2])(
    'rolls back every progress write when task %i fails and preserves the prior retryable state after reopen',
    async (failAt) => {
      const database = await importDatabase();
      await seedDatabase(database);
      const baselineReading = await database.getReadingState(book.id);
      const baselineQueue = await database.getPendingSync(server.id);
      const baselineBook = (await database.getBooks(server.id))[0];

      native.failTransactionAt = failAt;
      await expect(database.saveLocalProgress(book, 'new-cfi', '/new', 0.8)).rejects.toThrow(
        `injected transaction failure at ${failAt}`,
      );

      const reopened = await reopenDatabase(database);
      expect(await reopened.getReadingState(book.id)).toEqual(baselineReading);
      expect(await reopened.getPendingSync(server.id)).toEqual(baselineQueue);
      expect((await reopened.getBooks(server.id))[0]).toEqual(baselineBook);
    },
  );

  it('rolls back a failed completion transaction without losing its retryable queue row', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    const baselineReading = await database.getReadingState(book.id);
    const baselineQueue = await database.getPendingSync(server.id);
    const baselineBook = (await database.getBooks(server.id))[0];

    native.failTransactionAt = 2;
    await expect(database.markBookCompleted(book)).rejects.toThrow(
      'injected transaction failure at 2',
    );

    const reopened = await reopenDatabase(database);
    expect(await reopened.getReadingState(book.id)).toEqual(baselineReading);
    expect(await reopened.getPendingSync(server.id)).toEqual(baselineQueue);
    expect((await reopened.getBooks(server.id))[0]).toEqual(baselineBook);
  });

  it('rolls back a failed acknowledgement so the queue can be retried after reopen', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    const pending = (await database.getPendingSync(server.id))[0];
    const before = await database.getReadingState(book.id);
    expect(pending).toBeDefined();

    native.failTransactionAt = 1;
    await expect(
      database.confirmSync(
        book.id,
        '2026-01-02T00:00:00.000Z',
        pending!.revision,
        pending!.updatedAt,
      ),
    ).rejects.toThrow('injected transaction failure at 1');

    const reopened = await reopenDatabase(database);
    expect(await reopened.getReadingState(book.id)).toEqual(before);
    expect(await reopened.getPendingSync(server.id)).toEqual([pending]);

    await reopened.confirmSync(
      book.id,
      '2026-01-02T00:00:00.000Z',
      pending!.revision,
      pending!.updatedAt,
    );
    const afterRetry = await reopenDatabase(reopened);
    expect(await afterRetry.getPendingSync(server.id)).toEqual([]);
    expect(await afterRetry.getReadingState(book.id)).toMatchObject({
      pendingSync: false,
      syncedLocalUpdatedAt: pending!.updatedAt,
      serverUpdatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('keeps pending SQLite progress ahead of a known remote snapshot', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    await database.saveLocalProgress(book, 'local-cfi', '/local', 0.4);
    const localProgress = (await database.getBooks(server.id))[0];
    expect(localProgress).toBeDefined();

    await database.reconcileBooks(server.id, [
      {
        ...book,
        title: 'Updated metadata',
        pagesRead: 0,
        lastReadAt: null,
        remoteProgressKnown: true,
      },
    ]);

    expect((await database.getBooks(server.id))[0]).toMatchObject({
      title: 'Updated metadata',
      pagesRead: localProgress!.pagesRead,
      lastReadAt: localProgress!.lastReadAt,
    });
    expect(await database.getPendingSync(server.id)).toHaveLength(1);
  });

  it('keeps progress acknowledged while an older catalog snapshot was in flight', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    await database.saveLocalProgress(book, 'local-cfi', '/local', 0.4);
    const pending = (await database.getPendingSync(server.id))[0]!;
    const startedAt = new Date(Date.parse(pending.updatedAt) + 1000).toISOString();
    const acknowledgedAt = new Date(Date.parse(startedAt) + 1000).toISOString();
    await database.confirmSync(book.id, acknowledgedAt, pending.revision, pending.updatedAt);
    expect(await database.getPendingSync(server.id)).toEqual([]);

    await database.reconcileBooks(server.id, [{ ...book, pagesRead: 0 }], {
      snapshotStartedAt: startedAt,
    });
    expect((await database.getBooks(server.id))[0]?.pagesRead).toBe(40);

    await database.reconcileBooks(server.id, [{ ...book, pagesRead: 60 }], {
      snapshotStartedAt: new Date(Date.parse(acknowledgedAt) + 1000).toISOString(),
    });
    expect((await database.getBooks(server.id))[0]?.pagesRead).toBe(60);
  });

  it('filters SQLite sync work by its owning server', async () => {
    const database = await importDatabase();
    const otherServer = { ...server, id: 'other', baseUrl: 'https://other.example.com' };
    const otherBook = { ...book, id: 'other:1:10', serverId: otherServer.id };
    await database.saveServer(server);
    await database.saveServer(otherServer);
    await database.reconcileBooks(server.id, [book]);
    await database.reconcileBooks(otherServer.id, [otherBook]);
    await database.saveLocalProgress(book, 'main-cfi', '/main', 0.2);
    await database.saveLocalProgress(otherBook, 'other-cfi', '/other', 0.8);

    expect(await database.getPendingSync(server.id)).toHaveLength(1);
    expect(await database.getPendingSync(otherServer.id)).toHaveLength(1);
    expect(await database.getSyncStatus(server.id)).toMatchObject({
      pendingCount: 1,
      failedCount: 0,
    });
  });

  it('routes queued SQLite progress through refreshed book IDs', async () => {
    const database = await importDatabase();
    await database.saveServer(server);
    await database.reconcileBooks(server.id, [book]);
    await database.saveLocalProgress(book, 'local-cfi', '/local', 0.4);

    await database.reconcileBooks(server.id, [{ ...book, libraryId: 2, volumeId: 22 }]);

    const pending = (await database.getPendingSync(server.id))[0];
    expect(pending).toBeDefined();
    expect(JSON.parse(pending!.payload)).toMatchObject({
      libraryId: 2,
      seriesId: book.seriesId,
      volumeId: 22,
      chapterId: book.chapterId,
      pageNum: 40,
      bookScrollId: '/local',
    });
    expect((await database.getBooks(server.id))[0]).toMatchObject({
      libraryId: 2,
      volumeId: 22,
    });
  });

  it('clears native retry errors when a new local revision replaces the failed payload', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    const failed = (await database.getPendingSync(server.id))[0];
    expect(failed).toBeDefined();
    await database.markSyncFailure(book.id, 'expired key', failed!.revision, failed!.updatedAt);
    expect(await database.getSyncStatus(server.id)).toMatchObject({
      pendingCount: 1,
      failedCount: 1,
      lastError: 'expired key',
    });

    await database.saveLocalProgress(book, 'new-cfi', '/new', 0.75);

    expect(await database.getPendingSync(server.id)).toMatchObject([
      { revision: failed!.revision + 1 },
    ]);
    expect(await database.getSyncStatus(server.id)).toMatchObject({
      pendingCount: 1,
      failedCount: 0,
      lastError: null,
    });
  });

  it('adopts a selected server location and clears only the displayed SQLite revision', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    const initial = await database.getReadingState(book.id);
    expect(initial?.syncRevision).toBe(1);
    const remote = {
      libraryId: 1,
      seriesId: 1,
      volumeId: 10,
      chapterId: 10,
      pageNum: 80,
      bookScrollId: '/remote',
      lastModifiedUtc: '2026-01-02T00:00:00.000Z',
    };

    expect(
      await database.acceptRemoteProgress(
        book,
        remote,
        initial!.syncRevision!,
        initial!.localUpdatedAt,
      ),
    ).toBe(true);
    expect(await database.getPendingSync(server.id)).toEqual([]);
    expect(await database.getReadingState(book.id)).toMatchObject({
      cfi: '',
      xpath: '/remote',
      percentage: 0.8,
      pendingSync: false,
    });
    expect((await database.getBooks(server.id))[0]).toMatchObject({
      pagesRead: 80,
      lastReadAt: remote.lastModifiedUtc,
    });

    await database.saveLocalProgress(book, 'newer-cfi', '/newer', 0.9);
    expect(
      await database.acceptRemoteProgress(
        book,
        remote,
        initial!.syncRevision!,
        initial!.localUpdatedAt,
      ),
    ).toBe(false);
    expect(await database.getPendingSync(server.id)).toHaveLength(1);
    expect(await database.getReadingState(book.id)).toMatchObject({
      cfi: 'newer-cfi',
      pendingSync: true,
    });
  });

  it('keeps progress for removed books locally and resumes uploads when they return', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    await database.reconcileBooks(server.id, []);
    await database.saveLocalProgress(book, 'offline-cfi', '/offline', 0.5);

    expect(await database.getPendingSync(server.id)).toEqual([]);
    expect(await database.getSyncStatus(server.id)).toMatchObject({ pendingCount: 0 });
    expect(await database.getReadingState(book.id)).toMatchObject({ cfi: 'offline-cfi' });

    await database.reconcileBooks(server.id, [book]);
    expect(await database.getPendingSync(server.id)).toMatchObject([{ bookId: book.id }]);
  });

  it('marks and clears SQLite download metadata across reopen without touching other books', async () => {
    const database = await importDatabase();
    const sibling = { ...book, id: 'server:1:11', chapterId: 11, title: 'Sibling' };
    await database.saveServer(server);
    await database.reconcileBooks(server.id, [book, sibling]);

    await database.markDownloaded(book.id, 'books/server-1-10.epub', 4096);
    const afterMark = await reopenDatabase(database);
    expect(await afterMark.getBooks(server.id)).toEqual([
      expect.objectContaining({
        id: book.id,
        downloadPath: 'books/server-1-10.epub',
        downloadStatus: 'available',
        fileSize: 4096,
      }),
      expect.objectContaining({
        id: sibling.id,
        downloadPath: null,
        downloadStatus: 'none',
        fileSize: null,
      }),
    ]);

    await afterMark.removeDownload(book.id);
    const afterRemove = await reopenDatabase(afterMark);
    expect(await afterRemove.getBooks(server.id)).toEqual([
      expect.objectContaining({
        id: book.id,
        downloadPath: null,
        downloadStatus: 'none',
        fileSize: null,
      }),
      expect.objectContaining({
        id: sibling.id,
        downloadPath: null,
        downloadStatus: 'none',
        fileSize: null,
      }),
    ]);
    const rawRow = native.database
      ?.prepare('SELECT download_path, download_status, file_size FROM books WHERE id=?')
      .get(book.id);
    expect(rawRow).toEqual({
      download_path: null,
      download_status: 'none',
      file_size: null,
    });
  });

  it('normalizes zero-page remote progress to zero percent while storing raw server_page_num', async () => {
    const database = await importDatabase();
    const zeroPageBook = { ...book, pages: 0 };
    await database.saveServer(server);
    await database.reconcileBooks(server.id, [zeroPageBook]);
    const remote = {
      libraryId: 1,
      seriesId: 1,
      volumeId: 10,
      chapterId: 10,
      pageNum: 17,
      bookScrollId: '/zero',
      lastModifiedUtc: '2026-01-03T00:00:00.000Z',
    };

    expect(await database.saveRemoteProgress(zeroPageBook, remote, null)).toBe(true);
    expect(await database.getReadingState(zeroPageBook.id)).toMatchObject({
      cfi: '',
      xpath: '/zero',
      percentage: 0,
      pendingSync: false,
    });
    expect((await database.getBooks(server.id))[0]?.pagesRead).toBe(0);
    expect(
      native.database
        ?.prepare('SELECT percentage, server_page_num FROM reading_state WHERE book_id=?')
        .get(zeroPageBook.id),
    ).toEqual({
      percentage: 0,
      server_page_num: 17,
    });
  });

  it('seeds the persistent progress revision when upgrading a pending version-6 queue', async () => {
    const updatedAt = '2026-01-01T00:00:00.000Z';
    native.database = new DatabaseSync(native.databasePath);
    native.database.exec(`
      CREATE TABLE books (
        id TEXT PRIMARY KEY NOT NULL,
        server_id TEXT NOT NULL,
        library_id INTEGER NOT NULL DEFAULT 0,
        series_id INTEGER NOT NULL DEFAULT 0,
        volume_id INTEGER NOT NULL DEFAULT 0,
        chapter_id INTEGER NOT NULL DEFAULT 0,
        pages_read INTEGER NOT NULL DEFAULT 0,
        last_read_at TEXT,
        remote_available INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE reading_state (
        book_id TEXT PRIMARY KEY NOT NULL,
        cfi TEXT NOT NULL,
        kavita_xpath TEXT,
        percentage REAL NOT NULL,
        local_updated_at TEXT NOT NULL,
        synced_local_updated_at TEXT,
        server_page_num INTEGER,
        server_xpath TEXT,
        server_updated_at TEXT,
        pending_sync INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sync_queue (
        book_id TEXT PRIMARY KEY NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO books(id,server_id,library_id,series_id,volume_id,chapter_id,pages_read,last_read_at)
        VALUES ('server:1:10','server',1,1,10,10,25,'${updatedAt}');
      INSERT INTO reading_state(
        book_id,cfi,kavita_xpath,percentage,local_updated_at,pending_sync
      ) VALUES ('server:1:10','legacy-cfi','/legacy',0.25,'${updatedAt}',1);
      INSERT INTO sync_queue(
        book_id,payload_json,created_at,updated_at,revision
      ) VALUES ('server:1:10','{"pageNum":25}','${updatedAt}','${updatedAt}',7);
      PRAGMA user_version = 6;
    `);

    const database = await importDatabase();
    const legacy = await database.getReadingState(book.id);
    expect(legacy?.syncRevision).toBe(7);

    await database.saveLocalProgress(book, 'next-cfi', '/next', 0.5);

    expect(await database.getPendingSync(server.id)).toMatchObject([{ revision: 8 }]);
    expect(await database.getReadingState(book.id)).toMatchObject({
      cfi: 'next-cfi',
      syncRevision: 8,
      pendingSync: true,
    });
  });

  it('retries an interrupted migration after reopening the same database file', async () => {
    const database = await importDatabase();
    native.failTransactionAt = 1;
    await expect(database.openDatabase()).rejects.toThrow('injected transaction failure at 1');

    if (native.database) native.database.close();
    native.database = null;
    native.isOpen = false;

    const reopened = await importDatabase();
    await expect(reopened.openDatabase()).resolves.toBeDefined();
    await expect(reopened.saveServer(server)).resolves.toBeUndefined();
  });

  it('persists secondary EPUB reading positions and completion locally without queuing remote sync', async () => {
    const database = await importDatabase();
    await database.saveServer(server);
    const primaryBook = {
      ...book,
      id: 'server:1:10:2114',
      fileId: 2114,
      fileName: 'vol3-primary.epub',
      pages: 5,
      fileSize: 1955734,
      remoteFileSize: 1955734,
      chapterEpubIndex: 0,
      multiFileChapter: true,
      syncProgress: true,
    };
    const siblingBook = {
      ...book,
      id: 'server:1:10:2115',
      fileId: 2115,
      fileName: 'vol3-secondary.epub',
      title: 'Book (vol3-secondary)',
      pages: 4,
      fileSize: 2169759,
      remoteFileSize: 2169759,
      chapterEpubIndex: 1,
      multiFileChapter: true,
      syncProgress: false,
      remoteProgressKnown: false,
      remoteReadDateKnown: false,
    };
    await database.reconcileBooks(server.id, [primaryBook, siblingBook]);

    await database.saveLocalProgress(siblingBook, 'epubcfi(/6/4)', '/html/body/p[3]', 0.5, 1);

    const reopened = await reopenDatabase(database);
    expect(await reopened.getReadingState(siblingBook.id)).toMatchObject({
      cfi: 'epubcfi(/6/4)',
      xpath: '/html/body/p[3]',
      percentage: 0.5,
      pendingSync: false,
    });
    expect(await reopened.getPendingSync(server.id)).toEqual([]);
    expect(await reopened.getSyncStatus(server.id)).toMatchObject({ pendingCount: 0 });

    await reopened.reconcileBooks(server.id, [primaryBook, siblingBook]);
    const savedSibling = (await reopened.getBooks(server.id)).find(
      (item) => item.id === siblingBook.id,
    );
    expect(savedSibling).toMatchObject({
      fileId: 2115,
      fileName: 'vol3-secondary.epub',
      remoteFileSize: 2169759,
      chapterEpubIndex: 1,
      multiFileChapter: true,
      syncProgress: false,
      pagesRead: 2,
    });

    await reopened.markBookCompleted(siblingBook);
    expect(await reopened.getPendingSync(server.id)).toEqual([]);
    expect(
      (await reopened.getBooks(server.id)).find((item) => item.id === siblingBook.id)?.pagesRead,
    ).toBe(4);
  });

  it('upgrades a version-7 SQLite database to version 8 and preserves per-file downloads and progress across reversed file order', async () => {
    const updatedAt = '2026-09-05T12:00:00.000Z';
    native.database = new DatabaseSync(native.databasePath);
    native.database.exec('PRAGMA foreign_keys = ON;');
    const { migrations } = await import('./schema');
    for (const migration of migrations) {
      if (migration.version <= 7) {
        native.database.exec(migration.statements);
      }
    }
    native.database.exec('PRAGMA user_version = 7;');
    native.database
      .prepare(
        `INSERT INTO server_config
          (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(server.id, server.displayName, server.baseUrl, server.credentialRef, '0.8.4', updatedAt);
    native.database
      .prepare(
        `INSERT INTO books
          (id, server_id, library_id, series_id, volume_id, chapter_id, title, author, series,
           description_html, format, metadata_refreshed_at, download_path, download_status,
           file_size, pages, pages_read, created_at, last_read_at, remote_available)
          VALUES (?, ?, 1, 82, 188, 1406, 'Vol 3', 'Rawlinson', 'Ancient World', NULL, 'epub',
                  ?, 'books/legacy-vol3.epub', 'available', 1955734, 9, 3, ?, ?, 1)`,
      )
      .run('server:82:1406', server.id, updatedAt, updatedAt, updatedAt);
    native.database
      .prepare(
        `INSERT INTO reading_state
          (book_id, cfi, kavita_xpath, percentage, local_updated_at, pending_sync, sync_revision)
          VALUES ('server:82:1406', 'epubcfi(/6/2!/4/8)', '/body/p[8]', 0.6, ?, 1, 3)`,
      )
      .run(updatedAt);
    native.database
      .prepare(
        `INSERT INTO sync_queue
          (book_id, payload_json, created_at, updated_at, revision)
          VALUES ('server:82:1406', '{"libraryId":1,"seriesId":82,"volumeId":188,"chapterId":1406,"pageNum":3}', ?, ?, 3)`,
      )
      .run(updatedAt, updatedAt);
    native.database
      .prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)')
      .run('readerBookmarks:server:82:1406', '["legacy-bm"]', updatedAt);

    const database = await importDatabase();
    const { mapSeriesToBooks } = await import('../kavita/mapper');
    const seriesMeta = {
      id: 82,
      name: 'Ancient World',
      libraryId: 1,
      format: 3,
      pages: 9,
      pagesRead: 1,
      created: updatedAt,
      latestReadDate: updatedAt,
      coverImage: null,
    };
    const file2114 = {
      id: 2114,
      bytes: 1955734,
      pages: 5,
      extension: '.epub',
      format: 3,
      fileName: 'pg16163-images-3.epub',
    };
    const file2115 = {
      id: 2115,
      bytes: 2169759,
      pages: 4,
      extension: '.epub',
      format: 3,
      fileName: 'vol3-media.epub',
    };
    const detailFor = (files: Array<typeof file2114>) => ({
      chapters: [],
      specials: [],
      storylineChapters: [],
      volumes: [
        {
          id: 188,
          chapters: [
            {
              id: 1406,
              volumeId: 188,
              title: 'Vol 3',
              titleName: 'Vol 3',
              pages: 9,
              pagesRead: 1,
              summary: '',
              format: 3,
              files,
              writers: [{ name: 'Rawlinson' }],
              lastReadingProgressUtc: updatedAt,
              hasMultipleFiles: files.length > 1,
            },
          ],
        },
      ],
    });

    // Upgrade reconcile even when Kavita returns reversed order [2115, 2114] on first v8 scan!
    const firstScan = mapSeriesToBooks(server.id, seriesMeta, detailFor([file2115, file2114]));
    await database.reconcileBooks(server.id, firstScan);

    expect(
      native.database.prepare('PRAGMA user_version').get() as { user_version: number },
    ).toEqual({ user_version: 8 });

    let saved = await database.getBooks(server.id);
    expect(saved).toHaveLength(2);
    const upgraded2114 = saved.find((item) => item.fileId === 2114)!;
    const upgraded2115 = saved.find((item) => item.fileId === 2115)!;
    expect(upgraded2114).toMatchObject({
      id: 'server:82:1406:2114',
      downloadPath: 'books/legacy-vol3.epub',
      downloadStatus: 'available',
      fileSize: 1955734,
      pagesRead: 3,
      syncProgress: true,
    });
    expect(upgraded2115).toMatchObject({
      id: 'server:82:1406:2115',
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: 2169759,
      pagesRead: 0,
      syncProgress: false,
    });
    expect(await database.getReadingState(upgraded2114.id)).toMatchObject({
      cfi: 'epubcfi(/6/2!/4/8)',
      pendingSync: true,
      syncRevision: 3,
    });
    expect(await database.getPendingSync(server.id)).toMatchObject([
      { bookId: upgraded2114.id, revision: 3 },
    ]);
    expect(
      await database.getPreferences([
        'readerBookmarks:server:82:1406',
        `readerBookmarks:${upgraded2114.id}`,
      ]),
    ).toEqual(new Map([[`readerBookmarks:${upgraded2114.id}`, '["legacy-bm"]']]));

    // Download and read sibling 2115, then reconcile with reversed file order [2114, 2115].
    await database.markDownloaded(upgraded2115.id, 'books/vol3-2115.epub', 2169759);
    await database.saveLocalProgress(upgraded2115, 'epubcfi(/6/8!/4/2)', '/body/p[2]', 0.75, 2);
    await database.setPreference(`readerBookmarks:${upgraded2115.id}`, '["sibling-bm"]');

    const secondScan = mapSeriesToBooks(server.id, seriesMeta, detailFor([file2114, file2115]));
    await database.reconcileBooks(server.id, secondScan);

    saved = await database.getBooks(server.id);
    expect(saved.find((item) => item.fileId === 2114)).toMatchObject({
      id: 'server:82:1406:2114',
      downloadPath: 'books/legacy-vol3.epub',
      pagesRead: 3,
      chapterEpubIndex: 0,
      syncProgress: true,
    });
    expect(saved.find((item) => item.fileId === 2115)).toMatchObject({
      id: 'server:82:1406:2115',
      downloadPath: 'books/vol3-2115.epub',
      pagesRead: 3,
      chapterEpubIndex: 1,
      syncProgress: false,
    });
    expect(
      await database.getPreferences([
        `readerBookmarks:${upgraded2114.id}`,
        `readerBookmarks:${upgraded2115.id}`,
      ]),
    ).toEqual(
      new Map([
        [`readerBookmarks:${upgraded2114.id}`, '["legacy-bm"]'],
        [`readerBookmarks:${upgraded2115.id}`, '["sibling-bm"]'],
      ]),
    );

    // Collapse to single EPUB 2114 ('server:82:1406'), then replace 2114 with 2199:
    // the v7 NULL upgrade was one-time, so 2199 must NOT inherit 2114's download or reading state.
    await database.reconcileBooks(
      server.id,
      mapSeriesToBooks(server.id, seriesMeta, detailFor([file2114])),
    );
    expect((await database.getBooks(server.id)).find((item) => item.fileId === 2114)).toMatchObject(
      {
        id: 'server:82:1406',
        downloadPath: 'books/legacy-vol3.epub',
        pagesRead: 3,
      },
    );

    const replacement2199 = {
      id: 2199,
      bytes: 777777,
      pages: 12,
      extension: '.epub',
      format: 3,
      fileName: 'vol3-replaced.epub',
    };
    await database.reconcileBooks(
      server.id,
      mapSeriesToBooks(server.id, seriesMeta, detailFor([replacement2199])),
    );
    expect((await database.getBooks(server.id)).find((item) => item.fileId === 2199)).toMatchObject(
      {
        id: 'server:82:1406',
        fileId: 2199,
        downloadPath: null,
        downloadStatus: 'none',
        fileSize: 777777,
        pagesRead: 1,
        lastReadAt: updatedAt,
      },
    );
    expect(await database.getReadingState('server:82:1406')).toBeNull();
    expect(await database.getPendingSync(server.id)).toEqual([]);
    expect(await database.getPreferences(['readerBookmarks:server:82:1406'])).toEqual(new Map());
  });

  it('serializes reads behind reconcileBooks so mid-transaction remote_available=0 is hidden', async () => {
    const database = await importDatabase();
    await seedDatabase(database);

    const captured: {
      pending?: ReturnType<typeof database.getPendingSync>;
      status?: ReturnType<typeof database.getSyncStatus>;
      books?: ReturnType<typeof database.getBooks>;
    } = {};
    native.onTransactionTask = async (index) => {
      if (index !== 0) return;
      native.onTransactionTask = null;
      captured.pending = database.getPendingSync(server.id);
      captured.status = database.getSyncStatus(server.id);
      captured.books = database.getBooks(server.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await database.reconcileBooks(server.id, [{ ...book, title: 'Refreshed during sync' }]);

    expect(captured.pending).toBeDefined();
    expect(await captured.pending).toMatchObject([{ bookId: book.id, revision: 1 }]);
    expect(await captured.status).toMatchObject({ pendingCount: 1, failedCount: 0 });
    expect(await captured.books).toMatchObject([
      { id: book.id, title: 'Refreshed during sync', remoteAvailable: true },
    ]);
  });

  it('hides uncommitted progress rows when saveLocalProgress rolls back mid-transaction', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    const baselineReading = await database.getReadingState(book.id);
    const baselineQueue = await database.getPendingSync(server.id);

    const captured: {
      reading?: ReturnType<typeof database.getReadingState>;
      queue?: ReturnType<typeof database.getPendingSync>;
    } = {};
    native.failTransactionAt = 2;
    native.onTransactionTask = async (index) => {
      if (index !== 1) return;
      native.onTransactionTask = null;
      captured.reading = database.getReadingState(book.id);
      captured.queue = database.getPendingSync(server.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await expect(
      database.saveLocalProgress(book, 'rolled-back-cfi', '/rolled-back', 0.8),
    ).rejects.toThrow('injected transaction failure at 2');

    expect(await captured.reading).toEqual(baselineReading);
    expect(await captured.queue).toEqual(baselineQueue);
    expect(await database.getServer()).toEqual(server);
  });

  it('prevents torn reads across reading_state and sync_queue during confirmSync', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    const pending = (await database.getPendingSync(server.id))[0]!;

    const captured: {
      reading?: ReturnType<typeof database.getReadingState>;
      queue?: ReturnType<typeof database.getPendingSync>;
    } = {};
    native.onTransactionTask = async (index) => {
      if (index !== 0) return;
      native.onTransactionTask = null;
      captured.reading = database.getReadingState(book.id);
      captured.queue = database.getPendingSync(server.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await database.confirmSync(
      book.id,
      '2026-01-02T00:00:00.000Z',
      pending.revision,
      pending.updatedAt,
    );

    expect(await captured.reading).toMatchObject({
      pendingSync: false,
      syncedLocalUpdatedAt: pending.updatedAt,
      serverUpdatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(await captured.queue).toEqual([]);
  });

  it('keeps internal reads unqueued in saveRemoteProgress while serializing concurrent reads', async () => {
    const database = await importDatabase();
    await database.saveServer(server);
    await database.reconcileBooks(server.id, [book]);
    const remote = { ...book, pageNum: 41, bookScrollId: '/remote' };

    const captured: {
      reading?: ReturnType<typeof database.getReadingState>;
      books?: ReturnType<typeof database.getBooks>;
    } = {};
    native.onTransactionTask = async (index) => {
      if (index !== 0) return;
      native.onTransactionTask = null;
      captured.reading = database.getReadingState(book.id);
      captured.books = database.getBooks(server.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    expect(await database.saveRemoteProgress(book, remote, null)).toBe(true);
    expect(await captured.reading).toMatchObject({
      xpath: '/remote',
      percentage: 0.41,
      pendingSync: false,
    });
    expect((await captured.books)?.[0]?.pagesRead).toBe(41);
  });

  it('keeps acceptRemoteProgress transaction and verification atomic ahead of queued reads and writes', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    const initial = (await database.getReadingState(book.id))!;
    const remote = {
      libraryId: 1,
      seriesId: 1,
      volumeId: 10,
      chapterId: 10,
      pageNum: 80,
      bookScrollId: '/remote',
      lastModifiedUtc: '2026-01-02T00:00:00.000Z',
    };

    const captured: {
      reading?: ReturnType<typeof database.getReadingState>;
      queue?: ReturnType<typeof database.getPendingSync>;
      books?: ReturnType<typeof database.getBooks>;
      queuedLocalSave?: Promise<void>;
    } = {};
    native.onTransactionTask = async (index) => {
      if (index !== 0) return;
      native.onTransactionTask = null;
      captured.reading = database.getReadingState(book.id);
      captured.queue = database.getPendingSync(server.id);
      captured.books = database.getBooks(server.id);
      captured.queuedLocalSave = database.saveLocalProgress(book, 'newer-cfi', '/newer', 0.9);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    expect(
      await database.acceptRemoteProgress(
        book,
        remote,
        initial.syncRevision!,
        initial.localUpdatedAt,
      ),
    ).toBe(true);

    expect(await captured.reading).toMatchObject({
      cfi: '',
      xpath: '/remote',
      percentage: 0.8,
      pendingSync: false,
    });
    expect(await captured.queue).toEqual([]);
    expect((await captured.books)?.[0]).toMatchObject({
      pagesRead: 80,
      lastReadAt: remote.lastModifiedUtc,
    });

    await captured.queuedLocalSave;
    expect(await database.getReadingState(book.id)).toMatchObject({
      cfi: 'newer-cfi',
      pendingSync: true,
    });
  });
});
