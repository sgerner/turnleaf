import { beforeEach, expect, it, vi } from 'vitest';
import type { capSQLiteChanges, capTask } from '@capacitor-community/sqlite';

const mocks = vi.hoisted(() => {
  let databaseVersion = 8;
  const executeTransaction = vi.fn<(tasks: capTask[]) => Promise<capSQLiteChanges>>(async () => ({
    changes: { changes: 0 },
  }));
  const db = {
    close: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ changes: { changes: 0 } })),
    executeTransaction,
    getVersion: vi.fn(async () => ({ version: databaseVersion })),
    open: vi.fn(async () => undefined),
    query: vi.fn<
      (statement: string, values?: unknown[]) => Promise<{ values: Record<string, unknown>[] }>
    >(async () => ({ values: [] })),
    run: vi.fn<
      (statement: string, values?: unknown[]) => Promise<{ changes: { changes: number } }>
    >(async () => ({ changes: { changes: 1 } })),
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
      databaseVersion = 8;
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
  syncedLocalUpdatedAt: null,
  serverUpdatedAt: null,
  pendingSync: false,
};

beforeEach(async () => {
  mocks.reset();
  await openAndClearMocks();
  mocks.reset();
});

it('reads several preferences with one native query', async () => {
  const { getPreferences } = await import('./database');
  mocks.db.query.mockResolvedValueOnce({ values: [{ key: 'uiTheme', value: 'eink' }] });

  const values = await getPreferences(['uiTheme', 'uiMode']);

  expect(mocks.db.query).toHaveBeenCalledExactlyOnceWith(
    'SELECT key, value FROM preferences WHERE key IN (?, ?)',
    ['uiTheme', 'uiMode'],
  );
  expect(values.get('uiTheme')).toBe('eink');
  expect(values.has('uiMode')).toBe(false);
});

