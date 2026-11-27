import { beforeEach, expect, it, vi } from 'vitest';
import type { capSQLiteChanges, capTask } from '@capacitor-community/sqlite';

const mocks = vi.hoisted(() => {
  let databaseVersion = 7;
  let nativePlatform = true;
  const deleteDatabase = vi.fn(async () => undefined);
  const executeTransaction = vi.fn<(tasks: capTask[]) => Promise<capSQLiteChanges>>(async () => ({
    changes: { changes: 0 },
  }));
  const db = {
    close: vi.fn(async () => undefined),
    execute: vi.fn<(statements: string, transaction?: boolean) => Promise<capSQLiteChanges>>(
      async () => ({ changes: { changes: 0 } }),
    ),
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
    deleteDatabase,
    executeTransaction,
    isNativePlatform: () => nativePlatform,
    reset() {
      databaseVersion = 7;
      nativePlatform = true;
      vi.clearAllMocks();
      deleteDatabase.mockImplementation(async () => undefined);
      executeTransaction.mockImplementation(async () => ({ changes: { changes: 0 } }));
      db.close.mockImplementation(async () => undefined);
      db.execute.mockImplementation(async () => ({ changes: { changes: 0 } }));
      db.getVersion.mockImplementation(async () => ({ version: databaseVersion }));
      db.open.mockImplementation(async () => undefined);
      db.query.mockImplementation(async () => ({ values: [] }));
      db.run.mockImplementation(async () => ({ changes: { changes: 1 } }));
      sqlite.checkConnectionsConsistency.mockImplementation(async () => ({ result: true }));
      sqlite.createConnection.mockImplementation(async () => db);
      sqlite.isConnection.mockImplementation(async () => ({ result: false }));
    },
    setDatabaseVersion(version: number) {
      databaseVersion = version;
    },
    setNativePlatform(value: boolean) {
      nativePlatform = value;
    },
    sqlite,
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mocks.isNativePlatform(),
  },
}));

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {
    deleteDatabase: mocks.deleteDatabase,
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

beforeEach(() => {
  mocks.reset();
});

it('reads several preferences with one native query', async () => {
  const { getPreferences, openDatabase } = await import('./database');
  await openDatabase();
  mocks.db.query.mockClear();
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

  expect(mocks.executeTransaction).toHaveBeenCalledTimes(7);
  const migrationTasks = mocks.executeTransaction.mock.calls.map(([tasks]) => tasks);
  expect(migrationTasks.map((tasks) => tasks?.[0]?.statement)).toEqual([
    expect.stringContaining('CREATE TABLE IF NOT EXISTS server_config'),
    expect.stringContaining('ALTER TABLE books ADD COLUMN pages'),
    expect.stringContaining('CREATE TABLE preferences'),
    expect.stringContaining('ALTER TABLE books ADD COLUMN remote_available'),
    expect.stringContaining('CREATE INDEX IF NOT EXISTS books_server_title_idx'),
    expect.stringContaining('ALTER TABLE sync_queue ADD COLUMN revision'),
    expect.stringContaining('ALTER TABLE reading_state ADD COLUMN sync_revision'),
  ]);
  expect(migrationTasks.map((tasks) => tasks?.[1]?.statement)).toEqual([
    'PRAGMA user_version = 1;',
    'PRAGMA user_version = 2;',
    'PRAGMA user_version = 3;',
    'PRAGMA user_version = 4;',
    'PRAGMA user_version = 5;',
    'PRAGMA user_version = 6;',
    'PRAGMA user_version = 7;',
  ]);
});

function createGate() {
  let markEntered!: () => void;
  let release!: () => void;
  let fail!: (error: Error) => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { entered, fail, gate, markEntered, release };
}

function stubMemoryStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => void store.delete(key),
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
  return store;
}

