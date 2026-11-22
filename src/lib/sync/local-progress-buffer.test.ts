// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookRecord } from '../database/database';
import type { ReaderLocation } from '../reader/session';
import { createLocalProgressBuffer } from './local-progress-buffer';

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

const book: BookRecord = {
  id: 'book-1',
  serverId: 'server-1',
  libraryId: 1,
  seriesId: 10,
  volumeId: 20,
  chapterId: 30,
  title: 'Example Book',
  author: 'Author',
  series: 'Series',
  descriptionHtml: null,
  format: 'epub',
  pages: 100,
  pagesRead: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: null,
  downloadPath: 'books/book-1.epub',
  downloadStatus: 'downloaded',
  fileSize: 1024,
};

function makeLocation(page: number): ReaderLocation {
  return {
    cfi: `epubcfi(/6/2!/4/2/${page}:0)`,
    xpath: `//body/DocFragment[1]/body/p[${page}]`,
    href: 'chapter-1.xhtml',
    percentage: page / 100,
    spineIndex: 0,
    pageIndex: page - 1,
    pageCount: 100,
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  localStorage.clear();
});

describe('createLocalProgressBuffer', () => {
  it('retains locations that fail with SQLITE_BUSY and retries them on flush', async () => {
    const write = vi
      .fn<(target: BookRecord, location: ReaderLocation) => Promise<void>>()
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockResolvedValueOnce(undefined);
    const buffer = createLocalProgressBuffer(write);
    const page2 = makeLocation(2);

    await expect(buffer.queue(book, page2)).rejects.toThrow('SQLITE_BUSY');
    expect(buffer.hasPending(book.id)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);

    await expect(buffer.flush()).resolves.toBeUndefined();
    expect(buffer.hasPending(book.id)).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(2, book, page2);
  });

  it('serializes writes and coalesces superseded intermediate locations per book', async () => {
    let inFlight = 0;
    let maxConcurrency = 0;
    let releaseFirst!: () => void;
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const write = vi.fn(async (_target: BookRecord, location: ReaderLocation) => {
      inFlight += 1;
      maxConcurrency = Math.max(maxConcurrency, inFlight);
      try {
        if (location.pageIndex === 1) {
          notifyFirstStarted();
          await firstGate;
        }
      } finally {
        inFlight -= 1;
      }
    });

    const buffer = createLocalProgressBuffer(write);
    const page2 = makeLocation(2);
    const page3 = makeLocation(3);
    const page4 = makeLocation(4);

    const p2 = buffer.queue(book, page2);
    await firstStarted;
    const p3 = buffer.queue(book, page3);
    const p4 = buffer.queue(book, page4);

    releaseFirst();
    await Promise.all([p2, p3, p4]);

    expect(maxConcurrency).toBe(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.map(([, loc]) => loc.cfi)).toEqual([page2.cfi, page4.cfi]);
    expect(buffer.hasPending(book.id)).toBe(false);
  });

  it('replaces a failed write with a newer location and resolves when the newer write succeeds', async () => {
    let releaseFirstFailure!: () => void;
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const firstFailureGate = new Promise<void>((resolve) => {
      releaseFirstFailure = resolve;
    });

    const write = vi.fn(async (_target: BookRecord, location: ReaderLocation) => {
      if (location.pageIndex === 1) {
        notifyFirstStarted();
        await firstFailureGate;
        throw new Error('SQLITE_BUSY');
      }
    });

    const buffer = createLocalProgressBuffer(write);
    const first = buffer.queue(book, makeLocation(2));
    await firstStarted;
    const second = buffer.queue(book, makeLocation(5));

    releaseFirstFailure();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(write.mock.calls.map(([, loc]) => loc.pageIndex)).toEqual([1, 4]);
    expect(buffer.hasPending(book.id)).toBe(false);
  });

  it('drops buffered retries for a cleared book while preserving other books', async () => {
    const otherBook: BookRecord = { ...book, id: 'book-2', chapterId: 31 };
    const write = vi
      .fn<(target: BookRecord, location: ReaderLocation) => Promise<void>>()
      .mockRejectedValueOnce(new Error('SQLITE_BUSY'))
      .mockRejectedValueOnce(new Error('SQLITE_BUSY'))
      .mockResolvedValue(undefined);
    const buffer = createLocalProgressBuffer(write);

    await expect(
      Promise.all([buffer.queue(book, makeLocation(3)), buffer.queue(otherBook, makeLocation(7))]),
    ).rejects.toThrow();

    buffer.clear(book.id);
    expect(buffer.hasPending(book.id)).toBe(false);
    expect(buffer.hasPending(otherBook.id)).toBe(true);

    await buffer.flush();
    expect(write).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenLastCalledWith(otherBook, expect.objectContaining({ pageIndex: 6 }));
    expect(buffer.hasPending(otherBook.id)).toBe(false);
  });

  it('persists coalesced locations through saveLocalProgress by default', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        serverConfig: null,
        books: [{ ...book }],
        readingState: {},
        syncQueue: {},
        preferences: {},
      }),
    );

    const buffer = createLocalProgressBuffer();
    const finalLocation = { ...makeLocation(25), spineIndex: 4 };
    await buffer.queue(book, finalLocation);

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      books: BookRecord[];
      readingState: Record<string, { cfi: string; xpath: string | null; percentage: number }>;
    };
    expect(saved.readingState[book.id]).toMatchObject({
      cfi: finalLocation.cfi,
      xpath: finalLocation.xpath,
      percentage: 0.25,
    });
    expect(saved.books[0]?.pagesRead).toBe(5);
  });
});
