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
      try {
        for (const [index, task] of tasks.entries()) {
          if (index === failAt) throw new Error(`injected transaction failure at ${index}`);
          if (task.values && task.values.length > 0) {
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
  });

  afterEach(() => {
    if (native.database) native.database.close();
    native.database = null;
    native.isOpen = false;
    native.failTransactionAt = null;
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([0, 1, 2])(
    'rolls back every progress write when task %i fails and preserves the prior retryable state after reopen',
    async (failAt) => {
      const database = await importDatabase();
      await seedDatabase(database);
      const baselineReading = await database.getReadingState(book.id);
      const baselineQueue = await database.getPendingSync();
      const baselineBook = (await database.getBooks(server.id))[0];

      native.failTransactionAt = failAt;
      await expect(database.saveLocalProgress(book, 'new-cfi', '/new', 0.8)).rejects.toThrow(
        `injected transaction failure at ${failAt}`,
      );

      const reopened = await reopenDatabase(database);
      expect(await reopened.getReadingState(book.id)).toEqual(baselineReading);
      expect(await reopened.getPendingSync()).toEqual(baselineQueue);
      expect((await reopened.getBooks(server.id))[0]).toEqual(baselineBook);
    },
  );

  it('rolls back a failed completion transaction without losing its retryable queue row', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    const baselineReading = await database.getReadingState(book.id);
    const baselineQueue = await database.getPendingSync();
    const baselineBook = (await database.getBooks(server.id))[0];

    native.failTransactionAt = 2;
    await expect(database.markBookCompleted(book, baselineReading)).rejects.toThrow(
      'injected transaction failure at 2',
    );

    const reopened = await reopenDatabase(database);
    expect(await reopened.getReadingState(book.id)).toEqual(baselineReading);
    expect(await reopened.getPendingSync()).toEqual(baselineQueue);
    expect((await reopened.getBooks(server.id))[0]).toEqual(baselineBook);
  });

  it('rolls back a failed acknowledgement so the queue can be retried after reopen', async () => {
    const database = await importDatabase();
    await seedDatabase(database);
    const pending = (await database.getPendingSync())[0];
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
    expect(await reopened.getPendingSync()).toEqual([pending]);

    await reopened.confirmSync(
      book.id,
      '2026-01-02T00:00:00.000Z',
      pending!.revision,
      pending!.updatedAt,
    );
    const afterRetry = await reopenDatabase(reopened);
    expect(await afterRetry.getPendingSync()).toEqual([]);
    expect(await afterRetry.getReadingState(book.id)).toMatchObject({
      pendingSync: false,
      syncedLocalUpdatedAt: pending!.updatedAt,
      serverUpdatedAt: '2026-01-02T00:00:00.000Z',
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
});
