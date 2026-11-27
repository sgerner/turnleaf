// @vitest-environment jsdom

import { expect, it, vi } from 'vitest';
import type { capSQLiteChanges, capTask } from '@capacitor-community/sqlite';
import {
  acceptRemoteProgress,
  confirmSync,
  getBooks,
  getPendingSync,
  getPreferences,
  getReadingState,
  getServer,
  getSyncStatus,
  markBookCompleted,
  markDownloaded,
  reconcileBooks,
  removeDownload,
  removeServer,
  replaceBooksInTransaction,
  resetLocalDatabase,
  saveLocalProgress,
  saveRemoteProgress,
  saveServer,
  setPreference,
  setPreferences,
  type BookRecord,
} from './database';
import { BOOT_THEME_STORAGE_KEY, themeTokens } from '../themes/themes';

const BROWSER_STORAGE_KEY = 'turnleaf_browser_database_v1';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  failWrites = false;

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('browser storage write failed');
    this.values.set(key, value);
  }
}

const existingBook: BookRecord = {
  id: 'server:1:10',
  serverId: 'server',
  libraryId: 1,
  seriesId: 1,
  volumeId: 10,
  chapterId: 10,
  title: 'Old title',
  author: 'Old author',
  series: 'Old series',
  descriptionHtml: '<p>Old description</p>',
  format: 'epub',
  pages: 100,
  pagesRead: 25,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-01-02T00:00:00.000Z',
  downloadPath: 'books/server-1-10.epub',
  downloadStatus: 'available',
  fileSize: 1234,
};

const refreshedBook: BookRecord = {
  ...existingBook,
  title: 'New title',
  author: 'New author',
  series: 'New series',
  descriptionHtml: '<p>New description</p>',
  pages: 120,
  pagesRead: 30,
  lastReadAt: '2026-02-02T00:00:00.000Z',
  downloadPath: null,
  downloadStatus: 'none',
  fileSize: 4321,
};

function createDatabase(initialRows: BookRecord[], failAt?: number) {
  let rows = structuredClone(initialRows);
  const executeTransaction = vi.fn(async (tasks: capTask[]): Promise<capSQLiteChanges> => {
    const before = structuredClone(rows);
    try {
      tasks.forEach((task, index) => {
        if (index === failAt) throw new Error('metadata write failed');
        const values = task.values as unknown[];
        const existing = rows.find((row) => row.id === values[0]);
        if (existing) {
          existing.title = String(values[6]);
          existing.author = (values[7] as string | null) ?? null;
          existing.series = (values[8] as string | null) ?? null;
          existing.descriptionHtml = (values[9] as string | null) ?? null;
          existing.format = String(values[10]);
          existing.pages = Number(values[15]);
          existing.pagesRead = Number(values[16]);
          existing.createdAt = String(values[17]);
          existing.lastReadAt = (values[18] as string | null) ?? null;
          return;
        }
        rows.push({
          id: String(values[0]),
          serverId: String(values[1]),
          libraryId: Number(values[2]),
          seriesId: Number(values[3]),
          volumeId: Number(values[4]),
          chapterId: Number(values[5]),
          title: String(values[6]),
          author: (values[7] as string | null) ?? null,
          series: (values[8] as string | null) ?? null,
          descriptionHtml: (values[9] as string | null) ?? null,
          format: String(values[10]),
          pages: Number(values[15]),
          pagesRead: Number(values[16]),
          createdAt: String(values[17]),
          lastReadAt: (values[18] as string | null) ?? null,
          downloadPath: (values[12] as string | null) ?? null,
          downloadStatus: String(values[13]),
          fileSize: (values[14] as number | null) ?? null,
        });
      });
    } catch (error) {
      rows = before;
      throw error;
    }
    return { changes: { changes: tasks.length } };
  });

  return {
    db: { executeTransaction },
    executeTransaction,
    rows: () => rows,
  };
}

it('commits metadata while preserving downloaded file state on existing books', async () => {
  const database = createDatabase([existingBook]);

  await replaceBooksInTransaction(
    database.db,
    'server',
    [refreshedBook, { ...refreshedBook, id: 'server:1:11', chapterId: 11 }],
    '2026-09-07T00:00:00.000Z',
  );

  expect(database.executeTransaction).toHaveBeenCalledOnce();
  const tasks = database.executeTransaction.mock.calls[0]?.[0] ?? [];
  expect(tasks).toHaveLength(2);
  expect(tasks[0]?.statement).not.toContain('download_path=excluded');
  expect(tasks[0]?.statement).not.toContain('server_id=excluded');
  expect(tasks[0]?.statement).toContain('pending_sync');
  expect(database.rows()[0]).toMatchObject({
    id: existingBook.id,
    title: 'New title',
    pagesRead: 30,
    downloadPath: existingBook.downloadPath,
    downloadStatus: existingBook.downloadStatus,
    fileSize: existingBook.fileSize,
    serverId: existingBook.serverId,
  });
  expect(database.rows()).toHaveLength(2);
});

