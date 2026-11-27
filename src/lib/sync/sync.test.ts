// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as database from '../database/database';
import { saveLocalProgress } from '../database/database';
import { cancelProgressFlush, flushProgress } from './sync';

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
  vi.restoreAllMocks();
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
    expect.any(AbortSignal),
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

it('aborts a stalled upload and syncs via the new client when the client instance changes', async () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(pendingState('2026-09-07T01:00:00.000Z', '{"pageNum":3}')),
  );

  let stalledSignal: AbortSignal | undefined;
  let resolveStalledStarted!: () => void;
  const stalledStarted = new Promise<void>((resolve) => {
    resolveStalledStarted = resolve;
  });
  const oldSave = vi.fn((_progress: unknown, signal?: AbortSignal) => {
    stalledSignal = signal;
    resolveStalledStarted();
    return new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    });
  });
  const newSave = vi.fn().mockResolvedValue(undefined);

  const staleFlush = flushProgress({ saveProgress: oldSave } as never, 'primary-test');
  // Re-populate under primary-test serverId to mirror preserved primary server ID.
  const state = pendingState('2026-09-07T01:00:00.000Z', '{"pageNum":3}');
  state.books[0]!.serverId = 'primary-test';
  state.syncQueue['book-1'].serverId = 'primary-test';
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  // Start stalled upload on oldClient, then replace with newClient on the same serverId.
  await staleFlush;
  const activeStale = flushProgress({ saveProgress: oldSave } as never, 'primary-test');
  await stalledStarted;
  expect(stalledSignal?.aborted).toBe(false);

  const nextFlush = flushProgress({ saveProgress: newSave } as never, 'primary-test');
  expect(stalledSignal?.aborted).toBe(true);

  await Promise.all([activeStale, nextFlush]);

  expect(newSave).toHaveBeenCalledOnce();
  expect(newSave).toHaveBeenCalledWith(
    expect.objectContaining({ pageNum: 3 }),
    expect.any(AbortSignal),
  );
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as typeof state;
  expect(saved.syncQueue['book-1']).toBeUndefined();
  expect(saved.readingState['book-1']?.pendingSync).toBe(false);
});

it('never increments retry counts on caller cancellation while recording timeouts', async () => {
  const updatedAt = '2026-09-07T02:00:00.000Z';
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingState(updatedAt, '{"pageNum":4}')));

  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const cancellableSave = vi.fn((_progress: unknown, signal?: AbortSignal) => {
    resolveStarted();
    return new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    });
  });

  const cancelledFlush = flushProgress({ saveProgress: cancellableSave } as never, 'server');
  await started;
  cancelProgressFlush('server');
  await expect(cancelledFlush).resolves.toBeUndefined();

  const afterCancel = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as ReturnType<
    typeof pendingState
  >;
  expect(afterCancel.syncQueue['book-1']).toMatchObject({
    attemptCount: 0,
    lastError: null,
  });

  const timedOutSave = vi.fn().mockRejectedValueOnce(new Error('Kavita did not respond in time.'));
  await expect(flushProgress({ saveProgress: timedOutSave } as never, 'server')).rejects.toThrow(
    '1 reading progress item failed to sync.',
  );

  const afterTimeout = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as ReturnType<
    typeof pendingState
  >;
  expect(afterTimeout.syncQueue['book-1']).toMatchObject({
    attemptCount: 1,
    lastError: 'Kavita did not respond in time.',
  });
});

