// @vitest-environment jsdom

import { expect, it, vi } from 'vitest';
import type { capSQLiteChanges, capTask } from '@capacitor-community/sqlite';
import {
  acceptRemoteProgress,
  confirmSync,
  deleteBookAnnotation,
  deleteBookBookmark,
  getBookAnnotations,
  getBookBookmarks,
  getBookHistory,
  getBooks,
  getPendingAnnotationSync,
  getPendingBookmarkSync,
  getPendingSync,
  getServerAnnotations,
  getSyncStatus,
  markAnnotationSyncFailure,
  reconcileBooks,
  recordBookHistory,
  removeServer,
  renameBookBookmark,
  replaceBooksInTransaction,
  saveBookAnnotation,
  saveBookBookmark,
  saveLocalProgress,
  saveServer,
  updateBookAnnotationNote,
  type BookRecord,
} from './database';

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

it('isolates study data per server and purges all annotations, bookmarks, history, and queued items on removeServer', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });

  await saveServer({
    id: 'srv_one',
    displayName: 'First Server',
    baseUrl: 'https://one.example.com',
    credentialRef: 'srv_one_api_key',
    kavitaVersion: '0.8.8',
    lastConnectedAt: '2026-09-01T00:00:00.000Z',
  });
  const bookOne: BookRecord = {
    ...existingBook,
    id: 'srv_one:1:10',
    serverId: 'srv_one',
  };
  await reconcileBooks('srv_one', [bookOne]);
  await saveLocalProgress(bookOne, 'epubcfi(/6/2!/4/2)', '//body/DocFragment[1]/body/p[1]', 0.25);
  await saveBookAnnotation(bookOne.id, {
    cfi: 'epubcfi(/6/2!/4/2/1:0)',
    xpath: '//body/DocFragment[1]/body/p[1]',
    endingXPath: '//body/DocFragment[1]/body/p[1]',
    pageNumber: 0,
    excerpt: 'Server one quote',
    note: 'Server one note',
  });
  await saveBookBookmark(bookOne.id, {
    cfi: 'epubcfi(/6/2!/4/2)',
    xpath: '//body/DocFragment[1]/body/p[1]',
    href: 'ch1.xhtml',
    percentage: 0.25,
    pageNumber: 0,
    label: 'Server one bookmark',
  });
  await recordBookHistory(bookOne.id, {
    cfi: 'epubcfi(/6/2!/4/2)',
    href: 'ch1.xhtml',
    percentage: 0.25,
    label: '25%',
  });

  await removeServer('srv_one');

  const afterRemove = JSON.parse(storage.getItem(BROWSER_STORAGE_KEY) ?? '{}') as {
    serverConfig: unknown;
    books: BookRecord[];
    readingState: Record<string, unknown>;
    syncQueue: Record<string, unknown>;
    annotations: Record<string, unknown>;
    bookmarks: Record<string, unknown>;
    readingHistory: Record<string, unknown>;
  };
  expect(afterRemove.serverConfig).toBeNull();
  expect(afterRemove.books).toEqual([]);
  expect(afterRemove.readingState).toEqual({});
  expect(afterRemove.syncQueue).toEqual({});
  expect(afterRemove.annotations).toEqual({});
  expect(afterRemove.bookmarks).toEqual({});
  expect(afterRemove.readingHistory).toEqual({});

  // Connecting a second server with identical Kavita seriesId/chapterId starts completely clean.
  await saveServer({
    id: 'srv_two',
    displayName: 'Second Server',
    baseUrl: 'https://two.example.com',
    credentialRef: 'srv_two_api_key',
    kavitaVersion: '0.8.8',
    lastConnectedAt: '2026-09-02T00:00:00.000Z',
  });
  const bookTwo: BookRecord = {
    ...existingBook,
    id: 'srv_two:1:10',
    serverId: 'srv_two',
  };
  await reconcileBooks('srv_two', [bookTwo]);
  await expect(getBookAnnotations(bookTwo.id)).resolves.toEqual([]);
  await expect(getBookBookmarks(bookTwo.id)).resolves.toEqual([]);
  await expect(getBookHistory(bookTwo.id)).resolves.toEqual([]);
  await expect(getPendingAnnotationSync('srv_two')).resolves.toEqual([]);
  await expect(getPendingBookmarkSync('srv_two')).resolves.toEqual([]);
});