it('rolls back every metadata change when one task fails', async () => {
  const database = createDatabase([existingBook], 1);

  await expect(
    replaceBooksInTransaction(
      database.db,
      'server',
      [refreshedBook, { ...refreshedBook, id: 'server:1:11', chapterId: 11 }],
      '2026-09-07T00:00:00.000Z',
    ),
  ).rejects.toThrow('metadata write failed');

  expect(database.rows()).toEqual([existingBook]);
});

it('skips the native transaction when there is no metadata to refresh', async () => {
  const database = createDatabase([]);

  await replaceBooksInTransaction(database.db, 'server', []);

  expect(database.executeTransaction).not.toHaveBeenCalled();
  expect(database.rows()).toEqual([]);
});

it('preserves browser progress when a remote snapshot omits it and applies a known zero', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  storage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: null,
      books: [existingBook],
      readingState: {},
      syncQueue: {},
      preferences: {},
    }),
  );

  await reconcileBooks('server', [
    {
      ...refreshedBook,
      title: 'Updated with incomplete progress',
      pagesRead: 0,
      lastReadAt: null,
      remoteProgressKnown: false,
    },
  ]);

  let savedBooks = JSON.parse(storage.getItem(BROWSER_STORAGE_KEY) ?? '{}').books as BookRecord[];
  expect(savedBooks[0]).toMatchObject({
    title: 'Updated with incomplete progress',
    pagesRead: existingBook.pagesRead,
    lastReadAt: existingBook.lastReadAt,
  });
  expect(savedBooks[0]).not.toHaveProperty('remoteProgressKnown');

  await reconcileBooks('server', [
    {
      ...refreshedBook,
      pagesRead: 0,
      lastReadAt: '2026-02-02T00:00:00.000Z',
      remoteProgressKnown: true,
    },
  ]);

  savedBooks = JSON.parse(storage.getItem(BROWSER_STORAGE_KEY) ?? '{}').books as BookRecord[];
  expect(savedBooks[0]).toMatchObject({
    pagesRead: 0,
    lastReadAt: '2026-02-02T00:00:00.000Z',
  });
  expect(savedBooks[0]).not.toHaveProperty('remoteProgressKnown');

  await reconcileBooks('server', [
    {
      ...refreshedBook,
      pagesRead: 7,
      lastReadAt: null,
      remoteProgressKnown: true,
      remoteReadDateKnown: false,
    },
  ]);

  savedBooks = JSON.parse(storage.getItem(BROWSER_STORAGE_KEY) ?? '{}').books as BookRecord[];
  expect(savedBooks[0]).toMatchObject({
    pagesRead: 7,
    lastReadAt: '2026-02-02T00:00:00.000Z',
  });
  expect(savedBooks[0]).not.toHaveProperty('remoteReadDateKnown');
});

it('keeps pending browser progress ahead of a remote metadata refresh', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  const updatedAt = '2026-09-07T00:00:00.000Z';
  const queuedBook: BookRecord = {
    ...existingBook,
    pagesRead: 45,
    lastReadAt: updatedAt,
  };
  storage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: null,
      books: [queuedBook],
      readingState: {
        [existingBook.id]: {
          cfi: 'local-cfi',
          xpath: '/local',
          percentage: 0.45,
          localUpdatedAt: updatedAt,
          syncedLocalUpdatedAt: null,
          serverUpdatedAt: null,
          pendingSync: true,
        },
      },
      syncQueue: {
        [existingBook.id]: {
          bookId: existingBook.id,
          payloadJson: '{"pageNum":45}',
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
          createdAt: updatedAt,
          updatedAt,
          revision: 1,
        },
      },
      preferences: {},
    }),
  );

  await reconcileBooks('server', [
    {
      ...refreshedBook,
      pagesRead: 0,
      lastReadAt: null,
      remoteProgressKnown: true,
    },
  ]);

  const savedState = JSON.parse(storage.getItem(BROWSER_STORAGE_KEY) ?? '{}') as {
    books: BookRecord[];
    syncQueue: Record<string, unknown>;
  };
  expect(savedState.books[0]).toMatchObject({ pagesRead: 45, lastReadAt: updatedAt });
  expect(savedState.syncQueue[existingBook.id]).toBeDefined();
});

