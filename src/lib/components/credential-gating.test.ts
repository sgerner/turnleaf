// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '../database/database';
import type * as NativeDownloadModule from '../downloads/native-download';
import type * as ThemesModule from '../themes/themes';

const runtime = vi.hoisted(() => ({
  native: true,
  platform: 'android',
  online: true,
  appStateListeners: [] as Array<(event: { isActive: boolean }) => void>,
  networkListeners: [] as Array<(event: { connected: boolean }) => void>,
  selectionCallback: null as
    ((selection: { cfi: string; text: string; href: string } | null) => void) | null,
  relocateCallback: null as
    | ((
        location: {
          cfi: string;
          xpath: string | null;
          href: string;
          label: string | null;
          percentage: number;
          displayedPage: number | null;
          displayedTotal: number | null;
          spineIndex: number | null;
        },
        origin: 'initial' | 'navigation' | 'link',
      ) => void)
    | null,
}));

const secureStorageMock = vi.hoisted(() => ({
  values: new Map<string, string>(),
  throwOnGet: false,
  setKeyPrefix: vi.fn(async () => undefined),
  setSynchronize: vi.fn(async () => undefined),
  get: vi.fn(async (key: string) => {
    if (secureStorageMock.throwOnGet) {
      throw new Error('Keystore unreadable');
    }
    return secureStorageMock.values.get(key) ?? null;
  }),
  set: vi.fn(async (key: string, value: string) => {
    secureStorageMock.values.set(key, value);
  }),
  remove: vi.fn(async (key: string) => {
    secureStorageMock.values.delete(key);
  }),
}));

const nativeDownloadMock = vi.hoisted(() => ({
  verifiedFile: {
    webViewUrl: 'web://books/primary-1.epub',
    relativePath: 'books/primary-1.epub',
    size: 4096,
  } as { webViewUrl: string; relativePath: string; size: number } | null,
  downloadResult: null as
    (() => Promise<{ webViewUrl: string; relativePath: string; size: number }>) | null,
  coverResult: null as
    ((seriesId: number, allowDownload?: boolean, epoch?: number) => Promise<string>) | null,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => runtime.native,
    getPlatform: () => (runtime.native ? runtime.platform : 'web'),
    convertFileSrc: (value: string) => `web://${value}`,
  },
  CapacitorHttp: {
    get: vi.fn(),
    request: vi.fn(),
  },
  registerPlugin: () => ({
    setEnabled: vi.fn(async () => undefined),
  }),
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({
      connected: runtime.online,
      connectionType: runtime.online ? 'wifi' : 'none',
    })),
    addListener: vi.fn(
      async (_event: string, listener: (event: { connected: boolean }) => void) => {
        runtime.networkListeners.push(listener);
        return {
          remove: async () => {
            const index = runtime.networkListeners.indexOf(listener);
            if (index >= 0) runtime.networkListeners.splice(index, 1);
          },
        };
      },
    ),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(
      async (event: string, listener: (payload: { isActive: boolean }) => void) => {
        if (event === 'appStateChange') runtime.appStateListeners.push(listener);
        return {
          remove: async () => {
            const index = runtime.appStateListeners.indexOf(listener);
            if (index >= 0) runtime.appStateListeners.splice(index, 1);
          },
        };
      },
    ),
    exitApp: vi.fn(async () => undefined),
  },
}));

vi.mock('@capacitor/status-bar', () => ({
  Animation: { None: 'NONE' },
  Style: {
    Dark: 'DARK',
    Light: 'LIGHT',
    Default: 'DEFAULT',
  },
  StatusBar: {
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
    setStyle: vi.fn(async () => undefined),
    setBackgroundColor: vi.fn(async () => undefined),
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA', Documents: 'DOCUMENTS' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    writeFile: vi.fn(async () => ({ uri: 'file://notes.md' })),
  },
}));

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: secureStorageMock,
}));

vi.mock('../themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    loadTheme: vi.fn(async () => true),
    skeletonThemes: ['fennec', 'cerberus'],
  };
});

vi.mock('../github/releases', () => ({
  fetchLatestGithubRelease: vi.fn(async () => null),
}));