it('configures WAL, synchronous mode, foreign keys, and busy timeout outside transactions before migrations', async () => {
  const { openDatabase, resetLocalDatabase } = await import('./database');
  await resetLocalDatabase();
  mocks.reset();
  mocks.setDatabaseVersion(0);

  const events: string[] = [];
  mocks.db.open.mockImplementationOnce(async () => void events.push('open'));
  mocks.db.query.mockImplementation(async (statement: string) => {
    events.push(`query:${statement}`);
    return { values: [] };
  });
  mocks.db.execute.mockImplementation(async (statement: string, transaction?: boolean) => {
    events.push(`execute:${String(transaction)}:${statement}`);
    return { changes: { changes: 0 } };
  });
  mocks.db.getVersion.mockImplementationOnce(async () => {
    events.push('getVersion');
    return { version: 0 };
  });
  mocks.executeTransaction.mockImplementationOnce(async () => {
    events.push('migrate:1');
    return { changes: { changes: 0 } };
  });

  await openDatabase();

  expect(mocks.db.query.mock.calls).toEqual([
    ['PRAGMA journal_mode = WAL;'],
    ['PRAGMA busy_timeout = 5000;'],
  ]);
  expect(mocks.db.execute.mock.calls).toEqual([
    ['PRAGMA synchronous = NORMAL;', false],
    ['PRAGMA foreign_keys = ON;', false],
  ]);
  expect(events.slice(0, 7)).toEqual([
    'open',
    'query:PRAGMA journal_mode = WAL;',
    'execute:false:PRAGMA synchronous = NORMAL;',
    'execute:false:PRAGMA foreign_keys = ON;',
    'query:PRAGMA busy_timeout = 5000;',
    'getVersion',
    'migrate:1',
  ]);
});

it('drains queued writes and reverts WAL mode before closing and deleting on reset, even when cleanup queries fail', async () => {
  const { openDatabase, resetLocalDatabase, saveLocalProgress } = await import('./database');
  await openDatabase();
  mocks.reset();

  const events: string[] = [];
  const write = createGate();
  mocks.executeTransaction.mockImplementationOnce(async () => {
    events.push('write:start');
    write.markEntered();
    await write.gate;
    events.push('write:done');
    return { changes: { changes: 3 } };
  });
  mocks.db.query.mockImplementation(async (statement: string) => {
    events.push(`query:${statement}`);
    return { values: [] };
  });
  mocks.db.close.mockImplementationOnce(async () => void events.push('close'));
  mocks.deleteDatabase.mockImplementationOnce(async () => void events.push('deleteDatabase'));

  const pendingWrite = saveLocalProgress(book, readingState.cfi, readingState.xpath, 0.4);
  await write.entered;
  const resetting = resetLocalDatabase();
  await Promise.resolve();
  expect(events).toEqual(['write:start']);

  write.release();
  await Promise.all([pendingWrite, resetting]);

  expect(events).toEqual([
    'write:start',
    'write:done',
    'query:PRAGMA wal_checkpoint(TRUNCATE);',
    'query:PRAGMA journal_mode = DELETE;',
    'close',
    'deleteDatabase',
  ]);
  expect(mocks.deleteDatabase).toHaveBeenCalledExactlyOnceWith({
    database: 'turnleaf',
    readonly: false,
  });

  await openDatabase();
  mocks.reset();
  mocks.db.query.mockRejectedValue(new Error('database disk image is malformed'));
  await expect(resetLocalDatabase()).resolves.toBeUndefined();
  expect(mocks.db.query.mock.calls).toEqual([
    ['PRAGMA wal_checkpoint(TRUNCATE);'],
    ['PRAGMA journal_mode = DELETE;'],
  ]);
  expect(mocks.db.close).toHaveBeenCalledOnce();
  expect(mocks.deleteDatabase).toHaveBeenCalledOnce();
});