it('retains a vanished browser book with synced CFI but marks it unavailable', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  const cfi = 'epubcfi(/6/4!/4/2/1:12)';
  const undownloadedBook: BookRecord = {
    ...existingBook,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: null,
  };
  storage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: null,
      books: [undownloadedBook],
      readingState: {
        [existingBook.id]: {
          cfi,
          xpath: '/html/body/p[2]',
          percentage: 0.25,
          localUpdatedAt: '2026-09-07T00:00:00.000Z',
          syncedLocalUpdatedAt: '2026-09-07T00:00:00.000Z',
          serverUpdatedAt: '2026-09-07T00:00:00.000Z',
          pendingSync: false,
        },
      },
      syncQueue: {},
      preferences: {},
    }),
  );

  await reconcileBooks('server', []);

  expect(await getBooks('server')).toMatchObject([
    { id: existingBook.id, remoteAvailable: false, downloadPath: null },
  ]);
  expect(
    (
      JSON.parse(storage.getItem(BROWSER_STORAGE_KEY) ?? '{}') as {
        readingState: Record<string, { cfi: string }>;
      }
    ).readingState[existingBook.id]?.cfi,
  ).toBe(cfi);
});

it('updates incoming browser books while preserving unmatched rows from a partial snapshot', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  const unmatched: BookRecord = {
    ...existingBook,
    id: 'server:1:11',
    chapterId: 11,
    title: 'Unmatched saved book',
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: null,
    remoteAvailable: false,
  };
  storage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: null,
      books: [existingBook, unmatched],
      readingState: {},
      syncQueue: {},
      preferences: {},
    }),
  );

  await reconcileBooks('server', [{ ...refreshedBook, title: 'Updated from partial snapshot' }], {
    preserveMissing: true,
  });

  const savedBooks = JSON.parse(storage.getItem(BROWSER_STORAGE_KEY) ?? '{}').books as BookRecord[];
  expect(savedBooks).toHaveLength(2);
  expect(savedBooks.find((book) => book.id === existingBook.id)).toMatchObject({
    title: 'Updated from partial snapshot',
    remoteAvailable: true,
  });
  expect(savedBooks.find((book) => book.id === unmatched.id)).toEqual(unmatched);
});

it('preserves every browser row when a partial snapshot contains no books', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  const saved = [
    { ...existingBook, remoteAvailable: true },
    {
      ...existingBook,
      id: 'server:1:11',
      chapterId: 11,
      title: 'Unmatched saved book',
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
      remoteAvailable: false,
    },
  ];
  storage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: null,
      books: saved,
      readingState: {},
      syncQueue: {},
      preferences: {},
    }),
  );

  const before = await getBooks('server');
  await reconcileBooks('server', [], { preserveMissing: true });

  expect(await getBooks('server')).toEqual(before);
});

it('does not acknowledge a queue item that was replaced while it uploaded', async () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  const state = {
    serverConfig: null,
    books: [],
    readingState: {
      'book-1': {
        cfi: 'cfi',
        xpath: null,
        percentage: 0.5,
        localUpdatedAt: '2026-09-07T00:00:01.000Z',
        syncedLocalUpdatedAt: null,
        serverUpdatedAt: null,
        pendingSync: true,
      },
    },
    syncQueue: {
      'book-1': {
        bookId: 'book-1',
        payloadJson: '{"pageNum":2}',
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
        createdAt: '2026-09-07T00:00:01.000Z',
        updatedAt: '2026-09-07T00:00:01.000Z',
        revision: 2,
      },
    },
    preferences: {},
  };
  localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(state));

  await confirmSync('book-1', '2026-09-07T00:00:02.000Z', 1, '2026-09-07T00:00:00.000Z');

  expect(JSON.parse(localStorage.getItem(BROWSER_STORAGE_KEY) ?? '{}')).toEqual(state);
});

