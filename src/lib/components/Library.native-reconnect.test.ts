// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CoreModule from '@capacitor/core';
import type * as SessionModule from '../reader/session';
import type * as ThemesModule from '../themes/themes';
import type { BookRecord, PendingSyncItem, ServerConfig, SyncStatus } from '../database/database';

const state = vi.hoisted(() => {
  const networkListeners = new Set<
    (status: { connected: boolean; connectionType: string }) => void
  >();
  let connected = false;
  let onLine = false;
  let pendingItems: PendingSyncItem[] = [];
  const uploadedPayloads: unknown[] = [];
  let seriesRequests = 0;

  return {
    networkListeners,
    get connected() {
      return connected;
    },
    set connected(value: boolean) {
      connected = value;
    },
    get onLine() {
      return onLine;
    },
    set onLine(value: boolean) {
      onLine = value;
    },
    get pendingItems() {
      return pendingItems;
    },
    set pendingItems(value: PendingSyncItem[]) {
      pendingItems = value;
    },
    uploadedPayloads,
    get seriesRequests() {
      return seriesRequests;
    },
    incrementSeriesRequests() {
      seriesRequests += 1;
    },
    reset() {
      networkListeners.clear();
      connected = false;
      onLine = false;
      pendingItems = [];
      uploadedPayloads.length = 0;
      seriesRequests = 0;
    },
  };
});

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => true,
    },
    CapacitorHttp: {
      ...actual.CapacitorHttp,
      request: vi.fn(async (options: { url: string; method?: string; data?: unknown }) => {
        const url = new URL(options.url);
        if (url.pathname === '/api/Reader/progress') {
          state.uploadedPayloads.push(options.data);
          return { status: 200, headers: {}, data: {}, url: options.url };
        }
        if (url.pathname === '/api/Series/v2') {
          state.incrementSeriesRequests();
          return { status: 200, headers: {}, data: [], url: options.url };
        }
        return { status: 200, headers: {}, data: {}, url: options.url };
      }),
    },
  };
});

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({
      connected: state.connected,
      connectionType: state.connected ? 'wifi' : 'none',
    })),
    addListener: vi.fn(
      async (
        event: string,
        listener: (status: { connected: boolean; connectionType: string }) => void,
      ) => {
        if (event === 'networkStatusChange') state.networkListeners.add(listener);
        return {
          remove: async () => {
            state.networkListeners.delete(listener);
          },
        };
      },
    ),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
    exitApp: vi.fn(async () => undefined),
  },
}));

vi.mock('../downloads/native-download', () => ({
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class EpubTransferError extends Error {},
  cacheBookCover: vi.fn(async () => 'file:///cover.img'),
  cacheCover: vi.fn(async () => 'file:///cover.img'),
  clearCoverCache: vi.fn(async () => undefined),
  cleanupInterruptedEpubDownloads: vi.fn(async () => undefined),
  deleteDownloadedEpub: vi.fn(async () => undefined),
  downloadEpub: vi.fn(async () => ({ relativePath: 'books/book-1.epub', size: 1024 })),
  verifyDownloadedEpub: vi.fn(async (path: string) => ({
    relativePath: path,
    webViewUrl: `capacitor://localhost/${path}`,
  })),
}));

vi.mock('../native/credentials', () => ({
  saveApiKey: vi.fn(async () => undefined),
  removeApiKey: vi.fn(async () => undefined),
}));

vi.mock('../themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    skeletonThemes: ['fennec', 'vintage'],
    loadTheme: vi.fn(async () => true),
  };
});

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    ReaderSession: class MockReaderSession {
      open = vi.fn(async () => undefined);
      next = vi.fn(async () => undefined);
      prev = vi.fn(async () => undefined);
      goTo = vi.fn(async () => undefined);
      tableOfContents = () => [];
      getVisiblePassages = () => [];
      clearTextSelection = vi.fn();
      updateHighlights = vi.fn();
      destroy = vi.fn();
    },
  };
});

const seededBook: BookRecord = {
  id: 'server-1:1:1',
  serverId: 'server-1',
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 1,
  title: 'Turnleaf CI EPUB',
  author: 'Author',
  series: null,
  descriptionHtml: null,
  format: 'epub',
  pages: 2,
  pagesRead: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  lastReadAt: '2026-09-02T00:00:00.000Z',
  downloadPath: 'books/book-1.epub',
  downloadStatus: 'available',
  fileSize: 2048,
};

