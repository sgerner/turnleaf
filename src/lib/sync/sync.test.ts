// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  deleteBookAnnotation,
  deleteBookBookmark,
  getBookAnnotations,
  getBookBookmarks,
  getSyncStatus,
  reconcileBooks,
  renameBookBookmark,
  saveBookAnnotation,
  saveBookBookmark,
  saveLocalProgress,
  updateBookAnnotationNote,
} from '../database/database';
import { KavitaError } from '../kavita/client';
import { flushProgress, syncBookStudyData, syncLibraryAnnotations } from './sync';

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

it('flushes offline annotation and PToC bookmark creates, edits, and deletes idempotently', async () => {
  await reconcileBooks('server', [book]);
  const createdAnnotation = await saveBookAnnotation(book.id, {
    cfi: 'epubcfi(/6/2!/4/2/1:0)',
    xpath: '//body/DocFragment[1]/body/p[1]',
    endingXPath: '//body/DocFragment[1]/body/p[1]',
    pageNumber: 0,
    excerpt: 'Offline highlight',
    note: 'Offline note',
  });
  const createdBookmark = await saveBookBookmark(book.id, {
    cfi: 'epubcfi(/6/2!/4/2)',
    xpath: '//body/DocFragment[1]/body/p[1]',
    href: 'ch1.xhtml',
    percentage: 0.1,
    pageNumber: 0,
    label: 'Offline bookmark',
  });

  const remoteAnnotation = {
    id: 99,
    chapterId: 1,
    volumeId: 1,
    seriesId: 1,
    libraryId: 1,
    ownerUserId: 1,
    xPath: '//body/DocFragment[1]/body/p[1]',
    endingXPath: '//body/DocFragment[1]/body/p[1]',
    selectedText: 'Offline highlight',
    comment: '',
    commentHtml: '<p>Offline note</p>',
    commentPlainText: 'Offline note',
    chapterTitle: null,
    context: 'Offline highlight',
    highlightCount: 17,
    containsSpoiler: false,
    pageNumber: 0,
    selectedSlotIndex: 0,
    createdUtc: '2026-09-07T00:00:00Z',
    lastModifiedUtc: '2026-09-07T00:00:00Z',
  };

  const client = {
    saveProgress: vi.fn().mockResolvedValue(undefined),
    createAnnotation: vi.fn().mockResolvedValue(remoteAnnotation),
    updateAnnotation: vi.fn().mockImplementation(async (input: { note: string }) => ({
      ...remoteAnnotation,
      commentPlainText: input.note,
    })),
    deleteAnnotation: vi.fn().mockResolvedValue(undefined),
    getAnnotations: vi.fn().mockResolvedValue([]),
    createPersonalToc: vi
      .fn()
      // First call simulates duplicate 400 retry recovery from an earlier interrupted response
      .mockRejectedValueOnce(new KavitaError('Duplicate PToC', 'server', 400))
      .mockResolvedValue(undefined),
    deletePersonalToc: vi.fn().mockResolvedValue(undefined),
    getPersonalToc: vi.fn().mockResolvedValue([
      {
        id: 77,
        chapterId: 1,
        pageNumber: 0,
        title: 'Offline bookmark',
        bookScrollId: '//body/DocFragment[1]/body/p[1]',
        selectedText: null,
        chapterTitle: null,
      },
    ]),
  };

  await flushProgress(client as never, 'server');
  expect(client.createAnnotation).toHaveBeenCalledOnce();
  expect(client.createPersonalToc).toHaveBeenCalledOnce();
  await expect(getSyncStatus('server')).resolves.toMatchObject({ pendingCount: 0, failedCount: 0 });

  // Edit note + rename bookmark offline, then flush
  await updateBookAnnotationNote(book.id, createdAnnotation!.id, 'Updated note');
  await renameBookBookmark(book.id, createdBookmark!.id, 'Renamed bookmark');
  await flushProgress(client as never, 'server');

  expect(client.updateAnnotation).toHaveBeenCalledWith(
    expect.objectContaining({ id: 99, note: 'Updated note' }),
  );
  expect(client.deletePersonalToc).toHaveBeenCalledWith(1, 0, 'Offline bookmark');
  expect(client.createPersonalToc).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: 'Renamed bookmark', pageNumber: 0 }),
  );

  // Delete both offline, then flush
  await deleteBookAnnotation(book.id, createdAnnotation!.id);
  await deleteBookBookmark(book.id, createdBookmark!.id);
  await flushProgress(client as never, 'server');

  expect(client.deleteAnnotation).toHaveBeenCalledWith(99);
  expect(client.deletePersonalToc).toHaveBeenLastCalledWith(1, 0, 'Renamed bookmark');
  await expect(getBookAnnotations(book.id)).resolves.toEqual([]);
  await expect(getBookBookmarks(book.id)).resolves.toEqual([]);
});

it('syncs open-book and library-wide study data while preserving unsynced local edits', async () => {
  await reconcileBooks('server', [book]);
  await saveBookAnnotation(book.id, {
    cfi: 'epubcfi(/6/2!/4/2/1:0)',
    xpath: '//body/DocFragment[1]/body/p[1]',
    pageNumber: 0,
    excerpt: 'Pending local quote',
    note: 'Pending note',
  });

  const remoteFromKavita = {
    id: 201,
    chapterId: 1,
    volumeId: 1,
    seriesId: 1,
    libraryId: 1,
    ownerUserId: 1,
    xPath: '//body/DocFragment[2]/body/p[3]',
    endingXPath: '//body/DocFragment[2]/body/p[3]',
    selectedText: 'Remote Kavita highlight',
    comment: '',
    commentHtml: '<p>From Kavita web</p>',
    commentPlainText: 'From Kavita web',
    chapterTitle: 'Chapter 2',
    context: 'Remote Kavita highlight',
    highlightCount: 23,
    containsSpoiler: false,
    pageNumber: 1,
    selectedSlotIndex: 0,
    createdUtc: '2026-09-08T00:00:00Z',
    lastModifiedUtc: '2026-09-08T00:00:00Z',
  };

  const client = {
    saveProgress: vi.fn().mockResolvedValue(undefined),
    // Simulate temporary create failure so local item stays pending_create during reconciliation
    createAnnotation: vi.fn().mockRejectedValueOnce(new Error('offline during create')),
    getAnnotations: vi.fn().mockResolvedValue([remoteFromKavita]),
    getPersonalToc: vi.fn().mockResolvedValue([
      {
        id: 301,
        chapterId: 1,
        pageNumber: 1,
        title: 'Remote PToC',
        bookScrollId: '//body/DocFragment[2]/body/p[3]',
        selectedText: null,
        chapterTitle: 'Chapter 2',
      },
    ]),
    getSeriesAnnotations: vi.fn().mockResolvedValue([remoteFromKavita]),
  };

  const synced = await syncBookStudyData(client as never, book);
  expect(synced.annotations.map((item) => item.excerpt).sort()).toEqual([
    'Pending local quote',
    'Remote Kavita highlight',
  ]);
  expect(synced.bookmarks.map((item) => item.label)).toEqual(['Remote PToC']);

  const groups = await syncLibraryAnnotations(client as never, 'server', [book]);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.annotations).toHaveLength(2);
});