it('isolates SQLITE_BUSY during confirmSync and confirms locally on retry without duplicate uploads', async () => {
  type PendingFixture = ReturnType<typeof pendingState>;
  type ExpandableFixture = Omit<PendingFixture, 'readingState' | 'syncQueue'> & {
    readingState: Record<string, PendingFixture['readingState']['book-1']>;
    syncQueue: Record<string, PendingFixture['syncQueue']['book-1']>;
  };
  const state = pendingState('2026-09-07T03:00:00.000Z', '{"pageNum":5}') as ExpandableFixture;
  state.books.push({ ...book, id: 'book-2' });
  state.readingState['book-2'] = {
    ...state.readingState['book-1']!,
    localUpdatedAt: '2026-09-07T03:00:01.000Z',
  };
  state.syncQueue['book-2'] = {
    ...state.syncQueue['book-1']!,
    bookId: 'book-2',
    serverId: 'server',
    payloadJson: '{"pageNum":6}',
    createdAt: '2026-09-07T03:00:01.000Z',
    updatedAt: '2026-09-07T03:00:01.000Z',
    revision: 1,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  const realConfirm = database.confirmSync;
  const confirmSpy = vi
    .spyOn(database, 'confirmSync')
    .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
    .mockImplementation(realConfirm);
  const markFailureSpy = vi.spyOn(database, 'markSyncFailure');
  const saveProgress = vi.fn().mockResolvedValue(undefined);

  await expect(flushProgress({ saveProgress } as never, 'server')).rejects.toThrow(
    '1 reading progress item failed to sync.',
  );

  expect(saveProgress).toHaveBeenCalledTimes(2);
  expect(markFailureSpy).not.toHaveBeenCalled();

  const afterBusy = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as typeof state;
  expect(afterBusy.syncQueue['book-1']?.attemptCount).toBe(0);
  expect(afterBusy.syncQueue['book-1']?.lastError).toBeNull();
  expect(afterBusy.syncQueue['book-2']).toBeUndefined();
  expect(afterBusy.readingState['book-2']?.pendingSync).toBe(false);

  // Retry confirms book-1 locally from memory without sending a duplicate saveProgress request.
  await expect(flushProgress({ saveProgress } as never, 'server')).resolves.toBeUndefined();
  expect(saveProgress).toHaveBeenCalledTimes(2);
  expect(confirmSpy).toHaveBeenCalledTimes(3);

  const afterRetry = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as typeof state;
  expect(afterRetry.syncQueue['book-1']).toBeUndefined();
  expect(afterRetry.readingState['book-1']?.pendingSync).toBe(false);
});

it('continues syncing remaining books when markSyncFailure throws SQLITE_BUSY', async () => {
  type PendingFixture = ReturnType<typeof pendingState>;
  type ExpandableFixture = Omit<PendingFixture, 'readingState' | 'syncQueue'> & {
    readingState: Record<string, PendingFixture['readingState']['book-1']>;
    syncQueue: Record<string, PendingFixture['syncQueue']['book-1']>;
  };
  const state = pendingState('2026-09-07T04:00:00.000Z', '{"pageNum":7}') as ExpandableFixture;
  state.books.push({ ...book, id: 'book-2' });
  state.readingState['book-2'] = {
    ...state.readingState['book-1']!,
    localUpdatedAt: '2026-09-07T04:00:01.000Z',
  };
  state.syncQueue['book-2'] = {
    ...state.syncQueue['book-1']!,
    bookId: 'book-2',
    serverId: 'server',
    payloadJson: '{"pageNum":8}',
    createdAt: '2026-09-07T04:00:01.000Z',
    updatedAt: '2026-09-07T04:00:01.000Z',
    revision: 1,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  vi.spyOn(database, 'markSyncFailure').mockRejectedValueOnce(
    new Error('SQLITE_BUSY: database is locked'),
  );
  const saveProgress = vi
    .fn()
    .mockRejectedValueOnce(new Error('network error'))
    .mockResolvedValueOnce(undefined);

  await expect(flushProgress({ saveProgress } as never, 'server')).rejects.toThrow(
    '1 reading progress item failed to sync.',
  );

  expect(saveProgress).toHaveBeenCalledTimes(2);
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as typeof state;
  expect(saved.syncQueue['book-1']).toBeDefined();
  expect(saved.syncQueue['book-2']).toBeUndefined();
  expect(saved.readingState['book-2']?.pendingSync).toBe(false);
});

it('uses caller-local cancellation when two callers share a flush and only one aborts', async () => {
  // Case 1: joining caller aborts while initiating caller continues awaiting.
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(pendingState('2026-09-07T05:00:00.000Z', '{"pageNum":12}')),
  );

  let uploadSignal1: AbortSignal | undefined;
  let resolveUpload1!: () => void;
  let startedUpload1!: () => void;
  const uploadStarted1 = new Promise<void>((resolve) => {
    startedUpload1 = resolve;
  });
  const saveProgress1 = vi.fn((_payload: unknown, signal?: AbortSignal) => {
    uploadSignal1 = signal;
    startedUpload1();
    return new Promise<void>((resolve, reject) => {
      resolveUpload1 = resolve;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    });
  });
  const sharedClient1 = { saveProgress: saveProgress1 } as never;

  const callerA = new AbortController();
  const callerB = new AbortController();
  const flushA = flushProgress(sharedClient1, 'server', callerA.signal);
  const flushB = flushProgress(sharedClient1, 'server', callerB.signal);
  await uploadStarted1;

  callerB.abort();
  await expect(flushB).resolves.toBeUndefined();
  expect(uploadSignal1?.aborted).toBe(false);

  resolveUpload1();
  await expect(flushA).resolves.toBeUndefined();

  const afterJoinerAbort = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as ReturnType<
    typeof pendingState
  >;
  expect(afterJoinerAbort.syncQueue['book-1']).toBeUndefined();
  expect(afterJoinerAbort.readingState['book-1']?.pendingSync).toBe(false);

  // Case 2: initiating caller aborts while joining caller continues awaiting.
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(pendingState('2026-09-07T05:05:00.000Z', '{"pageNum":15}')),
  );

  let uploadSignal2: AbortSignal | undefined;
  let resolveUpload2!: () => void;
  let startedUpload2!: () => void;
  const uploadStarted2 = new Promise<void>((resolve) => {
    startedUpload2 = resolve;
  });
  const saveProgress2 = vi.fn((_payload: unknown, signal?: AbortSignal) => {
    uploadSignal2 = signal;
    startedUpload2();
    return new Promise<void>((resolve, reject) => {
      resolveUpload2 = resolve;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    });
  });
  const sharedClient2 = { saveProgress: saveProgress2 } as never;

  const initiator = new AbortController();
  const joiner = new AbortController();
  const initiatorFlush = flushProgress(sharedClient2, 'server', initiator.signal);
  const joinerFlush = flushProgress(sharedClient2, 'server', joiner.signal);
  await uploadStarted2;

  initiator.abort();
  await expect(initiatorFlush).resolves.toBeUndefined();
  expect(uploadSignal2?.aborted).toBe(false);

  resolveUpload2();
  await expect(joinerFlush).resolves.toBeUndefined();

  const afterInitiatorAbort = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as ReturnType<
    typeof pendingState
  >;
  expect(afterInitiatorAbort.syncQueue['book-1']).toBeUndefined();
  expect(afterInitiatorAbort.readingState['book-1']?.pendingSync).toBe(false);

  // Case 3: when every subscribed caller aborts, the underlying upload controller aborts.
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(pendingState('2026-09-07T05:10:00.000Z', '{"pageNum":18}')),
  );
  let uploadSignal3: AbortSignal | undefined;
  let startedUpload3!: () => void;
  const uploadStarted3 = new Promise<void>((resolve) => {
    startedUpload3 = resolve;
  });
  const saveProgress3 = vi.fn((_payload: unknown, signal?: AbortSignal) => {
    uploadSignal3 = signal;
    startedUpload3();
    return new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    });
  });
  const sharedClient3 = { saveProgress: saveProgress3 } as never;
  const c1 = new AbortController();
  const c2 = new AbortController();
  const f1 = flushProgress(sharedClient3, 'server', c1.signal);
  const f2 = flushProgress(sharedClient3, 'server', c2.signal);
  await uploadStarted3;
  c1.abort();
  expect(uploadSignal3?.aborted).toBe(false);
  c2.abort();
  expect(uploadSignal3?.aborted).toBe(true);
  await Promise.all([f1, f2]);
});

