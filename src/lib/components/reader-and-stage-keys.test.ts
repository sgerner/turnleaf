// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReaderSessionModule from '../reader/session';
import type * as ThemesModule from '../themes/themes';

const mocks = vi.hoisted(() => {
  let currentPlatform = 'ios';
  let nativePlatform = true;
  let capturedKeyboardHandler: ((event: KeyboardEvent) => void) | null = null;
  let capturedSelectionHandler: ((selection: { cfi: string; text: string } | null) => void) | null =
    null;
  const nextSpy = vi.fn(async () => undefined);
  const previousSpy = vi.fn(async () => undefined);
  const clearTextSelectionSpy = vi.fn();
  const setVolumeButtonsSpy = vi.fn(async () => undefined);
  const setReaderChromeSpy = vi.fn(async () => undefined);
  const setKeepAwakeSpy = vi.fn(async () => undefined);
  const fetchLatestGithubReleaseSpy = vi.fn<
    () => Promise<{
      version: string;
      title: string;
      releaseUrl: string;
      downloadUrl: string;
    } | null>
  >(async () => null);

  return {
    getPlatform: () => currentPlatform,
    setPlatform: (platform: string, isNative = platform !== 'web') => {
      currentPlatform = platform;
      nativePlatform = isNative;
    },
    isNativePlatform: () => nativePlatform,
    getKeyboardHandler: () => capturedKeyboardHandler,
    setKeyboardHandler: (handler: ((event: KeyboardEvent) => void) | null) => {
      capturedKeyboardHandler = handler;
    },
    getSelectionHandler: () => capturedSelectionHandler,
    setSelectionHandler: (
      handler: ((selection: { cfi: string; text: string } | null) => void) | null,
    ) => {
      capturedSelectionHandler = handler;
    },
    nextSpy,
    previousSpy,
    clearTextSelectionSpy,
    setVolumeButtonsSpy,
    setReaderChromeSpy,
    setKeepAwakeSpy,
    fetchLatestGithubReleaseSpy,
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => mocks.getPlatform(),
    isNativePlatform: () => mocks.isNativePlatform(),
  },
  registerPlugin: vi.fn((name: string) => {
    if (name === 'VolumeButtons') return { setEnabled: mocks.setVolumeButtonsSpy };
    if (name === 'ReaderChrome') return { setEnabled: mocks.setReaderChromeSpy };
    if (name === 'KeepAwake') return { setEnabled: mocks.setKeepAwakeSpy };
    return { setEnabled: vi.fn(async () => undefined) };
  }),
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

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    exitApp: vi.fn(async () => undefined),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: false })),
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
  },
}));

const dbMocks = vi.hoisted(() => ({
  server: null as {
    id: string;
    displayName: string;
    baseUrl: string;
    credentialRef: string;
    kavitaVersion: string;
    lastConnectedAt: string;
  } | null,
  preferences: new Map<string, string>(),
  books: [] as Array<{
    id: string;
    serverId: string;
    seriesId: number;
    chapterId: number;
    title: string;
    author: string | null;
    series: string | null;
    pages: number;
    pagesRead: number;
    downloadPath: string | null;
    downloadStatus: string;
    fileSize: number | null;
    lastReadAt: string | null;
    remoteAvailable: boolean;
  }>,
}));

