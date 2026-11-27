// @vitest-environment jsdom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let connected = true;
  let platform: 'web' | 'android' = 'web';
  const networkListeners = new Set<(status: { connected: boolean }) => void>();
  return {
    get connected() {
      return connected;
    },
    get platform() {
      return platform;
    },
    setPlatform(next: 'web' | 'android') {
      platform = next;
    },
    setConnected(next: boolean, notify = false) {
      connected = next;
      if (notify) {
        for (const listener of networkListeners) {
          listener({ connected: next });
        }
      }
    },
    emitNetworkEvent(connectedEvent: boolean) {
      for (const listener of networkListeners) {
        listener({ connected: connectedEvent });
      }
    },
    resetListeners() {
      networkListeners.clear();
    },
    networkListeners,
    downloadEpub: vi.fn(),
    verifyDownloadedEpub: vi.fn(),
    deleteDownloadedEpub: vi.fn(),
    cleanupInterruptedEpubDownloads: vi.fn(() => Promise.resolve()),
    cacheCover: vi.fn(() => Promise.reject(new Error('No cover in test'))),
    clearCoverCache: vi.fn(() => Promise.resolve()),
    getBookSeries: vi.fn(),
    getSeriesDetail: vi.fn(),
    getCover: vi.fn(() => Promise.reject(new Error('No cover in test'))),
    getProgress: vi.fn(),
    flushProgress: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => mocks.platform,
    convertFileSrc: (uri: string) => uri,
  },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: mocks.connected })),
    addListener: vi.fn(
      async (_event: string, listener: (status: { connected: boolean }) => void) => {
        mocks.networkListeners.add(listener);
        return {
          remove: async () => {
            mocks.networkListeners.delete(listener);
          },
        };
      },
    ),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => {} })),
    exitApp: vi.fn(async () => {}),
  },
}));

vi.mock('../downloads/native-download', () => {
  class EpubTransferError extends Error {
    constructor(
      readonly status: number | undefined,
      readonly connectionFailed: boolean,
      readonly timedOut = false,
    ) {
      super('The EPUB transfer failed.');
    }
  }
  return {
    EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
    EpubTransferError,
    downloadEpub: mocks.downloadEpub,
    verifyDownloadedEpub: mocks.verifyDownloadedEpub,
    deleteDownloadedEpub: mocks.deleteDownloadedEpub,
    cleanupInterruptedEpubDownloads: mocks.cleanupInterruptedEpubDownloads,
    cacheCover: mocks.cacheCover,
    clearCoverCache: mocks.clearCoverCache,
  };
});

vi.mock('../kavita/client', () => {
  class KavitaError extends Error {
    constructor(
      message: string,
      readonly kind: 'network' | 'authentication' | 'server' | 'invalid-response',
      readonly status?: number,
    ) {
      super(message);
    }
  }
  class KavitaClient {
    constructor(
      readonly baseUrl: string,
      readonly apiKey: string,
    ) {}
    downloadUrl(chapterId: number): string {
      return `${this.baseUrl}/api/Download/chapter?chapterId=${chapterId}`;
    }
    coverUrl(seriesId: number): string {
      return `${this.baseUrl}/api/Series/cover-image?seriesId=${seriesId}`;
    }
    getBookSeries(signal?: AbortSignal) {
      return mocks.getBookSeries(signal);
    }
    getSeriesDetail(seriesId: number, signal?: AbortSignal) {
      return mocks.getSeriesDetail(seriesId, signal);
    }
    getCover() {
      return mocks.getCover();
    }
    getProgress(chapterId: number, signal?: AbortSignal) {
      return mocks.getProgress(chapterId, signal);
    }
  }
  return { KavitaClient, KavitaError };
});

vi.mock('../sync/sync', () => ({
  flushProgress: mocks.flushProgress,
}));

