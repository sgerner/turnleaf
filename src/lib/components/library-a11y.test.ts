// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookRecord, ServerConfig, StoredReadingState } from '../database/database';
import type { KavitaProgress } from '../kavita/types';
import type * as ThemesModule from '../themes/themes';

const mocks = vi.hoisted(() => {
  let backListener: (() => void) | null = null;
  let books: BookRecord[] = [];
  let connected = false;
  let preferences = new Map<string, string>();
  let localReadingState: StoredReadingState | null = null;
  let remoteProgress: KavitaProgress | null = null;
  let releaseBannerData: {
    version: string;
    title: string;
    releaseUrl: string;
    downloadUrl: string | null;
  } | null = null;

  return {
    getBackListener: () => backListener,
    setBackListener: (fn: (() => void) | null) => {
      backListener = fn;
    },
    getBooks: () => books,
    setBooks: (next: BookRecord[]) => {
      books = next;
    },
    getConnected: () => connected,
    setConnected: (next: boolean) => {
      connected = next;
    },
    getPreferences: () => preferences,
    setPreferences: (next: Map<string, string>) => {
      preferences = next;
    },
    getLocalReadingState: () => localReadingState,
    setLocalReadingState: (next: StoredReadingState | null) => {
      localReadingState = next;
    },
    getRemoteProgress: () => remoteProgress,
    setRemoteProgress: (next: KavitaProgress | null) => {
      remoteProgress = next;
    },
    getReleaseBanner: () => releaseBannerData,
    setReleaseBanner: (next: typeof releaseBannerData) => {
      releaseBannerData = next;
    },
  };
});

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: mocks.getConnected() })),
    addListener: vi.fn(async () => ({ remove: async () => {} })),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (eventName: string, callback: () => void) => {
      if (eventName === 'backButton') mocks.setBackListener(callback);
      return {
        remove: async () => {
          if (eventName === 'backButton' && mocks.getBackListener() === callback) {
            mocks.setBackListener(null);
          }
        },
      };
    }),
    exitApp: vi.fn(async () => {}),
  },
}));

vi.mock('../database/database', () => ({
  getServer: vi.fn(async (): Promise<ServerConfig> => ({
    id: 'srv-1',
    displayName: 'Local Kavita',
    baseUrl: 'https://kavita.example',
    credentialRef: 'cred-1',
    kavitaVersion: '0.8.0',
    lastConnectedAt: '2026-01-01T00:00:00.000Z',
  })),
  getBooks: vi.fn(async () => mocks.getBooks()),
  getPreferences: vi.fn(async () => new Map(mocks.getPreferences())),
  setPreference: vi.fn(async (key: string, value: string) => {
    mocks.getPreferences().set(key, value);
  }),
  getSyncStatus: vi.fn(async () => ({
    pendingCount: 0,
    failedCount: 0,
    lastError: null,
    lastUpdatedAt: null,
  })),
  getReadingState: vi.fn(async () => mocks.getLocalReadingState()),
  acceptRemoteProgress: vi.fn(async () => true),
  markDownloaded: vi.fn(async () => {}),
  markBookCompleted: vi.fn(async () => {}),
  removeDownload: vi.fn(async () => {}),
  removeServer: vi.fn(async () => {}),
  reconcileBooks: vi.fn(async () => {}),
  saveLocalProgress: vi.fn(async () => {}),
  saveRemoteProgress: vi.fn(async () => true),
  saveServer: vi.fn(async () => {}),
  resetLocalDatabase: vi.fn(async () => {}),
}));

vi.mock('../native/credentials', () => ({
  getApiKey: vi.fn(async () => 'test-api-key'),
  saveApiKey: vi.fn(async () => {}),
  removeApiKey: vi.fn(async () => {}),
}));

vi.mock('../themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    skeletonThemes: ['fennec', 'vintage'],
    loadTheme: vi.fn(async () => true),
  };
});

vi.mock('../github/releases', () => ({
  fetchLatestGithubRelease: vi.fn(async () => mocks.getReleaseBanner()),
}));

vi.mock('../downloads/native-download', () => ({
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class EpubTransferError extends Error {},
  cacheCover: vi.fn(async () => ''),
  clearCoverCache: vi.fn(async () => {}),
  cleanupInterruptedEpubDownloads: vi.fn(async () => {}),
  deleteDownloadedEpub: vi.fn(async () => {}),
  downloadEpub: vi.fn(async () => ({ path: 'book.epub', size: 1024 })),
  verifyDownloadedEpub: vi.fn(async () => ({ webViewUrl: 'blob:test-book' })),
}));

