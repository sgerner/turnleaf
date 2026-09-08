import { beforeEach, expect, it, vi } from 'vitest';
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

const pendingState = (updatedAt: string, payloadJson: string) => ({
  serverConfig: null,
  books: [],
  readingState: {
    'book-1': {
      cfi: 'cfi',
      xpath: null,
      percentage: payloadJson.includes('2') ? 0.2 : 0.1,
      localUpdatedAt: updatedAt,
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

it('keeps a newer local queue item when an older upload completes', async () => {
  let resolveUploaded!: () => void;
  const uploaded = new Promise<void>((resolve) => {
    resolveUploaded = resolve;
  });
  const first = pendingState('2026-09-07T00:00:00.000Z', '{"pageNum":1}');
  const second = pendingState('2026-09-07T00:00:01.000Z', '{"pageNum":2}');
  localStorage.setItem(STORAGE_KEY, JSON.stringify(first));

  const saveProgress = vi.fn(async () => uploaded);
  const flush = flushProgress({ saveProgress } as never);
  await vi.waitFor(() => expect(saveProgress).toHaveBeenCalledOnce());

  localStorage.setItem(STORAGE_KEY, JSON.stringify(second));
  resolveUploaded();
  await flush;

  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as typeof second;
  expect(saved.syncQueue['book-1']).toEqual(second.syncQueue['book-1']);
  expect(saved.readingState['book-1']?.pendingSync).toBe(true);
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
