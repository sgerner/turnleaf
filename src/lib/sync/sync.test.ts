// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  getPendingSync,
  getReadingState,
  resetLocalDatabase,
  saveLocalProgress,
} from '../database/database';
import { flushProgress } from './sync';

const STORAGE_KEY = 'turnleaf_browser_database_v1';

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

const pendingState = (updatedAt: string, payloadJson: string, revision = 1) => ({
  serverConfig: null,
  books: [{ ...book }],
  readingState: {
    'book-1': {
      cfi: 'cfi',
      xpath: null,
      percentage: payloadJson.includes('2') ? 0.2 : 0.1,
      localUpdatedAt: updatedAt,
      syncedLocalUpdatedAt: null,
      serverUpdatedAt: null,
      pendingSync: true,
    },
  },
  syncQueue: {
    'book-1': {
      bookId: 'book-1',
      serverId: 'server',
      payloadJson,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      createdAt: updatedAt,
      updatedAt,
      revision,
    },
  },
  preferences: {},
});

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

const book = {
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

it('keeps and uploads a newer local relocation when an older upload completes', async () => {
  vi.useFakeTimers();
  const updatedAt = '2026-09-07T00:00:00.000Z';
  vi.setSystemTime(new Date(updatedAt));
  let resolveUploaded!: () => void;
  const uploaded = new Promise<void>((resolve) => {
    resolveUploaded = resolve;
  });
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const first = pendingState(updatedAt, '{"pageNum":1}');
  localStorage.setItem(STORAGE_KEY, JSON.stringify(first));

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
  const acknowledged = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as typeof first;
  expect(acknowledged.syncQueue['book-1']).toBeUndefined();
  expect(acknowledged.readingState['book-1']).toMatchObject({
    pendingSync: false,
    syncedLocalUpdatedAt: updatedAt,
  });
});

it('continues syncing later items when an earlier item fails', async () => {
  type PendingFixture = ReturnType<typeof pendingState>;
  type ExpandableFixture = Omit<PendingFixture, 'readingState' | 'syncQueue'> & {
    readingState: Record<string, PendingFixture['readingState']['book-1']>;
    syncQueue: Record<string, PendingFixture['syncQueue']['book-1']>;
  };
  const state = pendingState('2026-09-07T00:00:00.000Z', '{"pageNum":1}') as ExpandableFixture;
  state.books.push({ ...book, id: 'book-2' });
  state.readingState['book-2'] = {
    ...state.readingState['book-1']!,
    localUpdatedAt: '2026-09-07T00:00:01.000Z',
  };
  state.syncQueue['book-2'] = {
    ...state.syncQueue['book-1']!,
    bookId: 'book-2',
    serverId: 'server',
    payloadJson: '{"pageNum":2}',
    createdAt: '2026-09-07T00:00:01.000Z',
    updatedAt: '2026-09-07T00:00:01.000Z',
    revision: 1,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  const saveProgress = vi
    .fn()
    .mockRejectedValueOnce(new Error('first item failed'))
    .mockResolvedValueOnce(undefined);

  await expect(flushProgress({ saveProgress } as never, 'server')).rejects.toThrow(
    '1 reading progress item failed to sync.',
  );
  expect(saveProgress).toHaveBeenCalledTimes(2);

  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as typeof state;
  expect(saved.syncQueue['book-1']?.lastError).toBe('first item failed');
  expect(saved.syncQueue['book-2']).toBeUndefined();
  expect(saved.readingState['book-2']?.pendingSync).toBe(false);
});

it('runs independent server queues without sharing an in-flight flush promise', async () => {
  type QueueFixture = ReturnType<typeof pendingState>;
  const state = pendingState('2026-09-07T00:00:00.000Z', '{"pageNum":1}') as Omit<
    QueueFixture,
    'syncQueue'
  > & {
    syncQueue: Record<string, QueueFixture['syncQueue']['book-1']>;
  };
  state.books.push({ ...book, id: 'book-2', serverId: 'other' });
  state.syncQueue['book-2'] = {
    ...state.syncQueue['book-1']!,
    bookId: 'book-2',
    serverId: 'other',
    payloadJson: '{"pageNum":2}',
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

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
  releaseFirst();
  await firstFlush;
});

it('allows a manual retry after an authorization failure', async () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(pendingState('2026-09-07T00:00:00.000Z', '{"pageNum":1}')),
  );
  const saveProgress = vi
    .fn()
    .mockRejectedValueOnce(new Error('Kavita rejected this auth key.'))
    .mockResolvedValueOnce(undefined);
  const client = { saveProgress } as never;

  await expect(flushProgress(client, 'server')).rejects.toThrow('1 reading progress item failed');
  await expect(flushProgress(client, 'server')).resolves.toBeUndefined();

  expect(saveProgress).toHaveBeenCalledTimes(2);
});

it('bootstraps multi-chapter books at chapter index zero and skips started, book-start, or single-spine books', async () => {
  const seed = (pages = book.pages) =>
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        serverConfig: { id: 'server' },
        books: [{ ...book, pages }],
        readingState: {},
        syncQueue: {},
        preferences: {},
      }),
    );

  seed();
  await saveLocalProgress(book, 'epubcfi(/6/2!/4/6)', '//body/p[3]', 0.04, 0);
  const getProgress = vi.fn().mockResolvedValue({
    libraryId: 1,
    seriesId: 1,
    volumeId: 1,
    chapterId: 1,
    pageNum: 0,
    bookScrollId: null,
  });
  const saveProgress = vi.fn().mockResolvedValue(undefined);
  await flushProgress({ getProgress, saveProgress } as never, 'server');
  expect(saveProgress.mock.calls.map(([arg]) => [arg.pageNum, arg.bookScrollId])).toEqual([
    [1, null],
    [0, '//body/p[3]'],
  ]);

  // Remote already started -> no bootstrap; book start (0%, //body/p[1]) -> no getProgress or bootstrap.
  await saveLocalProgress(book, 'epubcfi(/6/2!/4/8)', '//body/p[4]', 0.06, 0);
  const saveStarted = vi.fn().mockResolvedValue(undefined);
  await flushProgress(
    {
      getProgress: vi.fn().mockResolvedValue({ ...book, pageNum: 0, bookScrollId: '//body/p[1]' }),
      saveProgress: saveStarted,
    } as never,
    'server',
  );
  expect(saveStarted).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ pageNum: 0, bookScrollId: '//body/p[4]' }),
  );

  await saveLocalProgress(book, 'epubcfi(/6/2!/4/2)', '//body/p[1]', 0, 0);
  const probeAtStart = vi.fn();
  const saveAtStart = vi.fn().mockResolvedValue(undefined);
  await flushProgress({ getProgress: probeAtStart, saveProgress: saveAtStart } as never, 'server');
  expect(probeAtStart).not.toHaveBeenCalled();
  expect(saveAtStart).toHaveBeenCalledOnce();

  // Single-spine EPUB (pages = 1) must never send pageNum = 1 (completion) during mid-book reading.
  seed(1);
  await saveLocalProgress({ ...book, pages: 1 }, 'epubcfi(/6/2!/4/6)', '//body/p[3]', 0.4, 0);
  const saveSingleSpine = vi.fn().mockResolvedValue(undefined);
  await flushProgress(
    {
      getProgress: vi.fn().mockResolvedValue({ ...book, pageNum: 0, bookScrollId: null }),
      saveProgress: saveSingleSpine,
    } as never,
    'server',
  );
  expect(saveSingleSpine).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ pageNum: 0, bookScrollId: '//body/p[3]' }),
  );
});