it('records the uploaded local revision as the acknowledged baseline', async () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  const updatedAt = '2026-09-07T00:00:01.000Z';
  const state = {
    serverConfig: null,
    books: [],
    readingState: {
      'book-1': {
        cfi: 'cfi',
        xpath: null,
        percentage: 0.5,
        localUpdatedAt: updatedAt,
        syncedLocalUpdatedAt: null,
        serverUpdatedAt: null,
        pendingSync: true,
      },
    },
    syncQueue: {
      'book-1': {
        bookId: 'book-1',
        payloadJson: '{"pageNum":2}',
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
        createdAt: updatedAt,
        updatedAt,
        revision: 4,
      },
    },
    preferences: {},
  };
  localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(state));

  await confirmSync('book-1', '2026-09-07T00:00:02.000Z', 4, updatedAt);

  expect(JSON.parse(localStorage.getItem(BROWSER_STORAGE_KEY) ?? '{}')).toMatchObject({
    readingState: {
      'book-1': {
        pendingSync: false,
        syncedLocalUpdatedAt: updatedAt,
      },
    },
    syncQueue: {},
  });
});

it('keeps browser progress and its retryable queue row together when storage fails', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  const state = {
    serverConfig: null,
    books: [existingBook],
    readingState: {
      [existingBook.id]: {
        cfi: 'old-cfi',
        xpath: '/old',
        percentage: 0.25,
        localUpdatedAt: '2026-09-07T00:00:00.000Z',
        syncedLocalUpdatedAt: null,
        serverUpdatedAt: null,
        pendingSync: true,
      },
    },
    syncQueue: {
      [existingBook.id]: {
        bookId: existingBook.id,
        payloadJson: '{"pageNum":25}',
        attemptCount: 1,
        lastAttemptAt: '2026-09-07T00:00:01.000Z',
        lastError: 'offline',
        createdAt: '2026-09-07T00:00:00.000Z',
        updatedAt: '2026-09-07T00:00:00.000Z',
        revision: 1,
      },
    },
    preferences: {},
  };
  storage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(state));
  const before = storage.getItem(BROWSER_STORAGE_KEY);

  storage.failWrites = true;
  await expect(saveLocalProgress(existingBook, 'new-cfi', '/new', 0.8)).rejects.toThrow(
    'browser storage write failed',
  );

  expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(before);
});

it('keeps a browser queue item retryable when acknowledgement storage fails', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  const updatedAt = '2026-09-07T00:00:00.000Z';
  const state = {
    serverConfig: null,
    books: [existingBook],
    readingState: {
      [existingBook.id]: {
        cfi: 'cfi',
        xpath: '/html/body/p[1]',
        percentage: 0.5,
        localUpdatedAt: updatedAt,
        syncedLocalUpdatedAt: null,
        serverUpdatedAt: null,
        pendingSync: true,
      },
    },
    syncQueue: {
      [existingBook.id]: {
        bookId: existingBook.id,
        payloadJson: '{"pageNum":50}',
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
        createdAt: updatedAt,
        updatedAt,
        revision: 3,
      },
    },
    preferences: {},
  };
  storage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(state));
  const before = storage.getItem(BROWSER_STORAGE_KEY);

  storage.failWrites = true;
  await expect(
    confirmSync(existingBook.id, '2026-09-07T00:00:02.000Z', 3, updatedAt),
  ).rejects.toThrow('browser storage write failed');

  expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(before);

  storage.failWrites = false;
  await confirmSync(existingBook.id, '2026-09-07T00:00:02.000Z', 3, updatedAt);
  expect(JSON.parse(storage.getItem(BROWSER_STORAGE_KEY) ?? '{}')).toMatchObject({
    readingState: {
      [existingBook.id]: {
        pendingSync: false,
        syncedLocalUpdatedAt: updatedAt,
      },
    },
    syncQueue: {},
  });
});

it('reports pending and failed browser sync work for recovery UI', async () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  localStorage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: { id: 'server' },
      books: [
        { ...existingBook, id: 'book-1' },
        { ...existingBook, id: 'book-2' },
      ],
      readingState: {},
      syncQueue: {
        'book-1': {
          bookId: 'book-1',
          serverId: 'server',
          payloadJson: '{}',
          attemptCount: 1,
          lastAttemptAt: '2026-09-07T00:00:01.000Z',
          lastError: 'Kavita rejected this auth key.',
          createdAt: '2026-09-07T00:00:00.000Z',
          updatedAt: '2026-09-07T00:00:01.000Z',
        },
        'book-2': {
          bookId: 'book-2',
          serverId: 'server',
          payloadJson: '{}',
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
          createdAt: '2026-09-07T00:00:02.000Z',
          updatedAt: '2026-09-07T00:00:02.000Z',
        },
      },
      preferences: {},
    }),
  );

  await expect(getSyncStatus('server')).resolves.toEqual({
    pendingCount: 2,
    failedCount: 1,
    lastError: 'Kavita rejected this auth key.',
    lastUpdatedAt: '2026-09-07T00:00:02.000Z',
  });
});

