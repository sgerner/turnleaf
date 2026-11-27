// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { BookRecord, ServerConfig } from './lib/database/database';
import type * as ThemesModule from './lib/themes/themes';

const {
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

vi.mock('./lib/native/credentials', () => ({
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
    getStatus: vi.fn().mockResolvedValue({ connected: false, connectionType: 'none' }),
    addListener: vi.fn().mockResolvedValue({ remove: async () => {} }),
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
    expect(stage.dataset.stickyBannerHeight).toBe('0');
  });

  it('tracks releaseBanner height dynamically via ResizeObserver and resets on dismissal', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    try {
      instance = mount(App, { target: host });
      await vi.waitFor(() => {
        expect(host.querySelector('.release-banner')).not.toBeNull();
      });
      await tick();

      const banner = host.querySelector<HTMLElement>('.release-banner')!;
      const stage = host.querySelector<HTMLElement>('.app-stage')!;

      vi.spyOn(banner, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 96));
      resizeCallbacks[0]?.(
        [{ contentRect: { width: 800, height: 96 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      await tick();

      expect(banner.dataset.bannerHeight).toBe('96');
      expect(stage.dataset.stickyBannerHeight).toBe('96');
      expect(stage.style.getPropertyValue('--release-banner-height')).toBe('96px');
      expect(banner.inert).toBe(false);

      const dismissButton = Array.from(banner.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Dismiss',
      )!;
      flushSync(() => {
        dismissButton.click();
      });
      await tick();

      expect(stage.dataset.stickyBannerHeight).toBe('0');
      expect(stage.style.getPropertyValue('--release-banner-height')).toBe('0px');
    } finally {
      vi.unstubAllGlobals();
    }
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

    await vi.waitFor(() => {
      expect(target.querySelector('.reader-shell')).not.toBeNull();
    });
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
});
