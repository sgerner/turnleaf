// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptRemoteProgress,
  getBooks,
  getPendingSync,
  getReadingState,
  getServer,
  markBookCompleted,
  reconcileBooks,
  removeServer,
  saveLocalProgress,
  saveRemoteProgress,
  saveServer,
  type BookRecord,
  type ServerConfig,
} from '../database/database';
import type { KavitaProgress } from '../kavita/types';
import type { ReaderLocation } from '../reader/session';
import { createLocalProgressBuffer, type LocalProgressWriteContext } from './local-progress-buffer';

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

const server: ServerConfig = {
  id: 'server-1',
  displayName: 'Example Kavita',
  baseUrl: 'https://kavita.example.com',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.4',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

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

function createGate(): {
  started: Promise<void>;
  notifyStarted: () => void;
  gate: Promise<void>;
  release: () => void;
} {
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started, notifyStarted, gate, release };
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
    expect(write).toHaveBeenNthCalledWith(2, book, page2, expect.any(Object));
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

    await buffer.clear(book.id);
    expect(buffer.hasPending(book.id)).toBe(false);
    expect(buffer.hasPending(otherBook.id)).toBe(true);

    await buffer.flush();
    expect(write).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenLastCalledWith(
      otherBook,
      expect.objectContaining({ pageIndex: 6 }),
      expect.any(Object),
    );
    expect(buffer.hasPending(otherBook.id)).toBe(false);
  });

  it('invalidates an in-flight write on clear(bookId), prevents cleared queued versions from starting, and allows subsequent writes', async () => {
    await saveServer(server);
    const secondBook: BookRecord = { ...book, id: 'book-2', chapterId: 31 };
    const thirdBook: BookRecord = { ...book, id: 'book-3', chapterId: 32 };
    await reconcileBooks(server.id, [book, secondBook, thirdBook]);

    const firstWriteGate = createGate();
    const write = vi.fn(
      async (
        target: BookRecord,
        location: ReaderLocation,
        context: LocalProgressWriteContext,
      ): Promise<void> => {
        if (target.id === book.id && location.pageIndex === 1) {
          firstWriteGate.notifyStarted();
          await firstWriteGate.gate;
        }
        await saveLocalProgress(
          target,
          location.cfi,
          location.xpath,
          location.percentage,
          location.spineIndex,
          { shouldCommit: context.isCurrent },
        );
      },
    );
    const buffer = createLocalProgressBuffer(write);

    const p1 = buffer.queue(book, makeLocation(2));
    await firstWriteGate.started;
    const p2 = buffer.queue(secondBook, makeLocation(8));
    const p3 = buffer.queue(thirdBook, makeLocation(12));

    // Clear both the in-flight book and a queued-but-unstarted book while book-1 is gated.
    const clearInFlight = buffer.clear(book.id);
    const clearQueued = buffer.clear(secondBook.id);
    expect(buffer.hasPending(book.id)).toBe(false);
    expect(buffer.hasPending(secondBook.id)).toBe(false);
    expect(buffer.hasPending(thirdBook.id)).toBe(true);

    firstWriteGate.release();
    await Promise.all([p1, p2, p3, clearInFlight, clearQueued]);

    // secondBook's cleared version never started write(); book's in-flight write was invalidated.
    expect(write.mock.calls.map(([target]) => target.id)).toEqual([book.id, thirdBook.id]);
    expect(await getReadingState(book.id)).toBeNull();
    expect(await getReadingState(secondBook.id)).toBeNull();
    expect(await getReadingState(thirdBook.id)).toMatchObject({ percentage: 0.12 });

    // A brand-new relocation after clear still persists normally.
    await buffer.queue(book, makeLocation(20));
    expect(await getReadingState(book.id)).toMatchObject({ percentage: 0.2, pendingSync: true });
  });

  it('orders authoritative remote acceptance and completion after an active gated write so stale writes never overwrite them', async () => {
    await saveServer(server);
    const conflictBook: BookRecord = { ...book, id: 'book-conflict', chapterId: 31 };
    const completedBook: BookRecord = { ...book, id: 'book-complete', chapterId: 32 };
    await reconcileBooks(server.id, [book, conflictBook, completedBook]);

    // Seed conflictBook with an initial pending local revision (revision 1 at 30%).
    await saveLocalProgress(conflictBook, 'epubcfi(/6/2!/4/2/30:0)', '//p[30]', 0.3);
    const conflictLocal = await getReadingState(conflictBook.id);
    expect(conflictLocal).toMatchObject({ pendingSync: true, syncRevision: 1 });

    let activeGate: ReturnType<typeof createGate> | null = null;
    const buffer = createLocalProgressBuffer(async (target, location, context) => {
      if (activeGate) {
        activeGate.notifyStarted();
        await activeGate.gate;
      }
      await saveLocalProgress(
        target,
        location.cfi,
        location.xpath,
        location.percentage,
        location.spineIndex,
        { shouldCommit: context.isCurrent },
      );
    });

    // 1. Start a local write for `book`, accept newer remote progress via saveRemoteProgress, then release.
    activeGate = createGate();
    const oldRemoteWrite = buffer.queue(book, makeLocation(14));
    await activeGate.started;

    const remoteProgress: KavitaProgress = {
      libraryId: book.libraryId,
      seriesId: book.seriesId,
      volumeId: book.volumeId,
      chapterId: book.chapterId,
      pageNum: 72,
      bookScrollId: '//body/DocFragment[1]/body/p[72]',
      lastModifiedUtc: '2026-04-02T10:00:00.000Z',
    };
    const acceptRemote = buffer.runAuthoritative(book.id, () =>
      saveRemoteProgress(book, remoteProgress, null),
    );
    activeGate.release();
    const [, acceptedRemote] = await Promise.all([oldRemoteWrite, acceptRemote]);
    expect(acceptedRemote).toBe(true);
    expect(await getReadingState(book.id)).toMatchObject({
      cfi: '',
      xpath: '//body/DocFragment[1]/body/p[72]',
      percentage: 0.72,
      pendingSync: false,
    });
    expect((await getBooks(server.id)).find((item) => item.id === book.id)?.pagesRead).toBe(72);

    // 2. Start a local write for `conflictBook`, accept conflict remote progress, then release.
    activeGate = createGate();
    const oldConflictWrite = buffer.queue(conflictBook, makeLocation(19));
    await activeGate.started;

    const conflictRemote: KavitaProgress = {
      libraryId: conflictBook.libraryId,
      seriesId: conflictBook.seriesId,
      volumeId: conflictBook.volumeId,
      chapterId: conflictBook.chapterId,
      pageNum: 84,
      bookScrollId: '//body/DocFragment[1]/body/p[84]',
      lastModifiedUtc: '2026-04-02T11:00:00.000Z',
    };
    const acceptConflict = buffer.runAuthoritative(conflictBook.id, () =>
      acceptRemoteProgress(
        conflictBook,
        conflictRemote,
        conflictLocal!.syncRevision!,
        conflictLocal!.localUpdatedAt,
      ),
    );
    activeGate.release();
    const [, acceptedConflict] = await Promise.all([oldConflictWrite, acceptConflict]);
    expect(acceptedConflict).toBe(true);
    expect(await getReadingState(conflictBook.id)).toMatchObject({
      cfi: '',
      xpath: '//body/DocFragment[1]/body/p[84]',
      percentage: 0.84,
      pendingSync: false,
    });
    expect((await getBooks(server.id)).find((item) => item.id === conflictBook.id)?.pagesRead).toBe(
      84,
    );

    // 3. Start a local write for `completedBook`, mark completed, then release.
    activeGate = createGate();
    const oldCompleteWrite = buffer.queue(completedBook, makeLocation(22));
    await activeGate.started;

    const markComplete = buffer.runAuthoritative(completedBook.id, () =>
      markBookCompleted(completedBook),
    );
    activeGate.release();
    await Promise.all([oldCompleteWrite, markComplete]);
    expect(await getReadingState(completedBook.id)).toMatchObject({
      cfi: '',
      percentage: 1,
      pendingSync: true,
    });
    expect(
      (await getBooks(server.id)).find((item) => item.id === completedBook.id)?.pagesRead,
    ).toBe(100);
    const pendingItems = await getPendingSync(server.id);
    expect(pendingItems).toHaveLength(1);
    expect(JSON.parse(pendingItems[0]!.payload)).toMatchObject({
      chapterId: completedBook.chapterId,
      pageNum: 100,
    });
  });

  it('prevents an in-flight local write from recreating deleted reading state after server removal', async () => {
    await saveServer(server);
    await reconcileBooks(server.id, [book]);

    const writeGate = createGate();
    const buffer = createLocalProgressBuffer(async (target, location, context) => {
      writeGate.notifyStarted();
      await writeGate.gate;
      await saveLocalProgress(
        target,
        location.cfi,
        location.xpath,
        location.percentage,
        location.spineIndex,
        { shouldCommit: context.isCurrent },
      );
    });

    const staleWrite = buffer.queue(book, makeLocation(33));
    await writeGate.started;

    const deletion = buffer.runAuthoritative(undefined, () => removeServer(server.id));
    writeGate.release();
    await Promise.all([staleWrite, deletion]);

    expect(await getServer()).toBeNull();
    expect(await getBooks(server.id)).toEqual([]);
    expect(await getReadingState(book.id)).toBeNull();
    expect(await getPendingSync(server.id)).toEqual([]);
    const rawState = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      readingState?: Record<string, unknown>;
      syncQueue?: Record<string, unknown>;
    };
    expect(rawState.readingState).toEqual({});
    expect(rawState.syncQueue).toEqual({});
  });

  it('restores buffered progress for retry if an authoritative write throws', async () => {
    let failSave = true;
    const write = vi.fn(async () => {
      if (failSave) throw new Error('SQLITE_BUSY');
    });
    const buffer = createLocalProgressBuffer(write);
    const location = makeLocation(45);

    await expect(buffer.queue(book, location)).rejects.toThrow('SQLITE_BUSY');
    expect(buffer.hasPending(book.id)).toBe(true);

    await expect(
      buffer.runAuthoritative(book.id, async () => {
        throw new Error('SQLITE_BUSY: mark completed locked');
      }),
    ).rejects.toThrow('SQLITE_BUSY: mark completed locked');
    expect(buffer.hasPending(book.id)).toBe(true);

    failSave = false;
    await expect(buffer.flush()).resolves.toBeUndefined();
    expect(buffer.hasPending(book.id)).toBe(false);
    expect(write).toHaveBeenLastCalledWith(book, location, expect.any(Object));
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