it('mirrors native SQLite theme and mode preferences to browser localStorage and clears on reset', async () => {
  const store = stubMemoryStorage();
  try {
    const { resetLocalDatabase, setPreferences } = await import('./database');
    const { BOOT_THEME_STORAGE_KEY } = await import('../themes/themes');

    await setPreferences(
      new Map([
        ['uiTheme', 'eink'],
        ['uiMode', 'light'],
      ]),
    );
    expect(JSON.parse(store.get(BOOT_THEME_STORAGE_KEY) ?? '{}')).toMatchObject({
      theme: 'eink',
      mode: 'light',
    });

    await resetLocalDatabase();
    expect(store.has(BOOT_THEME_STORAGE_KEY)).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('gates concurrent openDatabase, reads, and writes until resetLocalDatabase finishes deleting', async () => {
  const { getPreferences, openDatabase, resetLocalDatabase, saveLocalProgress } =
    await import('./database');
  await openDatabase();
  mocks.reset();
  mocks.setDatabaseVersion(6);

  const events: string[] = [];
  const checkpoint = createGate();
  const deleting = createGate();

  mocks.sqlite.createConnection.mockImplementation(async () => {
    events.push('createConnection');
    return mocks.db;
  });
  mocks.db.open.mockImplementation(async () => void events.push('open'));
  mocks.db.query.mockImplementation(async (statement: string) => {
    events.push(`query:${statement}`);
    if (statement === 'PRAGMA wal_checkpoint(TRUNCATE);') {
      checkpoint.markEntered();
      await checkpoint.gate;
    }
    if (statement.startsWith('SELECT key, value FROM preferences')) {
      return { values: [{ key: 'uiTheme', value: 'eink' }] };
    }
    return { values: [] };
  });
  mocks.db.execute.mockImplementation(async (statement: string, transaction?: boolean) => {
    events.push(`execute:${String(transaction)}:${statement}`);
    return { changes: { changes: 0 } };
  });
  mocks.db.getVersion.mockImplementation(async () => {
    events.push('getVersion');
    return { version: 6 };
  });
  mocks.executeTransaction.mockImplementation(async (tasks: capTask[]) => {
    events.push(tasks[0]?.statement.startsWith('INSERT INTO reading_state') ? 'write' : 'migrate');
    return { changes: { changes: tasks.length } };
  });
  mocks.db.close.mockImplementationOnce(async () => void events.push('close'));
  mocks.deleteDatabase.mockImplementationOnce(async () => {
    events.push('deleteDatabase:start');
    deleting.markEntered();
    await deleting.gate;
    events.push('deleteDatabase:done');
  });

  const resetting = resetLocalDatabase();
  await checkpoint.entered;

  const reopenedWhileCheckpointing = openDatabase();
  const savedWhileCheckpointing = saveLocalProgress(
    book,
    readingState.cfi,
    readingState.xpath,
    0.5,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(events).toEqual(['query:PRAGMA wal_checkpoint(TRUNCATE);']);

  checkpoint.release();
  await deleting.entered;

  const readWhileDeleting = getPreferences(['uiTheme']);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(mocks.db.open).not.toHaveBeenCalled();
  expect(events).toEqual([
    'query:PRAGMA wal_checkpoint(TRUNCATE);',
    'query:PRAGMA journal_mode = DELETE;',
    'close',
    'deleteDatabase:start',
  ]);

  deleting.release();
  const [, , prefs] = await Promise.all([
    resetting,
    Promise.all([reopenedWhileCheckpointing, savedWhileCheckpointing]),
    readWhileDeleting,
  ]);

  expect(prefs.get('uiTheme')).toBe('eink');
  expect(events.slice(4)).toEqual([
    'deleteDatabase:done',
    'createConnection',
    'open',
    'query:PRAGMA journal_mode = WAL;',
    'execute:false:PRAGMA synchronous = NORMAL;',
    'execute:false:PRAGMA foreign_keys = ON;',
    'query:PRAGMA busy_timeout = 5000;',
    'getVersion',
    'migrate',
    'write',
    'query:SELECT key, value FROM preferences WHERE key IN (?)',
  ]);
});

it('cleans up partially opened connections and avoids returning deleted handles across reset', async () => {
  const { openDatabase, resetLocalDatabase } = await import('./database');
  await resetLocalDatabase();
  mocks.reset();

  // Case 1: Startup PRAGMA rejects after db.open(); reset cleans up partial handle while gating a second open.
  const pragmaEvents: string[] = [];
  const pragmaDelete = createGate();
  mocks.db.open.mockImplementation(async () => void pragmaEvents.push('open'));
  mocks.db.query.mockImplementation(async (statement: string) => {
    pragmaEvents.push(`query:${statement}`);
    return { values: [] };
  });
  mocks.db.execute
    .mockImplementationOnce(async (statement: string) => {
      pragmaEvents.push(`execute:fail:${statement}`);
      throw new Error('pragma synchronous failed');
    })
    .mockImplementation(async (statement: string) => {
      pragmaEvents.push(`execute:${statement}`);
      return { changes: { changes: 0 } };
    });
  mocks.db.close.mockImplementationOnce(async () => void pragmaEvents.push('close'));
  mocks.deleteDatabase.mockImplementationOnce(async () => {
    pragmaEvents.push('deleteDatabase:start');
    pragmaDelete.markEntered();
    await pragmaDelete.gate;
    pragmaEvents.push('deleteDatabase:done');
  });

  await expect(openDatabase()).rejects.toThrow('pragma synchronous failed');
  const pragmaReset = resetLocalDatabase();
  await pragmaDelete.entered;
  const secondOpen = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(pragmaEvents.slice(-4)).toEqual([
    'query:PRAGMA wal_checkpoint(TRUNCATE);',
    'query:PRAGMA journal_mode = DELETE;',
    'close',
    'deleteDatabase:start',
  ]);
  pragmaDelete.release();
  await Promise.all([pragmaReset, secondOpen]);
  expect(pragmaEvents.slice(7)).toEqual([
    'deleteDatabase:done',
    'open',
    'query:PRAGMA journal_mode = WAL;',
    'execute:PRAGMA synchronous = NORMAL;',
    'execute:PRAGMA foreign_keys = ON;',
    'query:PRAGMA busy_timeout = 5000;',
  ]);

  // Case 2: Migration setup rejects while resetLocalDatabase() and a concurrent openDatabase() wait.
  await resetLocalDatabase();
  mocks.reset();
  mocks.setDatabaseVersion(6);

  const migrateEvents: string[] = [];
  const migration = createGate();
  const migrateDelete = createGate();
  mocks.db.open.mockImplementation(async () => void migrateEvents.push('open'));
  mocks.db.query.mockImplementation(async (statement: string) => {
    migrateEvents.push(`query:${statement}`);
    return { values: [] };
  });
  mocks.db.execute.mockImplementation(async (statement: string) => {
    migrateEvents.push(`execute:${statement}`);
    return { changes: { changes: 0 } };
  });
  mocks.executeTransaction
    .mockImplementationOnce(async () => {
      migrateEvents.push('migrate:fail:start');
      migration.markEntered();
      await migration.gate;
      return { changes: { changes: 0 } };
    })
    .mockImplementation(async () => {
      migrateEvents.push('migrate:ok');
      return { changes: { changes: 2 } };
    });
  mocks.db.close.mockImplementationOnce(async () => void migrateEvents.push('close'));
  mocks.deleteDatabase.mockImplementationOnce(async () => {
    migrateEvents.push('deleteDatabase:start');
    migrateDelete.markEntered();
    await migrateDelete.gate;
    migrateEvents.push('deleteDatabase:done');
  });

  const failingOpen = openDatabase();
  await migration.entered;
  const concurrentReset = resetLocalDatabase();
  const gatedOpen = openDatabase();
  migration.fail(new Error('migration 7 failed'));
  await expect(failingOpen).rejects.toThrow('migration 7 failed');
  await migrateDelete.entered;
  expect(migrateEvents.slice(-2)).toEqual(['close', 'deleteDatabase:start']);
  migrateDelete.release();
  await Promise.all([concurrentReset, gatedOpen]);
  expect(migrateEvents.slice(-2)).toEqual(['query:PRAGMA busy_timeout = 5000;', 'migrate:ok']);

  // Case 3: In-flight openDatabase() that resolves as reset begins reopens instead of returning deleted handle.
  await resetLocalDatabase();
  mocks.reset();
  const firstVersion = createGate();
  const handleDelete = createGate();
  const makeDb = (onVersion?: () => Promise<void>) => ({
    ...mocks.db,
    close: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ changes: { changes: 0 } })),
    executeTransaction: vi.fn(async (tasks: capTask[]) => ({ changes: { changes: tasks.length } })),
    getVersion: vi.fn(async () => {
      await onVersion?.();
      return { version: 7 };
    }),
    open: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ values: [] })),
    run: vi.fn(async () => ({ changes: { changes: 1 } })),
  });
  const firstDb = makeDb(async () => {
    firstVersion.markEntered();
    await firstVersion.gate;
  });
  const secondDb = makeDb();
  mocks.deleteDatabase.mockImplementationOnce(async () => {
    handleDelete.markEntered();
    await handleDelete.gate;
  });
  mocks.sqlite.createConnection.mockResolvedValueOnce(firstDb).mockResolvedValueOnce(secondDb);

  const inFlightOpen = openDatabase();
  await firstVersion.entered;
  const handleReset = resetLocalDatabase();
  firstVersion.release();
  await handleDelete.entered;
  expect(firstDb.close).toHaveBeenCalledOnce();
  expect(secondDb.open).not.toHaveBeenCalled();
  handleDelete.release();
  const [, resolvedDb] = await Promise.all([handleReset, inFlightOpen]);
  expect(resolvedDb).toBe(secondDb);
});