it('routes browser progress queues through current books and ignores orphaned rows', async () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  const otherBook = { ...existingBook, id: 'other:1:10', serverId: 'other' };
  localStorage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: { id: 'server' },
      books: [existingBook, otherBook],
      readingState: {},
      syncQueue: {
        [existingBook.id]: {
          bookId: existingBook.id,
          payloadJson: '{"libraryId":9,"seriesId":8,"volumeId":7,"chapterId":6,"pageNum":20}',
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
          createdAt: '2026-09-07T00:00:00.000Z',
          updatedAt: '2026-09-07T00:00:00.000Z',
          revision: 1,
        },
        [otherBook.id]: {
          bookId: otherBook.id,
          serverId: otherBook.serverId,
          payloadJson: '{"pageNum":80}',
          attemptCount: 1,
          lastAttemptAt: '2026-09-07T00:00:02.000Z',
          lastError: 'wrong server',
          createdAt: '2026-09-07T00:00:00.000Z',
          updatedAt: '2026-09-07T00:00:02.000Z',
          revision: 2,
        },
        'removed:book': {
          bookId: 'removed:book',
          payloadJson: '{"libraryId":9,"seriesId":8,"volumeId":7,"chapterId":6,"pageNum":80}',
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
          createdAt: '2026-09-07T00:00:03.000Z',
          updatedAt: '2026-09-07T00:00:03.000Z',
          revision: 1,
        },
      },
      preferences: {},
    }),
  );

  await expect(getPendingSync('server')).resolves.toEqual([
    {
      bookId: existingBook.id,
      payload: JSON.stringify({
        libraryId: existingBook.libraryId,
        seriesId: existingBook.seriesId,
        volumeId: existingBook.volumeId,
        chapterId: existingBook.chapterId,
        pageNum: 20,
      }),
      updatedAt: '2026-09-07T00:00:00.000Z',
      revision: 1,
    },
  ]);
  await expect(getSyncStatus('server')).resolves.toEqual({
    pendingCount: 1,
    failedCount: 0,
    lastError: null,
    lastUpdatedAt: '2026-09-07T00:00:00.000Z',
  });
});

it('clears retry errors when a new browser progress revision replaces the failed payload', async () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  const updatedAt = '2026-09-07T00:00:00.000Z';
  localStorage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: { id: 'server' },
      books: [existingBook],
      readingState: {
        [existingBook.id]: {
          cfi: 'old-cfi',
          xpath: '/old',
          percentage: 0.25,
          localUpdatedAt: updatedAt,
          syncedLocalUpdatedAt: null,
          serverUpdatedAt: null,
          pendingSync: true,
        },
      },
      syncQueue: {
        [existingBook.id]: {
          bookId: existingBook.id,
          serverId: 'server',
          payloadJson: '{"pageNum":25}',
          attemptCount: 2,
          lastAttemptAt: updatedAt,
          lastError: 'expired key',
          createdAt: updatedAt,
          updatedAt,
          revision: 3,
        },
      },
      preferences: {},
    }),
  );

  await saveLocalProgress(existingBook, 'new-cfi', '/new', 0.8);

  const state = JSON.parse(localStorage.getItem(BROWSER_STORAGE_KEY) ?? '{}') as {
    syncQueue: Record<
      string,
      {
        attemptCount: number;
        lastAttemptAt: string | null;
        lastError: string | null;
        revision: number;
      }
    >;
  };
  expect(state.syncQueue[existingBook.id]).toMatchObject({
    attemptCount: 0,
    lastAttemptAt: null,
    lastError: null,
    revision: 4,
  });
  await expect(getSyncStatus('server')).resolves.toMatchObject({
    pendingCount: 1,
    failedCount: 0,
    lastError: null,
  });
});