vi.mock('../database/database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  const wrap =
    <Args extends unknown[], Result>(fn: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      const previous = runtime.native;
      runtime.native = false;
      try {
        return await fn(...args);
      } finally {
        runtime.native = previous;
      }
    };
  return {
    ...actual,
    getServer: wrap(actual.getServer),
    saveServer: wrap(actual.saveServer),
    removeServer: wrap(actual.removeServer),
    getBooks: wrap(actual.getBooks),
    reconcileBooks: wrap(actual.reconcileBooks),
    markDownloaded: wrap(actual.markDownloaded),
    removeDownload: wrap(actual.removeDownload),
    getReadingState: wrap(actual.getReadingState),
    saveLocalProgress: wrap(actual.saveLocalProgress),
    saveRemoteProgress: wrap(actual.saveRemoteProgress),
    acceptRemoteProgress: wrap(actual.acceptRemoteProgress),
    markBookCompleted: wrap(actual.markBookCompleted),
    getSyncStatus: wrap(actual.getSyncStatus),
    getPreferences: wrap(actual.getPreferences),
    setPreference: wrap(actual.setPreference),
  };
});

vi.mock('../downloads/native-download', async (importOriginal) => {
  const actual = await importOriginal<typeof NativeDownloadModule>();
  const { canSendCredential, markCredentialRejected } = await import('../native/credentials');
  return {
    ...actual,
    cleanupInterruptedEpubDownloads: vi.fn(async () => undefined),
    clearCoverCache: vi.fn(async () => undefined),
    deleteDownloadedEpub: vi.fn(async () => undefined),
    verifyDownloadedEpub: vi.fn(async () => nativeDownloadMock.verifiedFile),
    downloadEpub: vi.fn(
      async (
        _url: string,
        apiKey: string,
        _fileStem: string,
        _onProgress?: (percent: number | null) => void,
        _serverOrigin?: string,
        credentialEpoch?: number,
      ) => {
        if (!canSendCredential(apiKey, credentialEpoch)) {
          throw new actual.EpubTransferError(401, false);
        }
        if (nativeDownloadMock.downloadResult) {
          try {
            return await nativeDownloadMock.downloadResult();
          } catch (error) {
            if (error instanceof actual.EpubTransferError && error.status === 401) {
              markCredentialRejected(credentialEpoch, 401);
            }
            throw error;
          }
        }
        return {
          webViewUrl: 'web://books/primary-1.epub',
          relativePath: 'books/primary-1.epub',
          size: 4096,
        };
      },
    ),
    cacheCover: vi.fn(
      async (
        _url: string,
        apiKey: string,
        seriesId: number,
        _signal?: AbortSignal,
        _serverId?: string,
        allowDownload = true,
        _serverOrigin?: string,
        credentialEpoch?: number,
      ) => {
        if (nativeDownloadMock.coverResult) {
          return nativeDownloadMock.coverResult(seriesId, allowDownload, credentialEpoch);
        }
        if (!allowDownload || !canSendCredential(apiKey, credentialEpoch)) {
          throw new Error('Cover not cached');
        }
        throw new Error('Uncached cover network call attempted');
      },
    ),
  };
});

vi.mock('../reader/session', () => ({
  ReaderSession: class MockReaderSession {
    constructor(readonly url: string) {}

    async open(
      _container: HTMLElement,
      initialCfi: string | null,
      initialXPath: string | null,
      initialPercentage: number | null,
      _appearance: unknown,
      onRelocated: NonNullable<typeof runtime.relocateCallback>,
      _onTapZone: unknown,
      onSelection: NonNullable<typeof runtime.selectionCallback>,
    ) {
      runtime.relocateCallback = onRelocated;
      runtime.selectionCallback = onSelection;
      onRelocated(
        {
          cfi: initialCfi ?? 'epubcfi(/6/4!/4/2/1:0)',
          xpath: initialXPath ?? '//body/DocFragment[2]/body/p[1]',
          href: 'Text/chapter-2.xhtml',
          label: 'Chapter 2',
          percentage: initialPercentage ?? 0.5,
          displayedPage: 1,
          displayedTotal: 2,
          spineIndex: 1,
        },
        'initial',
      );
    }

    tableOfContents() {
      return [{ label: 'Chapter 1', href: 'Text/chapter-1.xhtml', children: [] }];
    }

    updateHighlights() {}
    applyAppearance() {}
    getVisiblePassages() {
      return [];
    }
    clearTextSelection() {}

    async next() {
      runtime.relocateCallback?.(
        {
          cfi: 'epubcfi(/6/4!/4/2/3:0)',
          xpath: '//body/DocFragment[2]/body/p[2]',
          href: 'Text/chapter-2.xhtml',
          label: 'Chapter 2',
          percentage: 0.75,
          displayedPage: 2,
          displayedTotal: 2,
          spineIndex: 1,
        },
        'navigation',
      );
    }

    async previous() {}
    async display() {}
    async displayCfi() {
      return true;
    }
    async displayServerLocation() {
      return true;
    }
    async displayServerPercentage() {}

    async search(query: string) {
      return [
        {
          cfi: 'epubcfi(/6/4!/4/2/1:0)',
          href: 'Text/chapter-2.xhtml',
          label: 'Chapter 2',
          excerpt: `Matched ${query} in offline EPUB`,
        },
      ];
    }

    destroy() {}
  },
}));

