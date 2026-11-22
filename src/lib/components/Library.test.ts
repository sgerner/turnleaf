// @vitest-environment jsdom

import { types } from 'node:util';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BookRecord,
  ServerConfig,
  StoredReadingState,
  SyncStatus,
} from '../database/database';
import type { KavitaProgress } from '../kavita/types';
import type { ReaderLocation } from '../reader/session';

const mocks = vi.hoisted(() => ({
  getBooks:
    vi.fn<
      (serverId: string, options?: { includeDescription?: boolean }) => Promise<BookRecord[]>
    >(),
  getReadingState: vi.fn<(bookId: string) => Promise<StoredReadingState | null>>(),
  getPreferences: vi.fn<(keys: readonly string[]) => Promise<Map<string, string>>>(),
  getSyncStatus: vi.fn<(serverId: string) => Promise<SyncStatus>>(),
  acceptRemoteProgress:
    vi.fn<
      (
        book: BookRecord,
        remote: KavitaProgress,
        expectedRevision: number,
        expectedUpdatedAt: string,
      ) => Promise<boolean>
    >(),
  markDownloaded: vi.fn<(bookId: string, path: string, size: number) => Promise<void>>(),
  markBookCompleted:
    vi.fn<(book: BookRecord, readingState?: StoredReadingState | null) => Promise<void>>(),
  removeDownload: vi.fn<(bookId: string) => Promise<void>>(),
  removeDownloads: vi.fn<(bookIds: readonly string[]) => Promise<void>>(),
  removeServer: vi.fn<(serverId: string) => Promise<void>>(),
  reconcileBooks:
    vi.fn<
      (
        serverId: string,
        books: BookRecord[],
        options?: { preserveMissing?: boolean; snapshotStartedAt?: string },
      ) => Promise<void>
    >(),
  saveLocalProgress:
    vi.fn<
      (
        book: BookRecord,
        cfi: string,
        xpath: string | null,
        percentage: number,
        spineIndex?: number,
      ) => Promise<void>
    >(),
  saveRemoteProgress:
    vi.fn<
      (
        book: BookRecord,
        remote: KavitaProgress,
        expected: StoredReadingState | null,
      ) => Promise<boolean>
    >(),
  saveServer: vi.fn<(config: ServerConfig) => Promise<void>>(),
  setPreference: vi.fn<(key: string, value: string) => Promise<void>>(),
  cacheCover: vi.fn<() => Promise<string>>(),
  clearCoverCache: vi.fn<() => Promise<void>>(),
  cleanupInterruptedEpubDownloads: vi.fn<() => Promise<void>>(),
  deleteAllDownloadedEpubs:
    vi.fn<
      (
        relativePaths?: readonly string[],
      ) => Promise<{ removedPaths: string[]; failedPaths: string[] }>
    >(),
  deleteDownloadedEpub: vi.fn<(relativePath: string) => Promise<void>>(),
  downloadEpub:
    vi.fn<
      (
        downloadUrl: string,
        apiKey: string,
        bookId: string,
        onProgress?: (percent: number) => void,
      ) => Promise<{ relativePath: string; nativeUri: string; webViewUrl: string; size: number }>
    >(),
  verifyDownloadedEpub: vi.fn<
    (relativePath: string) => Promise<{
      relativePath: string;
      nativeUri: string;
      webViewUrl: string;
      size: number;
    } | null>
  >(),
  removeApiKey: vi.fn<(credentialRef: string) => Promise<void>>(),
  saveApiKey: vi.fn<(credentialRef: string, apiKey: string) => Promise<void>>(),
  flushProgress: vi.fn<() => Promise<void>>(),
  getBookSeries: vi.fn<() => Promise<unknown[]>>(),
  getSeriesDetail: vi.fn<() => Promise<{ volumes: unknown[]; incomplete?: boolean }>>(),
  getProgress: vi.fn<(chapterId: number) => Promise<KavitaProgress | null>>(),
  getCover: vi.fn<() => Promise<Blob>>(),
  connected: true,
  readerProps: null as null | {
    bookId: string;
    title: string;
    onBack: () => void;
    onRelocated: (location: ReaderLocation) => void;
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    convertFileSrc: (uri: string) => `web://${uri}`,
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
    exitApp: vi.fn(async () => undefined),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: mocks.connected, connectionType: 'wifi' })),
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
  },
}));

