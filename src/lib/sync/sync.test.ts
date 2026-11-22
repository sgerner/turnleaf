// @vitest-environment node

import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import type * as CapacitorSQLiteModule from '@capacitor-community/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQLiteTestBridge } from '../database/sqlite-test-bridge';

const harness = vi.hoisted(() => ({
  nativeMode: false,
  bridge: null as SQLiteTestBridge | null,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => harness.nativeMode,
  },
  registerPlugin: () => ({}),
}));

vi.mock('@capacitor-community/sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof CapacitorSQLiteModule>();
  const { createSQLiteTestBridge } = await import('../database/sqlite-test-bridge');
  harness.bridge ??= createSQLiteTestBridge('turnleaf-sync-');
  return {
    ...actual,
    CapacitorSQLite: harness.bridge.plugin as unknown as typeof actual.CapacitorSQLite,
  };
});

import {
  getPendingSync,
  getReadingState,
  getSyncStatus,
  openDatabase,
  reconcileBooks,
  resetLocalDatabase,
  saveLocalProgress,
  saveServer,
  type BookRecord,
  type ServerConfig,
} from '../database/database';
import { flushProgress } from './sync';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

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
    this.values.set(key, value);
  }
}

const server: ServerConfig = {
  id: 'server',
  displayName: 'Test server',
  baseUrl: 'https://books.example.com',
  credentialRef: 'credential',
  kavitaVersion: null,
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const book: BookRecord = {
  id: 'book-1',
  serverId: 'server',
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 1,
  title: 'Book',
  author: null,
  series: null,
  descriptionHtml: null,
  format: 'epub',
  pages: 100,
  pagesRead: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: null,
  downloadPath: null,
  downloadStatus: 'none',
  fileSize: null,
};

async function seedPendingBook(
  targetServer: ServerConfig,
  targetBook: BookRecord,
  updatedAt: string,
  percentage = 0.01,
  xpath = 'xpath-a',
): Promise<void> {
  vi.setSystemTime(new Date(updatedAt));
  await saveServer(targetServer);
  await reconcileBooks(targetServer.id, [targetBook], { preserveMissing: true });
  await saveLocalProgress(targetBook, 'cfi-a', xpath, percentage);
}

describe.each(['browser', 'sqlite'] as const)('sync queue (%s backend)', (backend) => {
  beforeEach(async () => {
    harness.nativeMode = backend === 'sqlite';
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: storage },
    });
    if (backend === 'sqlite') {
      const db = await openDatabase();
      expect(db).toBeInstanceOf(SQLiteDBConnection);
      await resetLocalDatabase();
      harness.bridge?.useNewDirectory('turnleaf-sync-');
    }
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (backend === 'sqlite') {
      harness.bridge?.clearFaults();
      await resetLocalDatabase().catch(() => undefined);
      harness.bridge?.cleanup();
    }
    harness.nativeMode = false;
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('keeps and uploads a newer local relocation when an older upload completes', async () => {
    vi.useFakeTimers();
    const updatedAt = '2026-09-07T00:00:00.000Z';
    await seedPendingBook(server, book, updatedAt, 0.01, 'xpath-a');

    let resolveUploaded!: () => void;
    const uploaded = new Promise<void>((resolve) => {
      resolveUploaded = resolve;
    });
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const saveProgress = vi
      .fn()
      .mockImplementationOnce(async () => {
        resolveStarted();
        return uploaded;
      })
      .mockResolvedValue(undefined);
    const flush = flushProgress({ saveProgress } as never, 'server');
    await started;

    await saveLocalProgress(book, 'cfi-b', 'xpath-b', 0.2);
    resolveUploaded();
    await flush;

    expect(saveProgress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageNum: 20, bookScrollId: 'xpath-b' }),
    );
    expect(await getPendingSync('server')).toEqual([]);
    expect(await getReadingState(book.id)).toMatchObject({
      pendingSync: false,
      syncedLocalUpdatedAt: updatedAt,
    });
  });

  it('continues syncing later items when an earlier item fails', async () => {
    vi.useFakeTimers();
    const secondBook: BookRecord = { ...book, id: 'book-2', chapterId: 2 };
    await seedPendingBook(server, book, '2026-09-07T00:00:00.000Z', 0.01, 'xpath-1');
    await seedPendingBook(server, secondBook, '2026-09-07T00:00:01.000Z', 0.02, 'xpath-2');

    const saveProgress = vi
      .fn()
      .mockRejectedValueOnce(new Error('first item failed'))
      .mockResolvedValueOnce(undefined);

    await expect(flushProgress({ saveProgress } as never, 'server')).rejects.toThrow(
      '1 reading progress item failed to sync.',
    );
    expect(saveProgress).toHaveBeenCalledTimes(2);

    expect(await getPendingSync('server')).toMatchObject([{ bookId: 'book-1' }]);
    expect(await getSyncStatus('server')).toMatchObject({
      pendingCount: 1,
      failedCount: 1,
      lastError: 'first item failed',
    });
    expect(await getReadingState('book-2')).toMatchObject({ pendingSync: false });
  });

  it('runs independent server queues without sharing an in-flight flush promise', async () => {
    vi.useFakeTimers();
    const otherServer: ServerConfig = {
      ...server,
      id: 'other',
      baseUrl: 'https://other.example.com',
    };
    const otherBook: BookRecord = { ...book, id: 'book-2', serverId: 'other' };
    await seedPendingBook(server, book, '2026-09-07T00:00:00.000Z', 0.01, 'xpath-1');
    await seedPendingBook(otherServer, otherBook, '2026-09-07T00:00:00.000Z', 0.02, 'xpath-2');

    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstSave = vi.fn(() => firstBlocked);
    const secondSave = vi.fn().mockResolvedValue(undefined);

    const firstFlush = flushProgress({ saveProgress: firstSave } as never, 'server');
    const secondFlush = flushProgress({ saveProgress: secondSave } as never, 'other');
    await secondFlush;

    expect(firstSave).toHaveBeenCalledOnce();
    expect(secondSave).toHaveBeenCalledOnce();
    expect(await getPendingSync('other')).toEqual([]);
    expect(await getPendingSync('server')).toHaveLength(1);
    releaseFirst();
    await firstFlush;
    expect(await getPendingSync('server')).toEqual([]);
  });

  it('allows a manual retry after an authorization failure', async () => {
    vi.useFakeTimers();
    await seedPendingBook(server, book, '2026-09-07T00:00:00.000Z', 0.01, 'xpath-1');
    const saveProgress = vi
      .fn()
      .mockRejectedValueOnce(new Error('Kavita rejected this auth key.'))
      .mockResolvedValueOnce(undefined);
    const client = { saveProgress } as never;

    await expect(flushProgress(client, 'server')).rejects.toThrow('1 reading progress item failed');
    expect(await getSyncStatus('server')).toMatchObject({
      pendingCount: 1,
      failedCount: 1,
      lastError: 'Kavita rejected this auth key.',
    });
    await expect(flushProgress(client, 'server')).resolves.toBeUndefined();

    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(await getPendingSync('server')).toEqual([]);
  });

  it('preserves non-empty string rejections in lastError and falls back on blank strings', async () => {
    vi.useFakeTimers();
    await seedPendingBook(server, book, '2026-09-07T00:00:00.000Z', 0.01, 'xpath-1');
    const saveProgress = vi
      .fn()
      .mockRejectedValueOnce('Socket closed during progress upload')
      .mockRejectedValueOnce('   ');
    const client = { saveProgress } as never;

    await expect(flushProgress(client, 'server')).rejects.toThrow('1 reading progress item failed');
    expect(await getSyncStatus('server')).toMatchObject({
      lastError: 'Socket closed during progress upload',
    });

    await expect(flushProgress(client, 'server')).rejects.toThrow('1 reading progress item failed');
    expect(await getSyncStatus('server')).toMatchObject({
      lastError: 'Sync failed',
    });
  });
});