it('preserves browser sync timestamps when marking a book completed', async () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  const syncedLocalUpdatedAt = '2026-09-07T00:00:00.000Z';
  const serverUpdatedAt = '2026-09-07T00:00:05.000Z';
  const unreadBook: BookRecord = {
    ...existingBook,
    id: 'server:1:11',
    volumeId: 11,
    chapterId: 11,
    pagesRead: 0,
    lastReadAt: null,
  };
  localStorage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: { id: 'server' },
      books: [existingBook, unreadBook],
      readingState: {
        [existingBook.id]: {
          cfi: 'epubcfi(/6/4)',
          xpath: '/html/body/p[2]',
          percentage: 0.4,
          localUpdatedAt: syncedLocalUpdatedAt,
          syncedLocalUpdatedAt,
          serverUpdatedAt,
          pendingSync: false,
          syncRevision: 2,
        },
      },
      syncQueue: {},
      preferences: {},
    }),
  );

  await markBookCompleted(existingBook);
  await markBookCompleted(unreadBook);

  await expect(getReadingState(existingBook.id)).resolves.toMatchObject({
    cfi: '',
    xpath: null,
    percentage: 1,
    syncedLocalUpdatedAt,
    serverUpdatedAt,
    pendingSync: true,
    syncRevision: 3,
  });
  await expect(getReadingState(unreadBook.id)).resolves.toMatchObject({
    cfi: '',
    xpath: null,
    percentage: 1,
    syncedLocalUpdatedAt: null,
    serverUpdatedAt: null,
    pendingSync: true,
    syncRevision: 1,
  });
  await expect(getBooks('server')).resolves.toMatchObject([
    { id: existingBook.id, pagesRead: existingBook.pages },
    { id: unreadBook.id, pagesRead: unreadBook.pages },
  ]);
  await expect(getPendingSync('server')).resolves.toEqual([
    expect.objectContaining({
      bookId: existingBook.id,
      payload: JSON.stringify({
        libraryId: existingBook.libraryId,
        seriesId: existingBook.seriesId,
        volumeId: existingBook.volumeId,
        chapterId: existingBook.chapterId,
        pageNum: existingBook.pages,
        bookScrollId: null,
      }),
      revision: 3,
    }),
    expect.objectContaining({
      bookId: unreadBook.id,
      payload: JSON.stringify({
        libraryId: unreadBook.libraryId,
        seriesId: unreadBook.seriesId,
        volumeId: unreadBook.volumeId,
        chapterId: unreadBook.chapterId,
        pageNum: unreadBook.pages,
        bookScrollId: null,
      }),
      revision: 1,
    }),
  ]);
});

it('accepts the selected browser server progress and drops only the displayed local revision', async () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  const updatedAt = '2026-09-07T00:00:00.000Z';
  localStorage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: { id: 'server' },
      books: [existingBook],
      readingState: {
        [existingBook.id]: {
          cfi: 'local-cfi',
          xpath: '/local',
          percentage: 0.4,
          localUpdatedAt: updatedAt,
          syncedLocalUpdatedAt: null,
          serverUpdatedAt: null,
          pendingSync: true,
        },
      },
      syncQueue: {
        [existingBook.id]: {
          bookId: existingBook.id,
          serverId: 'server',
          payloadJson: '{"pageNum":40}',
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
          createdAt: updatedAt,
          updatedAt,
          revision: 2,
        },
      },
      preferences: {},
    }),
  );

  const remote = {
    libraryId: 1,
    seriesId: 1,
    volumeId: 10,
    chapterId: 10,
    pageNum: 80,
    bookScrollId: '/remote',
    lastModifiedUtc: '2026-09-07T00:00:05.000Z',
  };
  await expect(acceptRemoteProgress(existingBook, remote, 2, updatedAt)).resolves.toBe(true);
  expect(JSON.parse(localStorage.getItem(BROWSER_STORAGE_KEY) ?? '{}')).toMatchObject({
    readingState: {
      [existingBook.id]: {
        cfi: '',
        xpath: '/remote',
        percentage: 0.8,
        pendingSync: false,
      },
    },
    syncQueue: {},
    books: [{ id: existingBook.id, pagesRead: 80 }],
  });

  await saveLocalProgress(existingBook, 'newer-cfi', '/newer', 0.9);
  const newer = await getPendingSync('server');
  await expect(acceptRemoteProgress(existingBook, remote, 2, updatedAt)).resolves.toBe(false);
  await expect(getPendingSync('server')).resolves.toEqual(newer);
});