vi.mock('../kavita/client', () => ({
  KavitaError: class KavitaError extends Error {
    kind = 'network';
    status = 0;
  },
  KavitaClient: class {
    coverUrl(seriesId: number): string {
      return `https://kavita.example/cover/${seriesId}`;
    }
    async getCover(): Promise<Blob> {
      return new Blob();
    }
    async getBookSeries(): Promise<never[]> {
      return [];
    }
    async getProgress(): Promise<KavitaProgress | null> {
      return mocks.getRemoteProgress();
    }
  },
}));

import AppShell from '../../App.svelte';
import Library from './Library.svelte';

if (typeof Element !== 'undefined' && !Element.prototype.animate) {
  Element.prototype.animate = () => {
    const animation = {
      onfinish: null as (() => void) | null,
      cancel: () => {},
      finish: () => animation.onfinish?.(),
      play: () => {},
      pause: () => {},
      reverse: () => {},
      finished: Promise.resolve(),
    };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
}

function makeBooks(count: number): BookRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const padded = String(index + 1).padStart(4, '0');
    return {
      id: `book-${padded}`,
      serverId: 'srv-1',
      libraryId: 1,
      seriesId: index + 1,
      volumeId: index + 1,
      chapterId: index + 1,
      title: `Catalog Book ${padded}`,
      author: index % 2 === 0 ? 'Ursula Le Guin' : 'Octavia Butler',
      series: `Series ${(index % 5) + 1}`,
      descriptionHtml: null,
      format: 'EPUB',
      pages: 200,
      pagesRead: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastReadAt: null,
      downloadPath: index === 0 ? '/books/book-0001.epub' : null,
      downloadStatus: index === 0 ? 'downloaded' : 'none',
      fileSize: index === 0 ? 1024 : null,
      remoteAvailable: true,
    };
  });
}

const defaultServer: ServerConfig = {
  id: 'srv-1',
  displayName: 'Local Kavita',
  baseUrl: 'https://kavita.example',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.0',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await tick();
  }
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await tick();
}

