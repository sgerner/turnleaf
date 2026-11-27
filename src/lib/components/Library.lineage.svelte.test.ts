// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookRecord, ServerConfig } from '../database/database';
import type * as ThemesModule from '../themes/themes';

const events = vi.hoisted(() => [] as string[]);
const networkListeners = vi.hoisted(() => [] as Array<(status: { connected: boolean }) => void>);

const mocks = vi.hoisted(() => ({
  books: [] as BookRecord[],
  preferences: new Map<string, string>(),
  flushProgress: vi.fn(async () => {
    events.push('flushProgress');
  }),
  getBookSeries: vi.fn(async () => {
    events.push('getBookSeries');
    return [];
  }),
  getSeriesDetail: vi.fn(async () => ({
    chapters: [],
    specials: [],
    volumes: [],
    storylineChapters: [],
    incomplete: false,
  })),
  testConnection: vi.fn(async () => ({
    version: '0.8.8',
    bookLibraries: [{ id: 1, name: 'Books', type: 2 }],
  })),
  reconcileBooks: vi.fn(async () => {
    events.push('reconcileBooks');
    return new Map<string, string>();
  }),
  downloadEpub: vi.fn(async () => ({
    relativePath: 'epubs/primary-42-101.epub',
    webViewUrl: 'blob:updated-epub',
    size: 220_000,
    transferredSize: 220_000,
  })),
  deleteDownloadedEpub: vi.fn(async () => undefined),
  markDownloaded: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    Capacitor: Record<string, unknown>;
  } & Record<string, unknown>;
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => false,
      getPlatform: () => 'web',
    },
  };
});

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: true, connectionType: 'wifi' })),
    addListener: vi.fn(
      async (_event: string, listener: (status: { connected: boolean }) => void) => {
        networkListeners.push(listener);
        return { remove: async () => undefined };
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

vi.mock('../native/credentials', () => ({
  saveApiKey: vi.fn(async () => undefined),
  removeApiKey: vi.fn(async () => undefined),
}));

vi.mock('../themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    skeletonThemes: ['vintage'],
    loadTheme: vi.fn(async () => true),
  };
});

vi.mock('../downloads/native-download', () => ({
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/download-chapter',
  EpubTransferError: class extends Error {
    status?: number;
    connectionFailed = false;
  },
  cacheCover: vi.fn(async () => 'blob:cover'),
  clearCoverCache: vi.fn(async () => undefined),
  cleanupInterruptedEpubDownloads: vi.fn(async () => undefined),
  deleteDownloadedEpub: (...args: unknown[]) => mocks.deleteDownloadedEpub(...(args as [])),
  downloadEpub: (...args: unknown[]) => mocks.downloadEpub(...(args as [])),
  verifyDownloadedEpub: vi.fn(async () => ({ webViewUrl: 'blob:epub', size: 153_600 })),
}));

vi.mock('../kavita/client', () => ({
  KavitaError: class extends Error {
    kind = 'network';
    status?: number;
  },
  KavitaClient: class {
    baseUrl: string;
    apiKey: string;
    constructor(baseUrl: string, apiKey: string) {
      this.baseUrl = baseUrl;
      this.apiKey = apiKey;
    }
    coverUrl(seriesId: number): string {
      return `${this.baseUrl}/cover/${seriesId}`;
    }
    downloadUrl(chapterId: number): string {
      return `${this.baseUrl}/download/${chapterId}`;
    }
    getCover = vi.fn(async () => new Blob(['cover']));
    getBookSeries = mocks.getBookSeries;
    getSeriesDetail = mocks.getSeriesDetail;
    testConnection = mocks.testConnection;
    getProgress = vi.fn(async () => null);
    saveProgress = vi.fn(async () => undefined);
  },
}));

vi.mock('../sync/sync', () => ({
  flushProgress: (...args: unknown[]) => mocks.flushProgress(...(args as [])),
}));

vi.mock('../database/database', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBooks: vi.fn(async () => mocks.books.map((item) => ({ ...item }))),
    getPreferences: vi.fn(async (keys: readonly string[]) => {
      const map = new Map<string, string>();
      for (const key of keys) {
        const val = mocks.preferences.get(key);
        if (val !== undefined) map.set(key, val);
      }
      return map;
    }),
    setPreference: vi.fn(async (key: string, value: string) => {
      mocks.preferences.set(key, value);
    }),
    setPreferences: vi.fn(async (entries: ReadonlyMap<string, string>) => {
      for (const [key, value] of entries) mocks.preferences.set(key, value);
    }),
    getSyncStatus: vi.fn(async () => ({
      pendingCount: 0,
      failedCount: 0,
      lastError: null,
      lastUpdatedAt: null,
    })),
    reconcileBooks: (...args: unknown[]) => mocks.reconcileBooks(...(args as [])),
    markDownloaded: (...args: unknown[]) => mocks.markDownloaded(...(args as [])),
    saveServer: vi.fn(async () => undefined),
  };
});

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ReaderSession: class {
      open = vi.fn(async () => undefined);
      destroy = vi.fn();
      tableOfContents = vi.fn(() => []);
      updateHighlights = vi.fn();
      applyAppearance = vi.fn();
    },
  };
});