import { CapacitorHttp } from '@capacitor/core';
import App from '../../App.svelte';
import { clearDiagnostics } from '../diagnostics/log';
import { EpubTransferError, cacheCover, downloadEpub } from '../downloads/native-download';
import { getCredentialState, resetCredentialState } from '../native/credentials';
import type { BookRecord, ServerConfig } from '../database/database';

const DB_STORAGE_KEY = 'turnleaf_browser_database_v1';

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

const savedServer: ServerConfig = {
  id: 'primary',
  displayName: 'Books',
  baseUrl: 'https://books.example.com',
  credentialRef: 'server_primary_api_key',
  kavitaVersion: '0.8.0',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const downloadedBook: BookRecord = {
  id: 'primary:1:1',
  serverId: 'primary',
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 1,
  title: 'Offline Novel',
  author: 'Ada Lovelace',
  series: 'Offline Novel',
  descriptionHtml: null,
  format: 'epub',
  pages: 100,
  pagesRead: 50,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-01-02T00:00:00.000Z',
  downloadPath: 'books/primary-1.epub',
  downloadStatus: 'available',
  fileSize: 4096,
};

const onlineOnlyBook: BookRecord = {
  ...downloadedBook,
  id: 'primary:2:2',
  seriesId: 2,
  volumeId: 2,
  chapterId: 2,
  title: 'Remote Novel',
  pagesRead: 0,
  lastReadAt: null,
  downloadPath: null,
  downloadStatus: 'none',
  fileSize: null,
};

function seedDatabase({
  server = savedServer,
  books = [downloadedBook],
  pendingSync = false,
  secondPendingSync = false,
}: {
  server?: ServerConfig | null;
  books?: BookRecord[];
  pendingSync?: boolean;
  secondPendingSync?: boolean;
} = {}) {
  const updatedAt = '2026-01-02T00:00:00.000Z';
  const secondUpdatedAt = '2026-01-02T00:01:00.000Z';
  const db = {
    serverConfig: server,
    books,
    readingState: {
      ...(pendingSync
        ? {
            [downloadedBook.id]: {
              cfi: 'epubcfi(/6/4!/4/2/1:0)',
              xpath: '//body/DocFragment[2]/body/p[1]',
              percentage: 0.5,
              localUpdatedAt: updatedAt,
              syncedLocalUpdatedAt: null,
              serverUpdatedAt: null,
              pendingSync: true,
            },
          }
        : {}),
      ...(secondPendingSync
        ? {
            [onlineOnlyBook.id]: {
              cfi: 'epubcfi(/6/4!/4/4/1:0)',
              xpath: '//body/DocFragment[2]/body/p[2]',
              percentage: 0.25,
              localUpdatedAt: secondUpdatedAt,
              syncedLocalUpdatedAt: null,
              serverUpdatedAt: null,
              pendingSync: true,
            },
          }
        : {}),
    },
    syncQueue: {
      ...(pendingSync
        ? {
            [downloadedBook.id]: {
              bookId: downloadedBook.id,
              serverId: 'primary',
              payloadJson: JSON.stringify({
                libraryId: 1,
                seriesId: 1,
                volumeId: 1,
                chapterId: 1,
                pageNum: 50,
                bookScrollId: '//body/DocFragment[2]/body/p[1]',
              }),
              attemptCount: 0,
              lastAttemptAt: null,
              lastError: null,
              createdAt: updatedAt,
              updatedAt,
              revision: 1,
            },
          }
        : {}),
      ...(secondPendingSync
        ? {
            [onlineOnlyBook.id]: {
              bookId: onlineOnlyBook.id,
              serverId: 'primary',
              payloadJson: JSON.stringify({
                libraryId: 1,
                seriesId: 2,
                volumeId: 2,
                chapterId: 2,
                pageNum: 25,
                bookScrollId: '//body/DocFragment[2]/body/p[2]',
              }),
              attemptCount: 0,
              lastAttemptAt: null,
              lastError: null,
              createdAt: secondUpdatedAt,
              updatedAt: secondUpdatedAt,
              revision: 1,
            },
          }
        : {}),
    },
    preferences: {
      hideCompleted: 'false',
    },
  };
  window.localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(db));
}