describe('SQLite string rejection handling during confirmSync', () => {
  beforeEach(async () => {
    harness.nativeMode = true;
    const db = await openDatabase();
    expect(db).toBeInstanceOf(SQLiteDBConnection);
    await resetLocalDatabase();
    harness.bridge?.useNewDirectory('turnleaf-sync-confirm-');
  });

  afterEach(async () => {
    vi.useRealTimers();
    harness.bridge?.clearFaults();
    await resetLocalDatabase().catch(() => undefined);
    harness.bridge?.cleanup();
    harness.nativeMode = false;
  });

  it('records the SQLiteDBConnection.executeTransaction string rejection in lastError instead of Sync failed', async () => {
    vi.useFakeTimers();
    await seedPendingBook(server, book, '2026-09-07T00:00:00.000Z', 0.25, 'xpath-confirm');
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const client = { saveProgress } as never;

    const sqliteError = 'SQLITE_IOERR: disk I/O error while acknowledging sync';
    harness.bridge!.failStatement('DELETE FROM sync_queue', new Error(sqliteError));

    let caught: unknown;
    try {
      await flushProgress(client, 'server');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([sqliteError]);
    expect(await getSyncStatus('server')).toMatchObject({
      pendingCount: 1,
      failedCount: 1,
      lastError: sqliteError,
    });
    expect(await getReadingState(book.id)).toMatchObject({
      pendingSync: true,
    });

    await expect(flushProgress(client, 'server')).resolves.toBeUndefined();
    expect(await getPendingSync('server')).toEqual([]);
    expect(await getSyncStatus('server')).toMatchObject({
      pendingCount: 0,
      failedCount: 0,
      lastError: null,
    });
  });
});
