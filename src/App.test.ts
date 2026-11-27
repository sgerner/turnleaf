// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type * as CapacitorCoreModule from '@capacitor/core';
import type { BookRecord, ServerConfig } from './lib/database/database';
import type * as ThemesModule from './lib/themes/themes';

import { clearDiagnostics, exportDiagnostics } from './lib/diagnostics/log';

const {
  runtimeState,
  networkListeners,
  networkGetStatusMock,
  capacitorHttpRequestMock,
  prepareCredentialsMock,
  fetchLatestGithubReleaseMock,
  getServerMock,
  getPreferencesMock,
  setPreferenceMock,
  setPreferencesMock,
  getBooksMock,
  getReadingStateMock,
  getSyncStatusMock,
  removeServerMock,
  resetLocalDatabaseMock,
  getApiKeyMock,
  removeApiKeyMock,
  loadThemeMock,
  verifyDownloadedEpubMock,
  cleanupInterruptedEpubDownloadsMock,
  clearCoverCacheMock,
  openSessionMock,
  destroySessionMock,
} = vi.hoisted(() => ({
  runtimeState: { native: false },
  networkListeners: new Set<(status: { connected: boolean; connectionType: string }) => void>(),
  networkGetStatusMock: vi.fn().mockResolvedValue({ connected: false, connectionType: 'none' }),
  capacitorHttpRequestMock: vi.fn().mockResolvedValue({
    status: 200,
    headers: {},
    url: 'https://books.example.com/api/Series/v2',
    data: [],
  }),
  prepareCredentialsMock: vi.fn().mockResolvedValue(undefined),
  fetchLatestGithubReleaseMock: vi.fn(),
  getServerMock: vi.fn(),
  getPreferencesMock: vi.fn(),
  setPreferenceMock: vi.fn(),
  setPreferencesMock: vi.fn(),
  getBooksMock: vi.fn(),
  getReadingStateMock: vi.fn(),
  getSyncStatusMock: vi.fn(),
  removeServerMock: vi.fn(),
  resetLocalDatabaseMock: vi.fn(),
  getApiKeyMock: vi.fn(),
  removeApiKeyMock: vi.fn(),
  loadThemeMock: vi.fn(),
  verifyDownloadedEpubMock: vi.fn(),
  cleanupInterruptedEpubDownloadsMock: vi.fn(),
  clearCoverCacheMock: vi.fn(),
  openSessionMock: vi.fn(),
  destroySessionMock: vi.fn(),
}));

vi.mock('./lib/github/releases', () => ({
  fetchLatestGithubRelease: fetchLatestGithubReleaseMock,
}));

vi.mock('./lib/themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    loadTheme: loadThemeMock,
    skeletonThemes: ['fennec', 'eink', 'catppuccin'],
  };
});

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CapacitorCoreModule>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => runtimeState.native,
      getPlatform: () => (runtimeState.native ? 'android' : 'web'),
      convertFileSrc: (uri: string) => uri,
    },
    CapacitorHttp: {
      ...actual.CapacitorHttp,
      request: capacitorHttpRequestMock,
    },
  };
});

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA', Documents: 'DOCUMENTS' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    readFile: vi.fn().mockRejectedValue(new Error('File not found')),
    writeFile: vi.fn().mockResolvedValue({ uri: 'file://DATA/diagnostics.json' }),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./lib/native/credentials', () => ({
  prepare: prepareCredentialsMock,
  getApiKey: getApiKeyMock,
  removeApiKey: removeApiKeyMock,
  saveApiKey: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./lib/database/database', () => ({
  getServer: getServerMock,
  getPreferences: getPreferencesMock,
  setPreference: setPreferenceMock,
  setPreferences: setPreferencesMock,
  getBooks: getBooksMock,
  getReadingState: getReadingStateMock,
  getSyncStatus: getSyncStatusMock,
  removeServer: removeServerMock,
  resetLocalDatabase: resetLocalDatabaseMock,
  acceptRemoteProgress: vi.fn(),
  markDownloaded: vi.fn(),
  markBookCompleted: vi.fn(),
  removeDownload: vi.fn(),
  reconcileBooks: vi.fn(),
  saveLocalProgress: vi.fn(),
  saveRemoteProgress: vi.fn(),
  saveServer: vi.fn(),
}));

