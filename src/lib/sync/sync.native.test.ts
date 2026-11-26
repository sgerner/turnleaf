// @vitest-environment node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import type { capTask } from '@capacitor-community/sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const nativeEnv = vi.hoisted(() => ({
  rootDir: '',
  databasePath: '',
  dataDir: '',
  database: null as DatabaseSync | null,
  isOpen: false,
  failConfirmSyncOnce: false,
  httpRequest: vi.fn(),
  createAdapter: null as (() => unknown) | null,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
  CapacitorHttp: {
    request: (...args: unknown[]) => nativeEnv.httpRequest(...args),
    get: vi.fn(),
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    Data: 'DATA',
  },
  Encoding: {
    UTF8: 'utf8',
  },
  Filesystem: {
    mkdir: vi.fn(async ({ path, recursive }: { path: string; recursive?: boolean }) => {
      mkdirSync(join(nativeEnv.dataDir, path), { recursive: Boolean(recursive) });
    }),
    readFile: vi.fn(async ({ path }: { path: string }) => {
      const target = join(nativeEnv.dataDir, path);
      if (!existsSync(target)) {
        throw new Error('File does not exist');
      }
      return { data: readFileSync(target, 'utf8') };
    }),
    writeFile: vi.fn(async ({ path, data }: { path: string; data: string }) => {
      const target = join(nativeEnv.dataDir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data, 'utf8');
      return { uri: target };
    }),
    deleteFile: vi.fn(async ({ path }: { path: string }) => {
      const target = join(nativeEnv.dataDir, path);
      if (!existsSync(target)) {
        throw new Error('File does not exist');
      }
      rmSync(target, { force: true });
    }),
  },
}));

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {
    deleteDatabase: async () => {
      if (nativeEnv.database) nativeEnv.database.close();
      nativeEnv.database = null;
      nativeEnv.isOpen = false;
      rmSync(nativeEnv.databasePath, { force: true });
    },
  },
  SQLiteConnection: class {
    async checkConnectionsConsistency(): Promise<{ result: boolean }> {
      return { result: true };
    }

    async isConnection(): Promise<{ result: boolean }> {
      return { result: nativeEnv.isOpen };
    }

    async retrieveConnection(): Promise<unknown> {
      return nativeEnv.createAdapter?.();
    }

    async createConnection(): Promise<unknown> {
      return nativeEnv.createAdapter?.();
    }
  },
}));

