import { expect, it, vi } from 'vitest';
import type { capSQLiteChanges, capTask } from '@capacitor-community/sqlite';
import {
  confirmSync,
  getSyncStatus,
  replaceBooksInTransaction,
  saveLocalProgress,
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
      serverConfig: null,
      books: [],
      readingState: {},
      syncQueue: {
        'book-1': {
          bookId: 'book-1',
          payloadJson: '{}',
          attemptCount: 1,
          lastAttemptAt: '2026-09-07T00:00:01.000Z',
          lastError: 'Kavita rejected this auth key.',
          createdAt: '2026-09-07T00:00:00.000Z',
          updatedAt: '2026-09-07T00:00:01.000Z',
        },
        'book-2': {
          bookId: 'book-2',
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

  await expect(getSyncStatus()).resolves.toEqual({
    pendingCount: 2,
    failedCount: 1,
    lastError: 'Kavita rejected this auth key.',
    lastUpdatedAt: '2026-09-07T00:00:02.000Z',
  });
});
