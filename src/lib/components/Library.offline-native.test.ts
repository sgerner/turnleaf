// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { CapacitorHttp } from '@capacitor/core';
import { Network, type ConnectionStatusChangeListener } from '@capacitor/network';
import type * as DatabaseModule from '../database/database';
import type * as ThemesModule from '../themes/themes';
import type { BookRecord, PendingSyncItem, ServerConfig } from '../database/database';

const networkListeners = new Set<ConnectionStatusChangeListener>();
let networkConnected = true;
let savedBooksState: BookRecord[] = [];
let pendingSyncState: PendingSyncItem[] = [];

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    convertFileSrc: (value: string) => value,
  },
  CapacitorHttp: {
    get: vi.fn(),
    request: vi.fn(),
  },
  registerPlugin: () => ({}),
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({
      connected: networkConnected,
      connectionType: networkConnected ? 'wifi' : 'none',
    })),
    addListener: vi.fn(
      async (event: 'networkStatusChange', listener: ConnectionStatusChangeListener) => {
        if (event === 'networkStatusChange') networkListeners.add(listener);
        return {
          remove: async () => {
            networkListeners.delete(listener);
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
  cacheCover: vi.fn(async () => 'cover'),
  clearCoverCache: vi.fn(async () => undefined),
  cleanupInterruptedEpubDownloads: vi.fn(async () => undefined),
  deleteDownloadedEpub: vi.fn(async () => undefined),
  downloadEpub: vi.fn(async () => ({ relativePath: 'books/book-1.epub', size: 1024 })),
  verifyDownloadedEpub: vi.fn(async (path: string) => ({
    relativePath: path,
    webViewUrl: `blob:${path}`,
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
    loadTheme: vi.fn(async () => true),
  };
});

vi.mock('../database/database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return {
    ...actual,
    getPreferences: vi.fn(async () => new Map<string, string>()),
    getBooks: vi.fn(async () => savedBooksState.map((book) => ({ ...book }))),
    reconcileBooks: vi.fn(async (_serverId: string, nextBooks: BookRecord[]) => {
      savedBooksState = nextBooks.map((book) => ({ ...book }));
    }),
    getSyncStatus: vi.fn(async () => ({
      pendingCount: pendingSyncState.length,
      failedCount: 0,
      lastError: null,
      lastUpdatedAt: null,
    })),
    getPendingSync: vi.fn(async () => [...pendingSyncState]),
    confirmSync: vi.fn(async (bookId: string) => {
      pendingSyncState = pendingSyncState.filter((item) => item.bookId !== bookId);
    }),
    markSyncFailure: vi.fn(async () => undefined),
    setPreference: vi.fn(async () => undefined),
  };
});

const server: ServerConfig = {
  id: 'server-1',
  displayName: 'Kavita',
  baseUrl: 'http://127.0.0.1:43123',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.4',
  lastConnectedAt: '2026-09-01T00:00:00.000Z',
};

const seededBook: BookRecord = {
  id: 'server-1:101:301',
  serverId: server.id,
  libraryId: 1,
  seriesId: 101,
  volumeId: 201,
  chapterId: 301,
  title: 'The Orchard Lamp',
  author: 'Mara Finch',
  series: 'The Orchard Lamp',
  descriptionHtml: null,
  format: 'epub',
  pages: 120,
  pagesRead: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  lastReadAt: null,
  downloadPath: 'books/book-1.epub',
  downloadStatus: 'available',
  fileSize: 2048,
};

function seriesListItem(id = 101, name = 'The Orchard Lamp') {
  return {
    id,
    libraryId: 1,
    name,
    format: 3,
    pages: 120,
    pagesRead: 0,
  };
}

function seriesDetailPayload(chapterId = 301, title = 'The Orchard Lamp') {
  return {
    volumes: [
      {
        id: 201,
        chapters: [
          {
            id: chapterId,
            volumeId: 201,
            title,
            titleName: title,
            pages: 120,
            pagesRead: 0,
            format: 3,
            files: [{ id: 1, format: 3, extension: '.epub', bytes: 2048 }],
          },
        ],
      },
    ],
  };
}

async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await check()).toBe(true);
}