it('round-trips library filter preferences through native SQLite upserts and batched reads', async () => {
  const { getPreferences, setPreference } = await import('./database');
  const stored = new Map<string, string>();
  mocks.db.run.mockImplementation(async (_statement: string, values?: unknown[]) => {
    if (Array.isArray(values)) {
      for (let index = 0; index < values.length; index += 3) {
        stored.set(String(values[index]), String(values[index + 1]));
      }
    }
    return { changes: { changes: 1 } };
  });
  mocks.db.query.mockImplementation(async (_statement: string, values?: unknown[]) => ({
    values: (values ?? [])
      .map((key) => String(key))
      .filter((key) => stored.has(key))
      .map((key) => ({ key, value: stored.get(key)! })),
  }));

  const initial = await getPreferences(['libraryDownloadedOnly', 'libraryHideCompleted']);
  expect(initial.size).toBe(0);

  await setPreference('libraryDownloadedOnly', 'true');
  await setPreference('libraryHideCompleted', 'false');

  const saved = await getPreferences(['libraryDownloadedOnly', 'libraryHideCompleted']);
  expect(mocks.db.query).toHaveBeenLastCalledWith(
    'SELECT key, value FROM preferences WHERE key IN (?, ?)',
    ['libraryDownloadedOnly', 'libraryHideCompleted'],
  );
  expect(saved.get('libraryDownloadedOnly')).toBe('true');
  expect(saved.get('libraryHideCompleted')).toBe('false');

  await setPreference('libraryDownloadedOnly', 'false');
  await setPreference('libraryHideCompleted', 'false');

  const reset = await getPreferences(['libraryDownloadedOnly', 'libraryHideCompleted']);
  expect(reset.get('libraryDownloadedOnly')).toBe('false');
  expect(reset.get('libraryHideCompleted')).toBe('false');
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

it('serializes concurrent native progress transactions', async () => {
  let activeTransactions = 0;
  let peakTransactions = 0;
  mocks.executeTransaction.mockImplementation(async () => {
    activeTransactions += 1;
    peakTransactions = Math.max(peakTransactions, activeTransactions);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeTransactions -= 1;
    return { changes: { changes: 0 } };
  });

  const { saveLocalProgress } = await import('./database');
  await Promise.all([
    saveLocalProgress(book, readingState.cfi, readingState.xpath, 0.4),
    saveLocalProgress(book, readingState.cfi, readingState.xpath, 0.5),
  ]);

  expect(peakTransactions).toBe(1);
  expect(mocks.executeTransaction).toHaveBeenCalledTimes(2);
});

it('serializes direct native writes with transactions', async () => {
  let activeWrites = 0;
  let peakWrites = 0;
  const delay = async (): Promise<void> => {
    activeWrites += 1;
    peakWrites = Math.max(peakWrites, activeWrites);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeWrites -= 1;
  };
  mocks.executeTransaction.mockImplementation(async () => {
    await delay();
    return { changes: { changes: 0 } };
  });
  mocks.db.run.mockImplementation(async () => {
    await delay();
    return { changes: { changes: 0 } };
  });

  const { markSyncFailure, saveLocalProgress } = await import('./database');
  await Promise.all([
    saveLocalProgress(book, readingState.cfi, readingState.xpath, 0.4),
    markSyncFailure(book.id, 'offline', 1, readingState.localUpdatedAt),
  ]);

  expect(peakWrites).toBe(1);
});

it('serializes public native reads behind transactions and direct writes', async () => {
  let activeOperations = 0;
  let peakOperations = 0;
  const order: string[] = [];
  const track = async <T>(label: string, result: T): Promise<T> => {
    activeOperations += 1;
    peakOperations = Math.max(peakOperations, activeOperations);
    order.push(`${label}:start`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`${label}:end`);
    activeOperations -= 1;
    return result;
  };
  mocks.executeTransaction.mockImplementation(async () =>
    track('transaction', { changes: { changes: 0 } }),
  );
  mocks.db.run.mockImplementation(async () => track('run', { changes: { changes: 0 } }));
  mocks.db.query.mockImplementation(async () =>
    track('query', { values: [] as Record<string, unknown>[] }),
  );

  const {
    getBooks,
    getPendingSync,
    getPreferences,
    getReadingState,
    getServer,
    getSyncStatus,
    markSyncFailure,
    saveLocalProgress,
  } = await import('./database');
  await openAndClearMocks();
  await Promise.all([
    saveLocalProgress(book, readingState.cfi, readingState.xpath, 0.4),
    getServer(),
    getBooks(book.serverId),
    getReadingState(book.id),
    getPendingSync(book.serverId),
    getSyncStatus(book.serverId),
    getPreferences(['uiTheme']),
    markSyncFailure(book.id, 'offline', 1, readingState.localUpdatedAt),
  ]);

  expect(peakOperations).toBe(1);
  expect(order).toEqual([
    'transaction:start',
    'transaction:end',
    'query:start',
    'query:end',
    'query:start',
    'query:end',
    'query:start',
    'query:end',
    'query:start',
    'query:end',
    'query:start',
    'query:end',
    'query:start',
    'query:end',
    'run:start',
    'run:end',
  ]);
});

it('recovers nativeTransactionQueue after a rejected native query', async () => {
  const { getPreferences } = await import('./database');
  await openAndClearMocks();
  mocks.db.query
    .mockRejectedValueOnce(new Error('sqlite busy'))
    .mockResolvedValueOnce({ values: [{ key: 'uiTheme', value: 'eink' }] });

  await expect(getPreferences(['uiTheme'])).rejects.toThrow('sqlite busy');
  await expect(getPreferences(['uiTheme'])).resolves.toEqual(new Map([['uiTheme', 'eink']]));
});

it('keeps internal queries unqueued inside saveRemoteProgress and acceptRemoteProgress', async () => {
  const events: string[] = [];
  const { acceptRemoteProgress, markSyncFailure, saveRemoteProgress } = await import('./database');
  await openAndClearMocks();

  mocks.db.query.mockImplementation(async (statement: string) => {
    events.push(`query:${statement.includes('sync_queue') ? 'queue' : 'reading'}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return { values: [] as Record<string, unknown>[] };
  });
  mocks.executeTransaction.mockImplementation(async () => {
    events.push('transaction:start');
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push('transaction:end');
    return { changes: { changes: 1 } };
  });
  mocks.db.run.mockImplementation(async () => {
    events.push('run');
    return { changes: { changes: 1 } };
  });

  const remote = {
    libraryId: 1,
    seriesId: 1,
    volumeId: 10,
    chapterId: 10,
    pageNum: 50,
    bookScrollId: '/remote',
    lastModifiedUtc: '2026-01-02T00:00:00.000Z',
  };

  expect(await saveRemoteProgress(book, remote, null)).toBe(true);
  expect(events).toEqual(['query:reading', 'query:queue', 'transaction:start', 'transaction:end']);

  events.length = 0;
  await Promise.all([
    acceptRemoteProgress(book, remote, 1, readingState.localUpdatedAt),
    markSyncFailure(book.id, 'offline', 1, readingState.localUpdatedAt),
  ]);
  expect(events).toEqual(['transaction:start', 'transaction:end', 'query:reading', 'run']);
});

async function openAndClearMocks(): Promise<void> {
  const { openDatabase } = await import('./database');
  await openDatabase();
  vi.clearAllMocks();
}

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

  await markBookCompleted(book);
  await confirmSync(book.id, '2026-01-02T00:00:00.000Z', 1, readingState.localUpdatedAt);

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

  expect(mocks.executeTransaction).toHaveBeenCalledTimes(8);
  const migrationTasks = mocks.executeTransaction.mock.calls.map(([tasks]) => tasks);
  expect(migrationTasks.map((tasks) => tasks?.[0]?.statement)).toEqual([
    expect.stringContaining('CREATE TABLE IF NOT EXISTS server_config'),
    expect.stringContaining('ALTER TABLE books ADD COLUMN pages'),
    expect.stringContaining('CREATE TABLE preferences'),
    expect.stringContaining('ALTER TABLE books ADD COLUMN remote_available'),
    expect.stringContaining('CREATE INDEX IF NOT EXISTS books_server_title_idx'),
    expect.stringContaining('ALTER TABLE sync_queue ADD COLUMN revision'),
    expect.stringContaining('ALTER TABLE reading_state ADD COLUMN sync_revision'),
    expect.stringContaining('ALTER TABLE books ADD COLUMN remote_file_size'),
  ]);
  expect(migrationTasks.map((tasks) => tasks?.[1]?.statement)).toEqual([
    'PRAGMA user_version = 1;',
    'PRAGMA user_version = 2;',
    'PRAGMA user_version = 3;',
    'PRAGMA user_version = 4;',
    'PRAGMA user_version = 5;',
    'PRAGMA user_version = 6;',
    'PRAGMA user_version = 7;',
    'PRAGMA user_version = 8;',
  ]);
});

it('mirrors native SQLite theme and mode preferences to browser localStorage and clears on reset', async () => {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  vi.stubGlobal('window', { localStorage: mockStorage });
  try {
    const { resetLocalDatabase, setPreferences } = await import('./database');
    const { BOOT_THEME_STORAGE_KEY } = await import('../themes/themes');

    await setPreferences(
      new Map([
        ['uiTheme', 'eink'],
        ['uiMode', 'light'],
      ]),
    );

    expect(JSON.parse(store.get(BOOT_THEME_STORAGE_KEY) ?? '{}')).toEqual({
      theme: 'eink',
      mode: 'light',
      rootBgLight: 'oklch(1 0 0)',
      rootBgDark: 'oklch(0 0 0)',
      surfaceLight: 'oklch(1 0 0)',
      surfaceDark: 'oklch(0 0 0)',
    });

    await resetLocalDatabase();
    expect(store.has(BOOT_THEME_STORAGE_KEY)).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('reconciles missing #330 v8 columns on a #328-only v8 database without duplicating remote_file_size', async () => {
  const { openDatabase, resetLocalDatabase } = await import('./database');
  await resetLocalDatabase();
  mocks.setDatabaseVersion(8);
  mocks.executeTransaction.mockClear();
  mocks.db.query.mockResolvedValueOnce({
    values: [
      { kind: 'column', name: 'id' },
      { kind: 'column', name: 'file_id' },
      { kind: 'column', name: 'file_name' },
      { kind: 'column', name: 'remote_file_size' },
      { kind: 'column', name: 'chapter_epub_index' },
      { kind: 'column', name: 'multi_file_chapter' },
      { kind: 'column', name: 'sync_progress' },
      { kind: 'index', name: 'books_server_file_idx' },
    ],
  });

  await openDatabase();

  expect(mocks.executeTransaction).toHaveBeenCalledOnce();
  const [tasks] = mocks.executeTransaction.mock.calls[0] ?? [];
  expect(tasks).toHaveLength(1);
  const statement = tasks?.[0]?.statement ?? '';
  expect(statement).toContain('ALTER TABLE books ADD COLUMN downloaded_bytes INTEGER;');
  expect(statement).toContain('ALTER TABLE books ADD COLUMN downloaded_pages INTEGER;');
  expect(statement).toContain('ALTER TABLE books ADD COLUMN chapter_key TEXT;');
  expect(statement).not.toContain('remote_file_size');
  expect(statement).not.toContain('ADD COLUMN file_id');
  expect(JSON.stringify(tasks)).not.toContain('PRAGMA user_version');
});

it('reconciles missing #328 v8 columns and index on a #330-only database already at v10 without downgrading user_version', async () => {
  const { openDatabase, resetLocalDatabase } = await import('./database');
  await resetLocalDatabase();
  mocks.setDatabaseVersion(10);
  mocks.executeTransaction.mockClear();
  mocks.db.query.mockResolvedValueOnce({
    values: [
      { kind: 'column', name: 'id' },
      { kind: 'column', name: 'remote_file_size' },
      { kind: 'column', name: 'downloaded_bytes' },
      { kind: 'column', name: 'downloaded_pages' },
      { kind: 'column', name: 'chapter_key' },
      { kind: 'column', name: 'sort_order' },
      { kind: 'column', name: 'min_number' },
      { kind: 'column', name: 'volume_number' },
    ],
  });

  await openDatabase();

  expect(mocks.executeTransaction).toHaveBeenCalledOnce();
  const [tasks] = mocks.executeTransaction.mock.calls[0] ?? [];
  expect(tasks).toHaveLength(1);
  const statement = tasks?.[0]?.statement ?? '';
  expect(statement).toContain('ALTER TABLE books ADD COLUMN file_id INTEGER;');
  expect(statement).toContain('ALTER TABLE books ADD COLUMN file_name TEXT;');
  expect(statement).toContain(
    'ALTER TABLE books ADD COLUMN chapter_epub_index INTEGER NOT NULL DEFAULT 0;',
  );
  expect(statement).toContain(
    'ALTER TABLE books ADD COLUMN multi_file_chapter INTEGER NOT NULL DEFAULT 0;',
  );
  expect(statement).toContain(
    'ALTER TABLE books ADD COLUMN sync_progress INTEGER NOT NULL DEFAULT 1;',
  );
  expect(statement).toContain(
    'CREATE INDEX IF NOT EXISTS books_server_file_idx ON books(server_id, file_id);',
  );
  expect(statement).not.toContain('remote_file_size');
  expect(statement).not.toContain('downloaded_bytes');
  expect(JSON.stringify(tasks)).not.toContain('PRAGMA user_version');
});