it('retries interrupted chapter-zero uploads and preserves post-clear/reset progress across in-flight flushes', async () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      serverConfig: { id: 'server' },
      books: [{ ...book }],
      readingState: {},
      syncQueue: {},
      preferences: {},
    }),
  );
  await saveLocalProgress(book, 'epubcfi(/6/2!/4/6)', '//body/p[3]', 0.04, 0);

  const getProgress = vi
    .fn()
    .mockResolvedValueOnce({ ...book, pageNum: 0, bookScrollId: null })
    .mockResolvedValueOnce({ ...book, pageNum: 1, bookScrollId: null });
  const saveProgress = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('network lost after bootstrap'))
    .mockResolvedValueOnce(undefined);
  const client = { getProgress, saveProgress } as never;
  await expect(flushProgress(client, 'server')).rejects.toThrow('1 reading progress item failed');
  await expect(flushProgress(client, 'server')).resolves.toBeUndefined();
  expect(saveProgress).toHaveBeenCalledTimes(3);

  // Interleave an in-flight flush with localStorage.clear() + reset + fresh save at the same revision.
  await saveLocalProgress(book, 'stale-cfi', '//body/p[2]', 0.1, 1);
  let releaseUpload!: () => void;
  const inFlightSave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseUpload = resolve;
      }),
  );
  const flushing = flushProgress({ saveProgress: inFlightSave } as never, 'server');
  await vi.waitFor(() => expect(inFlightSave).toHaveBeenCalledOnce());

  localStorage.clear();
  await resetLocalDatabase();
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      serverConfig: { id: 'server' },
      books: [{ ...book }],
      readingState: {},
      syncQueue: {},
      preferences: {},
    }),
  );
  await saveLocalProgress(book, 'post-reset-cfi', '//body/p[8]', 0.5, 4);
  releaseUpload();
  await flushing;

  expect(await getReadingState(book.id)).toMatchObject({
    cfi: 'post-reset-cfi',
    pageNum: 4,
    pendingSync: true,
  });
  expect(await getPendingSync('server')).toHaveLength(1);

  const postResetSave = vi.fn().mockResolvedValue(undefined);
  await flushProgress({ saveProgress: postResetSave } as never, 'server');
  expect(postResetSave).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ pageNum: 4, bookScrollId: '//body/p[8]' }),
  );
  expect(await getPendingSync('server')).toEqual([]);
});