vi.mock('./lib/downloads/native-download', () => ({
  cacheCover: vi.fn(),
  clearCoverCache: clearCoverCacheMock,
  cleanupInterruptedEpubDownloads: cleanupInterruptedEpubDownloadsMock,
  deleteDownloadedEpub: vi.fn().mockResolvedValue(undefined),
  downloadEpub: vi.fn(),
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class EpubTransferError extends Error {},
  verifyDownloadedEpub: verifyDownloadedEpubMock,
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: networkGetStatusMock,
    addListener: vi.fn(
      async (
        _event: string,
        listener: (status: { connected: boolean; connectionType: string }) => void,
      ) => {
        networkListeners.add(listener);
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
    addListener: vi.fn().mockResolvedValue({ remove: async () => {} }),
    exitApp: vi.fn(),
  },
}));

vi.mock('./lib/reader/session', () => ({
  resolveReaderKeyboardAction: vi.fn(() => null),
  ReaderSession: class MockReaderSession {
    open = openSessionMock;
    tableOfContents = () => [];
    getVisiblePassages = () => [];
    clearTextSelection = vi.fn();
    updateHighlights = vi.fn();
    destroy = destroySessionMock;
  },
}));

import App from './App.svelte';

function ensureElementAnimate(): void {
  if (typeof Element.prototype.animate !== 'function') {
    Element.prototype.animate = (() => {
      const anim = {
        currentTime: 0,
        playState: 'running',
        effect: null,
        onfinish: null as ((event: AnimationPlaybackEvent) => void) | null,
        cancel() {
          anim.playState = 'idle';
        },
        finish() {
          anim.playState = 'finished';
        },
      };
      queueMicrotask(() => {
        if (anim.playState !== 'idle') {
          anim.playState = 'finished';
          anim.onfinish?.(new Event('finish') as AnimationPlaybackEvent);
        }
      });
      return anim as unknown as Animation;
    }) as typeof Element.prototype.animate;
  }
}

describe('App shell releaseBanner layout', () => {
  let host: HTMLDivElement;
  let instance: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    ensureElementAnimate();
    fetchLatestGithubReleaseMock.mockResolvedValue({
      version: '0.4.0',
      title: 'Accessibility Update',
      releaseUrl: 'https://github.com/sgerner/turnleaf/releases/tag/v0.4.0',
      downloadUrl: 'https://github.com/sgerner/turnleaf/releases/download/v0.4.0/turnleaf.apk',
    });
    getServerMock.mockResolvedValue(null);
    getPreferencesMock.mockResolvedValue(new Map());
    resetLocalDatabaseMock.mockResolvedValue(undefined);
    getApiKeyMock.mockResolvedValue(null);
    removeApiKeyMock.mockResolvedValue(undefined);
    loadThemeMock.mockResolvedValue(true);

    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(async () => {
    if (instance) {
      await unmount(instance);
      instance = null;
    }
    host.remove();
  });

  it('renders releaseBanner as a non-sticky sibling above .app-stage and allows dismissal', async () => {
    instance = mount(App, { target: host });
    await vi.waitFor(() => {
      expect(host.querySelector('.release-banner')).not.toBeNull();
    });
    await tick();

    const shell = host.querySelector<HTMLElement>('.app-shell')!;
    const banner = host.querySelector<HTMLElement>('.release-banner')!;
    const stage = host.querySelector<HTMLElement>('.app-stage')!;

    expect(banner.parentElement).toBe(shell);
    expect(stage.parentElement).toBe(shell);
    expect(stage.contains(banner)).toBe(false);
    expect(banner.classList.contains('sticky')).toBe(false);
    expect(stage.querySelector('.sticky')).toBeNull();
    expect(Boolean(banner.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );

    const dismissButton = Array.from(banner.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Dismiss',
    )!;
    flushSync(() => {
      dismissButton.click();
    });

    await vi.waitFor(() => {
      expect(host.querySelector('.release-banner')).toBeNull();
    });
  });

  it('marks .release-banner inert while Library overlays are open via onOverlayActiveChange and restores it on close', async () => {
    getServerMock.mockResolvedValue(savedServer);
    getApiKeyMock.mockResolvedValue('secret-api-key');
    getBooksMock.mockResolvedValue([downloadedBook]);
    getSyncStatusMock.mockResolvedValue({ pendingCount: 0, failedCount: 0 });
    cleanupInterruptedEpubDownloadsMock.mockResolvedValue(undefined);

    instance = mount(App, { target: host });
    await vi.waitFor(() => {
      expect(host.querySelector('.release-banner')).not.toBeNull();
      expect(host.querySelector('button[aria-label="Open settings"]')).not.toBeNull();
    });

    const banner = host.querySelector<HTMLElement>('.release-banner')!;
    expect(banner.inert).toBe(false);

    flushSync(() => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Open settings"]')?.click();
    });
    await tick();
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(banner.inert).toBe(true);

    flushSync(() => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]')?.click();
    });
    await tick();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(banner.inert).toBe(false);
  });
});

