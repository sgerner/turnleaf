// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { saveLocalProgress } from '../database/database';
import { KavitaError, KavitaOfflineError } from '../kavita/client';
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

it('stops immediately on a KavitaError authentication failure without trying remaining queued books', async () => {
  type PendingFixture = ReturnType<typeof pendingState>;
  type ExpandableFixture = Omit<PendingFixture, 'readingState' | 'syncQueue'> & {
    readingState: Record<string, PendingFixture['readingState']['book-1']>;
    syncQueue: Record<string, PendingFixture['syncQueue']['book-1']>;
  };
  const state = pendingState('2026-09-07T00:00:00.000Z', '{"pageNum":1}') as ExpandableFixture;
  state.books.push({ ...book, id: 'book-2', chapterId: 2 });
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
    .mockRejectedValueOnce(new KavitaError('Kavita rejected this auth key.', 'authentication', 401))
    .mockResolvedValueOnce(undefined);

  await expect(flushProgress({ saveProgress } as never, 'server')).rejects.toThrow(
    '1 reading progress item failed to sync.',
  );
  expect(saveProgress).toHaveBeenCalledTimes(1);

  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as typeof state;
  expect(saved.syncQueue['book-1']?.attemptCount).toBe(1);
  expect(saved.syncQueue['book-2']?.attemptCount).toBe(0);
  expect(saved.readingState['book-1']?.pendingSync).toBe(true);
  expect(saved.readingState['book-2']?.pendingSync).toBe(true);
});

it('stops cleanly without attempting queued books or recording sync failures when credentials become unavailable or signal aborts', async () => {
  type PendingFixture = ReturnType<typeof pendingState>;
  type ExpandableFixture = Omit<PendingFixture, 'readingState' | 'syncQueue'> & {
    readingState: Record<string, PendingFixture['readingState']['book-1']>;
    syncQueue: Record<string, PendingFixture['syncQueue']['book-1']>;
  };
  const state = pendingState('2026-09-07T00:00:00.000Z', '{"pageNum":1}') as ExpandableFixture;
  state.books.push({ ...book, id: 'book-2', chapterId: 2 });
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

  const blockedSave = vi.fn();
  await expect(
    flushProgress({ saveProgress: blockedSave, canSendRequests: () => false } as never, 'server'),
  ).resolves.toBeUndefined();
  expect(blockedSave).not.toHaveBeenCalled();

  const controller = new AbortController();
  let canSend = true;
  const abortingSave = vi.fn(async (_payload: unknown, signal?: AbortSignal) => {
    expect(signal).toBe(controller.signal);
    canSend = false;
    controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  });

  await expect(
    flushProgress(
      { saveProgress: abortingSave, canSendRequests: () => canSend } as never,
      'server',
      controller.signal,
    ),
  ).resolves.toBeUndefined();
  expect(abortingSave).toHaveBeenCalledTimes(1);

  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as typeof state;
  expect(saved.syncQueue['book-1']?.attemptCount).toBe(0);
  expect(saved.syncQueue['book-1']?.lastError).toBeNull();
  expect(saved.syncQueue['book-2']?.attemptCount).toBe(0);
  expect(saved.readingState['book-1']?.pendingSync).toBe(true);
  expect(saved.readingState['book-2']?.pendingSync).toBe(true);
});

it('stops between queued uploads without dispatching or penalizing remaining items when transport drops', async () => {
  type PendingFixture = ReturnType<typeof pendingState>;
  type ExpandableFixture = Omit<PendingFixture, 'readingState' | 'syncQueue'> & {
    readingState: Record<string, PendingFixture['readingState']['book-1']>;
    syncQueue: Record<string, PendingFixture['syncQueue']['book-1']>;
  };

  const buildThreeBookQueue = (): ExpandableFixture => {
    const state = pendingState('2026-09-07T00:00:00.000Z', '{"pageNum":1}') as ExpandableFixture;
    for (const [id, chapterId, sec] of [
      ['book-2', 2, '01'],
      ['book-3', 3, '02'],
    ] as const) {
      state.books.push({ ...book, id, chapterId });
      state.readingState[id] = {
        ...state.readingState['book-1']!,
        localUpdatedAt: `2026-09-07T00:00:${sec}.000Z`,
      };
      state.syncQueue[id] = {
        ...state.syncQueue['book-1']!,
        bookId: id,
        serverId: 'server',
        payloadJson: JSON.stringify({ pageNum: chapterId }),
        createdAt: `2026-09-07T00:00:${sec}.000Z`,
        updatedAt: `2026-09-07T00:00:${sec}.000Z`,
        revision: 1,
      };
    }
    return state;
  };

  // Case A: queueSignal aborts when connectivity drops right after book-1 finishes uploading
  localStorage.setItem(STORAGE_KEY, JSON.stringify(buildThreeBookQueue()));
  const queueController = new AbortController();
  let transportOnline = true;
  const saveProgressOnQueueAbort = vi.fn(async () => {
    transportOnline = false;
    queueController.abort();
  });

  await expect(
    flushProgress({ saveProgress: saveProgressOnQueueAbort } as never, 'server', {
      queueSignal: queueController.signal,
      canContinue: () => transportOnline,
    }),
  ).resolves.toBeUndefined();
  expect(saveProgressOnQueueAbort).toHaveBeenCalledTimes(1);

  const afterQueueAbort = JSON.parse(
    localStorage.getItem(STORAGE_KEY) ?? '{}',
  ) as ExpandableFixture;
  expect(afterQueueAbort.syncQueue['book-1']).toBeUndefined();
  expect(afterQueueAbort.readingState['book-1']?.pendingSync).toBe(false);
  expect(afterQueueAbort.syncQueue['book-2']).toMatchObject({ attemptCount: 0, lastError: null });
  expect(afterQueueAbort.syncQueue['book-3']).toMatchObject({ attemptCount: 0, lastError: null });

  // Case B: live pre-dispatch gate in client.saveProgress throws KavitaOfflineError on book-2
  // before any HTTP request is transmitted -> stops immediately without touching book-3 or marking failure
  localStorage.setItem(STORAGE_KEY, JSON.stringify(buildThreeBookQueue()));
  const saveProgressOfflineGate = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new KavitaOfflineError());

  await expect(
    flushProgress({ saveProgress: saveProgressOfflineGate } as never, 'server'),
  ).resolves.toBeUndefined();
  expect(saveProgressOfflineGate).toHaveBeenCalledTimes(2);

  const afterOfflineGate = JSON.parse(
    localStorage.getItem(STORAGE_KEY) ?? '{}',
  ) as ExpandableFixture;
  expect(afterOfflineGate.syncQueue['book-1']).toBeUndefined();
  expect(afterOfflineGate.syncQueue['book-2']).toMatchObject({ attemptCount: 0, lastError: null });
  expect(afterOfflineGate.syncQueue['book-3']).toMatchObject({ attemptCount: 0, lastError: null });
});