vi.mock('../database/database', () => ({
  getPreferences: vi.fn(async (keys: string[]) => {
    const out = new Map<string, string>();
    for (const key of keys) {
      const val = dbMocks.preferences.get(key);
      if (val !== undefined) out.set(key, val);
    }
    return out;
  }),
  setPreferences: vi.fn(async (entries: Map<string, string>) => {
    for (const [k, v] of entries) dbMocks.preferences.set(k, v);
  }),
  setPreference: vi.fn(async (key: string, value: string) => {
    dbMocks.preferences.set(key, value);
  }),
  getServer: vi.fn(async () => dbMocks.server),
  getBooks: vi.fn(async () => dbMocks.books),
  getSyncStatus: vi.fn(async () => ({
    pendingCount: 0,
    failedCount: 0,
    lastError: null,
    lastUpdatedAt: null,
  })),
  resetLocalDatabase: vi.fn(async () => undefined),
  getReadingState: vi.fn(async () => null),
  acceptRemoteProgress: vi.fn(async () => true),
  markDownloaded: vi.fn(async () => undefined),
  markBookCompleted: vi.fn(async () => undefined),
  removeDownload: vi.fn(async () => undefined),
  removeServer: vi.fn(async () => undefined),
  reconcileBooks: vi.fn(async () => undefined),
  saveLocalProgress: vi.fn(async () => undefined),
  saveRemoteProgress: vi.fn(async () => true),
  saveServer: vi.fn(async () => undefined),
}));

vi.mock('../native/credentials', () => ({
  getApiKey: vi.fn(async () => 'test-api-key'),
  saveApiKey: vi.fn(async () => undefined),
  removeApiKey: vi.fn(async () => undefined),
}));

vi.mock('../github/releases', () => ({
  fetchLatestGithubRelease: () => mocks.fetchLatestGithubReleaseSpy(),
}));

vi.mock('../themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    skeletonThemes: ['fennec', 'vintage'],
    loadTheme: vi.fn(async () => true),
  };
});

vi.mock('../downloads/native-download', () => ({
  cacheCover: vi.fn(async () => ''),
  clearCoverCache: vi.fn(async () => undefined),
  cleanupInterruptedEpubDownloads: vi.fn(async () => undefined),
  deleteDownloadedEpub: vi.fn(async () => undefined),
  downloadEpub: vi.fn(),
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class extends Error {},
  verifyDownloadedEpub: vi.fn(),
}));

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<typeof ReaderSessionModule>();
  return {
    ...actual,
    ReaderSession: class MockReaderSession {
      async open(
        target: HTMLElement,
        _cfi: string | null,
        _xpath: string | null,
        _percentage: number | null,
        _appearance: unknown,
        onLocation: (loc: {
          cfi: string;
          xpath: string | null;
          href: string;
          percentage: number;
          spineIndex: number;
          pageIndex: number;
          pageCount: number;
        }) => void,
        _onTap: unknown,
        onSelection?: (selection: { cfi: string; text: string } | null) => void,
        onKeyboardNavigation?: (event: KeyboardEvent) => void,
      ): Promise<void> {
        mocks.setKeyboardHandler(onKeyboardNavigation ?? null);
        mocks.setSelectionHandler(onSelection ?? null);
        const iframe = document.createElement('iframe');
        target.append(iframe);
        if (onKeyboardNavigation && iframe.contentDocument) {
          iframe.contentDocument.addEventListener('keydown', onKeyboardNavigation, {
            passive: false,
          });
        }
        onLocation({
          cfi: 'epubcfi(/6/2!/4/2/1:0)',
          xpath: '/body/div[1]/p[1]',
          href: 'chapter-1.xhtml',
          percentage: 0.25,
          spineIndex: 0,
          pageIndex: 1,
          pageCount: 10,
        });
      }
      async next(): Promise<void> {
        await mocks.nextSpy();
      }
      async previous(): Promise<void> {
        await mocks.previousSpy();
      }
      tableOfContents() {
        return [{ label: 'Chapter 1', href: 'chapter-1.xhtml', children: [] }];
      }
      getVisiblePassages() {
        return [];
      }
      clearTextSelection(): void {
        mocks.clearTextSelectionSpy();
      }
      updateHighlights(): void {}
      applyAppearance(): void {}
      async search() {
        return [];
      }
      async display(): Promise<void> {}
      async displayCfi(): Promise<boolean> {
        return true;
      }
      async displayServerLocation(): Promise<boolean> {
        return true;
      }
      async displayServerPercentage(): Promise<boolean> {
        return true;
      }
      destroy(): void {
        mocks.setKeyboardHandler(null);
        mocks.setSelectionHandler(null);
      }
    },
  };
});