async function waitForCondition(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    flushSync();
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  flushSync();
  expect(check()).toBe(true);
}

describe('credential state and 401 gating across App, Library, Onboarding, and Reader', () => {
  let target: HTMLDivElement;
  let mounted: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    clearDiagnostics();
    resetCredentialState();
    // database.ts uses browser storage when native is false; let's check how database.ts checks native:
    runtime.native = false;
    runtime.platform = 'android';
    runtime.online = true;
    runtime.appStateListeners.length = 0;
    runtime.networkListeners.length = 0;
    runtime.selectionCallback = null;
    runtime.relocateCallback = null;
    secureStorageMock.values.clear();
    secureStorageMock.throwOnGet = false;
    secureStorageMock.get.mockClear();
    secureStorageMock.set.mockClear();
    secureStorageMock.remove.mockClear();
    nativeDownloadMock.verifiedFile = {
      webViewUrl: 'web://books/primary-1.epub',
      relativePath: 'books/primary-1.epub',
      size: 4096,
    };
    nativeDownloadMock.downloadResult = null;
    nativeDownloadMock.coverResult = null;
    vi.mocked(CapacitorHttp.request).mockReset();
    vi.mocked(CapacitorHttp.get).mockReset();
    vi.mocked(cacheCover).mockClear();
    vi.mocked(downloadEpub).mockClear();

    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: () => {
        const animation = {
          onfinish: null as (() => void) | null,
          cancel() {},
          finish() {
            animation.onfinish?.();
          },
        };
        queueMicrotask(() => animation.onfinish?.());
        return animation;
      },
    });
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => undefined),
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Unexpected fetch call');
      }),
    );

    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(async () => {
    if (mounted) {
      await unmount(mounted);
      mounted = null;
    }
    target.remove();
    vi.useRealTimers();
  });

  it('mounts Library instead of Onboarding when saved key is missing and opens downloaded EPUBs offline', async () => {
    seedDatabase({ pendingSync: true });

    mounted = mount(App, { target });
    await waitForCondition(
      () =>
        target.querySelector('[data-credential-alert="missing"]') !== null &&
        target.querySelector('[data-book-open]') !== null,
    );

    expect(target.querySelector('input[type="url"]')).toBeNull();
    expect(target.querySelectorAll('.alert')).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();

    const openButton = target.querySelector<HTMLButtonElement>('[data-book-open]');
    expect(openButton).not.toBeNull();
    openButton!.click();

    await waitForCondition(
      () => target.querySelector('[aria-label="Show reading controls"]') !== null,
    );
    target.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')!.click();
    await waitForCondition(() => target.querySelector('[aria-label="Back to library"]') !== null);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('mounts Library instead of startupError when reading saved credentials throws, with Retry key recovery', async () => {
    seedDatabase();
    // Simulate unreadable browser/secure credential read on startup, then readable on retry
    const originalGetItem = window.localStorage.getItem.bind(window.localStorage);
    let failCredentialRead = true;
    vi.spyOn(window.localStorage, 'getItem').mockImplementation((key: string) => {
      if (failCredentialRead && key === 'turnleaf_browser_server_primary_api_key') {
        throw new Error('Storage corrupted');
      }
      return originalGetItem(key);
    });
    window.localStorage.setItem('turnleaf_browser_server_primary_api_key', 'recovered-key');

    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/Series/v2')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => [],
        } as unknown as Response;
      }
      if (url.includes('/api/Image/series-cover')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          blob: async () => new Blob(['img'], { type: 'image/png' }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:cover', revokeObjectURL: () => {} }),
    );

    mounted = mount(App, { target });
    await waitForCondition(
      () =>
        target.querySelector('[data-credential-alert="unreadable"]') !== null &&
        target.querySelector('[data-book-open]') !== null,
    );

    expect(target.textContent).not.toContain('Reset local data');
    expect(target.querySelectorAll('.alert')).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();

    failCredentialRead = false;
    const retryKeyButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Retry key',
    );
    expect(retryKeyButton).toBeDefined();
    retryKeyButton!.click();

    await waitForCondition(() => target.querySelector('[data-credential-alert]') === null);
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/api/Series/v2')),
    ).toBe(true);
  });

  it('stops all follow-up requests after startup 401, renders one consolidated alert, and keeps offline reader features working', async () => {
    seedDatabase({
      books: [downloadedBook, onlineOnlyBook],
      pendingSync: true,
      secondPendingSync: true,
    });
    window.localStorage.setItem('turnleaf_browser_server_primary_api_key', 'stale-key');

    const requestedUrls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      return {
        ok: false,
        status: 401,
        headers: { get: () => null },
      } as unknown as Response;
    });

    mounted = mount(App, { target });
    await waitForCondition(
      () =>
        target.querySelector('[data-credential-alert="rejected"]') !== null &&
        target.querySelector('[data-book-open]') !== null,
    );

    // Concurrent startup sync + refresh send at most 1 initial /api/Reader/progress and/or /api/Series/v2;
    // the 2nd queued progress item, series-detail, uncached covers, and checkOpenProgress are all gated.
    const initialRequestCount = requestedUrls.length;
    expect(initialRequestCount).toBeGreaterThanOrEqual(1);
    expect(initialRequestCount).toBeLessThanOrEqual(2);
    expect(
      requestedUrls.filter((url) => url.includes('/api/Reader/progress')).length,
    ).toBeLessThanOrEqual(1);
    expect(
      requestedUrls.filter((url) => url.includes('/api/Series/v2')).length,
    ).toBeLessThanOrEqual(1);
    expect(
      requestedUrls.every(
        (url) => url.includes('/api/Reader/progress') || url.includes('/api/Series/v2'),
      ),
    ).toBe(true);

    // Consolidated single credential alert instead of 3 stacked error banners.
    expect(target.querySelectorAll('.alert')).toHaveLength(1);
    expect(target.textContent).not.toContain('Retry sync');
    expect(
      target.querySelector<HTMLButtonElement>('[aria-label="Refresh library"]')?.disabled,
    ).toBe(true);

    // Open downloaded book while in 401 lockout and enable native reader foreground resume listener.
    runtime.native = true;
    const openButtons = [...target.querySelectorAll<HTMLButtonElement>('[data-book-open]')];
    const downloadedOpenButton = openButtons.find((btn) =>
      btn.getAttribute('aria-label')?.includes('Offline Novel'),
    );
    expect(downloadedOpenButton?.disabled).toBe(false);
    downloadedOpenButton!.click();

    await waitForCondition(
      () => target.querySelector('[aria-label="Show reading controls"]') !== null,
    );
    target.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')!.click();
    await waitForCondition(() => target.querySelector('[aria-label="Back to library"]') !== null);
    expect(requestedUrls).toHaveLength(initialRequestCount);
    expect(CapacitorHttp.request).not.toHaveBeenCalled();

    // Switch back to browser storage mode for local preference writes while testing reader features,
    // and fire the registered native foreground resume callback to prove zero resume probes fire!
    runtime.native = false;
    for (const listener of runtime.appStateListeners) {
      listener({ isActive: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requestedUrls).toHaveLength(initialRequestCount);
    expect(CapacitorHttp.request).not.toHaveBeenCalled();

    // Verify local in-book search works during lockout.
    target.querySelector<HTMLButtonElement>('[aria-label="Search this book"]')!.click();
    await waitForCondition(() => target.querySelector('#reader-search-query') !== null);
    const searchInput = target.querySelector<HTMLInputElement>('#reader-search-query')!;
    searchInput.value = 'offline';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput
      .closest('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitForCondition(
      () => target.textContent?.includes('Matched offline in offline EPUB') === true,
    );
    target.querySelector<HTMLButtonElement>('[aria-label="Close book search"]')!.click();

    // Verify local bookmarks work during lockout.
    await waitForCondition(
      () => target.querySelector('[aria-label="Marks, bookmarks and history"]') !== null,
    );
    target.querySelector<HTMLButtonElement>('[aria-label="Marks, bookmarks and history"]')!.click();
    await waitForCondition(
      () => target.querySelector('[data-reader-focus="bookmark-current"]') !== null,
    );
    target.querySelector<HTMLButtonElement>('[data-reader-focus="bookmark-current"]')!.click();
    await waitForCondition(
      () =>
        target
          .querySelector('[data-reader-focus="bookmark-current"]')
          ?.textContent?.includes('Remove bookmark') === true,
    );
    target.querySelector<HTMLButtonElement>('[aria-label="Close bookmarks and history"]')!.click();

    // Verify local highlights, notes, and Markdown export work during lockout.
    runtime.selectionCallback?.({
      cfi: 'epubcfi(/6/4!/4/2/1:0)',
      text: 'Important offline passage',
      href: 'Text/chapter-2.xhtml',
    });
    target
      .querySelector<HTMLButtonElement>('[aria-label="Notes: highlights and annotations"]')!
      .click();
    await waitForCondition(
      () => target.textContent?.includes('Important offline passage') === true,
    );
    const saveHighlightButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Save highlight',
    );
    expect(saveHighlightButton).toBeDefined();
    saveHighlightButton!.click();

    await waitForCondition(() => {
      const copyBtn = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
        (btn) => btn.textContent?.trim() === 'Copy Markdown',
      );
      return Boolean(copyBtn && !copyBtn.disabled);
    });
    const copyMarkdownButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Copy Markdown',
    )!;
    copyMarkdownButton.click();
    await waitForCondition(() => target.textContent?.includes('Markdown copied.') === true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('Important offline passage'),
    );

    // Zero network requests occurred across search, bookmarks, annotations, Markdown export, or resume.
    expect(requestedUrls).toHaveLength(initialRequestCount);
  });

  it('also gates follow-up requests when startup receives HTTP 403', async () => {
    seedDatabase({
      books: [downloadedBook, onlineOnlyBook],
      pendingSync: true,
      secondPendingSync: true,
    });
    window.localStorage.setItem('turnleaf_browser_server_primary_api_key', 'forbidden-key');

    const requestedUrls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      requestedUrls.push(String(input));
      return {
        ok: false,
        status: 403,
        headers: { get: () => null },
      } as unknown as Response;
    });

    mounted = mount(App, { target });
    await waitForCondition(
      () => target.querySelector('[data-credential-alert="rejected"]') !== null,
    );

    expect(requestedUrls.length).toBeGreaterThanOrEqual(1);
    expect(requestedUrls.length).toBeLessThanOrEqual(2);
    expect(
      requestedUrls.filter((url) => url.includes('/api/Reader/progress')).length,
    ).toBeLessThanOrEqual(1);
    expect(
      requestedUrls.filter((url) => url.includes('/api/Series/v2')).length,
    ).toBeLessThanOrEqual(1);
    expect(target.querySelectorAll('.alert')).toHaveLength(1);
  });

  it('keeps HTTP 403 on /api/Download/chapter distinct from HTTP 401 invalid-key errors', async () => {
    seedDatabase({ books: [onlineOnlyBook] });
    window.localStorage.setItem('turnleaf_browser_server_primary_api_key', 'no-download-perm-key');

    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/Series/v2')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => [
            { id: 2, libraryId: 1, name: 'Remote Novel', format: 3, pages: 100, pagesRead: 0 },
          ],
        } as unknown as Response;
      }
      if (url.includes('/api/Series/series-detail')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            volumes: [
              {
                id: 2,
                chapters: [
                  {
                    id: 2,
                    volumeId: 2,
                    title: 'Remote Novel',
                    pages: 100,
                    pagesRead: 0,
                    format: 3,
                    files: [{ id: 2, format: 3, extension: '.epub', bytes: 2048 }],
                  },
                ],
              },
            ],
          }),
        } as unknown as Response;
      }
      if (url.includes('/api/Image/series-cover')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          blob: async () => new Blob(['img'], { type: 'image/png' }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:cover', revokeObjectURL: () => {} }),
    );

    mounted = mount(App, { target });
    await waitForCondition(() => target.querySelector('[data-book-open]') !== null);

    nativeDownloadMock.downloadResult = async () => {
      throw new EpubTransferError(403, false);
    };

    target.querySelector<HTMLButtonElement>('[data-book-open]')!.click();
    await waitForCondition(
      () =>
        target.textContent?.includes(
          'Kavita denied the download. Check your account’s download permissions.',
        ) === true,
    );

    expect(getCredentialState().status).toBe('ready');
    expect(target.querySelector('[data-credential-alert]')).toBeNull();
  });

  it('recovers via Settings updateApiKey and via Onboarding same-address reconnect, updating server metadata and flushing progress', async () => {
    seedDatabase({ books: [downloadedBook], pendingSync: true });
    window.localStorage.setItem('turnleaf_browser_server_primary_api_key', 'stale-key');

    let activeServerKey = 'rotated-key-1';
    let serverVersion = '0.8.9';
    const progressUploads: Array<{ key: string | null; body: unknown }> = [];

    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const sentKey = headers.get('x-api-key');
      if (sentKey !== activeServerKey) {
        return {
          ok: false,
          status: 401,
          headers: { get: () => null },
        } as unknown as Response;
      }
      if (url.includes('/api/Library/libraries')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => [{ id: 1, name: 'Books', type: 2 }],
        } as unknown as Response;
      }
      if (url.includes('/api/Health')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ version: serverVersion }),
        } as unknown as Response;
      }
      if (url.includes('/api/Series/v2')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => [
            { id: 1, libraryId: 1, name: 'Offline Novel', format: 3, pages: 100, pagesRead: 50 },
          ],
        } as unknown as Response;
      }
      if (url.includes('/api/Series/series-detail')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            volumes: [
              {
                id: 1,
                chapters: [
                  {
                    id: 1,
                    volumeId: 1,
                    title: 'Offline Novel',
                    pages: 100,
                    pagesRead: 50,
                    format: 3,
                    files: [{ id: 1, format: 3, extension: '.epub', bytes: 4096 }],
                  },
                ],
              },
            ],
          }),
        } as unknown as Response;
      }
      if (url.includes('/api/Reader/progress')) {
        progressUploads.push({
          key: sentKey,
          body: JSON.parse(String(init?.body ?? '{}')),
        });
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({}),
        } as unknown as Response;
      }
      if (url.includes('/api/Image/series-cover')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          blob: async () => new Blob(['img'], { type: 'image/png' }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    mounted = mount(App, { target });
    await waitForCondition(
      () => target.querySelector('[data-credential-alert="rejected"]') !== null,
    );

    // 1) Recover via Settings replacement API key form
    target.querySelector<HTMLButtonElement>('[data-credential-recover]')!.click();
    await waitForCondition(() => target.querySelector('#replacement-api-key') !== null);

    const replacementInput = target.querySelector<HTMLInputElement>('#replacement-api-key')!;
    replacementInput.value = 'rotated-key-1';
    replacementInput.dispatchEvent(new Event('input', { bubbles: true }));
    replacementInput
      .closest('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitForCondition(
      () =>
        target.querySelector('[data-credential-alert]') === null && progressUploads.length === 1,
    );

    const dbAfterSettings = JSON.parse(window.localStorage.getItem(DB_STORAGE_KEY) ?? '{}') as {
      serverConfig: ServerConfig;
      syncQueue: Record<string, unknown>;
    };
    expect(dbAfterSettings.serverConfig.kavitaVersion).toBe('0.8.9');
    expect(dbAfterSettings.serverConfig.lastConnectedAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect(dbAfterSettings.syncQueue).toEqual({});

    // 2) Rotate key again on server, trigger 401 on refresh, then recover via Onboarding same-address Reconnect
    activeServerKey = 'rotated-key-2';
    serverVersion = '0.9.0';
    target.querySelector<HTMLButtonElement>('[aria-label="Refresh library"]')!.click();
    await waitForCondition(
      () => target.querySelector('[data-credential-alert="rejected"]') !== null,
    );

    const reconnectButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Reconnect',
    );
    expect(reconnectButton).toBeDefined();
    reconnectButton!.click();

    await waitForCondition(() => target.querySelector('#kavita-auth-key') !== null);
    const onboardingKeyInput = target.querySelector<HTMLInputElement>('#kavita-auth-key')!;
    onboardingKeyInput.value = 'rotated-key-2';
    onboardingKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
    onboardingKeyInput
      .closest('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitForCondition(
      () =>
        target.querySelector('[aria-label="Open settings"]') !== null &&
        target.querySelector('[data-credential-alert]') === null,
    );
    const dbAfterReconnect = JSON.parse(window.localStorage.getItem(DB_STORAGE_KEY) ?? '{}') as {
      serverConfig: ServerConfig;
    };
    expect(dbAfterReconnect.serverConfig.kavitaVersion).toBe('0.9.0');
  });
});