const server: ServerConfig = {
  id: 'primary',
  displayName: 'Kavita',
  baseUrl: 'https://kavita.example.com',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.8',
  lastConnectedAt: '2026-09-01T00:00:00.000Z',
};

const baseBook: BookRecord = {
  id: 'primary:42:101',
  serverId: 'primary',
  libraryId: 1,
  seriesId: 42,
  volumeId: 420,
  chapterId: 101,
  title: 'Outdated Downloaded Book',
  author: 'Ursula K. Le Guin',
  series: 'Hainish Cycle',
  descriptionHtml: null,
  format: 'epub',
  pages: 25,
  pagesRead: 4,
  createdAt: '2026-09-01T00:00:00.000Z',
  lastReadAt: '2026-09-02T00:00:00.000Z',
  downloadPath: 'epubs/primary-42-100.epub',
  downloadStatus: 'available',
  fileSize: 153_600,
  remoteFileSize: 220_000,
  downloadedBytes: 153_600,
  downloadedPages: 10,
  downloadOutdated: true,
  hasLocalData: true,
  remoteAvailable: true,
};

if (typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = function animateStub() {
    let canceled = false;
    let finishHandler: ((event: AnimationPlaybackEvent) => void) | null = null;
    const animation = {
      currentTime: 0,
      cancel() {
        canceled = true;
      },
      finish() {
        if (!canceled) finishHandler?.(new Event('finish') as AnimationPlaybackEvent);
      },
      get onfinish() {
        return finishHandler;
      },
      set onfinish(handler: ((event: AnimationPlaybackEvent) => void) | null) {
        finishHandler = handler;
        if (handler) {
          queueMicrotask(() => {
            if (!canceled && finishHandler === handler) {
              handler(new Event('finish') as AnimationPlaybackEvent);
            }
          });
        }
      },
    };
    return animation as unknown as Animation;
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

describe('Library and Reader lineage UX', () => {
  let target: HTMLDivElement;
  let instance: Record<string, unknown> | null = null;

  beforeEach(() => {
    events.length = 0;
    networkListeners.length = 0;
    mocks.books = [];
    mocks.preferences.clear();
    vi.clearAllMocks();
    if (!Element.prototype.animate) {
      Element.prototype.animate = () =>
        ({
          cancel: () => undefined,
          finish: () => undefined,
          onfinish: null,
          finished: Promise.resolve(),
        }) as unknown as Animation;
    }
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(async () => {
    if (instance) await unmount(instance);
    instance = null;
    target.remove();
  });

  it('flushes pending progress before refresh on startup, reconnect, and API key updates, then retries afterward', async () => {
    const { default: Library } = await import('./Library.svelte');
    instance = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'initial-key',
        theme: 'vintage',
        mode: 'dark',
        onThemeChange: () => undefined,
        onModeChange: () => undefined,
        onApiKeyChange: () => undefined,
        onServerDeleted: () => undefined,
        onChangeServerAddress: () => undefined,
      },
    });
    await settle();

    // Startup order: flushProgress -> getBookSeries -> reconcileBooks -> flushProgress
    expect(events).toEqual(['flushProgress', 'getBookSeries', 'reconcileBooks', 'flushProgress']);

    // Reconnect order
    events.length = 0;
    networkListeners[0]?.({ connected: false });
    networkListeners[0]?.({ connected: true });
    await settle();
    expect(events).toEqual(['flushProgress', 'getBookSeries', 'reconcileBooks', 'flushProgress']);

    // API key update order
    events.length = 0;
    const settingsButton = target.querySelector<HTMLButtonElement>('[aria-label="Open settings"]');
    expect(settingsButton).not.toBeNull();
    settingsButton!.click();
    flushSync();

    const keyInput = target.querySelector<HTMLInputElement>('#replacement-api-key');
    expect(keyInput).not.toBeNull();
    keyInput!.value = 'replacement-key';
    keyInput!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    const form = keyInput!.closest('form');
    expect(form).not.toBeNull();
    form!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(events).toEqual(['flushProgress', 'getBookSeries', 'reconcileBooks', 'flushProgress']);
  });

  it('displays retained non-downloaded annotated books and offers one-tap Update download for outdated books', async () => {
    const annotatedRemovedBook: BookRecord = {
      ...baseBook,
      id: 'primary:99:900',
      seriesId: 99,
      chapterId: 900,
      title: 'Vanished Annotated Novel',
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
      remoteFileSize: null,
      downloadedBytes: null,
      downloadedPages: null,
      downloadOutdated: false,
      hasLocalData: true,
      remoteAvailable: false,
    };
    mocks.books = [baseBook, annotatedRemovedBook];

    const { default: Library } = await import('./Library.svelte');
    instance = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'key',
        theme: 'vintage',
        mode: 'dark',
        onThemeChange: () => undefined,
        onModeChange: () => undefined,
        onApiKeyChange: () => undefined,
        onServerDeleted: () => undefined,
        onChangeServerAddress: () => undefined,
      },
    });
    await settle();

    expect(target.textContent).toContain('Vanished Annotated Novel');
    expect(target.textContent).toContain('Unavailable on Kavita · Notes saved');
    expect(target.textContent).toContain('Outdated Downloaded Book');
    expect(target.textContent).toContain('Update available');

    const actionsBtn = target.querySelector<HTMLButtonElement>(
      '[aria-label="Book actions for Outdated Downloaded Book, by Ursula K. Le Guin, Hainish Cycle, update available"]',
    );
    expect(actionsBtn).not.toBeNull();
    actionsBtn!.click();
    flushSync();

    const updateButton = [...target.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Update download'),
    );
    expect(updateButton).toBeDefined();
    updateButton!.click();
    await settle();

    expect(mocks.downloadEpub).toHaveBeenCalledOnce();
    expect(mocks.markDownloaded).toHaveBeenCalledWith(
      'primary:42:101',
      'epubs/primary-42-101.epub',
      220_000,
      {
        downloadedBytes: 220_000,
        downloadedPages: 25,
      },
    );
    expect(mocks.deleteDownloadedEpub).toHaveBeenCalledWith('epubs/primary-42-100.epub');
  });

  it('rekeys active Reader preferences when bookId remaps during an open session', async () => {
    mocks.preferences.set(
      'readerBookmarks:primary:42:100',
      '[{"id":"epubcfi(/6/2)|ch1.xhtml","cfi":"epubcfi(/6/2)","href":"ch1.xhtml","percentage":0.2,"label":"Chapter 1","savedAt":"2026-09-01T00:00:00.000Z"}]',
    );
    const { default: Reader } = await import('./Reader.svelte');

    const props = $state({
      bookUrl: 'blob:book',
      bookId: 'primary:42:100',
      title: 'Remapped Reader Book',
      onBack: () => undefined,
      onRelocated: () => undefined,
    });
    instance = mount(Reader, { target, props });
    await settle();

    // Simulate reconcileBooks migrating preferences in DB and Library updating Reader's bookId prop
    mocks.preferences.set(
      'readerBookmarks:primary:43:102',
      mocks.preferences.get('readerBookmarks:primary:42:100')!,
    );
    mocks.preferences.delete('readerBookmarks:primary:42:100');
    props.bookId = 'primary:43:102';
    await settle();

    expect(mocks.preferences.has('readerBookmarks:primary:42:100')).toBe(false);
    expect(mocks.preferences.get('readerBookmarks:primary:43:102')).toContain('Chapter 1');
  });

  it('hides a removed-from-server book after deleting its download when no notes or progress remain', async () => {
    const vanishedDownloadOnly: BookRecord = {
      ...baseBook,
      id: 'primary:88:800',
      seriesId: 88,
      chapterId: 800,
      title: 'Vanished Download Only Book',
      remoteAvailable: false,
      downloadPath: 'epubs/vanished-only.epub',
      downloadStatus: 'available',
      fileSize: 120_000,
      remoteFileSize: 120_000,
      downloadedBytes: 120_000,
      downloadedPages: 120,
      hasLocalData: true,
    };
    mocks.books = [vanishedDownloadOnly];
    mocks.reconcileBooks.mockImplementation(async () => new Map());
    const { default: Library } = await import('./Library.svelte');

    instance = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'secret-key',
        theme: 'turnleaf',
        mode: 'dark',
        onThemeChange: () => undefined,
        onModeChange: () => undefined,
        onApiKeyChange: () => undefined,
        onServerDeleted: () => undefined,
        onChangeServerAddress: () => undefined,
      },
    });
    await settle();

    expect(target.textContent).toContain('Vanished Download Only Book');
    expect(target.textContent).toContain('Unavailable on Kavita · Saved offline');

    const actionsBtn = target.querySelector<HTMLButtonElement>(
      '[aria-label="Book actions for Vanished Download Only Book, by Ursula K. Le Guin, Hainish Cycle, removed from server"]',
    );
    expect(actionsBtn).not.toBeNull();
    actionsBtn!.click();
    flushSync();

    // Simulate removeDownload pruning the unretained vanished row in storage
    mocks.books = [];

    const removeBtn = [...target.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Remove download'),
    );
    expect(removeBtn).toBeDefined();
    removeBtn!.click();
    await settle();

    expect(mocks.deleteDownloadedEpub).toHaveBeenCalledWith('epubs/vanished-only.epub');
    expect(target.textContent).not.toContain('Vanished Download Only Book');
    expect(target.textContent).not.toContain('Unavailable on Kavita · Notes saved');
  });
});
