import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { saveLocalProgress } from '../database/database';
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
  books: [],
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
  const flush = flushProgress({ saveProgress } as never);
  await started;

  await saveLocalProgress(book, 'cfi-b', 'xpath-b', 0.2);
  resolveUploaded();
  await flush;

  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as typeof first;
  expect(saved.syncQueue['book-1']).toMatchObject({
    payloadJson: expect.stringContaining('"pageNum":20'),
    revision: 2,
  });
  expect(saved.readingState['book-1']?.pendingSync).toBe(true);
  expect(saved.readingState['book-1']?.syncedLocalUpdatedAt).toBeNull();

  await flushProgress({ saveProgress } as never);

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
  state.readingState['book-2'] = {
    ...state.readingState['book-1']!,
    localUpdatedAt: '2026-09-07T00:00:01.000Z',
  };
  state.syncQueue['book-2'] = {
    ...state.syncQueue['book-1']!,
    bookId: 'book-2',
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

  await expect(flushProgress({ saveProgress } as never)).rejects.toThrow(
    '1 reading progress item failed to sync.',
  );
  expect(saveProgress).toHaveBeenCalledTimes(2);

  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as typeof state;
  expect(saved.syncQueue['book-1']?.lastError).toBe('first item failed');
  expect(saved.syncQueue['book-2']).toBeUndefined();
  expect(saved.readingState['book-2']?.pendingSync).toBe(false);
});
