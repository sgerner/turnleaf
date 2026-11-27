// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from './lib/database/database';
import type { BookRecord, ServerConfig, SyncStatus } from './lib/database/database';
import type * as NativeDownloadModule from './lib/downloads/native-download';
import type * as ReleasesModule from './lib/github/releases';
import type * as ThemesModule from './lib/themes/themes';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => {
  const removeHandle = async () => undefined;
  return {
    isNative: true,
    networkGetStatus: vi.fn(async () => ({ connected: false, connectionType: 'none' })),
    networkAddListener: vi.fn(async () => ({ remove: removeHandle })),
    appAddListener: vi.fn(async () => ({ remove: removeHandle })),
    appExitApp: vi.fn(async () => undefined),
    getServer: vi.fn<() => Promise<ServerConfig | null>>(async () => null),
    getPreferences: vi.fn<(keys: readonly string[]) => Promise<Map<string, string>>>(
      async () => new Map(),
    ),
    getBooks: vi.fn<
      (serverId: string, options?: { includeDescription?: boolean }) => Promise<BookRecord[]>
    >(async () => []),
    getSyncStatus: vi.fn<() => Promise<SyncStatus>>(async () => ({
      pendingCount: 0,
      failedCount: 0,
      lastError: null,
      lastUpdatedAt: null,
    })),
    resetLocalDatabase: vi.fn(async () => undefined),
    setPreference: vi.fn(async () => undefined),
    prepareCredentials: vi.fn(async () => undefined),
    getApiKey: vi.fn<(ref: string) => Promise<string | null>>(async () => 'secret-api-key'),
    saveApiKey: vi.fn(async () => undefined),
    removeApiKey: vi.fn(async () => undefined),
    loadTheme: vi.fn<(theme: string) => Promise<boolean>>(async () => true),
    fetchLatestGithubRelease: vi.fn(async () => null),
    cleanupInterruptedEpubDownloads: vi.fn(async () => undefined),
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mocks.isNative,
    getPlatform: () => (mocks.isNative ? 'android' : 'web'),
    convertFileSrc: (uri: string) => uri,
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    Data: 'DATA',
    Documents: 'DOCUMENTS',
  },
  Encoding: {
    UTF8: 'utf8',
  },
  Filesystem: {
    readFile: vi.fn(async () => {
      throw new Error('File not found');
    }),
    writeFile: vi.fn(async () => ({ uri: 'file://DATA/diagnostics.json' })),
    deleteFile: vi.fn(async () => undefined),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: mocks.networkGetStatus,
    addListener: mocks.networkAddListener,
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: mocks.appAddListener,
    exitApp: mocks.appExitApp,
  },
}));

vi.mock('./lib/database/database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return {
    ...actual,
    getServer: mocks.getServer,
    getPreferences: mocks.getPreferences,
    getBooks: mocks.getBooks,
    getSyncStatus: mocks.getSyncStatus,
    resetLocalDatabase: mocks.resetLocalDatabase,
    setPreference: mocks.setPreference,
  };
});

vi.mock('./lib/native/credentials', () => ({
  prepare: mocks.prepareCredentials,
  getApiKey: mocks.getApiKey,
  saveApiKey: mocks.saveApiKey,
  removeApiKey: mocks.removeApiKey,
}));

vi.mock('./lib/themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    loadTheme: mocks.loadTheme,
  };
});

vi.mock('./lib/github/releases', async (importOriginal) => {
  const actual = await importOriginal<typeof ReleasesModule>();
  return {
    ...actual,
    fetchLatestGithubRelease: mocks.fetchLatestGithubRelease,
  };
});

vi.mock('./lib/downloads/native-download', async (importOriginal) => {
  const actual = await importOriginal<typeof NativeDownloadModule>();
  return {
    ...actual,
    cleanupInterruptedEpubDownloads: mocks.cleanupInterruptedEpubDownloads,
  };
});

import App from './App.svelte';
import { clearDiagnostics, exportDiagnostics } from './lib/diagnostics/log';

const savedServer: ServerConfig = {
  id: 'primary',
  displayName: 'Home Library',
  baseUrl: 'https://books.example.com',
  credentialRef: 'server_primary_api_key',
  kavitaVersion: '0.8.4',
  lastConnectedAt: '2026-11-20T00:00:00.000Z',
};

const savedBook: BookRecord = {
  id: 'primary:1:10',
  serverId: 'primary',
  libraryId: 1,
  seriesId: 10,
  volumeId: 10,
  chapterId: 10,
  title: 'The Left Hand of Darkness',
  author: 'Ursula K. Le Guin',
  series: 'Hainish Cycle',
  descriptionHtml: null,
  format: 'epub',
  pages: 304,
  pagesRead: 120,
  createdAt: '2026-11-01T00:00:00.000Z',
  lastReadAt: '2026-11-20T00:00:00.000Z',
  downloadPath: 'books/primary-1-10.epub',
  downloadStatus: 'available',
  fileSize: 524288,
  remoteAvailable: true,
};

let mounted: ReturnType<typeof mount> | null = null;
let container: HTMLDivElement;

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
  flushSync();
}