const savedServer: ServerConfig = {
  id: 'server-1',
  baseUrl: 'https://books.example.com',
  displayName: 'Home Library',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.4',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const downloadedBook: BookRecord = {
  id: 'book-1',
  serverId: 'server-1',
  libraryId: 1,
  seriesId: 10,
  volumeId: 100,
  chapterId: 1000,
  title: 'Static Glows Handbook',
  author: 'Ada Lovelace',
  series: 'Performance Notes',
  descriptionHtml: null,
  format: 'EPUB',
  pages: 200,
  pagesRead: 40,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-01-02T00:00:00.000Z',
  downloadPath: 'books/book-1.epub',
  downloadStatus: 'downloaded',
  fileSize: 524_288,
  remoteAvailable: true,
};

describe('App.svelte static ambient glows and reader unmount behavior', () => {
  let target: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    ensureElementAnimate();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-mode');

    fetchLatestGithubReleaseMock.mockResolvedValue(null);
    getServerMock.mockResolvedValue(savedServer);
    getApiKeyMock.mockResolvedValue('secret-api-key');
    removeApiKeyMock.mockResolvedValue(undefined);
    removeServerMock.mockResolvedValue(undefined);
    loadThemeMock.mockResolvedValue(true);
    getPreferencesMock.mockResolvedValue(new Map());
    setPreferenceMock.mockResolvedValue(undefined);
    setPreferencesMock.mockResolvedValue(undefined);
    getBooksMock.mockResolvedValue([downloadedBook]);
    getReadingStateMock.mockResolvedValue({
      bookId: downloadedBook.id,
      cfi: 'epubcfi(/6/2!/4/2)',
      xpath: null,
      percentage: 0.2,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    getSyncStatusMock.mockResolvedValue({ pendingCount: 0, failedCount: 0 });
    verifyDownloadedEpubMock.mockResolvedValue({
      path: downloadedBook.downloadPath,
      webViewUrl: 'blob:book-1',
    });
    cleanupInterruptedEpubDownloadsMock.mockResolvedValue(undefined);
    clearCoverCacheMock.mockResolvedValue(undefined);
    openSessionMock.mockResolvedValue(undefined);

    target = document.createElement('div');
    document.body.append(target);
  });

  afterEach(async () => {
    if (mounted) {
      await unmount(mounted);
      mounted = null;
    }
    target.remove();
  });

  it('omits .mesh, will-change, translate3d, and infinite drift-* keyframe rules in App.svelte', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8');

    expect(source).not.toContain('.mesh');
    expect(source).not.toContain('class="mesh"');
    expect(source).not.toContain('will-change');
    expect(source).not.toContain('translate3d');
    expect(source).not.toMatch(/drift-(primary|secondary|tertiary)/);
    expect(source).not.toContain('@keyframes');

    expect(source).toContain('.orb-primary');
    expect(source).toContain('.orb-secondary');
    expect(source).toContain('.orb-tertiary');
    expect(source).toContain('.vignette');
  });

  it('mounts static .app-ambient in the library and unmounts it while Reader.svelte is open', async () => {
    mounted = mount(App, { target });

    const findContinueButton = () =>
      [...target.querySelectorAll<HTMLButtonElement>('button')].find(
        (btn) =>
          btn.textContent?.includes('Continue reading') &&
          btn.textContent?.includes('Static Glows Handbook'),
      ) ?? null;

    await vi.waitFor(() => {
      expect(findContinueButton()).not.toBeNull();
    });

    const ambient = target.querySelector('.app-ambient');
    expect(ambient).not.toBeNull();
    expect(ambient?.querySelectorAll('.orb')).toHaveLength(3);
    expect(ambient?.querySelector('.vignette')).not.toBeNull();
    expect(ambient?.querySelector('.mesh')).toBeNull();

    const continueButton = findContinueButton();
    continueButton?.click();

    await vi.waitFor(
      () => {
        expect(target.querySelector('.reader-shell')).not.toBeNull();
      },
      { timeout: 5000 },
    );
    flushSync();

    expect(target.querySelector('.app-ambient')).toBeNull();

    const showControlsButton = target.querySelector<HTMLButtonElement>(
      'button[aria-label="Show reading controls"]',
    );
    showControlsButton?.click();
    flushSync();

    const backButton = target.querySelector<HTMLButtonElement>(
      'button[aria-label="Back to library"]',
    );
    expect(backButton).not.toBeNull();
    backButton?.click();

    await vi.waitFor(() => {
      expect(target.querySelector('.reader-shell')).toBeNull();
      expect(target.querySelector('.app-ambient')).not.toBeNull();
    });
  });

  it('unmounts .app-ambient when uiTheme is eink and restores it for non-eink themes', async () => {
    getPreferencesMock.mockImplementation(async (keys: string[]) => {
      const map = new Map<string, string>();
      if (keys.includes('uiTheme')) map.set('uiTheme', 'eink');
      return map;
    });

    mounted = mount(App, { target });

    await vi.waitFor(() => {
      expect(target.querySelector('button[aria-label="Open settings"]')).not.toBeNull();
    });
    expect(document.documentElement.dataset.theme).toBe('eink');
    expect(target.querySelector('.app-ambient')).toBeNull();

    target.querySelector<HTMLButtonElement>('button[aria-label="Open settings"]')?.click();
    flushSync();

    target.querySelector<HTMLButtonElement>('button[aria-label="Use fennec theme"]')?.click();
    await vi.waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('fennec');
      expect(target.querySelector('.app-ambient')).not.toBeNull();
    });

    target.querySelector<HTMLButtonElement>('button[aria-label="Use eink theme"]')?.click();
    await vi.waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('eink');
      expect(target.querySelector('.app-ambient')).toBeNull();
    });
  });

  it('keeps .app-ambient mounted on Onboarding after leaving Library via server address change or deletion', async () => {
    mounted = mount(App, { target });

    await vi.waitFor(() => {
      expect(target.querySelector('button[aria-label="Open settings"]')).not.toBeNull();
    });

    target.querySelector<HTMLButtonElement>('button[aria-label="Open settings"]')?.click();
    flushSync();

    const changeAddressButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.includes('Change server address'),
    );
    expect(changeAddressButton).toBeDefined();
    changeAddressButton?.click();
    flushSync();

    expect(target.querySelector('.app-ambient')).not.toBeNull();

    const cancelButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find((btn) =>
      btn.textContent?.includes('Cancel'),
    );
    cancelButton?.click();

    await vi.waitFor(() => {
      expect(target.querySelector('button[aria-label="Open settings"]')).not.toBeNull();
    });
    target.querySelector<HTMLButtonElement>('button[aria-label="Open settings"]')?.click();
    flushSync();

    const deleteServerButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Delete server',
    );
    deleteServerButton?.click();
    flushSync();

    const confirmDeleteButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Delete now',
    );
    confirmDeleteButton?.click();

    await vi.waitFor(() => {
      expect(removeServerMock).toHaveBeenCalledWith('server-1');
    });
    flushSync();
    expect(target.querySelector('.app-ambient')).not.toBeNull();
  });

  it('hydrates Library from a single concurrent startup pass and discards stale loadLocalData generations', async () => {
    let resolveSlowBooks!: (books: BookRecord[]) => void;
    const slowBooksPromise = new Promise<BookRecord[]>((res) => {
      resolveSlowBooks = res;
    });

    getApiKeyMock
      .mockRejectedValueOnce(new Error('keystore locked'))
      .mockResolvedValueOnce('secret-api-key');
    getBooksMock.mockResolvedValueOnce([downloadedBook]).mockReturnValueOnce(slowBooksPromise);

    mounted = mount(App, { target });

    await vi.waitFor(() => {
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        'Turnleaf could not read the saved Kavita key.',
      );
    });
    expect(getPreferencesMock).toHaveBeenCalledTimes(1);
    expect(getBooksMock).toHaveBeenCalledTimes(1);

    const retryButton = [
      ...target.querySelectorAll<HTMLButtonElement>('[role="alert"] button'),
    ].find((btn) => btn.textContent?.trim() === 'Retry');
    retryButton?.click();
    await vi.waitFor(() => {
      expect(getBooksMock).toHaveBeenCalledTimes(2);
    });

    // Start a third generation via unmount + remount check or overlapping Retry:
    // here, unmounting while generation 2 is still awaiting slowBooksPromise ensures
    // resolving slowBooksPromise afterwards does not mutate DOM or throw.
    await unmount(mounted);
    mounted = null;
    resolveSlowBooks([
      {
        ...downloadedBook,
        id: 'stale-book',
        title: 'Stale Generation Book',
      },
    ]);
    await tick();
    expect(target.textContent).not.toContain('Stale Generation Book');
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
  flushSync();
}