function createSqliteAdapter() {
  return {
    async open(): Promise<void> {
      if (!nativeEnv.database) nativeEnv.database = new DatabaseSync(nativeEnv.databasePath);
      nativeEnv.isOpen = true;
    },
    async close(): Promise<void> {
      if (nativeEnv.database) nativeEnv.database.close();
      nativeEnv.database = null;
      nativeEnv.isOpen = false;
    },
    async getVersion(): Promise<{ version: number }> {
      const row = nativeEnv.database?.prepare('PRAGMA user_version').get() as
        { user_version?: number } | undefined;
      return { version: Number(row?.user_version ?? 0) };
    },
    async execute(statement: string): Promise<{ changes: { changes: number } }> {
      nativeEnv.database?.exec(statement);
      return { changes: { changes: 0 } };
    },
    async run(
      statement: string,
      values: unknown[] = [],
    ): Promise<{ changes: { changes: number } }> {
      const result = nativeEnv.database?.prepare(statement).run(...(values as SQLInputValue[]));
      return { changes: { changes: Number(result?.changes ?? 0) } };
    },
    async query(
      statement: string,
      values: unknown[] = [],
    ): Promise<{ values: Record<string, unknown>[] }> {
      const rows = nativeEnv.database?.prepare(statement).all(...(values as SQLInputValue[])) as
        Record<string, unknown>[] | undefined;
      return { values: rows ?? [] };
    },
    async executeTransaction(tasks: capTask[]): Promise<{ changes: { changes: number } }> {
      if (
        nativeEnv.failConfirmSyncOnce &&
        tasks.some((task) => task.statement.includes('DELETE FROM sync_queue'))
      ) {
        nativeEnv.failConfirmSyncOnce = false;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      const db = nativeEnv.database!;
      db.exec('BEGIN IMMEDIATE');
      try {
        let total = 0;
        for (const task of tasks) {
          if (task.values && task.values.length > 0) {
            const res = db.prepare(task.statement).run(...(task.values as SQLInputValue[]));
            total += Number(res.changes ?? 0);
          } else {
            db.exec(task.statement);
          }
        }
        db.exec('COMMIT');
        return { changes: { changes: total } };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

const server = {
  id: 'primary',
  displayName: 'Library',
  baseUrl: 'https://books.example.com',
  credentialRef: 'server_primary_api_key',
  kavitaVersion: '0.8.4',
  lastConnectedAt: '2026-09-07T00:00:00.000Z',
};

const book = {
  id: 'primary:1:10',
  serverId: 'primary',
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 10,
  title: 'Native Book',
  author: 'Author',
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

beforeEach(() => {
  nativeEnv.rootDir = mkdtempSync(join(tmpdir(), 'turnleaf-native-sync-'));
  nativeEnv.databasePath = join(nativeEnv.rootDir, 'turnleaf.sqlite');
  nativeEnv.dataDir = join(nativeEnv.rootDir, 'data');
  mkdirSync(nativeEnv.dataDir, { recursive: true });
  nativeEnv.database = null;
  nativeEnv.isOpen = false;
  nativeEnv.failConfirmSyncOnce = false;
  nativeEnv.httpRequest.mockReset();
  nativeEnv.createAdapter = createSqliteAdapter;
});

afterEach(() => {
  if (nativeEnv.database) {
    nativeEnv.database.close();
    nativeEnv.database = null;
  }
  nativeEnv.isOpen = false;
  rmSync(nativeEnv.rootDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

it('keeps replacement native uploads serialized behind an aborted in-flight POST so remote state stays newest', async () => {
  const { getPendingSync, getReadingState, reconcileBooks, saveLocalProgress, saveServer } =
    await import('../database/database');
  const { KavitaClient } = await import('../kavita/client');
  const { flushProgress } = await import('./sync');

  await saveServer(server);
  await reconcileBooks(server.id, [book]);
  await saveLocalProgress(book, 'epubcfi(/6/2!/4/2)', '//body/p[2]', 0.1);

  let remoteState: { pageNum: number; bookScrollId: string | null } | null = null;
  let resolveOldNativePost!: () => void;
  let resolveOldPostDispatched!: () => void;
  const oldPostDispatched = new Promise<void>((resolve) => {
    resolveOldPostDispatched = resolve;
  });

  nativeEnv.httpRequest.mockImplementation((options: { data?: Record<string, unknown> }) => {
    const body = options.data ?? {};
    const pageNum = Number(body.pageNum ?? 0);
    const bookScrollId = typeof body.bookScrollId === 'string' ? body.bookScrollId : null;
    if (pageNum === 10) {
      resolveOldPostDispatched();
      return new Promise((resolve) => {
        resolveOldNativePost = () => {
          remoteState = { pageNum, bookScrollId };
          resolve({ status: 200, headers: {}, url: '', data: '' });
        };
      });
    }
    remoteState = { pageNum, bookScrollId };
    return Promise.resolve({ status: 200, headers: {}, url: '', data: '' });
  });

  const oldClient = new KavitaClient('https://old.example.com', 'old-key');
  const newClient = new KavitaClient('https://new.example.com', 'new-key');

  const firstCaller = new AbortController();
  const abortedFlush = flushProgress(oldClient, server.id, firstCaller.signal);
  await oldPostDispatched;

  // Caller aborts while the old native CapacitorHttp POST (pageNum: 10) is still in flight.
  firstCaller.abort();
  await expect(abortedFlush).resolves.toBeUndefined();

  // Save newer local progress (pageNum: 25) and start a replacement flush on the new client.
  await saveLocalProgress(book, 'epubcfi(/6/2!/4/10)', '//body/p[10]', 0.25);
  const replacementFlush = flushProgress(newClient, server.id);

  // Give microtasks ample turns: the replacement POST must NOT dispatch before the old native POST settles.
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
  expect(nativeEnv.httpRequest).toHaveBeenCalledTimes(1);
  expect(remoteState).toBeNull();

  // Now complete the aborted old native POST after the replacement flush was already queued.
  resolveOldNativePost();
  await expect(replacementFlush).resolves.toBeUndefined();

  expect(nativeEnv.httpRequest).toHaveBeenCalledTimes(2);
  expect(remoteState).toEqual({ pageNum: 25, bookScrollId: '//body/p[10]' });
  expect(await getPendingSync(server.id)).toEqual([]);
  expect(await getReadingState(book.id)).toMatchObject({
    cfi: 'epubcfi(/6/2!/4/10)',
    xpath: '//body/p[10]',
    pendingSync: false,
  });
});

it('recovers across a native app restart without re-uploading after SQLite confirmSync fails', async () => {
  const dbBefore = await import('../database/database');
  const { KavitaClient: ClientBefore } = await import('../kavita/client');
  const { UNCONFIRMED_SYNC_FILE_PATH, flushProgress: flushBefore } = await import('./sync');

  await dbBefore.saveServer(server);
  await dbBefore.reconcileBooks(server.id, [book]);
  await dbBefore.saveLocalProgress(book, 'epubcfi(/6/2!/4/8)', '//body/p[8]', 0.4);

  nativeEnv.httpRequest.mockResolvedValue({ status: 200, headers: {}, url: '', data: '' });
  nativeEnv.failConfirmSyncOnce = true;

  await expect(
    flushBefore(new ClientBefore(server.baseUrl, 'native-key'), server.id),
  ).rejects.toThrow('1 reading progress item failed to sync.');

  expect(nativeEnv.httpRequest).toHaveBeenCalledTimes(1);
  expect(existsSync(join(nativeEnv.dataDir, UNCONFIRMED_SYNC_FILE_PATH))).toBe(true);
  expect(await dbBefore.getPendingSync(server.id)).toHaveLength(1);

  // Simulate process termination and fresh app launch against the same SQLite DB and Directory.Data.
  nativeEnv.database?.close();
  nativeEnv.database = null;
  nativeEnv.isOpen = false;
  vi.resetModules();

  const dbAfter = await import('../database/database');
  const { KavitaClient: ClientAfter } = await import('../kavita/client');
  const { flushProgress: flushAfter } = await import('./sync');

  await expect(
    flushAfter(new ClientAfter(server.baseUrl, 'native-key'), server.id),
  ).resolves.toBeUndefined();

  // No duplicate POST after restart; local confirmation succeeded and cleaned up the journal file.
  expect(nativeEnv.httpRequest).toHaveBeenCalledTimes(1);
  expect(existsSync(join(nativeEnv.dataDir, UNCONFIRMED_SYNC_FILE_PATH))).toBe(false);
  expect(await dbAfter.getPendingSync(server.id)).toEqual([]);
  expect(await dbAfter.getReadingState(book.id)).toMatchObject({
    cfi: 'epubcfi(/6/2!/4/8)',
    xpath: '//body/p[8]',
    pendingSync: false,
  });
});

it('records a server-accepted native upload even when the caller aborted before the POST settled', async () => {
  const { getPendingSync, getReadingState, reconcileBooks, saveLocalProgress, saveServer } =
    await import('../database/database');
  const { KavitaClient } = await import('../kavita/client');
  const { UNCONFIRMED_SYNC_FILE_PATH, flushProgress } = await import('./sync');

  await saveServer(server);
  await reconcileBooks(server.id, [book]);
  await saveLocalProgress(book, 'epubcfi(/6/2!/4/6)', '//body/p[6]', 0.3);

  let resolvePost!: () => void;
  let resolveDispatched!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    resolveDispatched = resolve;
  });

  nativeEnv.httpRequest.mockImplementationOnce(() => {
    resolveDispatched();
    return new Promise((resolve) => {
      resolvePost = () => resolve({ status: 200, headers: {}, url: '', data: '' });
    });
  });
  nativeEnv.failConfirmSyncOnce = true;

  const client = new KavitaClient(server.baseUrl, 'native-key');
  const caller = new AbortController();
  const initialFlush = flushProgress(client, server.id, caller.signal);
  await dispatched;

  caller.abort();
  await expect(initialFlush).resolves.toBeUndefined();

  // Server accepts the already-in-flight native POST, while confirmSync fails once with SQLITE_BUSY.
  resolvePost();

  // Replacement flush waits for settlement, sees the persisted unconfirmed upload, and confirms locally without re-POSTing.
  await expect(flushProgress(client, server.id)).resolves.toBeUndefined();
  expect(nativeEnv.httpRequest).toHaveBeenCalledTimes(1);
  expect(existsSync(join(nativeEnv.dataDir, UNCONFIRMED_SYNC_FILE_PATH))).toBe(false);
  expect(await getPendingSync(server.id)).toEqual([]);
  expect(await getReadingState(book.id)).toMatchObject({
    cfi: 'epubcfi(/6/2!/4/6)',
    xpath: '//body/p[6]',
    pendingSync: false,
  });
});