vi.mock('../database/database', () => ({
  getBooks: mocks.getBooks,
  getReadingState: mocks.getReadingState,
  getPreferences: mocks.getPreferences,
  getSyncStatus: mocks.getSyncStatus,
  acceptRemoteProgress: mocks.acceptRemoteProgress,
  markDownloaded: mocks.markDownloaded,
  markBookCompleted: mocks.markBookCompleted,
  removeDownload: mocks.removeDownload,
  removeDownloads: mocks.removeDownloads,
  removeServer: mocks.removeServer,
  reconcileBooks: mocks.reconcileBooks,
  saveLocalProgress: mocks.saveLocalProgress,
  saveRemoteProgress: mocks.saveRemoteProgress,
  saveServer: mocks.saveServer,
  setPreference: mocks.setPreference,
}));

vi.mock('../downloads/native-download', () => ({
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class EpubTransferError extends Error {
    constructor(
      readonly status: number | undefined,
      readonly connectionFailed: boolean,
    ) {
      super('The EPUB transfer failed.');
    }
  },
  cacheCover: mocks.cacheCover,
  clearCoverCache: mocks.clearCoverCache,
  cleanupInterruptedEpubDownloads: mocks.cleanupInterruptedEpubDownloads,
  deleteAllDownloadedEpubs: mocks.deleteAllDownloadedEpubs,
  deleteDownloadedEpub: mocks.deleteDownloadedEpub,
  downloadEpub: mocks.downloadEpub,
  verifyDownloadedEpub: mocks.verifyDownloadedEpub,
}));

vi.mock('../native/credentials', () => ({
  removeApiKey: mocks.removeApiKey,
  saveApiKey: mocks.saveApiKey,
}));

vi.mock('../sync/sync', () => ({
  flushProgress: mocks.flushProgress,
}));

vi.mock('../themes/themes', () => ({
  skeletonThemes: ['vintage', 'fennec'],
  loadTheme: vi.fn(async () => true),
}));

vi.mock('../kavita/client', () => ({
  KavitaError: class KavitaError extends Error {
    constructor(
      readonly kind: string,
      message: string,
      readonly status?: number,
    ) {
      super(message);
    }
  },
  KavitaClient: class {
    coverUrl(seriesId: number): string {
      return `https://books.example.com/api/image/series-cover?seriesId=${seriesId}`;
    }
    downloadUrl(chapterId: number): string {
      return `https://books.example.com/api/Download/chapter?id=${chapterId}`;
    }
    getBookSeries = mocks.getBookSeries;
    getSeriesDetail = mocks.getSeriesDetail;
    getProgress = mocks.getProgress;
    getCover = mocks.getCover;
  },
}));

vi.mock('./Reader.svelte', () => ({
  default: (_anchor: unknown, props: typeof mocks.readerProps) => {
    mocks.readerProps = props;
  },
}));

import Library from './Library.svelte';

const server: ServerConfig = {
  id: 'server',
  displayName: 'Test Kavita',
  baseUrl: 'https://books.example.com',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.0',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

function makeCatalog(count: number, downloadedCount = 0): BookRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const padded = String(index).padStart(5, '0');
    const downloaded = index < downloadedCount;
    return {
      id: `server:1:${index}`,
      serverId: server.id,
      libraryId: 1,
      seriesId: (index % 50) + 1,
      volumeId: index + 1,
      chapterId: index + 1,
      title: `Book ${padded}`,
      author: `Author ${String(index % 25).padStart(2, '0')}`,
      series: `Series ${String(index % 15).padStart(2, '0')}`,
      descriptionHtml: null,
      format: 'epub',
      pages: 100,
      pagesRead: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastReadAt: null,
      downloadPath: downloaded ? `books/server-1-${index}.epub` : null,
      downloadStatus: downloaded ? 'available' : 'none',
      fileSize: downloaded ? 1_048_576 : null,
      remoteAvailable: true,
    };
  });
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  flushSync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