it('suppresses duplicate uploads after an app restart when confirmSync previously failed', async () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(pendingState('2026-09-07T06:00:00.000Z', '{"pageNum":22}')),
  );

  vi.spyOn(database, 'confirmSync').mockRejectedValueOnce(
    new Error('SQLITE_BUSY: database is locked'),
  );
  const saveProgressBeforeRestart = vi.fn().mockResolvedValue(undefined);

  await expect(
    flushProgress({ saveProgress: saveProgressBeforeRestart } as never, 'server'),
  ).rejects.toThrow('1 reading progress item failed to sync.');
  expect(saveProgressBeforeRestart).toHaveBeenCalledOnce();
  expect(localStorage.getItem('turnleaf_unconfirmed_sync_v1')).not.toBeNull();

  // Simulate full app restart: reload modules while retaining persistent storage.
  vi.restoreAllMocks();
  vi.resetModules();
  const restartedSync = await import('./sync');
  const saveProgressAfterRestart = vi.fn().mockResolvedValue(undefined);

  await expect(
    restartedSync.flushProgress({ saveProgress: saveProgressAfterRestart } as never, 'server'),
  ).resolves.toBeUndefined();
  expect(saveProgressAfterRestart).not.toHaveBeenCalled();
  expect(localStorage.getItem('turnleaf_unconfirmed_sync_v1')).toBeNull();

  const confirmed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as ReturnType<
    typeof pendingState
  >;
  expect(confirmed.syncQueue['book-1']).toBeUndefined();
  expect(confirmed.readingState['book-1']?.pendingSync).toBe(false);

  // If newer local progress is saved after an unconfirmed upload before restart, the newer revision uploads.
  const restartedDb = await import('../database/database');
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(pendingState('2026-09-07T06:05:00.000Z', '{"pageNum":24}', 1)),
  );
  vi.spyOn(restartedDb, 'confirmSync').mockRejectedValueOnce(
    new Error('SQLITE_BUSY: database is locked'),
  );
  const firstAttempt = vi.fn().mockResolvedValue(undefined);
  await expect(
    restartedSync.flushProgress({ saveProgress: firstAttempt } as never, 'server'),
  ).rejects.toThrow('1 reading progress item failed to sync.');
  vi.restoreAllMocks();

  await restartedDb.saveLocalProgress(book, 'cfi-newer', 'xpath-newer', 0.35);
  vi.resetModules();
  const thirdSync = await import('./sync');
  const uploadNewer = vi.fn().mockResolvedValue(undefined);
  await expect(
    thirdSync.flushProgress({ saveProgress: uploadNewer } as never, 'server'),
  ).resolves.toBeUndefined();
  expect(uploadNewer).toHaveBeenCalledOnce();
  expect(uploadNewer).toHaveBeenCalledWith(
    expect.objectContaining({ pageNum: 35, bookScrollId: 'xpath-newer' }),
    expect.any(AbortSignal),
  );
});