const mountedInstances: Array<Record<string, unknown>> = [];
const containers: HTMLElement[] = [];

async function mountLibrary() {
  const Library = (await import('./Library.svelte')).default;
  const target = document.createElement('div');
  target.className = 'app-stage';
  document.body.appendChild(target);
  containers.push(target);
  const instance = mount(Library, {
    target,
    props: {
      server,
      apiKey: 'android-journey-valid-key',
      theme: 'fennec',
      mode: 'dark',
      onThemeChange: vi.fn(),
      onModeChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onServerDeleted: vi.fn(),
      onChangeServerAddress: vi.fn(),
    },
  });
  mountedInstances.push(instance);
  return { target, instance };
}

beforeEach(() => {
  networkConnected = true;
  networkListeners.clear();
  savedBooksState = [{ ...seededBook }];
  pendingSyncState = [];
  vi.mocked(CapacitorHttp.request).mockReset();
  vi.mocked(Network.getStatus).mockImplementation(async () => ({
    connected: networkConnected,
    connectionType: networkConnected ? 'wifi' : 'none',
  }));
  vi.mocked(Network.addListener).mockImplementation(
    async (event: 'networkStatusChange', listener: ConnectionStatusChangeListener) => {
      if (event === 'networkStatusChange') networkListeners.add(listener);
      return {
        remove: async () => {
          networkListeners.delete(listener);
        },
      };
    },
  );
  if (!Element.prototype.animate) {
    Element.prototype.animate = () =>
      ({
        cancel: () => {},
        finish: () => {},
        onfinish: null,
        finished: Promise.resolve(),
      }) as unknown as Animation;
  }
});

