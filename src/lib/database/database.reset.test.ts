import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  const dataFiles = new Map<string, string>([
    ['books/primary-1-10.epub', 'PK\x03\x04epub-bytes'],
    ['turnleafSQLite.db', 'corrupt-sqlite-header'],
    ['turnleafSQLite.db-wal', 'corrupt-wal'],
  ]);
  let openShouldFail = true;

  const db = {
    close: vi.fn(async () => {
      events.push('db.close');
    }),
    execute: vi.fn(async () => ({ changes: { changes: 0 } })),
    executeTransaction: vi.fn(async () => ({ changes: { changes: 0 } })),
    getVersion: vi.fn(async () => ({ version: 7 })),
    open: vi.fn(async () => {
      events.push('db.open');
      if (openShouldFail) {
        throw new Error('SQLiteDiskIOException: file is not a database (code 26)');
      }
    }),
    query: vi.fn(async () => ({ values: [] as Record<string, unknown>[] })),
    run: vi.fn(async () => ({ changes: { changes: 1 } })),
  };

  const sqlite = {
    checkConnectionsConsistency: vi.fn(async () => ({ result: true })),
    createConnection: vi.fn(async () => db),
    isConnection: vi.fn(async () => ({ result: false })),
    retrieveConnection: vi.fn(async () => db),
  };

  const closeConnection = vi.fn(async () => {
    events.push('CapacitorSQLite.closeConnection');
  });

  const legacyDeleteDatabase = vi.fn(async () => {
    events.push('CapacitorSQLite.deleteDatabase');
    throw new Error('Legacy deleteDatabase attempted open() on corrupt file');
  });

  const nativeUnlinkDatabase = vi.fn(async ({ database }: { database?: string }) => {
    events.push(`SqliteReset.deleteDatabase:${database ?? 'turnleaf'}`);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      dataFiles.delete(`${database ?? 'turnleaf'}SQLite.db${suffix}`);
    }
    return { deletedCount: 2 };
  });

  return {
    closeConnection,
    dataFiles,
    db,
    events,
    legacyDeleteDatabase,
    nativeUnlinkDatabase,
    reset() {
      events.length = 0;
      dataFiles.clear();
      dataFiles.set('books/primary-1-10.epub', 'PK\x03\x04epub-bytes');
      dataFiles.set('turnleafSQLite.db', 'corrupt-sqlite-header');
      dataFiles.set('turnleafSQLite.db-wal', 'corrupt-wal');
      openShouldFail = true;
      vi.clearAllMocks();
    },
    setOpenShouldFail(next: boolean) {
      openShouldFail = next;
    },
    sqlite,
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
  registerPlugin: () => ({
    deleteDatabase: mocks.nativeUnlinkDatabase,
  }),
}));

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {
    closeConnection: mocks.closeConnection,
    deleteDatabase: mocks.legacyDeleteDatabase,
  },
  SQLiteConnection: class {
    constructor() {
      return mocks.sqlite;
    }
  },
}));

beforeEach(() => {
  mocks.reset();
});

describe('native SQLite reset without opening corrupt database files', () => {
  it('deletes corrupt SQLite files via SqliteReset without calling open() and preserves downloaded EPUBs', async () => {
    const { openDatabase, resetLocalDatabase } = await import('./database');

    await expect(openDatabase()).rejects.toThrow('file is not a database');
    mocks.events.length = 0;
    mocks.db.open.mockClear();

    await resetLocalDatabase();

    expect(mocks.db.open).not.toHaveBeenCalled();
    expect(mocks.legacyDeleteDatabase).not.toHaveBeenCalled();
    expect(mocks.nativeUnlinkDatabase).toHaveBeenCalledExactlyOnceWith({ database: 'turnleaf' });
    expect(mocks.events).toEqual([
      'CapacitorSQLite.closeConnection',
      'SqliteReset.deleteDatabase:turnleaf',
    ]);
    expect(mocks.dataFiles.has('turnleafSQLite.db')).toBe(false);
    expect(mocks.dataFiles.has('turnleafSQLite.db-wal')).toBe(false);
    expect(mocks.dataFiles.get('books/primary-1-10.epub')).toBe('PK\x03\x04epub-bytes');

    mocks.setOpenShouldFail(false);
    await expect(openDatabase()).resolves.toBe(mocks.db);
  });

  it('closes an active SQLite handle before invoking native file deletion', async () => {
    const { openDatabase, resetLocalDatabase } = await import('./database');
    mocks.setOpenShouldFail(false);
    await openDatabase();
    mocks.events.length = 0;

    await resetLocalDatabase();

    expect(mocks.events).toEqual([
      'db.close',
      'CapacitorSQLite.closeConnection',
      'SqliteReset.deleteDatabase:turnleaf',
    ]);
  });

  it('blocks concurrent openDatabase and writes until native deletion finishes', async () => {
    const { openDatabase, resetLocalDatabase, saveServer } = await import('./database');
    mocks.setOpenShouldFail(false);
    await openDatabase();
    mocks.events.length = 0;
    mocks.sqlite.createConnection.mockClear();
    mocks.sqlite.retrieveConnection.mockClear();
    mocks.db.open.mockClear();

    let finishUnlink!: () => void;
    mocks.nativeUnlinkDatabase.mockImplementationOnce(
      async ({ database }: { database?: string }) => {
        mocks.events.push(`SqliteReset.deleteDatabase:start:${database ?? 'turnleaf'}`);
        await new Promise<void>((resolve) => {
          finishUnlink = resolve;
        });
        mocks.events.push(`SqliteReset.deleteDatabase:done:${database ?? 'turnleaf'}`);
        return { deletedCount: 1 };
      },
    );

    const resetPromise = resetLocalDatabase();
    await vi.waitFor(() => {
      expect(mocks.events).toContain('SqliteReset.deleteDatabase:start:turnleaf');
    });

    // Trigger concurrent openDatabase() and saveServer() while native unlink is in progress.
    let concurrentOpenSettled = false;
    const concurrentOpen = openDatabase().then((handle) => {
      concurrentOpenSettled = true;
      return handle;
    });
    const concurrentWrite = saveServer({
      id: 'primary',
      displayName: 'Home Kavita',
      baseUrl: 'https://books.example.com',
      credentialRef: 'turnleaf_api_key_primary',
      kavitaVersion: '0.8.4',
      lastConnectedAt: '2026-03-10T00:00:00.000Z',
    });

    await new Promise((resolve) => setTimeout(resolve, 15));

    // No connection creation, retrieval, or db.open() may occur before native deletion completes.
    expect(concurrentOpenSettled).toBe(false);
    expect(mocks.sqlite.createConnection).not.toHaveBeenCalled();
    expect(mocks.sqlite.retrieveConnection).not.toHaveBeenCalled();
    expect(mocks.db.open).not.toHaveBeenCalled();

    finishUnlink();
    await Promise.all([resetPromise, concurrentOpen, concurrentWrite]);

    expect(concurrentOpenSettled).toBe(true);
    expect(mocks.events).toEqual([
      'db.close',
      'CapacitorSQLite.closeConnection',
      'SqliteReset.deleteDatabase:start:turnleaf',
      'SqliteReset.deleteDatabase:done:turnleaf',
      'db.open',
    ]);
  });
});