describe('Library virtualized focus, feed semantics, sticky banner, and modal isolation', () => {
  let mountedComponent: Record<string, unknown> | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.setBackListener(null);
    mocks.setConnected(false);
    mocks.setBooks(makeBooks(500));
    mocks.setPreferences(new Map([['syncFurthest', 'false']]));
    mocks.setLocalReadingState(null);
    mocks.setRemoteProgress(null);
    mocks.setReleaseBanner(null);
  });

  afterEach(async () => {
    if (mountedComponent) {
      await unmount(mountedComponent);
      mountedComponent = null;
    }
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('traverses 100% of a 500-book catalog via focusin without Tab keydown events while keeping card count bounded and preserving button identity', async () => {
    const stage = document.createElement('div');
    stage.className = 'app-stage';
    Object.defineProperty(stage, 'clientHeight', { value: 800, configurable: true });
    document.body.append(stage);

    mountedComponent = mount(Library, {
      target: stage,
      props: {
        server: defaultServer,
        apiKey: 'test-api-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });
    await settle();

    const feed = stage.querySelector<HTMLElement>('#library-results');
    expect(feed).not.toBeNull();
    expect(feed?.getAttribute('role')).toBe('feed');
    expect(feed?.getAttribute('aria-busy')).toBe('false');

    Object.defineProperty(feed!, 'clientWidth', { value: 500, configurable: true });
    flushSync(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await settle();

    const visitedIndices: number[] = [];
    for (let index = 0; index < 500; index += 1) {
      const card = feed!.querySelector<HTMLElement>(`article[data-book-index="${index}"]`);
      expect(card).not.toBeNull();
      expect(card!.getAttribute('aria-posinset')).toBe(String(index + 1));
      expect(card!.getAttribute('aria-setsize')).toBe('500');
      const titleId = card!.getAttribute('aria-labelledby');
      expect(titleId).toBeTruthy();
      expect(document.getElementById(titleId!)?.textContent?.trim()).toBe(
        `Catalog Book ${String(index + 1).padStart(4, '0')}`,
      );

      const openButton = card!.querySelector<HTMLButtonElement>('[data-book-open]')!;
      const actionsButton = card!.querySelector<HTMLButtonElement>('[data-book-actions]')!;

      openButton.focus();
      expect(openButton.isConnected).toBe(true);
      expect(document.activeElement).toBe(openButton);

      actionsButton.focus();
      expect(actionsButton.isConnected).toBe(true);
      expect(document.activeElement).toBe(actionsButton);

      const mountedCards = feed!.querySelectorAll('article');
      expect(mountedCards.length).toBeGreaterThanOrEqual(4);
      expect(mountedCards.length).toBeLessThanOrEqual(21);

      visitedIndices.push(index);
    }

    expect(visitedIndices).toHaveLength(500);
    expect(visitedIndices[0]).toBe(0);
    expect(visitedIndices[499]).toBe(499);

    // Reverse focus traversal without Tab keydown also reaches the beginning cleanly.
    for (let index = 499; index >= 490; index -= 1) {
      const card = feed!.querySelector<HTMLElement>(`article[data-book-index="${index}"]`);
      expect(card).not.toBeNull();
      const openButton = card!.querySelector<HTMLButtonElement>('[data-book-open]')!;
      openButton.focus();
      expect(document.activeElement).toBe(openButton);
    }
  });

  it('maintains 1-based aria-posinset and aria-setsize across grid, list, and filtered states and supports page-jump shortcuts', async () => {
    mocks.setBooks(makeBooks(40));
    const stage = document.createElement('div');
    stage.className = 'app-stage';
    Object.defineProperty(stage, 'clientHeight', { value: 800, configurable: true });
    document.body.append(stage);

    mountedComponent = mount(Library, {
      target: stage,
      props: {
        server: defaultServer,
        apiKey: 'test-api-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });
    await settle();

    const feed = stage.querySelector<HTMLElement>('#library-results')!;
    const firstOpen = feed.querySelector<HTMLButtonElement>(
      'article[data-book-index="0"] [data-book-open]',
    )!;
    firstOpen.focus();

    // PageDown jumps forward a viewport page of rows.
    firstOpen.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    await settle();
    const afterPageDownIndex = Number(
      document.activeElement?.closest<HTMLElement>('[data-book-index]')?.dataset.bookIndex,
    );
    expect(afterPageDownIndex).toBeGreaterThan(0);

    // End jumps to the final book.
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    );
    await settle();
    expect(
      document.activeElement?.closest<HTMLElement>('[data-book-index]')?.dataset.bookIndex,
    ).toBe('39');

    // Home jumps back to the first book.
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
    await settle();
    expect(
      document.activeElement?.closest<HTMLElement>('[data-book-index]')?.dataset.bookIndex,
    ).toBe('0');

    // Switch to List view and verify aria-posinset / aria-setsize.
    const listToggle = Array.from(stage.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'List',
    )!;
    listToggle.click();
    await settle();

    const listArticles = Array.from(feed.querySelectorAll<HTMLElement>('article'));
    expect(listArticles.length).toBeGreaterThan(0);
    for (const article of listArticles) {
      const idx = Number(article.dataset.bookIndex);
      expect(article.getAttribute('aria-posinset')).toBe(String(idx + 1));
      expect(article.getAttribute('aria-setsize')).toBe('40');
    }

    // Filter to Octavia Butler (20 books) and verify aria-setsize / aria-posinset update.
    const searchInput = stage.querySelector<HTMLInputElement>('#library-search')!;
    searchInput.value = 'Octavia';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    const filteredArticles = Array.from(feed.querySelectorAll<HTMLElement>('article'));
    expect(filteredArticles.length).toBeGreaterThan(0);
    expect(filteredArticles[0]?.getAttribute('aria-posinset')).toBe('1');
    expect(filteredArticles[0]?.getAttribute('aria-setsize')).toBe('20');
  });

  it('tracks sticky releaseBanner height on .app-stage, offsets programmatic scrolling, and isolates background siblings across Library dialogs', async () => {
    mocks.setConnected(true);
    mocks.setBooks(makeBooks(30));
    mocks.setReleaseBanner({
      version: '0.4.0',
      title: 'Accessibility release',
      releaseUrl: 'https://github.com/sgerner/turnleaf/releases/tag/v0.4.0',
      downloadUrl: 'https://github.com/sgerner/turnleaf/releases/download/v0.4.0/turnleaf.apk',
    });
    mocks.setLocalReadingState({
      cfi: 'epubcfi(/6/2!/4/2:0)',
      xpath: '/body/p[1]',
      percentage: 0.25,
      localUpdatedAt: '2026-02-01T00:00:00.000Z',
      syncedLocalUpdatedAt: null,
      serverUpdatedAt: null,
      pendingSync: true,
      syncRevision: 1,
    });
    mocks.setRemoteProgress({
      libraryId: 1,
      seriesId: 1,
      volumeId: 1,
      chapterId: 1,
      pageNum: 120,
      bookScrollId: '/body/p[9]',
      lastModifiedUtc: '2026-02-02T00:00:00.000Z',
    });

    const host = document.createElement('div');
    document.body.append(host);
    mountedComponent = mount(AppShell, { target: host });
    await settle();

    const stage = host.querySelector<HTMLElement>('.app-stage')!;
    const banner = host.querySelector<HTMLElement>('[data-release-banner]')!;
    expect(banner).not.toBeNull();
    expect(stage.contains(banner)).toBe(false);

    const feed = stage.querySelector<HTMLElement>('#library-results')!;
    const listTop = 320;
    Object.defineProperty(stage, 'clientHeight', { value: 700, configurable: true });
    stage.dataset.stickyBannerHeight = '112';
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 112, 800, 700));
    vi.spyOn(banner, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 112));
    vi.spyOn(feed, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 112 + listTop - stage.scrollTop, 800, 6000),
    );
    window.dispatchEvent(new Event('resize'));
    await settle();

    // Scroll so row 0 is partially obscured (listTop 320 - scrollTop 260 = 60 < 112).
    stage.scrollTop = 260;
    const row0Open = feed.querySelector<HTMLButtonElement>(
      'article[data-book-index="0"] [data-book-open]',
    )!;
    row0Open.focus();
    await settle();

    // Focusing row 0 subtracts sticky banner height (320 - 112 = 208), leaving 0% banner overlap!
    expect(stage.scrollTop).toBe(208);

    const libraryMain = stage.querySelector<HTMLElement>('main')!;

    // 1. Settings dialog: isolates both releaseBanner and libraryMain; closes via Escape, backdrop, close button, and Android Back.
    const settingsOpener = stage.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!;
    settingsOpener.focus();
    settingsOpener.click();
    await settle();

    expect(banner.hasAttribute('inert')).toBe(true);
    expect(banner.getAttribute('aria-hidden')).toBe('true');
    expect(libraryMain.hasAttribute('inert')).toBe(true);
    expect(libraryMain.getAttribute('aria-hidden')).toBe('true');

    const closeSettingsBtn = stage.querySelector<HTMLButtonElement>(
      '[aria-label="Close settings"]',
    )!;
    closeSettingsBtn.click();
    await settle();
    expect(banner.hasAttribute('inert')).toBe(false);
    expect(libraryMain.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(settingsOpener);

    // 2. Book actions dialog: open and close via Escape and Android Back.
    const actionsOpener = feed.querySelector<HTMLButtonElement>(
      'article[data-book-index="0"] [data-book-actions]',
    )!;
    actionsOpener.focus();
    actionsOpener.click();
    await settle();

    expect(banner.hasAttribute('inert')).toBe(true);
    expect(libraryMain.hasAttribute('inert')).toBe(true);
    const actionsDialog = stage.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="book-actions-title"]',
    )!;
    actionsDialog.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle();
    expect(banner.hasAttribute('inert')).toBe(false);
    expect(libraryMain.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(actionsOpener);

    // Reopen Book actions and close via backdrop click.
    actionsOpener.click();
    await settle();
    const actionsBackdrop = stage.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="book-actions-title"]',
    )!.parentElement!;
    actionsBackdrop.click();
    await settle();
    expect(document.activeElement).toBe(actionsOpener);

    // 3. Conflict dialog: triggered when opening book-0001 with divergent local & remote progress; close via Android Back.
    const openBookBtn = feed.querySelector<HTMLButtonElement>(
      'article[data-book-index="0"] [data-book-open]',
    )!;
    openBookBtn.focus();
    openBookBtn.click();
    await settle();

    const conflictDialog = stage.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="sync-conflict-title"]',
    );
    expect(conflictDialog).not.toBeNull();
    expect(banner.hasAttribute('inert')).toBe(true);
    expect(libraryMain.hasAttribute('inert')).toBe(true);

    mocks.getBackListener()?.();
    await settle();
    expect(banner.hasAttribute('inert')).toBe(false);
    expect(libraryMain.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(openBookBtn);

    // 4. Transition from Book actions -> Open book -> Sync conflict -> Cancel restores focus to Book actions trigger.
    actionsOpener.focus();
    actionsOpener.click();
    await settle();
    const menuOpenBookBtn = Array.from(
      stage.querySelectorAll<HTMLButtonElement>(
        '[role="dialog"][aria-labelledby="book-actions-title"] button',
      ),
    ).find((btn) => btn.textContent?.includes('Open book'))!;
    menuOpenBookBtn.focus();
    menuOpenBookBtn.click();
    await settle();

    const conflictFromMenu = stage.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="sync-conflict-title"]',
    );
    expect(conflictFromMenu).not.toBeNull();
    expect(banner.hasAttribute('inert')).toBe(true);
    expect(libraryMain.hasAttribute('inert')).toBe(true);

    const cancelConflictBtn = Array.from(
      conflictFromMenu!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((btn) => btn.textContent?.trim() === 'Cancel')!;
    cancelConflictBtn.click();
    await settle();

    expect(banner.hasAttribute('inert')).toBe(false);
    expect(libraryMain.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(actionsOpener);
  });
});