beforeEach(async () => {
  await clearDiagnostics();
  if (typeof Element.prototype.animate !== 'function') {
    Element.prototype.animate = (() => {
      const animation = {
        onfinish: null as (() => void) | null,
        cancel() {},
        finish() {
          animation.onfinish?.();
        },
      };
      queueMicrotask(() => animation.onfinish?.());
      return animation as unknown as Animation;
    }) as typeof Element.prototype.animate;
  }
  mocks.isNative = true;
  document.documentElement.dataset.theme = 'fennec';
  document.documentElement.dataset.mode = 'dark';
  container = document.createElement('div');
  document.body.append(container);

  mocks.networkGetStatus
    .mockReset()
    .mockResolvedValue({ connected: false, connectionType: 'none' });
  mocks.networkAddListener.mockClear();
  mocks.appAddListener.mockClear();
  mocks.getServer.mockReset().mockResolvedValue(savedServer);
  mocks.getPreferences.mockReset().mockResolvedValue(new Map());
  mocks.getBooks.mockReset().mockResolvedValue([savedBook]);
  mocks.getSyncStatus.mockReset().mockResolvedValue({
    pendingCount: 0,
    failedCount: 0,
    lastError: null,
    lastUpdatedAt: null,
  });
  mocks.resetLocalDatabase.mockReset().mockResolvedValue(undefined);
  mocks.prepareCredentials.mockReset().mockResolvedValue(undefined);
  mocks.getApiKey.mockReset().mockResolvedValue('secret-api-key');
  mocks.loadTheme.mockReset().mockResolvedValue(true);
  mocks.fetchLatestGithubRelease.mockReset().mockResolvedValue(null);
  mocks.cleanupInterruptedEpubDownloads.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  if (mounted) {
    unmount(mounted);
    mounted = null;
  }
  container.remove();
  vi.restoreAllMocks();
});