it('migrates legacy reader preference rows for the active server and purges orphaned deleted-server entries', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  const activeBook: BookRecord = {
    ...existingBook,
    id: 'active:1:10',
    serverId: 'active',
  };
  storage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({
      serverConfig: {
        id: 'active',
        displayName: 'Active',
        baseUrl: 'https://active.example',
        credentialRef: 'active_key',
        kavitaVersion: '0.8.8',
        lastConnectedAt: '2026-09-01T00:00:00.000Z',
      },
      books: [activeBook],
      readingState: {},
      syncQueue: {},
      preferences: {
        uiTheme: 'vintage',
        'readerAnnotations:active:1:10': JSON.stringify([
          {
            id: 'leg-a1',
            cfi: 'epubcfi(/6/4!/4/2/1:0)',
            excerpt: 'Migrated highlight',
            note: 'Migrated note',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ]),
        'readerAnnotations:primary:1:10': JSON.stringify([
          {
            id: 'orphan-a1',
            cfi: 'epubcfi(/6/2!/4/2/1:0)',
            excerpt: 'Deleted server highlight',
            note: 'Must be purged',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ]),
        'readerBookmarks:active:1:10': JSON.stringify([
          {
            id: 'leg-b1',
            cfi: 'epubcfi(/6/4!/4/2)',
            href: 'ch2.xhtml',
            percentage: 0.4,
            label: 'Duplicate Name',
            savedAt: '2026-08-01T00:00:00.000Z',
          },
          {
            id: 'leg-b2',
            cfi: 'epubcfi(/6/4!/4/6)',
            href: 'ch2.xhtml',
            percentage: 0.45,
            label: 'Duplicate Name',
            savedAt: '2026-08-01T00:01:00.000Z',
          },
        ]),
        'readerHistory:active:1:10': JSON.stringify([
          {
            id: 'leg-h1',
            cfi: 'epubcfi(/6/4!/4/2)',
            href: 'ch2.xhtml',
            percentage: 0.4,
            label: '40%',
            savedAt: '2026-08-01T00:00:00.000Z',
          },
        ]),
      },
    }),
  );

  const annotations = await getBookAnnotations(activeBook.id);
  const bookmarks = await getBookBookmarks(activeBook.id);
  const history = await getBookHistory(activeBook.id);

  expect(annotations).toMatchObject([
    {
      excerpt: 'Migrated highlight',
      note: 'Migrated note',
      syncState: 'pending_create',
      xpath: '//body/DocFragment[2]/body',
      pageNumber: 1,
    },
  ]);
  expect(bookmarks.map((item) => item.label).sort()).toEqual([
    'Duplicate Name',
    'Duplicate Name (2)',
  ]);
  expect(history).toHaveLength(1);

  const raw = JSON.parse(storage.getItem(BROWSER_STORAGE_KEY) ?? '{}') as {
    preferences: Record<string, string>;
    annotations: Record<string, unknown>;
  };
  expect(raw.preferences).toEqual({ uiTheme: 'vintage' });
  expect(raw.annotations['primary:1:10']).toBeUndefined();
});

it('retains undownloaded books with saved annotations or bookmarks when they leave Kavita', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  const annotatedBook: BookRecord = {
    ...existingBook,
    id: 'server:1:20',
    chapterId: 20,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: null,
  };
  const bookmarkedBook: BookRecord = {
    ...existingBook,
    id: 'server:1:21',
    chapterId: 21,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: null,
  };
  const emptyBook: BookRecord = {
    ...existingBook,
    id: 'server:1:22',
    chapterId: 22,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: null,
  };
  await reconcileBooks('server', [annotatedBook, bookmarkedBook, emptyBook]);
  await saveBookAnnotation(annotatedBook.id, {
    cfi: 'epubcfi(/6/2!/4/2/1:0)',
    excerpt: 'Keep this quote',
    note: 'My note',
  });
  await saveBookBookmark(bookmarkedBook.id, {
    cfi: 'epubcfi(/6/2!/4/2)',
    href: 'ch1.xhtml',
    percentage: 0.1,
    label: 'Keep this bookmark',
  });

  await reconcileBooks('server', []);

  const remaining = await getBooks('server');
  expect(remaining.map((book) => ({ id: book.id, remoteAvailable: book.remoteAvailable }))).toEqual(
    [
      { id: annotatedBook.id, remoteAvailable: false },
      { id: bookmarkedBook.id, remoteAvailable: false },
    ],
  );
  const serverGroups = await getServerAnnotations('server');
  expect(serverGroups).toHaveLength(1);
  expect(serverGroups[0]?.annotations[0]?.excerpt).toBe('Keep this quote');
});

it('deduplicates same-CFI annotations, disambiguates bookmark labels, and tracks study sync status', async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  await reconcileBooks('server', [existingBook]);

  const first = await saveBookAnnotation(existingBook.id, {
    cfi: 'epubcfi(/6/2!/4/2/1:0)',
    excerpt: 'Highlighted passage',
    note: 'Initial note',
  });
  const second = await saveBookAnnotation(existingBook.id, {
    cfi: 'epubcfi(/6/2!/4/2/1:0)',
    excerpt: 'Highlighted passage',
    note: 'Refined note',
  });
  expect(second?.id).toBe(first?.id);
  expect(await getBookAnnotations(existingBook.id)).toHaveLength(1);
  expect((await getBookAnnotations(existingBook.id))[0]?.note).toBe('Refined note');

  await updateBookAnnotationNote(existingBook.id, first!.id, 'Third note');
  const pendingAnnotations = await getPendingAnnotationSync('server');
  expect(pendingAnnotations).toHaveLength(1);
  await markAnnotationSyncFailure(
    first!.id,
    existingBook.id,
    'Network timeout',
    pendingAnnotations[0]!.syncRevision,
  );

  const b1 = await saveBookBookmark(existingBook.id, {
    cfi: 'epubcfi(/6/2!/4/2)',
    href: 'ch1.xhtml',
    percentage: 0.2,
    pageNumber: 0,
    label: 'Chapter 1',
  });
  const b2 = await saveBookBookmark(existingBook.id, {
    cfi: 'epubcfi(/6/2!/4/8)',
    href: 'ch1.xhtml',
    percentage: 0.3,
    pageNumber: 0,
    label: 'Chapter 1',
  });
  expect(b1?.label).toBe('Chapter 1');
  expect(b2?.label).toBe('Chapter 1 (2)');
  const renamed = await renameBookBookmark(existingBook.id, b2!.id, 'Chapter 1');
  expect(renamed?.label).toBe('Chapter 1 (2)');

  await expect(getSyncStatus('server')).resolves.toMatchObject({
    pendingCount: 3,
    failedCount: 1,
    lastError: 'Network timeout',
  });

  await deleteBookAnnotation(existingBook.id, first!.id);
  await deleteBookBookmark(existingBook.id, b1!.id);
  await deleteBookBookmark(existingBook.id, b2!.id);
  await expect(getSyncStatus('server')).resolves.toMatchObject({
    pendingCount: 0,
    failedCount: 0,
  });
});