describe('App cold-launch parallel hydration', () => {
  let container: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    await clearDiagnostics();
    ensureElementAnimate();
    runtimeState.native = true;
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    networkListeners.clear();
    document.documentElement.dataset.theme = 'fennec';
    document.documentElement.dataset.mode = 'dark';
    container = document.createElement('div');
    document.body.append(container);

    networkGetStatusMock
      .mockReset()
      .mockResolvedValue({ connected: false, connectionType: 'none' });
    capacitorHttpRequestMock.mockReset().mockResolvedValue({
      status: 200,
      headers: {},
      url: 'https://books.example.com/api/Series/v2',
      data: [],
    });
    prepareCredentialsMock.mockReset().mockResolvedValue(undefined);
    fetchLatestGithubReleaseMock.mockReset().mockResolvedValue(null);
    getServerMock.mockReset().mockResolvedValue(savedServer);
    getPreferencesMock.mockReset().mockResolvedValue(new Map());
    getBooksMock.mockReset().mockResolvedValue([downloadedBook]);
    getSyncStatusMock.mockReset().mockResolvedValue({ pendingCount: 0, failedCount: 0 });
    resetLocalDatabaseMock.mockReset().mockResolvedValue(undefined);
    getApiKeyMock.mockReset().mockResolvedValue('secret-api-key');
    loadThemeMock.mockReset().mockResolvedValue(true);
    cleanupInterruptedEpubDownloadsMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (mounted) {
      await unmount(mounted);
      mounted = null;
    }
    runtimeState.native = false;
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    networkListeners.clear();
    container.remove();
  });

  it('merges preference reads, overlaps hydration work, skips duplicate Library reads, and defers release/cleanup work', async () => {
    const serverDeferred = deferred<ServerConfig | null>();
    const preferencesDeferred = deferred<Map<string, string>>();
    const networkDeferred = deferred<{ connected: boolean; connectionType: string }>();
    const themeDeferred = deferred<boolean>();
    const apiKeyDeferred = deferred<string | null>();
    const booksDeferred = deferred<BookRecord[]>();

    getServerMock.mockReturnValueOnce(serverDeferred.promise);
    getPreferencesMock.mockReturnValueOnce(preferencesDeferred.promise);
    networkGetStatusMock.mockReturnValueOnce(networkDeferred.promise);
    loadThemeMock.mockReturnValueOnce(themeDeferred.promise);
    getApiKeyMock.mockReturnValueOnce(apiKeyDeferred.promise);
    getBooksMock.mockReturnValueOnce(booksDeferred.promise);

    mounted = mount(App, { target: container });
    await flushMicrotasks(2);

    expect(prepareCredentialsMock).toHaveBeenCalledOnce();
    expect(getServerMock).toHaveBeenCalledOnce();
    expect(getPreferencesMock).toHaveBeenCalledExactlyOnceWith([
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
    expect(networkGetStatusMock).toHaveBeenCalledOnce();
    expect(fetchLatestGithubReleaseMock).not.toHaveBeenCalled();
    expect(cleanupInterruptedEpubDownloadsMock).not.toHaveBeenCalled();

    serverDeferred.resolve(savedServer);
    preferencesDeferred.resolve(
      new Map([
        ['uiTheme', 'catppuccin'],
        ['uiMode', 'dark'],
        ['librarySort', 'recent'],
        ['libraryDownloadedOnly', 'true'],
        ['libraryHideCompleted', 'false'],
      ]),
    );
    await flushMicrotasks(4);

    expect(loadThemeMock).toHaveBeenCalledExactlyOnceWith('catppuccin');
    expect(getApiKeyMock).toHaveBeenCalledExactlyOnceWith('cred-1');
    expect(getBooksMock).toHaveBeenCalledExactlyOnceWith('server-1', {
      includeDescription: false,
    });
    expect(fetchLatestGithubReleaseMock).not.toHaveBeenCalled();
    expect(cleanupInterruptedEpubDownloadsMock).not.toHaveBeenCalled();

    themeDeferred.resolve(true);
    apiKeyDeferred.resolve('secret-api-key');
    booksDeferred.resolve([downloadedBook]);
    networkDeferred.resolve({ connected: false, connectionType: 'none' });
    await flushMicrotasks(8);

    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('catppuccin');
    expect(container.textContent).toContain('Static Glows Handbook');
    expect(container.textContent).toContain('No network connection. Showing your saved library.');
    const filterButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[role="group"][aria-label="Library filters"] button',
      ),
    ];
    expect(
      filterButtons
        .find((btn) => btn.textContent?.includes('Downloaded Only'))
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      filterButtons
        .find((btn) => btn.textContent?.includes('Hide completed'))
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
    expect(getPreferencesMock).toHaveBeenCalledOnce();
    expect(getBooksMock).toHaveBeenCalledOnce();
    expect(networkGetStatusMock).toHaveBeenCalledOnce();
    expect(fetchLatestGithubReleaseMock).toHaveBeenCalledOnce();
    expect(cleanupInterruptedEpubDownloadsMock).toHaveBeenCalledOnce();
  });

  it('preserves Retry, Enter auth key, Reset local data, and post-unmount diagnostic guards', async () => {
    getApiKeyMock.mockRejectedValueOnce(new Error('keystore locked'));
    mounted = mount(App, { target: container });
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Turnleaf could not read the saved Kavita key. Retry or enter the key again.',
      );
    });
    expect(exportDiagnostics({ appVersion: '0.3.5', platform: 'android' })).toContain(
      'startup endpoint=local/credentials detail=credential-read-failed',
    );
    const enterKeyBtn = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="alert"] button'),
    ].find((btn) => btn.textContent?.trim() === 'Enter auth key');
    enterKeyBtn?.click();
    flushSync();
    expect(container.textContent).toContain('Reconnect to Kavita');

    await unmount(mounted);
    container.innerHTML = '';
    await clearDiagnostics();

    getServerMock.mockRejectedValueOnce(new Error('sqlite corrupt')).mockResolvedValueOnce(null);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      mounted = mount(App, { target: container });
      await vi.waitFor(() => {
        expect(container.querySelector('[role="alert"]')?.textContent ?? '').toContain(
          'Turnleaf could not open its local data.',
        );
      });
      const resetBtn = [
        ...container.querySelectorAll<HTMLButtonElement>('[role="alert"] button'),
      ].find((btn) => btn.textContent?.includes('Reset local data'));
      resetBtn?.click();
      await vi.waitFor(() => {
        expect(resetLocalDatabaseMock).toHaveBeenCalledOnce();
        expect(container.textContent).toContain('Your books,');
      });
    } finally {
      confirmSpy.mockRestore();
    }

    await unmount(mounted);
    container.innerHTML = '';
    await clearDiagnostics();

    const staleBooks = deferred<BookRecord[]>();
    getBooksMock.mockReturnValueOnce(staleBooks.promise);
    mounted = mount(App, { target: container });
    await flushMicrotasks(4);
    await unmount(mounted);
    mounted = null;
    staleBooks.reject(new Error('late sqlite failure'));
    await flushMicrotasks(4);
    expect(exportDiagnostics({ appVersion: '0.3.5', platform: 'android' })).not.toContain(
      'database-open-failed',
    );
  });

  it('reconciles WebView offline state and stale startup Network.getStatus so offline launch blocks requests and refreshes on reconnect', async () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    networkGetStatusMock.mockResolvedValue({ connected: true, connectionType: 'wifi' });

    mounted = mount(App, { target: container });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('No network connection. Showing your saved library.');
    });
    await flushMicrotasks(6);
    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();

    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(capacitorHttpRequestMock).toHaveBeenCalled();
    });

    await unmount(mounted);
    mounted = null;
    container.innerHTML = '';
    capacitorHttpRequestMock.mockClear();

    networkGetStatusMock
      .mockResolvedValueOnce({ connected: true, connectionType: 'wifi' })
      .mockResolvedValue({ connected: false, connectionType: 'none' });

    mounted = mount(App, { target: container });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('No network connection. Showing your saved library.');
    });
    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();

    networkGetStatusMock.mockResolvedValue({ connected: true, connectionType: 'wifi' });
    for (const listener of networkListeners) {
      listener({ connected: true, connectionType: 'wifi' });
    }
    await vi.waitFor(() => {
      expect(capacitorHttpRequestMock).toHaveBeenCalled();
    });
  });
});