it('mirrors browser theme, mode, and surface colors to localStorage and clears them on reset', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });

  await setPreference('uiMode', 'light');
  expect(JSON.parse(storage.getItem(BOOT_THEME_STORAGE_KEY) ?? '{}')).toEqual({
    theme: 'fennec',
    mode: 'light',
    rootBgLight: themeTokens.fennec.rootBgLight,
    rootBgDark: themeTokens.fennec.rootBgDark,
    surfaceLight: themeTokens.fennec.surfaceLight,
    surfaceDark: themeTokens.fennec.surfaceDark,
  });

  await setPreference('uiTheme', 'eink');
  expect(JSON.parse(storage.getItem(BOOT_THEME_STORAGE_KEY) ?? '{}')).toEqual({
    theme: 'eink',
    mode: 'light',
    rootBgLight: 'oklch(1 0 0)',
    rootBgDark: 'oklch(0 0 0)',
    surfaceLight: 'oklch(1 0 0)',
    surfaceDark: 'oklch(0 0 0)',
  });

  await resetLocalDatabase();
  expect(storage.getItem(BOOT_THEME_STORAGE_KEY)).toBeNull();
});

it('round-trips library filter preferences in browser storage and clears them on database reset', async () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });

  const initial = await getPreferences(['libraryDownloadedOnly', 'libraryHideCompleted']);
  expect(initial.size).toBe(0);

  await setPreference('libraryDownloadedOnly', 'true');
  await setPreference('libraryHideCompleted', 'false');

  const saved = await getPreferences(['libraryDownloadedOnly', 'libraryHideCompleted']);
  expect(saved.get('libraryDownloadedOnly')).toBe('true');
  expect(saved.get('libraryHideCompleted')).toBe('false');
  expect(JSON.parse(localStorage.getItem(BROWSER_STORAGE_KEY) ?? '{}')).toMatchObject({
    preferences: {
      libraryDownloadedOnly: 'true',
      libraryHideCompleted: 'false',
    },
  });

  await setPreference('libraryDownloadedOnly', 'false');
  await setPreference('libraryHideCompleted', 'false');

  const cleared = await getPreferences(['libraryDownloadedOnly', 'libraryHideCompleted']);
  expect(cleared.get('libraryDownloadedOnly')).toBe('false');
  expect(cleared.get('libraryHideCompleted')).toBe('false');

  await resetLocalDatabase();
  const afterReset = await getPreferences(['libraryDownloadedOnly', 'libraryHideCompleted']);
  expect(afterReset.size).toBe(0);
});

it('marks and removes browser downloads only on the matching book', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  const undownloaded: BookRecord = {
    ...existingBook,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: null,
  };
  const sibling: BookRecord = {
    ...existingBook,
    id: 'server:1:11',
    chapterId: 11,
  };
  storage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: { id: 'server' },
      books: [undownloaded, sibling],
      readingState: {},
      syncQueue: {},
      preferences: {},
    }),
  );

  await markDownloaded(undownloaded.id, 'books/downloaded.epub', 9876);
  expect(await getBooks('server')).toEqual([
    expect.objectContaining({
      id: undownloaded.id,
      downloadPath: 'books/downloaded.epub',
      downloadStatus: 'available',
      fileSize: 9876,
    }),
    expect.objectContaining({
      id: sibling.id,
      downloadPath: sibling.downloadPath,
      downloadStatus: sibling.downloadStatus,
      fileSize: sibling.fileSize,
    }),
  ]);

  await removeDownload(undownloaded.id);
  expect(await getBooks('server')).toEqual([
    expect.objectContaining({
      id: undownloaded.id,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
    }),
    expect.objectContaining({
      id: sibling.id,
      downloadPath: sibling.downloadPath,
      downloadStatus: sibling.downloadStatus,
      fileSize: sibling.fileSize,
    }),
  ]);
});

it('skips browser storage writes when removing an unmatched server or empty preferences', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  const serverConfig = {
    id: 'server',
    displayName: 'Test server',
    baseUrl: 'https://books.example.com',
    credentialRef: 'credential',
    kavitaVersion: '0.8.4',
    lastConnectedAt: '2026-09-07T00:00:00.000Z',
  };
  await saveServer(serverConfig);
  await setPreferences(new Map([['uiTheme', 'eink']]));
  await reconcileBooks('server', [existingBook]);

  const setItemSpy = vi.spyOn(storage, 'setItem');
  await setPreferences(new Map());
  await removeServer('other-server');
  expect(setItemSpy).not.toHaveBeenCalled();
  await expect(getServer()).resolves.toEqual(serverConfig);
  await expect(getPreferences(['uiTheme'])).resolves.toEqual(new Map([['uiTheme', 'eink']]));

  await removeServer('server');
  expect(setItemSpy).toHaveBeenCalledOnce();
  await expect(getServer()).resolves.toBeNull();
  await expect(getBooks('server')).resolves.toEqual([]);
  await expect(getPreferences(['uiTheme'])).resolves.toEqual(new Map([['uiTheme', 'eink']]));
});