it('drops superseded pre-reset writes and orphan post-clear progress while preserving post-reset writes', async () => {
  const store = stubMemoryStorage();
  try {
    const dbModule = await import('./database');
    const { BOOT_THEME_STORAGE_KEY, clearBootThemeCache } = await import('../themes/themes');
    await dbModule.resetLocalDatabase();
    mocks.reset();

    const firstOpen = createGate();
    const firstDelete = createGate();
    const makeConn = (pauseOpen?: boolean) => ({
      ...mocks.db,
      close: vi.fn(async () => undefined),
      execute: vi.fn(async () => ({ changes: { changes: 0 } })),
      executeTransaction: vi.fn(async (tasks: capTask[]) => ({
        changes: { changes: tasks.length },
      })),
      getVersion: vi.fn(async () => {
        if (pauseOpen) {
          firstOpen.markEntered();
          await firstOpen.gate;
        }
        return { version: 7 };
      }),
      open: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ values: [] })),
      run: vi.fn(async (_statement: string, _values?: unknown[]) => ({
        changes: { changes: 1 },
      })),
    });
    const preResetDb = makeConn(true);
    const postResetDb = makeConn(false);
    mocks.sqlite.createConnection
      .mockResolvedValueOnce(preResetDb)
      .mockResolvedValueOnce(postResetDb);
    mocks.deleteDatabase.mockImplementationOnce(async () => {
      firstDelete.markEntered();
      await firstDelete.gate;
    });

    const staleServer = {
      id: 'stale-server',
      displayName: 'Stale',
      baseUrl: 'https://stale.example.com',
      credentialRef: 'cred-stale',
      kavitaVersion: null,
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    };
    const freshServer = { ...staleServer, id: 'fresh-server', displayName: 'Fresh' };
    const freshBook = { ...book, id: 'fresh-server:1:10', serverId: freshServer.id };

    const staleOps = Promise.all([
      dbModule.saveServer(staleServer),
      dbModule.saveLocalProgress(book, 'stale-cfi', '/stale', 0.4),
      dbModule.setPreferences(new Map([['uiTheme', 'eink']])),
    ]);
    await firstOpen.entered;

    const resetAndFreshOps = Promise.all([
      dbModule.resetLocalDatabase(),
      dbModule.saveServer(freshServer),
      dbModule.reconcileBooks(freshServer.id, [freshBook]),
      dbModule.saveLocalProgress(freshBook, 'fresh-cfi', '/fresh', 0.6),
    ]);
    firstOpen.release();
    await firstDelete.entered;
    firstDelete.release();
    await Promise.all([staleOps, resetAndFreshOps]);

    expect(store.has(BOOT_THEME_STORAGE_KEY)).toBe(false);
    expect(postResetDb.run).toHaveBeenCalledOnce();
    expect(postResetDb.run.mock.calls[0]?.[1]?.[0]).toBe('fresh-server');
    expect(JSON.stringify(postResetDb.executeTransaction.mock.calls)).not.toContain('stale-cfi');
    expect(JSON.stringify(postResetDb.executeTransaction.mock.calls)).toContain('fresh-cfi');

    // Browser storage path: interleaving progress writes with clear() / removeServer / reset leaves no orphan rows.
    mocks.setNativePlatform(false);
    const staleBook = { ...book, serverId: staleServer.id };
    await dbModule.saveServer(staleServer);
    await dbModule.reconcileBooks(staleServer.id, [staleBook]);
    await dbModule.saveLocalProgress(staleBook, 'stale-cfi', '/stale', 0.3);
    await dbModule.setPreferences(new Map([['uiTheme', 'eink']]));

    await dbModule.removeServer(staleServer.id);
    clearBootThemeCache();
    await dbModule.saveLocalProgress(staleBook, 'orphan-cfi', '/orphan', 0.8);
    await dbModule.markBookCompleted(staleBook);
    expect(await dbModule.getReadingState(book.id)).toBeNull();
    expect(await dbModule.getPendingSync(staleServer.id)).toEqual([]);
    expect(store.has(BOOT_THEME_STORAGE_KEY)).toBe(false);

    window.localStorage.clear();
    await dbModule.saveLocalProgress(staleBook, 'after-clear', '/clear', 0.5);
    await dbModule.saveServer(freshServer);
    await dbModule.reconcileBooks(freshServer.id, [freshBook]);
    await dbModule.saveLocalProgress(freshBook, 'kept-cfi', '/kept', 0.7);
    expect(await dbModule.getReadingState(book.id)).toBeNull();
    expect(await dbModule.getReadingState(freshBook.id)).toMatchObject({ cfi: 'kept-cfi' });

    await dbModule.resetLocalDatabase();
    expect(await dbModule.getServer()).toBeNull();
    expect(await dbModule.getReadingState(freshBook.id)).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