vi.mock('../database/database', () => ({
  getBooks: vi.fn(async () => [{ ...seededBook }]),
  getBookDescription: vi.fn(async () => null),
  getPreferences: vi.fn(async () => new Map<string, string>()),
  setPreference: vi.fn(async () => undefined),
  setPreferences: vi.fn(async () => undefined),
  getReadingState: vi.fn(async () => ({
    cfi: 'epubcfi(/6/4!/4/2)',
    xpath: '//body/DocFragment[2]/body/h1',
    percentage: 0.5,
    localUpdatedAt: '2026-09-02T00:00:00.000Z',
    syncedLocalUpdatedAt: null,
    serverUpdatedAt: null,
    pendingSync: state.pendingItems.length > 0,
  })),
  getPendingSync: vi.fn(async () => [...state.pendingItems]),
  confirmSync: vi.fn(async (bookId: string) => {
    state.pendingItems = state.pendingItems.filter((item) => item.bookId !== bookId);
  }),
  recordSyncFailure: vi.fn(async () => undefined),
  getSyncStatus: vi.fn(async (): Promise<SyncStatus> => ({
    pendingCount: state.pendingItems.length,
    failedCount: 0,
    lastError: null,
    lastUpdatedAt: null,
  })),
  reconcileBooks: vi.fn(async () => undefined),
  saveLocalProgress: vi.fn(async () => undefined),
  saveRemoteProgress: vi.fn(async () => true),
  markBookCompleted: vi.fn(async () => undefined),
  markDownloaded: vi.fn(async () => undefined),
  removeDownload: vi.fn(async () => undefined),
  removeServer: vi.fn(async () => undefined),
  saveServer: vi.fn(async () => undefined),
}));

const server: ServerConfig = {
  id: 'server-1',
  displayName: 'Kavita',
  baseUrl: 'http://127.0.0.1:5000',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.0',
  lastConnectedAt: '2026-09-01T00:00:00.000Z',
};

async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

describe('Library native reconnect while Reader is open', () => {
  let target: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;

  beforeEach(() => {
    state.reset();
    state.pendingItems = [
      {
        bookId: seededBook.id,
        payload: JSON.stringify({
          libraryId: 1,
          seriesId: 1,
          volumeId: 1,
          chapterId: 1,
          pageNum: 1,
          bookScrollId: '//body/DocFragment[2]/body/h1',
        }),
        revision: 1,
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
    ];
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => state.onLine,
    });
    if (!Element.prototype.animate) {
      Element.prototype.animate = () =>
        ({
          cancel: () => {},
          finish: () => {},
          onfinish: null,
          finished: Promise.resolve(),
        }) as unknown as Animation;
    }
    target = document.createElement('div');
    target.className = 'app-stage';
    document.body.appendChild(target);
  });

  afterEach(async () => {
    if (mounted) {
      await unmount(mounted);
      mounted = null;
    }
    target.remove();
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
    });
  });

  it('waits for WebView navigator.onLine to catch up after native reconnect while Reader is open and uploads queued progress', async () => {
    const Library = (await import('./Library.svelte')).default;
    mounted = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'test-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });

    await waitForCondition(() => Boolean(target.querySelector('[data-book-open]')));

    // Open downloaded book while offline (mirrors android-reading-journey after restart)
    target.querySelector<HTMLButtonElement>('[data-book-open]')!.click();
    flushSync();
    await waitForCondition(() =>
      Boolean(
        target.querySelector(
          '[aria-label="Show reading controls"], [aria-label="Back to library"]',
        ),
      ),
    );

    // Native Network plugin reports connected=true BEFORE WebView navigator.onLine flips to true
    state.connected = true;
    state.onLine = false;
    for (const listener of state.networkListeners) {
      listener({ connected: true, connectionType: 'wifi' });
    }
    await new Promise((resolve) => setTimeout(resolve, 180));

    // Must not fail or drop the queued upload while WebView still reports navigator.onLine === false
    expect(state.uploadedPayloads).toHaveLength(0);
    expect(state.pendingItems).toHaveLength(1);
    expect(state.seriesRequests).toBe(0);

    // WebView updates navigator.onLine = true and dispatches 'online' while Reader remains open
    state.onLine = true;
    window.dispatchEvent(new Event('online'));

    await waitForCondition(() => state.uploadedPayloads.length === 1);
    expect(state.uploadedPayloads[0]).toMatchObject({
      chapterId: 1,
      bookScrollId: '//body/DocFragment[2]/body/h1',
    });
    expect(state.pendingItems).toHaveLength(0);
    // Catalog refresh remains deferred while Reader is open
    expect(state.seriesRequests).toBe(0);
  });
});