const mountedInstances: Array<Record<string, unknown>> = [];

function renderLibrary(overrides: Partial<{ onServerDeleted: () => void }> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(Library, {
    target,
    props: {
      server,
      apiKey: 'secret-key',
      theme: 'vintage',
      mode: 'dark',
      onThemeChange: vi.fn(),
      onModeChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onServerDeleted: overrides.onServerDeleted ?? vi.fn(),
      onChangeServerAddress: vi.fn(),
    },
  });
  flushSync();
  mountedInstances.push(instance);
  return { target, instance };
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.animate = vi.fn(() => {
    const animation = {
      onfinish: null as (() => void) | null,
      cancel: vi.fn(),
      finish: vi.fn(),
    };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    window.clearTimeout(id);
  });
  window.scrollBy = vi.fn();
  mocks.connected = false;
  mocks.readerProps = null;
  mocks.getPreferences.mockResolvedValue(new Map([['syncFurthest', 'false']]));
  mocks.getSyncStatus.mockResolvedValue({
    pendingCount: 0,
    failedCount: 0,
    lastError: null,
    lastUpdatedAt: null,
  });
  mocks.getBooks.mockResolvedValue([]);
  mocks.getReadingState.mockResolvedValue(null);
  mocks.acceptRemoteProgress.mockResolvedValue(true);
  mocks.markDownloaded.mockResolvedValue(undefined);
  mocks.markBookCompleted.mockResolvedValue(undefined);
  mocks.removeDownload.mockResolvedValue(undefined);
  mocks.removeDownloads.mockResolvedValue(undefined);
  mocks.removeServer.mockResolvedValue(undefined);
  mocks.reconcileBooks.mockResolvedValue(undefined);
  mocks.saveLocalProgress.mockResolvedValue(undefined);
  mocks.saveRemoteProgress.mockResolvedValue(true);
  mocks.saveServer.mockResolvedValue(undefined);
  mocks.setPreference.mockResolvedValue(undefined);
  mocks.cacheCover.mockResolvedValue('web://cover.img');
  mocks.clearCoverCache.mockResolvedValue(undefined);
  mocks.cleanupInterruptedEpubDownloads.mockResolvedValue(undefined);
  mocks.deleteAllDownloadedEpubs.mockImplementation(async (paths = []) => ({
    removedPaths: [...paths],
    failedPaths: [],
  }));
  mocks.deleteDownloadedEpub.mockResolvedValue(undefined);
  mocks.downloadEpub.mockImplementation(async (_url, _key, safeId) => ({
    relativePath: `books/${safeId}.epub`,
    nativeUri: `file://books/${safeId}.epub`,
    webViewUrl: `web://books/${safeId}.epub`,
    size: 2_097_152,
  }));
  mocks.verifyDownloadedEpub.mockImplementation(async (path) => ({
    relativePath: path,
    nativeUri: `file://${path}`,
    webViewUrl: `web://${path}`,
    size: 1_048_576,
  }));
  mocks.removeApiKey.mockResolvedValue(undefined);
  mocks.saveApiKey.mockResolvedValue(undefined);
  mocks.flushProgress.mockResolvedValue(undefined);
  mocks.getBookSeries.mockResolvedValue([]);
  mocks.getSeriesDetail.mockResolvedValue({ volumes: [] });
  mocks.getProgress.mockResolvedValue(null);
});