import App from '../../App.svelte';
import Reader from './Reader.svelte';

async function flushAll(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

describe('Reader and .app-stage keyboard and hardware button behavior', () => {
  let host: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.server = null;
    dbMocks.preferences.clear();
    dbMocks.books = [];
    mocks.fetchLatestGithubReleaseSpy.mockResolvedValue(null);
    mocks.setPlatform('ios', true);
    if (typeof Element.prototype.animate !== 'function') {
      Element.prototype.animate = (() => {
        const anim = {
          currentTime: 0,
          playState: 'running',
          effect: null,
          finished: Promise.resolve(),
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
    host = document.createElement('div');
    document.body.innerHTML = '';
    document.body.append(host);
    document.body.focus();
  });

  afterEach(() => {
    if (mounted) {
      unmount(mounted);
      mounted = null;
    }
    host.remove();
  });

  it('scrolls .app-stage in onboarding and library views and after clicking Clear search or Clear library filters', async () => {
    mocks.setPlatform('web', false);
    mounted = mount(App, { target: host });
    await flushAll();

    const stage = host.querySelector<HTMLElement>('.app-stage')!;
    expect(stage).toBeTruthy();
    Object.defineProperty(stage, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(stage, 'scrollHeight', { value: 2000, configurable: true });
    stage.scrollTop = 0;
    document.body.focus();

    // Onboarding view: all 7 scroll keys (8 combinations) move .app-stage.scrollTop
    for (const [key, shiftKey, expected] of [
      ['PageDown', false, 350],
      ['PageUp', false, 0],
      [' ', false, 350],
      [' ', true, 0],
      ['ArrowDown', false, 40],
      ['ArrowUp', false, 0],
      ['End', false, 1600],
      ['Home', false, 0],
    ] as const) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
      );
      expect(stage.scrollTop).toBe(expected);
    }

    unmount(mounted);
    mounted = null;

    // Library view with books
    dbMocks.server = {
      id: 'primary',
      displayName: 'Books',
      baseUrl: 'https://books.example.com',
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.8.0',
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    };
    dbMocks.books = Array.from({ length: 20 }, (_, i) => ({
      id: `book-${i}`,
      serverId: 'primary',
      seriesId: i + 1,
      chapterId: i + 100,
      title: `Book Title ${i}`,
      author: `Author ${i}`,
      series: `Series ${i}`,
      pages: 300,
      pagesRead: 10,
      downloadPath: 'books/book.epub',
      downloadStatus: 'available',
      fileSize: 1024,
      lastReadAt: null,
      remoteAvailable: true,
    }));

    mounted = mount(App, { target: host });
    await flushAll();

    const libraryStage = host.querySelector<HTMLElement>('.app-stage')!;
    Object.defineProperty(libraryStage, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(libraryStage, 'scrollHeight', { value: 2400, configurable: true });
    libraryStage.scrollTop = 0;

    // Focus search, type query, then click Clear search -> immediately operable
    const searchInput = host.querySelector<HTMLInputElement>('#library-search')!;
    searchInput.focus();
    searchInput.value = 'Book Title 1';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAll();

    const clearSearchButton = host.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!;
    expect(clearSearchButton).toBeTruthy();
    clearSearchButton.focus();
    flushSync(() => clearSearchButton.click());

    expect(document.activeElement).toBe(document.body);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
    expect(libraryStage.scrollTop).toBe(350);

    // Click Clear library filters -> immediately operable
    const clearFiltersButton = host.querySelector<HTMLButtonElement>(
      '[aria-label="Clear library filters"]',
    )!;
    expect(clearFiltersButton).toBeTruthy();
    clearFiltersButton.focus();
    flushSync(() => clearFiltersButton.click());

    expect(document.activeElement).toBe(document.body);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    expect(libraryStage.scrollTop).toBe(390);

    // Search with no matching books -> click Clear search and filters -> immediately operable
    searchInput.focus();
    searchInput.value = 'nonexistent-query-xyz';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAll();

    const clearEmptyStateButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Clear search and filters',
    )!;
    expect(clearEmptyStateButton).toBeTruthy();
    clearEmptyStateButton.focus();
    flushSync(() => clearEmptyStateButton.click());

    expect(document.activeElement).toBe(document.body);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', cancelable: true }));
    expect(libraryStage.scrollTop).toBe(40);
  });

  it('preserves releaseBanner inert coordination and suppresses .app-stage scroll forwarding while stageOverlayActive is true', async () => {
    mocks.setPlatform('web', false);
    mocks.fetchLatestGithubReleaseSpy.mockResolvedValue({
      version: '0.9.0',
      title: 'Reader Update',
      releaseUrl: 'https://github.com/sgerner/turnleaf/releases/tag/v0.9.0',
      downloadUrl: 'https://github.com/sgerner/turnleaf/releases/download/v0.9.0/turnleaf.apk',
    });
    dbMocks.server = {
      id: 'primary',
      displayName: 'Books',
      baseUrl: 'https://books.example.com',
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.8.0',
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    };
    dbMocks.books = [
      {
        id: 'book-0',
        serverId: 'primary',
        seriesId: 1,
        chapterId: 100,
        title: 'Book Title 0',
        author: 'Author 0',
        series: 'Series 0',
        pages: 300,
        pagesRead: 10,
        downloadPath: 'books/book.epub',
        downloadStatus: 'available',
        fileSize: 1024,
        lastReadAt: null,
        remoteAvailable: true,
      },
    ];

    mounted = mount(App, { target: host });
    await flushAll();

    const banner = host.querySelector<HTMLElement>('.release-banner')!;
    const stage = host.querySelector<HTMLElement>('.app-stage')!;
    expect(banner).toBeTruthy();
    expect(banner.inert).toBe(false);

    Object.defineProperty(stage, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(stage, 'scrollHeight', { value: 2000, configurable: true });
    stage.scrollTop = 0;
    document.body.focus();

    // Body focus scrolls .app-stage even when release banner is visible
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
    expect(stage.scrollTop).toBe(350);

    // Focusing a control inside releaseBanner does not forward Space to .app-stage
    const dismissButton = [...banner.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Dismiss',
    )!;
    dismissButton.focus();
    const spaceOnDismiss = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    dismissButton.dispatchEvent(spaceOnDismiss);
    expect(spaceOnDismiss.defaultPrevented).toBe(false);
    expect(stage.scrollTop).toBe(350);

    // Opening Library settings activates stageOverlayActive -> banner becomes inert and stage scroll is suppressed
    const openSettingsButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Open settings"]',
    )!;
    openSettingsButton.focus();
    openSettingsButton.click();
    await flushAll();
    expect(banner.inert).toBe(true);

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
    expect(stage.scrollTop).toBe(350);

    // Closing Library settings restores banner interactivity, returns focus to Open settings, and restores stage scroll on body focus
    host.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]')!.click();
    await flushAll();
    expect(banner.inert).toBe(false);
    expect(document.activeElement).toBe(openSettingsButton);

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    expect(stage.scrollTop).toBe(390);

    // Dismissing the release banner still works after overlay close
    dismissButton.click();
    await flushAll();
    expect(host.querySelector('.release-banner')).toBeNull();
  });

  it('turns pages with ArrowUp, ArrowDown, PageUp, PageDown, and Shift+Space on window and EPUB iframe with defaultPrevented, and blocks all open reader panels', async () => {
    const onSyncLatest = vi.fn(async () => ({
      xpath: '/body/div[2]/p[4]',
      percentage: 0.75,
      accept: vi.fn(async () => undefined),
    }));

    mounted = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'book.epub',
        bookId: 'book-1',
        title: 'Sample Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onSyncLatest,
      },
    });
    await flushAll();

    const helpText = host.querySelector('#reader-keyboard-help')?.textContent ?? '';
    expect(helpText).toContain('Up');
    expect(helpText).toContain('Down');
    expect(helpText).toContain('Shift+Space');
    expect(helpText).toContain('clear selected text');

    // Window keydown turns one page with defaultPrevented = true
    for (const [key, shiftKey, spy] of [
      ['ArrowDown', false, mocks.nextSpy],
      ['PageDown', false, mocks.nextSpy],
      ['ArrowUp', false, mocks.previousSpy],
      ['PageUp', false, mocks.previousSpy],
      [' ', true, mocks.previousSpy],
    ] as const) {
      spy.mockClear();
      const event = new KeyboardEvent('keydown', {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(spy).toHaveBeenCalledOnce();
    }

    // EPUB iframe keydown turns one page with defaultPrevented = true
    const iframe = host.querySelector('iframe')!;
    expect(iframe).toBeTruthy();
    for (const [key, spy] of [
      ['ArrowDown', mocks.nextSpy],
      ['PageDown', mocks.nextSpy],
      ['ArrowUp', mocks.previousSpy],
      ['PageUp', mocks.previousSpy],
    ] as const) {
      spy.mockClear();
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        view: iframe.contentWindow,
      });
      iframe.contentDocument!.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(spy).toHaveBeenCalledOnce();
    }

    // Shift+Arrow in EPUB iframe is left alone for text selection, and Escape clears active selection
    mocks.nextSpy.mockClear();
    mocks.previousSpy.mockClear();
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const shiftArrow = new KeyboardEvent('keydown', {
        key,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        view: iframe.contentWindow,
      });
      iframe.contentDocument!.body.dispatchEvent(shiftArrow);
      expect(shiftArrow.defaultPrevented).toBe(false);
    }
    expect(mocks.nextSpy).not.toHaveBeenCalled();
    expect(mocks.previousSpy).not.toHaveBeenCalled();

    // Focused link inside EPUB iframe suppresses page-turn keys
    const epubLink = iframe.contentDocument!.createElement('a');
    epubLink.href = '#footnote';
    epubLink.textContent = 'Footnote 1';
    iframe.contentDocument!.body.append(epubLink);
    epubLink.focus();
    const keyOnLink = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
      view: iframe.contentWindow,
    });
    epubLink.dispatchEvent(keyOnLink);
    expect(keyOnLink.defaultPrevented).toBe(false);
    expect(mocks.nextSpy).not.toHaveBeenCalled();
    epubLink.remove();

    mocks.getSelectionHandler()?.({ cfi: 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:5)', text: 'Hello' });
    await flushAll();
    expect(host.querySelector('[aria-label="Selected text"]')).not.toBeNull();
    mocks.clearTextSelectionSpy.mockClear();
    const escapeSelection = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(escapeSelection);
    await flushAll();
    expect(escapeSelection.defaultPrevented).toBe(true);
    expect(mocks.clearTextSelectionSpy).toHaveBeenCalledOnce();
    expect(host.querySelector('[aria-label="Selected text"]')).toBeNull();

    // Hardware page button turns pages even when appearance.volumeButtons is false
    mocks.nextSpy.mockClear();
    mocks.previousSpy.mockClear();
    const pageNext = new Event('turnleafPageButton');
    Object.assign(pageNext, { direction: 'next' });
    window.dispatchEvent(pageNext);
    expect(mocks.nextSpy).toHaveBeenCalledOnce();

    const pagePrev = new Event('turnleafPageButton');
    Object.assign(pagePrev, { direction: 'previous' });
    window.dispatchEvent(pagePrev);
    expect(mocks.previousSpy).toHaveBeenCalledOnce();

    // Volume button is ignored while appearance.volumeButtons is false
    mocks.nextSpy.mockClear();
    const volNextDisabled = new Event('turnleafVolumeButton');
    Object.assign(volNextDisabled, { direction: 'next' });
    window.dispatchEvent(volNextDisabled);
    expect(mocks.nextSpy).not.toHaveBeenCalled();

    // Reveal reader toolbar so we can open each of the 6 reader panels
    host.querySelector<HTMLButtonElement>('.reader-top-reveal')!.click();
    await flushAll();

    const panelTriggers = [
      {
        selector: '[aria-controls="reader-appearance"]',
        closeSelector: '[aria-label="Close reading appearance"]',
      },
      {
        selector: '[aria-controls="reader-contents"]',
        closeSelector: '[aria-label="Close table of contents"]',
      },
      {
        selector: '[aria-controls="reader-bookmarks"]',
        closeSelector: '[aria-label="Close bookmarks and history"]',
      },
      {
        selector: '[aria-controls="reader-annotations"]',
        closeSelector: '[aria-label="Close highlights and notes"]',
      },
      {
        selector: '[aria-controls="reader-search"]',
        closeSelector: '[aria-label="Close book search"]',
      },
      { selector: '[aria-label="Sync latest reading position"]', closeSelector: null },
    ];

    for (const panel of panelTriggers) {
      host.querySelector<HTMLButtonElement>(panel.selector)!.click();
      await flushAll();

      mocks.nextSpy.mockClear();
      mocks.previousSpy.mockClear();
      for (const key of [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'PageUp',
        'PageDown',
        ' ',
      ]) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
      }
      const blockedPageBtn = new Event('turnleafPageButton');
      Object.assign(blockedPageBtn, { direction: 'next' });
      window.dispatchEvent(blockedPageBtn);
      expect(mocks.nextSpy).not.toHaveBeenCalled();
      expect(mocks.previousSpy).not.toHaveBeenCalled();

      if (panel.closeSelector) {
        host.querySelector<HTMLButtonElement>(panel.closeSelector)!.click();
      } else {
        // Close sync confirmation via Stay here button
        const stayButton = [...host.querySelectorAll('button')].find(
          (btn) => btn.textContent?.trim() === 'Stay here',
        )!;
        stayButton.click();
      }
      await flushAll();
    }
  });

  it.each(['ios', 'android'] as const)(
    'renders "Turn pages with volume buttons" in #reader-appearance and calls VolumeButtons.setEnabled on %s',
    async (platform) => {
      mocks.setPlatform(platform, true);
      mounted = mount(Reader, {
        target: host,
        props: {
          bookUrl: 'book.epub',
          bookId: `book-${platform}`,
          title: 'Volume Test Book',
          onBack: vi.fn(),
          onRelocated: vi.fn(),
        },
      });
      await flushAll();

      host.querySelector<HTMLButtonElement>('.reader-top-reveal')!.click();
      await flushAll();
      host.querySelector<HTMLButtonElement>('[aria-controls="reader-appearance"]')!.click();
      await flushAll();

      const appearanceDialog = host.querySelector('#reader-appearance')!;
      expect(appearanceDialog).toBeTruthy();
      expect(appearanceDialog.textContent).toContain('Turn pages with volume buttons');

      const labels = [...appearanceDialog.querySelectorAll('label')];
      const volumeLabel = labels.find((label) =>
        label.textContent?.includes('Turn pages with volume buttons'),
      )!;
      const checkbox = volumeLabel.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      expect(checkbox.checked).toBe(false);

      mocks.setVolumeButtonsSpy.mockClear();
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      await flushAll();

      // While appearance dialog is still open, volume interception stays paused (false)
      expect(mocks.setVolumeButtonsSpy).toHaveBeenLastCalledWith({ enabled: false });

      // Closing the appearance dialog activates VolumeButtons.setEnabled({ enabled: true })
      host.querySelector<HTMLButtonElement>('[aria-label="Close reading appearance"]')!.click();
      await flushAll();
      expect(mocks.setVolumeButtonsSpy).toHaveBeenLastCalledWith({ enabled: true });

      // Dispatching turnleafVolumeButton now turns pages
      mocks.previousSpy.mockClear();
      const volUp = new Event('turnleafVolumeButton');
      Object.assign(volUp, { direction: 'previous' });
      window.dispatchEvent(volUp);
      expect(mocks.previousSpy).toHaveBeenCalledOnce();
    },
  );
});