it('saves normalized browser remote progress and guards against concurrent local edits', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  const zeroPageBook: BookRecord = {
    ...existingBook,
    id: 'server:1:12',
    chapterId: 12,
    pages: 0,
    pagesRead: 0,
  };
  storage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: { id: 'server' },
      books: [existingBook, zeroPageBook],
      readingState: {},
      syncQueue: {},
      preferences: {},
    }),
  );

  const clampedRemote = {
    libraryId: 1,
    seriesId: 1,
    volumeId: 10,
    chapterId: 10,
    pageNum: 150,
    bookScrollId: '/remote/end',
    lastModifiedUtc: '2026-09-07T00:00:05.000Z',
  };
  await expect(saveRemoteProgress(existingBook, clampedRemote, null)).resolves.toBe(true);
  const saved = await getReadingState(existingBook.id);
  expect(saved).toMatchObject({
    cfi: '',
    pageNum: 100,
    xpath: null,
    percentage: 1,
    serverUpdatedAt: '2026-09-07T00:00:05.000Z',
    pendingSync: false,
    syncRevision: 1,
  });
  expect((await getBooks('server')).find((book) => book.id === existingBook.id)).toMatchObject({
    pagesRead: 100,
    lastReadAt: '2026-09-07T00:00:05.000Z',
  });

  await expect(
    saveRemoteProgress(zeroPageBook, { ...clampedRemote, chapterId: 12, pageNum: 12 }, null),
  ).resolves.toBe(true);
  expect(await getReadingState(zeroPageBook.id)).toMatchObject({
    cfi: '',
    pageNum: 12,
    percentage: 0,
    pendingSync: false,
    syncRevision: 1,
  });
  expect((await getBooks('server')).find((book) => book.id === zeroPageBook.id)?.pagesRead).toBe(0);

  await saveLocalProgress(existingBook, 'local-cfi', '/local', 0.5);
  const setItemSpy = vi.spyOn(storage, 'setItem');
  await expect(saveRemoteProgress(existingBook, clampedRemote, saved)).resolves.toBe(false);
  expect(setItemSpy).not.toHaveBeenCalled();
});

it('persists zero-based spine pageNum, explicit completion payloads, and legacy DocFragment remote overrides in browser storage', async () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  localStorage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: { id: 'server' },
      books: [existingBook],
      readingState: {},
      syncQueue: {},
      preferences: {},
    }),
  );

  await saveLocalProgress(existingBook, 'cfi-ch1', '//body/p[4]', 0.05, 0);
  await expect(getReadingState(existingBook.id)).resolves.toMatchObject({
    cfi: 'cfi-ch1',
    pageNum: 0,
    xpath: '//body/p[4]',
    percentage: 0.05,
    pendingSync: true,
  });
  const firstQueue = await getPendingSync('server');
  expect(JSON.parse(firstQueue[0]!.payload)).toMatchObject({
    pageNum: 0,
    bookScrollId: '//body/p[4]',
  });

  await markBookCompleted(existingBook);
  await expect(getReadingState(existingBook.id)).resolves.toMatchObject({
    pageNum: existingBook.pages,
    xpath: null,
    percentage: 1,
    pendingSync: true,
  });
  const completedQueue = await getPendingSync('server');
  expect(JSON.parse(completedQueue[0]!.payload)).toMatchObject({
    pageNum: existingBook.pages,
    bookScrollId: null,
  });

  await confirmSync(
    existingBook.id,
    '2026-09-07T00:01:00.000Z',
    completedQueue[0]!.revision,
    completedQueue[0]!.updatedAt,
  );
  const acknowledged = await getReadingState(existingBook.id);
  await expect(
    saveRemoteProgress(
      existingBook,
      {
        libraryId: 1,
        seriesId: 1,
        volumeId: 10,
        chapterId: 10,
        pageNum: 3,
        bookScrollId: '//body/DocFragment[3]/body/p[2]',
        lastModifiedUtc: '2026-09-07T00:02:00.000Z',
      },
      acknowledged,
    ),
  ).resolves.toBe(true);
  await expect(getReadingState(existingBook.id)).resolves.toMatchObject({
    cfi: '',
    pageNum: 2,
    xpath: '//body/DocFragment[3]/body/p[2]',
    percentage: 0.02,
    pendingSync: false,
  });
});