vi.mock('../themes/themes', () => ({
  skeletonThemes: ['vintage', 'fennec'],
  loadTheme: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('./Reader.svelte', () => {
  throw new Error('Reader view stub');
});

import {
  getBooks,
  markDownloaded,
  reconcileBooks,
  resetLocalDatabase,
  saveLocalProgress,
  saveServer,
  type BookRecord,
  type ServerConfig,
} from '../database/database';
import { EpubTransferError } from '../downloads/native-download';
import { KavitaError } from '../kavita/client';
import Library from './Library.svelte';

const server: ServerConfig = {
  id: 'srv-1',
  displayName: 'Home Kavita',
  baseUrl: 'https://kavita.example',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.4',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

function makeBook(
  overrides: Partial<BookRecord> & { chapterId: number; title: string },
): BookRecord {
  const seriesId = overrides.seriesId ?? overrides.chapterId;
  return {
    id: `${server.id}:${seriesId}:${overrides.chapterId}`,
    serverId: server.id,
    libraryId: 1,
    seriesId,
    volumeId: overrides.chapterId,
    author: 'Author Name',
    series: null,
    descriptionHtml: null,
    format: 'epub',
    pages: 100,
    pagesRead: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastReadAt: null,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: null,
    remoteAvailable: true,
    ...overrides,
  };
}

if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = function () {
    const animation = {
      onfinish: null as (() => void) | null,
      cancel: () => {},
      finish: () => {},
      play: () => {},
      pause: () => {},
      reverse: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      finished: Promise.resolve(),
    };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
}

function setupCatalogFromBooks(catalogBooks: BookRecord[]): void {
  mocks.getBookSeries.mockImplementation(async () =>
    catalogBooks.map((book) => ({
      id: book.seriesId,
      libraryId: book.libraryId,
      name: book.title,
      format: 3,
      pages: book.pages,
      pagesRead: book.pagesRead,
      created: book.createdAt,
      latestReadDate: book.lastReadAt ?? '',
      coverImage: null,
    })),
  );
  mocks.getSeriesDetail.mockImplementation(async (seriesId: number) => {
    const book = catalogBooks.find((item) => item.seriesId === seriesId);
    if (!book) {
      return { volumes: [], chapters: [], specials: [], storylineChapters: [], incomplete: false };
    }
    return {
      incomplete: false,
      storylineChapters: [],
      chapters: [],
      specials: [],
      volumes: [
        {
          id: book.volumeId,
          chapters: [
            {
              id: book.chapterId,
              volumeId: book.volumeId,
              title: book.title,
              titleName: book.title,
              pages: book.pages,
              pagesRead: book.pagesRead,
              summary: '',
              format: 3,
              writers: book.author ? [{ name: book.author }] : [],
              lastReadingProgressUtc: book.lastReadAt,
              files: [{ id: book.chapterId, format: 3, bytes: 4096, extension: '.epub' }],
            },
          ],
        },
      ],
    };
  });
}

let mountedComponent: Record<string, unknown> | null = null;
let host: HTMLDivElement | null = null;

async function flushUi(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

function buttonByText(label: string, root: ParentNode = document): HTMLButtonElement | null {
  const buttons = Array.from(root.querySelectorAll('button'));
  return (buttons.find((btn) => btn.textContent?.trim() === label) as HTMLButtonElement) ?? null;
}

async function mountLibrary(props: { onChangeServerAddress?: () => void } = {}) {
  host = document.createElement('div');
  host.className = 'app-stage';
  document.body.appendChild(host);
  mountedComponent = mount(Library, {
    target: host,
    props: {
      server,
      apiKey: 'secret-key',
      theme: 'fennec',
      mode: 'dark',
      onThemeChange: vi.fn(),
      onModeChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onServerDeleted: vi.fn(),
      onChangeServerAddress: props.onChangeServerAddress ?? vi.fn(),
    },
  });
  await vi.waitFor(() => {
    expect(host?.textContent).not.toContain('Opening your saved library...');
  });
  await flushUi();
}

beforeEach(async () => {
  window.localStorage.clear();
  await resetLocalDatabase();
  await saveServer(server);
  mocks.resetListeners();
  mocks.setPlatform('web');
  mocks.setConnected(true, false);
  mocks.downloadEpub.mockReset();
  mocks.verifyDownloadedEpub.mockReset();
  mocks.deleteDownloadedEpub.mockReset().mockResolvedValue(undefined);
  mocks.getBookSeries.mockReset();
  mocks.getSeriesDetail.mockReset();
  mocks.getProgress.mockReset().mockResolvedValue({
    libraryId: 1,
    seriesId: 1,
    volumeId: 1,
    chapterId: 1,
    pageNum: 0,
  });
  mocks.flushProgress.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  if (mountedComponent) {
    await unmount(mountedComponent);
    mountedComponent = null;
  }
  host?.remove();
  host = null;
});

describe('Library download banners, cancellation, and offline guards', () => {
  it('cancels a stalled download on tap and immediately unlocks server and cleanup actions', async () => {
    const stalledBook = makeBook({ chapterId: 1, title: 'Alpha Book' });
    const downloadedBook = makeBook({
      chapterId: 2,
      title: 'Beta Downloaded',
      downloadPath: 'books/srv-1-2-2.epub',
      downloadStatus: 'available',
      fileSize: 8192,
    });
    const thirdBook = makeBook({ chapterId: 3, title: 'Gamma Book' });

    await reconcileBooks(server.id, [stalledBook, downloadedBook, thirdBook]);
    await markDownloaded(downloadedBook.id, 'books/srv-1-2-2.epub', 8192);
    setupCatalogFromBooks([stalledBook, downloadedBook, thirdBook]);

    let capturedSignal: AbortSignal | undefined;
    mocks.downloadEpub.mockImplementationOnce(
      (_url: string, _key: string, _bookId: string, _onProgress?: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    const onChangeServerAddress = vi.fn();
    await mountLibrary({ onChangeServerAddress });

    // Start stalled download of Alpha Book.
    const alphaOpen = document.querySelector<HTMLButtonElement>(
      `[data-book-id="${stalledBook.id}"] [data-book-open]`,
    );
    expect(alphaOpen).not.toBeNull();
    alphaOpen!.click();
    await vi.waitFor(() => expect(mocks.downloadEpub).toHaveBeenCalledTimes(1));
    await flushUi();

    const activeBanner = document.querySelector('[data-banner="active-download"]');
    expect(activeBanner?.textContent).toContain('Downloading Alpha Book...');
    const cancelBtn = buttonByText('Cancel', activeBanner!);
    expect(cancelBtn).not.toBeNull();
    expect(cancelBtn!.className).toContain('min-h-[44px]');

    // Verify actions are locked while download is active.
    document.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await flushUi();
    expect(buttonByText('Change server address')?.disabled).toBe(true);
    expect(buttonByText('Remove all downloaded books')?.disabled).toBe(true);
    document.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click();
    await flushUi();

    document
      .querySelector<HTMLButtonElement>(
        `[data-book-id="${downloadedBook.id}"] [data-book-actions]`,
      )!
      .click();
    await flushUi();
    expect(buttonByText('Remove download')?.disabled).toBe(true);
    document.querySelector<HTMLButtonElement>('[aria-label="Close book actions"]')!.click();
    await flushUi();

    // Tap Cancel.
    cancelBtn!.click();
    await flushUi();

    expect(capturedSignal?.aborted).toBe(true);
    expect(document.querySelector('[data-banner="active-download"]')).toBeNull();
    expect(document.querySelector('[data-banner="status-message"]')?.textContent).toContain(
      'Cancelled download for Alpha Book.',
    );

    // Change server address and Remove all downloaded books are unlocked immediately.
    document.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await flushUi();
    expect(buttonByText('Change server address')?.disabled).toBe(false);
    expect(buttonByText('Remove all downloaded books')?.disabled).toBe(false);
    document.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click();
    await flushUi();

    // Remove download is unlocked immediately.
    document
      .querySelector<HTMLButtonElement>(
        `[data-book-id="${downloadedBook.id}"] [data-book-actions]`,
      )!
      .click();
    await flushUi();
    expect(buttonByText('Remove download')?.disabled).toBe(false);
    document.querySelector<HTMLButtonElement>('[aria-label="Close book actions"]')!.click();
    await flushUi();

    // New downloads are unlocked immediately.
    mocks.downloadEpub.mockResolvedValueOnce({
      relativePath: 'books/srv-1-3-3.epub',
      nativeUri: 'file://books/srv-1-3-3.epub',
      webViewUrl: 'web://books/srv-1-3-3.epub',
      size: 4096,
    });
    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${thirdBook.id}"] [data-book-actions]`)!
      .click();
    await flushUi();
    const downloadThirdBtn = buttonByText('Download for offline');
    expect(downloadThirdBtn?.disabled).toBe(false);
    downloadThirdBtn!.click();
    await vi.waitFor(() => expect(mocks.downloadEpub).toHaveBeenCalledTimes(2));
  });

  it('cancels an active download on disconnect, surfaces Retry download, and keeps it across reconnect', async () => {
    const book = makeBook({ chapterId: 1, title: 'Offline Recovery Book' });
    await reconcileBooks(server.id, [book]);
    setupCatalogFromBooks([book]);

    let capturedSignal: AbortSignal | undefined;
    mocks.downloadEpub.mockImplementationOnce(
      (_url: string, _key: string, _bookId: string, _onProgress?: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    await mountLibrary();

    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${book.id}"] [data-book-open]`)!
      .click();
    await vi.waitFor(() => expect(mocks.downloadEpub).toHaveBeenCalledTimes(1));
    await flushUi();

    const refreshCallsBeforeReconnect = mocks.getBookSeries.mock.calls.length;

    // Drop network connectivity mid-download.
    mocks.setConnected(false, true);
    await flushUi();

    expect(capturedSignal?.aborted).toBe(true);
    expect(document.querySelector('[data-banner="active-download"]')).toBeNull();
    const failureBanner = document.querySelector('[data-banner="download-failure"]');
    expect(failureBanner?.getAttribute('role')).toBe('alert');
    expect(failureBanner?.textContent).toContain('Offline Recovery Book');
    const retryBtnOffline = buttonByText('Retry download', failureBanner!);
    expect(retryBtnOffline).not.toBeNull();
    expect(retryBtnOffline!.disabled).toBe(true);

    // Reconnect to network -> catalog refreshes, but Retry download alert stays visible and enabled.
    mocks.setConnected(true, true);
    await vi.waitFor(() =>
      expect(mocks.getBookSeries.mock.calls.length).toBeGreaterThan(refreshCallsBeforeReconnect),
    );
    await flushUi();

    const failureBannerAfterReconnect = document.querySelector('[data-banner="download-failure"]');
    expect(failureBannerAfterReconnect).not.toBeNull();
    const retryBtnOnline = buttonByText('Retry download', failureBannerAfterReconnect!);
    expect(retryBtnOnline?.disabled).toBe(false);

    // Dismissing clears the alert.
    const dismissBtn = buttonByText('Dismiss', failureBannerAfterReconnect!);
    expect(dismissBtn?.className).toContain('min-h-[44px]');
    dismissBtn!.click();
    await flushUi();
    expect(document.querySelector('[data-banner="download-failure"]')).toBeNull();
  });

  it('clears a failed download alert if the book disappears from Kavita on refresh', async () => {
    const book = makeBook({ chapterId: 1, title: 'Removed Remote Book' });
    await reconcileBooks(server.id, [book]);
    setupCatalogFromBooks([book]);
    mocks.downloadEpub.mockRejectedValueOnce(new EpubTransferError(undefined, true, false));

    await mountLibrary();

    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${book.id}"] [data-book-open]`)!
      .click();
    await vi.waitFor(() => expect(mocks.downloadEpub).toHaveBeenCalledTimes(1));
    await flushUi();
    expect(document.querySelector('[data-banner="download-failure"]')).not.toBeNull();

    // Now the book disappears from Kavita and the user refreshes the catalog.
    setupCatalogFromBooks([]);
    document.querySelector<HTMLButtonElement>('[aria-label="Refresh library"]')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-banner="download-failure"]')).toBeNull(),
    );
  });

  it('shows accurate alerts offline for undownloaded and missing-file books without calling downloadEpub', async () => {
    const undownloaded = makeBook({ chapterId: 1, title: 'Remote Only Book' });
    const missingLocal = makeBook({
      chapterId: 2,
      title: 'Missing File Book',
      downloadPath: 'books/srv-1-2-2.epub',
      downloadStatus: 'available',
      fileSize: 4096,
    });
    await reconcileBooks(server.id, [undownloaded, missingLocal]);
    await markDownloaded(missingLocal.id, 'books/srv-1-2-2.epub', 4096);
    mocks.setConnected(false, false);
    mocks.verifyDownloadedEpub.mockResolvedValue(null);

    await mountLibrary();

    // 1. Tap undownloaded book offline.
    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${undownloaded.id}"] [data-book-open]`)!
      .click();
    await flushUi();

    expect(mocks.downloadEpub).not.toHaveBeenCalled();
    expect(document.querySelector('[data-banner="download-failure"]')?.textContent).toContain(
      'No network connection. Connect to Kavita to download this book.',
    );

    // 2. Tap downloaded book whose local EPUB file is missing while offline.
    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${missingLocal.id}"] [data-book-open]`)!
      .click();
    await vi.waitFor(() =>
      expect(mocks.verifyDownloadedEpub).toHaveBeenCalledWith('books/srv-1-2-2.epub'),
    );
    await flushUi();

    expect(mocks.downloadEpub).not.toHaveBeenCalled();
    const alertText = document.querySelector('[data-banner="download-failure"]')?.textContent ?? '';
    expect(alertText).toContain('The downloaded file is missing.');

    const savedBooks = await getBooks(server.id);
    expect(savedBooks.find((item) => item.id === missingLocal.id)?.downloadPath).toBeNull();
  });

  it('renders Mark as read and Retry sync status messages without a stale Retry download button', async () => {
    const book = makeBook({ chapterId: 1, title: 'Sync Check Book' });
    await reconcileBooks(server.id, [book]);
    await saveLocalProgress(book, 'epubcfi(/6/2!/4/2)', '/body/p[1]', 0.25, 0);
    setupCatalogFromBooks([book]);

    mocks.downloadEpub.mockRejectedValueOnce(new EpubTransferError(undefined, true, false));

    await mountLibrary();

    // Trigger a download failure.
    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${book.id}"] [data-book-open]`)!
      .click();
    await vi.waitFor(() => expect(mocks.downloadEpub).toHaveBeenCalledTimes(1));
    await flushUi();

    expect(document.querySelector('[data-banner="download-failure"]')).not.toBeNull();

    // Trigger Retry sync from the pending sync banner.
    const retrySyncBtn = buttonByText('Retry sync');
    expect(retrySyncBtn).not.toBeNull();
    retrySyncBtn!.click();
    await vi.waitFor(() => expect(mocks.flushProgress).toHaveBeenCalled());
    await flushUi();

    const statusBanner = document.querySelector('[data-banner="status-message"]');
    expect(statusBanner?.textContent).toContain('Reading progress synced.');
    expect(buttonByText('Retry download', statusBanner!)).toBeNull();

    // Dismiss the failed download alert, then trigger Mark as read.
    buttonByText('Dismiss', document.querySelector('[data-banner="download-failure"]')!)!.click();
    await flushUi();

    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${book.id}"] [data-book-actions]`)!
      .click();
    await flushUi();
    buttonByText('Mark as read')!.click();
    await flushUi();

    const markReadBanner = document.querySelector('[data-banner="status-message"]');
    expect(markReadBanner?.textContent).toContain('Sync Check Book marked as read.');
    expect(buttonByText('Retry download')).toBeNull();
  });

  it('cancels an active download and records a recoverable failure when exiting library into reader', async () => {
    const downloadingBook = makeBook({ chapterId: 1, title: 'In-Flight Book' });
    const readyBook = makeBook({
      chapterId: 2,
      title: 'Ready Local Book',
      downloadPath: 'books/srv-1-2-2.epub',
      downloadStatus: 'available',
      fileSize: 4096,
    });
    await reconcileBooks(server.id, [downloadingBook, readyBook]);
    await markDownloaded(readyBook.id, 'books/srv-1-2-2.epub', 4096);
    setupCatalogFromBooks([downloadingBook, readyBook]);
    mocks.verifyDownloadedEpub.mockResolvedValue({
      relativePath: 'books/srv-1-2-2.epub',
      nativeUri: 'file://books/srv-1-2-2.epub',
      webViewUrl: 'web://books/srv-1-2-2.epub',
      size: 4096,
    });

    let capturedSignal: AbortSignal | undefined;
    mocks.downloadEpub.mockImplementationOnce(
      (_url: string, _key: string, _bookId: string, _onProgress?: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    await mountLibrary();

    // Start downloading Book 1.
    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${downloadingBook.id}"] [data-book-open]`)!
      .click();
    await vi.waitFor(() => expect(mocks.downloadEpub).toHaveBeenCalledTimes(1));
    await flushUi();

    // Open already-downloaded Book 2 -> exits library view into Reader.
    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${readyBook.id}"] [data-book-open]`)!
      .click();
    await vi.waitFor(() => expect(buttonByText('Back to library')).not.toBeNull());
    expect(capturedSignal?.aborted).toBe(true);

    // Return to library -> recoverable failure alert for Book 1 is surfaced.
    buttonByText('Back to library')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-banner="download-failure"]')).not.toBeNull(),
    );
    const failureBanner = document.querySelector('[data-banner="download-failure"]')!;
    expect(failureBanner.textContent).toContain('In-Flight Book');
    expect(buttonByText('Retry download', failureBanner)).not.toBeNull();
  });

  it('cancels an active download when the library view unmounts', async () => {
    const book = makeBook({ chapterId: 1, title: 'Unmount Book' });
    await reconcileBooks(server.id, [book]);
    setupCatalogFromBooks([book]);

    let capturedSignal: AbortSignal | undefined;
    mocks.downloadEpub.mockImplementationOnce(
      (_url: string, _key: string, _bookId: string, _onProgress?: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    await mountLibrary();
    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${book.id}"] [data-book-open]`)!
      .click();
    await vi.waitFor(() => expect(mocks.downloadEpub).toHaveBeenCalledTimes(1));

    await unmount(mountedComponent!);
    mountedComponent = null;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('confirms networkStatusChange disconnects with Network.getStatus before cancelling an active download or latching offline', async () => {
    mocks.setPlatform('android');
    const book = makeBook({ chapterId: 1, title: 'Dual Radio Book' });
    await reconcileBooks(server.id, [book]);
    setupCatalogFromBooks([book]);

    let capturedSignal: AbortSignal | undefined;
    let resolveDownload: ((value: unknown) => void) | undefined;
    mocks.downloadEpub.mockImplementationOnce(
      (_url: string, _key: string, _bookId: string, _onProgress?: unknown, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          capturedSignal = signal;
          resolveDownload = resolve;
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    await mountLibrary();
    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${book.id}"] [data-book-open]`)!
      .click();
    await vi.waitFor(() => expect(mocks.downloadEpub).toHaveBeenCalledTimes(1));
    await flushUi();

    // Android NetworkPlugin.onLost(cellular) emits connected=false while Wi-Fi remains connected in getStatus().
    mocks.setConnected(true, false);
    mocks.emitNetworkEvent(false);
    await flushUi();

    expect(capturedSignal?.aborted).toBe(false);
    expect(document.querySelector('[data-banner="active-download"]')).not.toBeNull();
    expect(document.querySelector('[data-banner="download-failure"]')).toBeNull();

    resolveDownload?.({
      relativePath: 'books/srv-1-1-1.epub',
      nativeUri: 'file://books/srv-1-1-1.epub',
      webViewUrl: 'web://books/srv-1-1-1.epub',
      size: 4096,
    });
    mocks.verifyDownloadedEpub.mockResolvedValue({
      relativePath: 'books/srv-1-1-1.epub',
      nativeUri: 'file://books/srv-1-1-1.epub',
      webViewUrl: 'web://books/srv-1-1-1.epub',
      size: 4096,
    });
    await vi.waitFor(() => expect(buttonByText('Back to library')).not.toBeNull());
  });

  it('flushes queued reading progress concurrently with catalog refresh on reconnect while keeping a disconnect failure banner actionable', async () => {
    mocks.setPlatform('android');
    const book = makeBook({ chapterId: 1, title: 'Queued Sync Book' });
    await reconcileBooks(server.id, [book]);
    await saveLocalProgress(book, 'epubcfi(/6/4!/4/2)', '//body/h1[1]', 0.5, 1);
    setupCatalogFromBooks([book]);

    mocks.downloadEpub.mockImplementationOnce(
      (_url: string, _key: string, _bookId: string, _onProgress?: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    await mountLibrary();
    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${book.id}"] [data-book-open]`)!
      .click();
    await vi.waitFor(() => expect(mocks.downloadEpub).toHaveBeenCalledTimes(1));

    // Confirm real disconnect -> download cancels into failure alert while device goes offline.
    mocks.setConnected(false, true);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-banner="download-failure"]')?.textContent).toContain(
        'Connection lost while downloading Queued Sync Book.',
      ),
    );
    expect(buttonByText('Retry download')?.disabled).toBe(true);

    const callOrder: string[] = [];
    let resolveCatalog: ((value: unknown[]) => void) | undefined;
    mocks.flushProgress.mockClear().mockImplementation(async () => {
      callOrder.push('flushProgress');
    });
    mocks.getBookSeries.mockClear().mockImplementation(
      () =>
        new Promise((resolve) => {
          callOrder.push('getBookSeries:start');
          resolveCatalog = resolve;
        }),
    );

    // Reconnect with a trailing false cellular onLost event while Wi-Fi is connected.
    mocks.setConnected(true, false);
    mocks.emitNetworkEvent(false);

    // flushProgress must start and finish without waiting for getBookSeries to resolve.
    await vi.waitFor(() => {
      expect(mocks.flushProgress).toHaveBeenCalledTimes(1);
      expect(mocks.getBookSeries).toHaveBeenCalledTimes(1);
    });
    expect(callOrder).toContain('flushProgress');
    expect(callOrder).toContain('getBookSeries:start');
    expect(document.querySelector('[data-banner="download-failure"]')?.textContent).toContain(
      'Connection lost while downloading Queued Sync Book.',
    );
    expect(buttonByText('Retry download')?.disabled).toBe(false);

    resolveCatalog?.([
      {
        id: book.seriesId,
        libraryId: book.libraryId,
        name: book.title,
        format: 3,
        pages: book.pages,
        pagesRead: book.pagesRead,
        created: book.createdAt,
        latestReadDate: book.lastReadAt ?? '',
        coverImage: null,
      },
    ]);
    await flushUi();
    expect(document.querySelector('[data-banner="download-failure"]')?.textContent).toContain(
      'Connection lost while downloading Queued Sync Book.',
    );
  });

  it('does not delete a replacement download or show ready-offline when cancelled as downloadEpub settles', async () => {
    const book = makeBook({ chapterId: 1, title: 'Late Settlement Book' });
    await reconcileBooks(server.id, [book]);
    setupCatalogFromBooks([book]);

    let resolveFirstDownload: ((value: unknown) => void) | undefined;
    let resolveSecondDownload: ((value: unknown) => void) | undefined;
    mocks.downloadEpub
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstDownload = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondDownload = resolve;
          }),
      );

    await mountLibrary();
    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${book.id}"] [data-book-open]`)!
      .click();
    await vi.waitFor(() => expect(mocks.downloadEpub).toHaveBeenCalledTimes(1));
    await flushUi();

    const activeBanner = document.querySelector('[data-banner="active-download"]');
    buttonByText('Cancel', activeBanner!)!.click();
    await flushUi();
    expect(document.querySelector('[data-banner="status-message"]')?.textContent).toContain(
      'Cancelled download for Late Settlement Book.',
    );

    // Immediately start a replacement download for the same book before the first promise settles.
    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${book.id}"] [data-book-open]`)!
      .click();
    await vi.waitFor(() => expect(mocks.downloadEpub).toHaveBeenCalledTimes(2));

    // Late resolution of the cancelled first attempt must not delete the active book or emit ready offline.
    resolveFirstDownload?.({
      relativePath: 'books/srv-1-1-1.epub',
      nativeUri: 'file://books/srv-1-1-1.epub',
      webViewUrl: 'web://books/srv-1-1-1.epub',
      size: 4096,
      ownerToken: 1,
    });
    await flushUi();
    expect(mocks.deleteDownloadedEpub).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Late Settlement Book is ready offline.');

    mocks.verifyDownloadedEpub.mockResolvedValue({
      relativePath: 'books/srv-1-1-1.epub',
      nativeUri: 'file://books/srv-1-1-1.epub',
      webViewUrl: 'web://books/srv-1-1-1.epub',
      size: 4096,
    });
    resolveSecondDownload?.({
      relativePath: 'books/srv-1-1-1.epub',
      nativeUri: 'file://books/srv-1-1-1.epub',
      webViewUrl: 'web://books/srv-1-1-1.epub',
      size: 4096,
      ownerToken: 2,
    });
    await vi.waitFor(() => expect(buttonByText('Back to library')).not.toBeNull());
  });

  it('passes serverOrigin to downloadEpub and surfaces redirect KavitaError on the decoupled failure alert', async () => {
    const book = makeBook({ chapterId: 1, title: 'Redirect Guard Book' });
    await reconcileBooks(server.id, [book]);
    setupCatalogFromBooks([book]);

    mocks.downloadEpub.mockRejectedValueOnce(
      new KavitaError(
        'Kavita redirected to a different server. Update the saved address to its final address.',
        'server',
        302,
      ),
    );

    await mountLibrary();
    document
      .querySelector<HTMLButtonElement>(`[data-book-id="${book.id}"] [data-book-open]`)!
      .click();
    await vi.waitFor(() => expect(mocks.downloadEpub).toHaveBeenCalledTimes(1));
    await flushUi();

    expect(mocks.downloadEpub.mock.calls[0]?.[4]).toBeInstanceOf(AbortSignal);
    expect(mocks.downloadEpub.mock.calls[0]?.[5]).toBe('https://kavita.example');
    const failureBanner = document.querySelector('[data-banner="download-failure"]');
    expect(failureBanner?.getAttribute('role')).toBe('alert');
    expect(failureBanner?.textContent).toContain('Kavita redirected to a different server.');
    expect(document.querySelector('[data-banner="status-message"]')).toBeNull();
  });
});