afterEach(async () => {
  for (const instance of mountedInstances.splice(0)) {
    await unmount(instance);
  }
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

describe('Library native Android offline transitions (CapacitorHttp + Network plugin)', () => {
  it('blocks /api/Series/v2 and restores offline state when wifi-to-cellular handover drops before or during catalog dispatch', async () => {
    let initialRefreshDone = false;
    const offlineAuthenticatedRequests: string[] = [];
    let getStatusCallsDuringReconnect = 0;
    let simulateLateDropBeforeDispatch = false;

    vi.mocked(Network.getStatus).mockImplementation(async () => {
      if (simulateLateDropBeforeDispatch) {
        getStatusCallsDuringReconnect += 1;
        // Simulate `svc wifi disable` -> cellular briefly reporting connected on initial listener/cover checks,
        // then `svc data disable` completing right before CapacitorHttp.request('/api/Series/v2') dispatches!
        if (getStatusCallsDuringReconnect <= 2) {
          return { connected: true, connectionType: 'cellular' };
        }
        networkConnected = false;
        return { connected: false, connectionType: 'none' };
      }
      return {
        connected: networkConnected,
        connectionType: networkConnected ? 'wifi' : 'none',
      };
    });

    vi.mocked(CapacitorHttp.request).mockImplementation(async (options) => {
      const url = new URL(options.url);
      const headerKey =
        options.headers?.['x-api-key'] ?? options.headers?.['X-Api-Key'] ?? undefined;
      if (!networkConnected && headerKey) {
        offlineAuthenticatedRequests.push(url.pathname);
      }
      if (url.pathname === '/api/Series/v2') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          data: [seriesListItem()],
          url: options.url,
        };
      }
      if (url.pathname === '/api/Series/series-detail') {
        initialRefreshDone = true;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          data: seriesDetailPayload(),
          url: options.url,
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: {},
        url: options.url,
      };
    });

    const { target } = await mountLibrary();
    await waitForCondition(() => initialRefreshDone);

    // Phase 1: `adb shell svc wifi disable` followed by `adb shell svc data disable`.
    // ConnectivityThread emits `{ connected: false }` for Wi-Fi lost, then `{ connected: true, connectionType: 'cellular' }`
    // while cellular is still tearing down (`simulateLateDropBeforeDispatch = true`).
    for (const listener of networkListeners) {
      listener({ connected: false, connectionType: 'none' });
    }
    simulateLateDropBeforeDispatch = true;
    for (const listener of networkListeners) {
      listener({ connected: true, connectionType: 'cellular' });
    }

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(offlineAuthenticatedRequests).toEqual([]);
    expect(target.textContent).toContain('No network connection. Showing your saved library.');
  });

  it('aborts catalog pagination and detail batches before dispatch if connectivity drops after /api/Series/v2 starts', async () => {
    let initialRefreshDone = false;
    let dropAfterSeriesPage = false;
    const offlineAuthenticatedRequests: string[] = [];

    vi.mocked(CapacitorHttp.request).mockImplementation(async (options) => {
      const url = new URL(options.url);
      const headerKey =
        options.headers?.['x-api-key'] ?? options.headers?.['X-Api-Key'] ?? undefined;
      if (!networkConnected && headerKey) {
        offlineAuthenticatedRequests.push(url.pathname);
      }
      if (url.pathname === '/api/Series/v2') {
        if (dropAfterSeriesPage) {
          // Network drops while `/api/Series/v2` is returning, before `/api/Series/series-detail` dispatches
          networkConnected = false;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          data: [seriesListItem()],
          url: options.url,
        };
      }
      if (url.pathname === '/api/Series/series-detail') {
        initialRefreshDone = true;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          data: seriesDetailPayload(),
          url: options.url,
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: {},
        url: options.url,
      };
    });

    await mountLibrary();
    await waitForCondition(() => initialRefreshDone);

    dropAfterSeriesPage = true;
    for (const listener of networkListeners) {
      listener({ connected: true, connectionType: 'wifi' });
    }
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(offlineAuthenticatedRequests).toEqual([]);
  });

  it('rechecks Network.getStatus after listener registration on mount so offline drops during startup dispatch zero requests', async () => {
    pendingSyncState = [
      {
        bookId: seededBook.id,
        payload: JSON.stringify({
          libraryId: 1,
          seriesId: 101,
          volumeId: 201,
          chapterId: 301,
          pageNum: 12,
          bookScrollId: '//body/p[4]',
        }),
        revision: 1,
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
    ];

    const originalAddListener = vi.mocked(Network.addListener).getMockImplementation()!;
    vi.mocked(Network.addListener).mockImplementationOnce(async (event, listener) => {
      // Connectivity drops while `Network.addListener` is registering during onMount
      networkConnected = false;
      return originalAddListener(event, listener);
    });

    const offlineAuthenticatedRequests: string[] = [];
    vi.mocked(CapacitorHttp.request).mockImplementation(async (options) => {
      const url = new URL(options.url);
      if (!networkConnected) offlineAuthenticatedRequests.push(url.pathname);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: [],
        url: options.url,
      };
    });

    const { target } = await mountLibrary();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(offlineAuthenticatedRequests).toEqual([]);
    expect(target.textContent).toContain('No network connection. Showing your saved library.');
  });

  it('passes pre-dispatch Network.getStatus guards into native cacheCover so mid-preparation offline drops never dispatch FileTransfer', async () => {
    const { cacheCover } = await import('../downloads/native-download');
    let initialRefreshDone = false;
    const offlineCoverTransfers: number[] = [];

    vi.mocked(cacheCover).mockImplementation(
      async (
        _downloadUrl,
        apiKey,
        seriesId,
        _signal,
        _namespace,
        allowDownload,
        _serverOrigin,
        beforeDispatch,
      ) => {
        if (!allowDownload) throw new Error('Offline');
        // Simulate connectivity dropping while Filesystem directories/URIs are being prepared before FileTransfer
        networkConnected = false;
        await beforeDispatch?.();
        if (!networkConnected && apiKey) {
          offlineCoverTransfers.push(seriesId);
        }
        return `cover-${seriesId}`;
      },
    );

    vi.mocked(CapacitorHttp.request).mockImplementation(async (options) => {
      const url = new URL(options.url);
      if (url.pathname === '/api/Series/v2') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          data: [seriesListItem()],
          url: options.url,
        };
      }
      if (url.pathname === '/api/Series/series-detail') {
        initialRefreshDone = true;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          data: seriesDetailPayload(),
          url: options.url,
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: {},
        url: options.url,
      };
    });

    await mountLibrary();
    await waitForCondition(() => initialRefreshDone || !networkConnected);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(offlineCoverTransfers).toEqual([]);
  });
});
