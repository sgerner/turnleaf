// @vitest-environment node

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { capTask } from '@capacitor-community/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDiagnostics, recordDiagnostic } from '../diagnostics/log';
import { parseReadingNotesBackup, serializeReadingNotesBackup } from '../reader/notes-backup';
import { BOOT_THEME_STORAGE_KEY, clearBootThemeCache } from '../themes/themes';

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
    execute: vi.fn(async (_sql = '') => ({ changes: { changes: 0 } })),
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

  it('serializes queued writes, WAL checkpoint, journal-mode revert, close, and native file deletion', async () => {
    const { openDatabase, resetLocalDatabase, setPreference } = await import('./database');
    mocks.setOpenShouldFail(false);
    await openDatabase();
    mocks.events.length = 0;

    let releaseWrite!: () => void;
    mocks.db.run.mockImplementationOnce(async () => {
      mocks.events.push('queuedWrite:start');
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      mocks.events.push('queuedWrite:done');
      return { changes: { changes: 1 } };
    });
    mocks.db.execute.mockImplementation(async (sql: string) => {
      mocks.events.push(`db.execute:${sql}`);
      return { changes: { changes: 0 } };
    });

    const writePromise = setPreference('uiTheme', 'vintage');
    await vi.waitFor(() => {
      expect(mocks.events).toContain('queuedWrite:start');
    });

    const resetPromise = resetLocalDatabase();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.events).toEqual(['queuedWrite:start']);

    releaseWrite();
    await Promise.all([writePromise, resetPromise]);

    expect(mocks.events).toEqual([
      'queuedWrite:start',
      'queuedWrite:done',
      'db.execute:PRAGMA wal_checkpoint(TRUNCATE);',
      'db.execute:PRAGMA journal_mode = DELETE;',
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
    mocks.db.execute.mockImplementation(async () => ({ changes: { changes: 0 } }));

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

    // Trigger multiple concurrent openDatabase() and saveServer() callers while native unlink is in progress.
    let concurrentOpenSettled = false;
    const concurrentOpenA = openDatabase().then((handle) => {
      concurrentOpenSettled = true;
      return handle;
    });
    const concurrentOpenB = openDatabase();
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
    await Promise.all([resetPromise, concurrentOpenA, concurrentOpenB, concurrentWrite]);

    expect(concurrentOpenSettled).toBe(true);
    expect(mocks.events).toEqual([
      'db.close',
      'CapacitorSQLite.closeConnection',
      'SqliteReset.deleteDatabase:start:turnleaf',
      'SqliteReset.deleteDatabase:done:turnleaf',
      'db.open',
    ]);
  });

  describe('real SQLite interleaving of writes with clear() and resetLocalDatabase()', () => {
    let tempDir = '';
    let sqlitePath = '';
    let activeSqlite: DatabaseSync | null = null;
    let sqliteRegistered = false;
    const storageMap = new Map<string, string>();
    const fakeLocalStorage = {
      clear: () => storageMap.clear(),
      getItem: (key: string) => storageMap.get(key) ?? null,
      key: (index: number) => [...storageMap.keys()][index] ?? null,
      get length() {
        return storageMap.size;
      },
      removeItem: (key: string) => {
        storageMap.delete(key);
      },
      setItem: (key: string, value: string) => {
        storageMap.set(key, value);
      },
    };

    function createSqliteFileAdapter() {
      const handle = {
        close: vi.fn(async () => {
          mocks.events.push('sqlite.close');
          activeSqlite?.close();
          activeSqlite = null;
          sqliteRegistered = false;
        }),
        execute: vi.fn(async (statement: string) => {
          activeSqlite?.exec(statement);
          return { changes: { changes: 0 } };
        }),
        executeTransaction: vi.fn(async (tasks: capTask[]) => {
          const database = activeSqlite;
          if (!database) throw new Error('SQLite handle is closed');
          database.exec('BEGIN');
          try {
            for (const task of tasks) {
              if (task.values?.length) {
                database.prepare(task.statement).run(...(task.values as SQLInputValue[]));
              } else {
                database.exec(task.statement);
              }
            }
            database.exec('COMMIT');
            return { changes: { changes: tasks.length } };
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          }
        }),
        getVersion: vi.fn(async () => {
          const row = activeSqlite?.prepare('PRAGMA user_version').get() as
            { user_version?: number } | undefined;
          return { version: Number(row?.user_version ?? 0) };
        }),
        open: vi.fn(async () => {
          mocks.events.push('sqlite.open');
          if (!activeSqlite) {
            activeSqlite = new DatabaseSync(sqlitePath);
            activeSqlite.exec('PRAGMA journal_mode = WAL;');
          }
          sqliteRegistered = true;
        }),
        query: vi.fn(async (statement: string, values: unknown[] = []) => {
          const rows = activeSqlite?.prepare(statement).all(...(values as SQLInputValue[])) as
            Record<string, unknown>[] | undefined;
          return { values: rows ?? [] };
        }),
        run: vi.fn(async (statement: string, values: unknown[] = []) => {
          const result = activeSqlite?.prepare(statement).run(...(values as SQLInputValue[]));
          return { changes: { changes: Number(result?.changes ?? 0) } };
        }),
      };
      return handle;
    }

    beforeEach(() => {
      vi.resetModules();
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { localStorage: fakeLocalStorage },
      });
      fakeLocalStorage.clear();
      tempDir = mkdtempSync(join(tmpdir(), 'turnleaf-sqlite-reset-'));
      sqlitePath = join(tempDir, 'turnleafSQLite.db');
      activeSqlite = null;
      sqliteRegistered = false;

      let currentAdapter = createSqliteFileAdapter();
      mocks.sqlite.isConnection.mockImplementation(async () => ({ result: sqliteRegistered }));
      mocks.sqlite.retrieveConnection.mockImplementation(async () => currentAdapter as never);
      mocks.sqlite.createConnection.mockImplementation(async () => {
        currentAdapter = createSqliteFileAdapter();
        return currentAdapter as never;
      });
      mocks.closeConnection.mockImplementation(async () => {
        mocks.events.push('CapacitorSQLite.closeConnection');
        if (activeSqlite) {
          activeSqlite.close();
          activeSqlite = null;
        }
        sqliteRegistered = false;
      });
      mocks.nativeUnlinkDatabase.mockImplementation(async ({ database }: { database?: string }) => {
        const target = database ?? 'turnleaf';
        mocks.events.push(`SqliteReset.deleteDatabase:${target}`);
        let deletedCount = 0;
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          const candidate = join(tempDir, `${target}SQLite.db${suffix}`);
          if (existsSync(candidate)) {
            rmSync(candidate, { force: true });
            deletedCount += 1;
          }
        }
        return { deletedCount };
      });
    });

    afterEach(() => {
      try {
        activeSqlite?.close();
      } catch {
        // Ignore already-closed test handles.
      }
      activeSqlite = null;
      Reflect.deleteProperty(globalThis, 'window');
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('interleaves writes with clear() and resetLocalDatabase() so no stale row survives and nothing post-reset is lost', async () => {
      const {
        getBooks,
        getPendingSync,
        getPreferencesByPrefix,
        getReadingState,
        getServer,
        reconcileBooks,
        removeServer,
        resetLocalDatabase,
        restoreReadingNotesBackup,
        saveLocalProgress,
        saveServer,
        setPreferences,
      } = await import('./database');

      const staleServer = {
        id: 'stale-server',
        displayName: 'Stale Kavita',
        baseUrl: 'https://stale.example.com',
        credentialRef: 'turnleaf_api_key_stale',
        kavitaVersion: '0.8.3',
        lastConnectedAt: '2026-03-01T00:00:00.000Z',
      };
      const staleBook = {
        id: 'stale-server:1:99',
        serverId: staleServer.id,
        libraryId: 1,
        seriesId: 1,
        volumeId: 99,
        chapterId: 99,
        title: 'Stale Book',
        author: 'Stale Author',
        series: null,
        descriptionHtml: null,
        format: 'epub',
        pages: 200,
        pagesRead: 0,
        createdAt: '2026-03-01T00:00:00.000Z',
        lastReadAt: null,
        downloadPath: null,
        downloadStatus: 'none',
        fileSize: null,
      };

      const freshServer = {
        id: 'fresh-server',
        displayName: 'Fresh Kavita',
        baseUrl: 'https://fresh.example.com',
        credentialRef: 'turnleaf_api_key_fresh',
        kavitaVersion: '0.8.4',
        lastConnectedAt: '2026-03-15T00:00:00.000Z',
      };
      const freshBook = {
        ...staleBook,
        id: 'fresh-server:2:10',
        serverId: freshServer.id,
        libraryId: 2,
        seriesId: 2,
        volumeId: 10,
        chapterId: 10,
        title: 'Fresh Book',
        author: 'Fresh Author',
        pages: 120,
      };

      await saveServer(staleServer);
      await reconcileBooks(staleServer.id, [staleBook]);
      await saveLocalProgress(staleBook, 'epubcfi(/6/2!/4/2:0)', '/stale/start', 0.25);
      await setPreferences(
        new Map([
          ['uiTheme', 'vintage'],
          [
            `readerBookmarks:${staleBook.id}`,
            JSON.stringify([
              {
                id: 'stale-bm',
                cfi: 'epubcfi(/6/2!/4/2:0)',
                href: 'ch1.xhtml',
                percentage: 0.25,
                label: 'Stale bookmark',
                savedAt: '2026-03-01T00:00:00.000Z',
              },
            ]),
          ],
        ]),
      );
      recordDiagnostic({
        category: 'startup',
        endpoint: 'local/database',
        detail: 'pre-reset-event',
      });
      expect(window.localStorage.getItem(BOOT_THEME_STORAGE_KEY)).toContain('vintage');

      const staleBackup = parseReadingNotesBackup(
        serializeReadingNotesBackup([
          {
            bookId: 'stale-server:1:100',
            title: 'Stale Backup Book',
            author: null,
            series: null,
            bookmarks: [
              {
                id: 'stale-backup-bm',
                cfi: 'epubcfi(/6/4!/4/2:0)',
                href: 'ch2.xhtml',
                percentage: 0.5,
                label: 'Stale restored bookmark',
                savedAt: '2026-03-02T00:00:00.000Z',
              },
            ],
            annotations: [],
          },
        ]),
      );
      const freshBackup = parseReadingNotesBackup(
        serializeReadingNotesBackup([
          {
            bookId: 'fresh-server:2:20',
            title: 'Fresh Restored Book',
            author: 'Fresh Author',
            series: 'Fresh Series',
            bookmarks: [
              {
                id: 'fresh-backup-bm',
                cfi: 'epubcfi(/6/8!/4/2:0)',
                href: 'ch4.xhtml',
                percentage: 0.8,
                label: 'Fresh restored bookmark',
                savedAt: '2026-03-16T00:00:00.000Z',
              },
            ],
            annotations: [
              {
                id: 'fresh-backup-note',
                cfi: 'epubcfi(/6/8!/4/4:0)',
                excerpt: 'Fresh excerpt',
                note: 'Fresh note',
                createdAt: '2026-03-16T00:00:00.000Z',
              },
            ],
          },
        ]),
      );

      let releaseUnlink!: () => void;
      const originalUnlink = mocks.nativeUnlinkDatabase.getMockImplementation()!;
      mocks.nativeUnlinkDatabase.mockImplementationOnce(async (args) => {
        await new Promise<void>((resolve) => {
          releaseUnlink = resolve;
        });
        return originalUnlink(args);
      });

      // Kick off pre-reset writes, clear() calls, and resetLocalDatabase() back-to-back.
      const staleProgressWrite = saveLocalProgress(
        staleBook,
        'epubcfi(/6/6!/4/2:0)',
        '/stale/late',
        0.9,
      );
      const stalePreferenceWrite = setPreferences(
        new Map([
          ['uiTheme', 'vintage'],
          [`readerAnnotations:${staleBook.id}`, '[{"id":"late-stale"}]'],
        ]),
      );
      const staleRestoreWrite = restoreReadingNotesBackup(staleBackup);
      const staleRemoveServer = removeServer(staleServer.id);

      window.localStorage.clear();
      clearBootThemeCache();
      const diagnosticsClear = clearDiagnostics();
      const resetTask = resetLocalDatabase();

      await vi.waitFor(() => {
        expect(releaseUnlink).toBeTypeOf('function');
      });

      // Interleave post-reset writes while native SQLite unlink is still in flight.
      const postServerWrite = saveServer(freshServer);
      const postBooksWrite = reconcileBooks(freshServer.id, [freshBook]);
      const postProgressWrite = saveLocalProgress(
        freshBook,
        'epubcfi(/6/10!/4/2:0)',
        '/fresh/pos',
        0.75,
      );
      const postPreferenceWrite = setPreferences(
        new Map([
          ['uiTheme', 'fennec'],
          [
            `readerBookmarks:${freshBook.id}`,
            JSON.stringify([
              {
                id: 'fresh-live-bm',
                cfi: 'epubcfi(/6/10!/4/2:0)',
                href: 'ch5.xhtml',
                percentage: 0.75,
                label: 'Fresh live bookmark',
                savedAt: '2026-03-16T01:00:00.000Z',
              },
            ]),
          ],
        ]),
      );
      const postRestoreWrite = restoreReadingNotesBackup(freshBackup);

      releaseUnlink();
      await Promise.all([
        staleProgressWrite,
        stalePreferenceWrite,
        staleRestoreWrite,
        staleRemoveServer,
        diagnosticsClear,
        resetTask,
        postServerWrite,
        postBooksWrite,
        postProgressWrite,
        postPreferenceWrite,
        postRestoreWrite,
      ]);

      // Verify via database APIs: zero stale rows survived, and every post-reset write persisted.
      await expect(getServer()).resolves.toEqual(freshServer);
      await expect(getBooks(staleServer.id)).resolves.toEqual([]);
      const persistedBooks = await getBooks(freshServer.id);
      expect(persistedBooks).toHaveLength(1);
      expect(persistedBooks[0]).toMatchObject({
        id: freshBook.id,
        pagesRead: 90,
      });

      await expect(getReadingState(staleBook.id)).resolves.toBeNull();
      await expect(getReadingState(freshBook.id)).resolves.toMatchObject({
        cfi: 'epubcfi(/6/10!/4/2:0)',
        xpath: '/fresh/pos',
        percentage: 0.75,
        pendingSync: true,
      });
      await expect(getPendingSync(staleServer.id)).resolves.toEqual([]);
      const pendingSync = await getPendingSync(freshServer.id);
      expect(pendingSync).toHaveLength(1);
      expect(pendingSync[0]?.bookId).toBe(freshBook.id);

      const notePrefs = await getPreferencesByPrefix([
        'readerBookmarks:',
        'readerAnnotations:',
        'readerNoteMeta:',
      ]);
      expect([...notePrefs.keys()].some((key) => key.includes('stale-server'))).toBe(false);
      expect(notePrefs.get(`readerBookmarks:${freshBook.id}`)).toContain('Fresh live bookmark');
      expect(notePrefs.get('readerBookmarks:fresh-server:2:20')).toContain(
        'Fresh restored bookmark',
      );
      expect(notePrefs.get('readerAnnotations:fresh-server:2:20')).toContain('Fresh note');
      expect(window.localStorage.getItem(BOOT_THEME_STORAGE_KEY)).toContain('fennec');

      // Reopen the SQLite file directly from disk to prove on-disk persistence and absence of stale rows.
      activeSqlite?.close();
      activeSqlite = null;
      const diskInspector = new DatabaseSync(sqlitePath);
      try {
        const serversOnDisk = diskInspector.prepare('SELECT id FROM server_config').all();
        expect(serversOnDisk).toEqual([{ id: freshServer.id }]);
        const booksOnDisk = diskInspector.prepare('SELECT id, pages_read FROM books').all();
        expect(booksOnDisk).toEqual([{ id: freshBook.id, pages_read: 90 }]);
        const stalePrefsOnDisk = diskInspector
          .prepare("SELECT key FROM preferences WHERE key LIKE '%stale-server%'")
          .all();
        expect(stalePrefsOnDisk).toEqual([]);
      } finally {
        diskInspector.close();
      }
    });
  });
});