describe('App cold-launch parallel hydration', () => {
  it('merges preference reads, overlaps hydration work, skips duplicate Library reads, and defers release/cleanup work', async () => {
    const serverDeferred = deferred<ServerConfig | null>();
    const preferencesDeferred = deferred<Map<string, string>>();
    const networkDeferred = deferred<{ connected: boolean; connectionType: string }>();
    const themeDeferred = deferred<boolean>();
    const apiKeyDeferred = deferred<string | null>();
    const booksDeferred = deferred<BookRecord[]>();

    mocks.getServer.mockReturnValueOnce(serverDeferred.promise);
    mocks.getPreferences.mockReturnValueOnce(preferencesDeferred.promise);
    mocks.networkGetStatus.mockReturnValueOnce(networkDeferred.promise);
    mocks.loadTheme.mockReturnValueOnce(themeDeferred.promise);
    mocks.getApiKey.mockReturnValueOnce(apiKeyDeferred.promise);
    mocks.getBooks.mockReturnValueOnce(booksDeferred.promise);

    mounted = mount(App, { target: container });
    await flushMicrotasks(2);

    // Stage 1: prepareCredentials, getServer, merged 9-key getPreferences, and Network.getStatus all started concurrently.
    expect(mocks.prepareCredentials).toHaveBeenCalledOnce();
    expect(mocks.getServer).toHaveBeenCalledOnce();
    expect(mocks.getPreferences).toHaveBeenCalledExactlyOnceWith([
      'uiTheme',
      'uiMode',
      'syncFurthest',
      'librarySort',
      'libraryAuthor',
      'librarySeries',
      'libraryView',
      'libraryDownloadedOnly',
      'libraryHideCompleted',
    ]);
    expect(mocks.networkGetStatus).toHaveBeenCalledOnce();
    expect(mocks.fetchLatestGithubRelease).not.toHaveBeenCalled();
    expect(mocks.cleanupInterruptedEpubDownloads).not.toHaveBeenCalled();

    // Resolve getServer + getPreferences while Network.getStatus is still in flight.
    serverDeferred.resolve(savedServer);
    preferencesDeferred.resolve(
      new Map([
        ['uiTheme', 'vintage'],
        ['uiMode', 'dark'],
        ['librarySort', 'recent'],
        ['libraryDownloadedOnly', 'true'],
        ['libraryHideCompleted', 'false'],
      ]),
    );
    await flushMicrotasks(4);

    // Stage 2: loadTheme, getApiKey, and getBooks all run concurrently while Network.getStatus is still pending!
    expect(mocks.loadTheme).toHaveBeenCalledExactlyOnceWith('vintage');
    expect(mocks.getApiKey).toHaveBeenCalledExactlyOnceWith('server_primary_api_key');
    expect(mocks.getBooks).toHaveBeenCalledExactlyOnceWith('primary', {
      includeDescription: false,
    });
    expect(mocks.fetchLatestGithubRelease).not.toHaveBeenCalled();
    expect(mocks.cleanupInterruptedEpubDownloads).not.toHaveBeenCalled();

    // Finish remaining parallel startup promises.
    themeDeferred.resolve(true);
    apiKeyDeferred.resolve('secret-api-key');
    booksDeferred.resolve([savedBook]);
    networkDeferred.resolve({ connected: false, connectionType: 'none' });
    await flushMicrotasks(8);

    // Library rendered saved books in dark mode without duplicate startup reads.
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('vintage');
    expect(container.textContent).toContain('The Left Hand of Darkness');
    expect(container.textContent).toContain('No network connection. Showing your saved library.');
    const filterButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[role="group"][aria-label="Library filters"] button',
      ),
    );
    const downloadedButton = filterButtons.find((btn) =>
      btn.textContent?.includes('Downloaded Only'),
    );
    const hideCompletedButton = filterButtons.find((btn) =>
      btn.textContent?.includes('Hide completed'),
    );
    expect(downloadedButton?.getAttribute('aria-pressed')).toBe('true');
    expect(hideCompletedButton?.getAttribute('aria-pressed')).toBe('false');
    expect(mocks.getPreferences).toHaveBeenCalledOnce();
    expect(mocks.getBooks).toHaveBeenCalledOnce();
    expect(mocks.networkGetStatus).toHaveBeenCalledOnce();

    // Deferred background tasks started only after initial view hydration rendered.
    expect(mocks.fetchLatestGithubRelease).toHaveBeenCalledOnce();
    expect(mocks.cleanupInterruptedEpubDownloads).toHaveBeenCalledOnce();
  });

  it('preserves Retry and Enter auth key recovery when reading credentials fails', async () => {
    mocks.getApiKey
      .mockRejectedValueOnce(new Error('keystore locked'))
      .mockResolvedValueOnce('recovered-api-key');

    mounted = mount(App, { target: container });
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Turnleaf could not read the saved Kavita key. Retry or enter the key again.',
      );
    });

    const alert = container.querySelector('[role="alert"]');
    const buttons = Array.from(alert?.querySelectorAll('button') ?? []).map((btn) =>
      btn.textContent?.trim(),
    );
    expect(buttons.slice(0, 2)).toEqual(['Retry', 'Enter auth key']);
    expect(alert?.textContent).toContain('Diagnostics (1)');
    expect(exportDiagnostics({ appVersion: '0.3.5', platform: 'android' })).toContain(
      'startup endpoint=local/credentials detail=credential-read-failed',
    );
    await vi.waitFor(() => expect(mocks.fetchLatestGithubRelease).toHaveBeenCalledOnce());

    // Clicking Enter auth key opens reconnect Onboarding with savedServer preserved.
    const enterKeyButton = Array.from(alert?.querySelectorAll('button') ?? []).find(
      (btn) => btn.textContent?.trim() === 'Enter auth key',
    );
    enterKeyButton?.click();
    flushSync();
    expect(container.textContent).toContain('Reconnect to Kavita');
    expect(container.textContent).toContain('https://books.example.com');

    // Remount to verify Retry recovers cleanly when keystore unlocks.
    unmount(mounted);
    container.innerHTML = '';
    mocks.getApiKey
      .mockReset()
      .mockRejectedValueOnce(new Error('keystore locked'))
      .mockResolvedValueOnce('recovered-api-key');

    mounted = mount(App, { target: container });
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    });
    const retryButton = Array.from(container.querySelectorAll('[role="alert"] button')).find(
      (btn) => btn.textContent?.trim() === 'Retry',
    ) as HTMLButtonElement | undefined;
    retryButton?.click();
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).toContain('The Left Hand of Darkness');
    });
  });

  it('preserves Reset local data safeguard via resetLocalDatabase when local SQLite fails', async () => {
    mocks.getServer.mockRejectedValueOnce(new Error('sqlite corrupt')).mockResolvedValueOnce(null);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    mounted = mount(App, { target: container });
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Turnleaf could not open its local data.',
      );
    });

    const alert = container.querySelector('[role="alert"]');
    const resetButton = Array.from(alert?.querySelectorAll('button') ?? []).find((btn) =>
      btn.textContent?.includes('Reset local data'),
    ) as HTMLButtonElement | undefined;
    expect(resetButton).toBeDefined();

    resetButton?.click();
    await vi.waitFor(() => {
      expect(mocks.resetLocalDatabase).toHaveBeenCalledOnce();
      expect(container.textContent).not.toContain('Turnleaf could not open its local data.');
      expect(container.textContent).toContain('Your books,');
    });
  });

  it('discards stale startup generations and post-unmount completions without recording stale diagnostics', async () => {
    const staleBooks = deferred<BookRecord[]>();
    mocks.getBooks.mockReturnValueOnce(staleBooks.promise);

    mounted = mount(App, { target: container });
    await flushMicrotasks(4);
    expect(mocks.getBooks).toHaveBeenCalledOnce();

    unmount(mounted);
    mounted = null;

    staleBooks.reject(new Error('late sqlite failure after unmount'));
    await flushMicrotasks(4);

    expect(exportDiagnostics({ appVersion: '0.3.5', platform: 'android' })).not.toContain(
      'database-open-failed',
    );
    expect(mocks.fetchLatestGithubRelease).not.toHaveBeenCalled();
  });
});