afterEach(async () => {
  for (const instance of mountedInstances.splice(0)) {
    await unmount(instance);
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('Library.svelte raw catalog state and batched cleanup', () => {
  it.each([500, 5_000, 10_000])(
    'stores %i BookRecord objects in $state.raw without deep proxies',
    async (size) => {
      let proxiedReads = 0;
      let rawReads = 0;
      const catalog = makeCatalog(size, 2).map((book) => {
        const record = { ...book };
        const rawTitle = record.title;
        Object.defineProperty(record, 'title', {
          enumerable: true,
          configurable: true,
          get() {
            if (types.isProxy(this)) proxiedReads += 1;
            else rawReads += 1;
            return rawTitle;
          },
        });
        return record;
      });
      mocks.getBooks.mockResolvedValueOnce(catalog);

      const { target } = renderLibrary();
      await settle();

      expect(target.textContent).toContain(`${size} of ${size} books`);
      expect(rawReads).toBeGreaterThan(size);
      expect(proxiedReads).toBe(0);
    },
  );

  it('skips reassigning and resorting books when refreshCatalog returns identical ordered rows', async () => {
    mocks.connected = true;
    const initial = makeCatalog(500, 3);
    let refreshedTitleReads = 0;
    const refreshedIdentical = makeCatalog(500, 3).map((book) => {
      const record = { ...book };
      const rawTitle = record.title;
      Object.defineProperty(record, 'title', {
        enumerable: true,
        configurable: true,
        get() {
          refreshedTitleReads += 1;
          return rawTitle;
        },
      });
      return record;
    });
    const refreshGate = createDeferred<void>();
    mocks.reconcileBooks.mockImplementationOnce(() => refreshGate.promise);
    mocks.getBooks.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshedIdentical);

    const { target } = renderLibrary();
    await settle();
    expect(target.textContent).toContain('500 of 500 books');

    const localeSpy = vi.spyOn(String.prototype, 'localeCompare');
    refreshGate.resolve();
    await settle();

    expect(mocks.reconcileBooks).toHaveBeenCalledOnce();
    expect(mocks.getBooks).toHaveBeenCalledTimes(2);
    expect(localeSpy).not.toHaveBeenCalled();
    // areBookListsEqual compares fields once to verify equality, then skips reassigning books:
    expect(refreshedTitleReads).toBe(500);
  });

  it.each(['title', 'author'] as const)(
    'skips localeCompare when sortOrder is %s across single-book progress and download updates',
    async (order) => {
      mocks.connected = true;
      const catalog = makeCatalog(500, 1);
      mocks.getPreferences.mockResolvedValueOnce(
        new Map([
          ['syncFurthest', 'false'],
          ['librarySort', order],
        ]),
      );
      mocks.getBooks.mockResolvedValue(catalog);
      const { target } = renderLibrary();
      await settle();

      const localeSpy = vi.spyOn(String.prototype, 'localeCompare');

      // 1. Download an undownloaded book: persists to SQLite first, updates storage total & card without localeCompare.
      const downloadDeferred = createDeferred<void>();
      mocks.markDownloaded.mockImplementationOnce(() => downloadDeferred.promise);

      const targetIndex = order === 'author' ? 25 : 1;
      const targetBook = catalog[targetIndex]!;
      const actionBtn = target.querySelector<HTMLButtonElement>(
        `[aria-label="Book actions for ${targetBook.title}"]`,
      );
      expect(actionBtn).not.toBeNull();
      actionBtn!.click();
      await settle();

      const downloadForOffline = Array.from(target.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Download for offline'),
      );
      expect(downloadForOffline).toBeDefined();
      downloadForOffline!.click();
      await settle();

      // Before markDownloaded resolves, book is not yet marked offline in memory.
      expect(
        target.querySelector(
          `[aria-label="Open ${targetBook.title}, downloaded for offline reading"]`,
        ),
      ).toBeNull();

      downloadDeferred.resolve();
      await settle();

      expect(
        target.querySelector(
          `[aria-label="Open ${targetBook.title}, downloaded for offline reading"]`,
        ),
      ).not.toBeNull();

      // Open settings to check storage total updated (1.0 MB + 2.0 MB = 3.0 MB).
      target.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
      await settle();
      expect(target.textContent).toContain('3.0 MB');
      target.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click();
      await settle();

      // 2. Relocated inside Reader: persists first, updates continueBook and visibleBooks without localeCompare.
      const downloadedBook = catalog[0]!;
      target
        .querySelector<HTMLButtonElement>(
          `[aria-label="Open ${downloadedBook.title}, downloaded for offline reading"]`,
        )!
        .click();
      await settle();
      expect(mocks.readerProps).not.toBeNull();

      const progressDeferred = createDeferred<void>();
      mocks.saveLocalProgress.mockImplementationOnce(() => progressDeferred.promise);
      mocks.readerProps!.onRelocated({
        cfi: 'epubcfi(/6/4)',
        xpath: '/html/body/p[1]',
        percentage: 0.45,
        spineIndex: 44,
        href: 'chapter-45.xhtml',
        pageIndex: 0,
        pageCount: 1,
      });
      await settle();
      progressDeferred.resolve();
      await settle();

      mocks.readerProps!.onBack();
      await settle();

      expect(
        target.querySelector(
          `[aria-label="Continue reading ${downloadedBook.title}, 45% complete"]`,
        ),
      ).not.toBeNull();

      // 3. continueFromKavita on conflict: persists first, updates progress without localeCompare.
      mocks.getReadingState.mockResolvedValueOnce({
        cfi: 'epubcfi(/6/4)',
        xpath: '/html/body/p[1]',
        percentage: 0.45,
        localUpdatedAt: '2026-02-01T00:00:00.000Z',
        syncedLocalUpdatedAt: null,
        serverUpdatedAt: null,
        pendingSync: true,
        syncRevision: 2,
      });
      mocks.getProgress.mockResolvedValueOnce({
        libraryId: 1,
        seriesId: 1,
        volumeId: 1,
        chapterId: 1,
        pageNum: 80,
        bookScrollId: '/html/body/p[8]',
        lastModifiedUtc: '2026-02-02T00:00:00.000Z',
      });

      target
        .querySelector<HTMLButtonElement>(
          `[aria-label="Open ${downloadedBook.title}, downloaded for offline reading, 45% complete"]`,
        )!
        .click();
      await settle();

      const acceptDeferred = createDeferred<boolean>();
      mocks.acceptRemoteProgress.mockImplementationOnce(() => acceptDeferred.promise);
      const continueFromKavitaBtn = Array.from(target.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Continue from Kavita'),
      );
      expect(continueFromKavitaBtn).toBeDefined();
      continueFromKavitaBtn!.click();
      await settle();

      expect(target.textContent).toContain('Saving choice');
      acceptDeferred.resolve(true);
      await settle();
      mocks.readerProps!.onBack();
      await settle();

      expect(
        target.querySelector(
          `[aria-label="Continue reading ${downloadedBook.title}, 80% complete"]`,
        ),
      ).not.toBeNull();

      // 4. Remove single download: persists first, updates storage total without localeCompare.
      target
        .querySelector<HTMLButtonElement>(`[aria-label="Book actions for ${targetBook.title}"]`)!
        .click();
      await settle();
      const removeBtn = Array.from(target.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Remove download'),
      );
      expect(removeBtn).toBeDefined();
      removeBtn!.click();
      await settle();
      expect(mocks.removeDownload).toHaveBeenCalledWith(targetBook.id);

      // 5. Mark as read: persists first, hides completed book from visibleBooks and clears continueBook without localeCompare.
      const completeDeferred = createDeferred<void>();
      mocks.markBookCompleted.mockImplementationOnce(() => completeDeferred.promise);
      target
        .querySelector<HTMLButtonElement>(
          `[aria-label="Book actions for ${downloadedBook.title}"]`,
        )!
        .click();
      await settle();
      const markReadBtn = Array.from(target.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Mark as read'),
      );
      expect(markReadBtn).toBeDefined();
      markReadBtn!.click();
      await settle();

      // Still visible before markBookCompleted resolves.
      expect(target.textContent).toContain('500 of 500 books');
      completeDeferred.resolve();
      await settle();

      expect(target.textContent).toContain('499 of 500 books');
      expect(target.textContent).not.toContain('Continue reading');

      expect(localeSpy).not.toHaveBeenCalled();
    },
  );

  it('batches removeAllDownloads into one filesystem cleanup and one SQLite write while blocking overlaps', async () => {
    const catalog = makeCatalog(500, 500);
    mocks.getBooks.mockResolvedValueOnce(catalog);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { target } = renderLibrary();
    await settle();

    const cleanupDeferred = createDeferred<{ removedPaths: string[]; failedPaths: string[] }>();
    mocks.deleteAllDownloadedEpubs.mockImplementationOnce(() => cleanupDeferred.promise);

    target.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await settle();
    expect(target.textContent).toContain('500.0 MB');

    const removeAllBtn = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Remove all downloaded books'),
    )!;
    removeAllBtn.click();
    await settle();

    // While cleanupInProgress is active, overlapping single-book removal is blocked.
    target.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click();
    await settle();
    target.querySelector<HTMLButtonElement>('[aria-label="Book actions for Book 00000"]')!.click();
    await settle();
    const singleRemoveBtn = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Remove download'),
    )!;
    singleRemoveBtn.click();
    await settle();
    expect(mocks.removeDownload).not.toHaveBeenCalled();
    expect(target.textContent).toContain(
      'Wait for the current download or cleanup to finish before removing a book.',
    );

    cleanupDeferred.resolve({
      removedPaths: catalog.map((book) => book.downloadPath!),
      failedPaths: [],
    });
    await settle();

    expect(mocks.deleteAllDownloadedEpubs).toHaveBeenCalledOnce();
    expect(mocks.removeDownloads).toHaveBeenCalledExactlyOnceWith(catalog.map((book) => book.id));
    expect(mocks.removeDownload).not.toHaveBeenCalled();
    expect(target.textContent).toContain('Removed 500 downloaded books. Kavita was not changed.');

    target.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await settle();
    expect(target.textContent).toContain('0.0 MB');
  });

  it('reports failed files during partial removeAllDownloads cleanup and updates SQLite only for removed files', async () => {
    const catalog = makeCatalog(4, 3);
    mocks.getBooks.mockResolvedValueOnce(catalog);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.deleteAllDownloadedEpubs.mockResolvedValueOnce({
      removedPaths: ['books/server-1-0.epub'],
      failedPaths: ['books/server-1-1.epub', 'books/server-1-2.epub'],
    });

    const { target } = renderLibrary();
    await settle();

    target.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await settle();
    Array.from(target.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Remove all downloaded books'))!
      .click();
    await settle();

    expect(mocks.removeDownloads).toHaveBeenCalledExactlyOnceWith(['server:1:0']);
    expect(mocks.removeDownload).not.toHaveBeenCalled();
    expect(target.textContent).toContain(
      '1 download removed; 2 could not be removed (Book 00001, Book 00002). Try again.',
    );

    target.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await settle();
    expect(target.textContent).toContain('2.0 MB');
  });

  it('deletes server via bulk EPUB cleanup and removeServer cascade without per-book removeDownload calls', async () => {
    const catalog = makeCatalog(20, 10);
    mocks.getBooks.mockResolvedValueOnce(catalog);
    const onServerDeleted = vi.fn();

    const { target } = renderLibrary({ onServerDeleted });
    await settle();

    target.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await settle();
    Array.from(target.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Delete server')!
      .click();
    await settle();

    const cleanupDeferred = createDeferred<{ removedPaths: string[]; failedPaths: string[] }>();
    mocks.deleteAllDownloadedEpubs.mockImplementationOnce(() => cleanupDeferred.promise);

    Array.from(target.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Delete now')!
      .click();
    await settle();

    expect(mocks.deleteAllDownloadedEpubs).toHaveBeenCalledExactlyOnceWith(
      catalog.slice(0, 10).map((book) => book.downloadPath!),
    );
    expect(mocks.removeServer).not.toHaveBeenCalled();

    cleanupDeferred.resolve({
      removedPaths: catalog.slice(0, 10).map((book) => book.downloadPath!),
      failedPaths: [],
    });
    await settle();

    expect(mocks.clearCoverCache).toHaveBeenCalledOnce();
    expect(mocks.removeApiKey).toHaveBeenCalledExactlyOnceWith(server.credentialRef);
    expect(mocks.removeServer).toHaveBeenCalledExactlyOnceWith(server.id);
    expect(mocks.removeDownload).not.toHaveBeenCalled();
    expect(mocks.removeDownloads).not.toHaveBeenCalled();
    expect(onServerDeleted).toHaveBeenCalledOnce();
  });
});
