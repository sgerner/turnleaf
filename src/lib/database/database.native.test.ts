import { beforeEach, expect, it, vi } from 'vitest';
import type { capSQLiteChanges, capTask } from '@capacitor-community/sqlite';

const mocks = vi.hoisted(() => {
  let databaseVersion = 5;
  const executeTransaction = vi.fn<(tasks: capTask[]) => Promise<capSQLiteChanges>>(async () => ({
    changes: { changes: 0 },
  }));
  const db = {
    close: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ changes: { changes: 0 } })),
    executeTransaction,
    getVersion: vi.fn(async () => ({ version: databaseVersion })),
    open: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ values: [] })),
    run: vi.fn(async () => ({ changes: { changes: 1 } })),
  };
  const sqlite = {
    checkConnectionsConsistency: vi.fn(async () => ({ result: true })),
    createConnection: vi.fn(async () => db),
    isConnection: vi.fn(async () => ({ result: false })),
  };
  return {
    db,
    executeTransaction,
    reset() {
      databaseVersion = 5;
      vi.clearAllMocks();
    },
    setDatabaseVersion(version: number) {
      databaseVersion = version;
    },
    sqlite,
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
}));

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {
    deleteDatabase: vi.fn(async () => undefined),
  },
  SQLiteConnection: class {
    constructor() {
      return mocks.sqlite;
    }
  },
}));

const book = {
  id: 'server:1:10',
  serverId: 'server',
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

const readingState = {
  cfi: 'epubcfi(/6/2)',
  xpath: '/html/body/p[1]',
  percentage: 0.4,
  localUpdatedAt: '2026-01-01T00:00:00.000Z',
  serverUpdatedAt: null,
  pendingSync: false,
};

beforeEach(() => {
  mocks.reset();
});

it('groups progress, queue, and book updates into one native transaction', async () => {
  const { saveLocalProgress } = await import('./database');

  await saveLocalProgress(book, readingState.cfi, readingState.xpath, 0.4, 2);

  expect(mocks.executeTransaction).toHaveBeenCalledOnce();
  const [tasks] = mocks.executeTransaction.mock.calls[0] ?? [];
  expect(tasks).toHaveLength(3);
  expect(tasks?.map((task) => task.statement)).toEqual([
    expect.stringContaining('INSERT INTO reading_state'),
    expect.stringContaining('INSERT INTO sync_queue'),
    expect.stringContaining('UPDATE books'),
  ]);
});

it('keeps a failed native progress transaction atomic', async () => {
  const persisted = { book: false, readingState: false, syncQueue: false };
  mocks.executeTransaction.mockImplementationOnce(async (tasks: capTask[]) => {
    const before = { ...persisted };
    try {
      tasks.forEach((task, index) => {
        if (index === 1) throw new Error('queue write failed');
        if (task.statement.includes('reading_state')) persisted.readingState = true;
        if (task.statement.includes('books')) persisted.book = true;
        if (task.statement.includes('sync_queue')) persisted.syncQueue = true;
      });
    } catch (error) {
      Object.assign(persisted, before);
      throw error;
    }
    return { changes: { changes: tasks.length } };
  });

  const { saveLocalProgress } = await import('./database');
  await expect(saveLocalProgress(book, readingState.cfi, readingState.xpath, 0.4)).rejects.toThrow(
    'queue write failed',
  );

  expect(persisted).toEqual({ book: false, readingState: false, syncQueue: false });
  expect(mocks.executeTransaction).toHaveBeenCalledOnce();
});

it('groups completion and acknowledgement writes separately', async () => {
  const { confirmSync, markBookCompleted } = await import('./database');

  await markBookCompleted(book, readingState);
  await confirmSync(book.id, '2026-01-02T00:00:00.000Z', readingState.localUpdatedAt);

  expect(mocks.executeTransaction).toHaveBeenCalledTimes(2);
  const [completionTasks, acknowledgementTasks] = mocks.executeTransaction.mock.calls;
  expect(completionTasks?.[0]).toHaveLength(3);
  expect(acknowledgementTasks?.[0]).toHaveLength(2);
  expect(acknowledgementTasks?.[0]?.map((task) => task.statement)).toEqual([
    expect.stringContaining('UPDATE reading_state'),
    expect.stringContaining('DELETE FROM sync_queue'),
  ]);
});

it('records each migration and its user version in one transaction', async () => {
  const { openDatabase, resetLocalDatabase } = await import('./database');
  await resetLocalDatabase();
  mocks.setDatabaseVersion(0);
  mocks.executeTransaction.mockClear();

  await openDatabase();

  expect(mocks.executeTransaction).toHaveBeenCalledTimes(5);
  const migrationTasks = mocks.executeTransaction.mock.calls.map(([tasks]) => tasks);
  expect(migrationTasks.map((tasks) => tasks?.[0]?.statement)).toEqual([
    expect.stringContaining('CREATE TABLE IF NOT EXISTS server_config'),
    expect.stringContaining('ALTER TABLE books ADD COLUMN pages'),
    expect.stringContaining('CREATE TABLE preferences'),
    expect.stringContaining('ALTER TABLE books ADD COLUMN remote_available'),
    expect.stringContaining('CREATE INDEX IF NOT EXISTS books_server_title_idx'),
  ]);
  expect(migrationTasks.map((tasks) => tasks?.[1]?.statement)).toEqual([
    'PRAGMA user_version = 1;',
    'PRAGMA user_version = 2;',
    'PRAGMA user_version = 3;',
    'PRAGMA user_version = 4;',
    'PRAGMA user_version = 5;',
  ]);
});
