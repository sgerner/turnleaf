// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookRecord, ServerConfig, SyncStatus } from '../database/database';

const mocks = vi.hoisted(() => ({
  connected: false,
  books: [] as BookRecord[],
  preferences: new Map<string, string>(),
  syncStatus: {
    pendingCount: 0,
    failedCount: 0,
    lastError: null,
    lastUpdatedAt: null,
  } satisfies SyncStatus,
  downloadEpub:
    vi.fn<
      (
        url: string,
        apiKey: string,
        bookKey: string,
        onProgress?: (percent: number | null) => void,
      ) => Promise<{ relativePath: string; size: number }>
    >(),
  markDownloaded: vi.fn<(bookId: string, path: string, size: number) => Promise<void>>(
    async () => {},
  ),
  setPreference: vi.fn<(key: string, value: string) => Promise<void>>(async () => {}),
  getBookSeries: vi.fn<(signal?: AbortSignal) => Promise<Array<{ id: number }>>>(async () => []),
  getSeriesDetail: vi.fn<
    (seriesId: number, signal?: AbortSignal) => Promise<{ volumes: never[]; incomplete: boolean }>
  >(async () => ({ volumes: [], incomplete: false })),
  flushProgress: vi.fn<() => Promise<void>>(async () => {}),
  networkListeners: [] as Array<(status: { connected: boolean; connectionType: string }) => void>,
  isNativePlatform: false,
}));

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = (await importOriginal()) as { Capacitor: Record<string, unknown> };
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => mocks.isNativePlatform,
    },
  };
});

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => {} })),
    exitApp: vi.fn(async () => {}),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({
      connected: mocks.connected,
      connectionType: mocks.connected ? 'wifi' : 'none',
    })),
    addListener: vi.fn(
      async (
        _eventName: string,
        listener: (status: { connected: boolean; connectionType: string }) => void,
      ) => {
        mocks.networkListeners.push(listener);
        return {
          remove: async () => {
            const index = mocks.networkListeners.indexOf(listener);
            if (index !== -1) mocks.networkListeners.splice(index, 1);
          },
        };
      },
    ),
  },
}));

vi.mock('../database/database', () => ({
  getBooks: vi.fn(async () => mocks.books.map((book) => ({ ...book }))),
  getReadingState: vi.fn(async () => null),
  getPreferences: vi.fn(async () => new Map(mocks.preferences)),
  getSyncStatus: vi.fn(async () => ({ ...mocks.syncStatus })),
  acceptRemoteProgress: vi.fn(async () => true),
  markDownloaded: (bookId: string, path: string, size: number) =>
    mocks.markDownloaded(bookId, path, size),
  markBookCompleted: vi.fn(async () => {}),
  removeDownload: vi.fn(async () => {}),
  removeServer: vi.fn(async () => {}),
  reconcileBooks: vi.fn(async () => {}),
  saveLocalProgress: vi.fn(async () => {}),
  saveRemoteProgress: vi.fn(async () => true),
  saveServer: vi.fn(async () => {}),
  setPreference: (key: string, value: string) => mocks.setPreference(key, value),
}));

vi.mock('../downloads/native-download', () => {
  class MockEpubTransferError extends Error {
    status: number | undefined;
    connectionFailed: boolean;
    constructor(message: string, status?: number, connectionFailed = false) {
      super(message);
      this.status = status;
      this.connectionFailed = connectionFailed;
    }
  }

  return {
    cacheCover: vi.fn(async () => ''),
    clearCoverCache: vi.fn(async () => {}),
    cleanupInterruptedEpubDownloads: vi.fn(async () => {}),
    deleteDownloadedEpub: vi.fn(async () => {}),
    downloadEpub: (
      url: string,
      apiKey: string,
      bookKey: string,
      onProgress?: (percent: number | null) => void,
    ) => mocks.downloadEpub(url, apiKey, bookKey, onProgress),
    EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
    EpubTransferError: MockEpubTransferError,
    verifyDownloadedEpub: vi.fn(async () => ({ webViewUrl: 'blob:test-book' })),
  };
});

vi.mock('../kavita/client', () => {
  class MockKavitaError extends Error {
    kind: string;
    status: number | undefined;
    constructor(message: string, kind = 'network', status?: number) {
      super(message);
      this.kind = kind;
      this.status = status;
    }
  }

  class MockKavitaClient {
    baseUrl: string;
    constructor(baseUrl: string) {
      this.baseUrl = baseUrl;
    }
    coverUrl(seriesId: number): string {
      return `${this.baseUrl}/api/Image/series-cover?seriesId=${seriesId}`;
    }
    downloadUrl(chapterId: number): string {
      return `${this.baseUrl}/api/Download/chapter?chapterId=${chapterId}`;
    }
    async getCover(): Promise<Blob> {
      throw new Error('Cover fetch disabled in unit test');
    }
    async getBookSeries(signal?: AbortSignal): Promise<Array<{ id: number }>> {
      return mocks.getBookSeries(signal);
    }
    async getSeriesDetail(
      seriesId: number,
      signal?: AbortSignal,
    ): Promise<{ volumes: never[]; incomplete: boolean }> {
      return mocks.getSeriesDetail(seriesId, signal);
    }
    async getProgress(): Promise<null> {
      return null;
    }
  }

  return {
    KavitaClient: MockKavitaClient,
    KavitaError: MockKavitaError,
  };
});

vi.mock('../sync/sync', () => ({
  flushProgress: () => mocks.flushProgress(),
}));

import Library from './Library.svelte';

const server: ServerConfig = {
  id: 'server-1',
  displayName: 'Home Kavita',
  baseUrl: 'https://kavita.example',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.4',
  lastConnectedAt: '2026-11-21T00:00:00.000Z',
};

function makeBook(overrides: Partial<BookRecord> & { id: string; title: string }): BookRecord {
  const numericId = Number.parseInt(overrides.id.replace(/\D+/g, ''), 10) || 1;
  return {
    serverId: server.id,
    libraryId: 1,
    seriesId: numericId,
    volumeId: numericId,
    chapterId: numericId,
    author: 'Ursula K. Le Guin',
    series: null,
    descriptionHtml: null,
    format: 'epub',
    pages: 200,
    pagesRead: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    lastReadAt: null,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: null,
    ...overrides,
  };
}

let stage: HTMLDivElement | null = null;
let mountedComponent: Record<string, unknown> | null = null;
let stageWidth = 500;
let stageHeight = 800;

function zeroRect(top = 0): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: stageWidth,
    bottom: top + stageHeight,
    width: stageWidth,
    height: stageHeight,
    toJSON: () => ({}),
  } as DOMRect;
}

async function mountLibrary(): Promise<HTMLDivElement> {
  stage = document.createElement('div');
  stage.className = 'app-stage';
  stage.scrollTop = 0;
  Object.defineProperty(stage, 'clientHeight', {
    configurable: true,
    get: () => stageHeight,
  });
  stage.getBoundingClientRect = () => zeroRect(0);
  document.body.append(stage);

  mountedComponent = mount(Library, {
    target: stage,
    props: {
      server,
      apiKey: 'test-api-key',
      theme: 'vintage',
      mode: 'dark',
      onThemeChange: vi.fn(),
      onModeChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onServerDeleted: vi.fn(),
      onChangeServerAddress: vi.fn(),
    },
  });

  await vi.waitFor(() => {
    expect(stage?.querySelector('section#library-results')).not.toBeNull();
  });

  const grid = stage.querySelector<HTMLElement>('section#library-results');
  if (grid) {
    Object.defineProperty(grid, 'clientWidth', {
      configurable: true,
      get: () => stageWidth,
    });
    grid.getBoundingClientRect = () => zeroRect(-(stage?.scrollTop ?? 0));
  }

  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await tick();
  return stage;
}

function getCard(root: ParentNode, bookId: string): HTMLElement {
  const card = root.querySelector<HTMLElement>(`article[data-book-id="${bookId}"]`);
  if (!card) throw new Error(`Expected card for ${bookId}`);
  return card;
}

function switchView(root: ParentNode, label: 'Grid' | 'List'): void {
  const group = root.querySelector('[role="group"][aria-label="Library view"]');
  const button = Array.from(group?.querySelectorAll('button') ?? []).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing ${label} view toggle`);
  flushSync(() => {
    button.click();
  });
}

beforeEach(() => {
  if (typeof Element.prototype.animate !== 'function') {
    Element.prototype.animate = (() => {
      const animation = {
        onfinish: null as (() => void) | null,
        cancel: () => {},
        finish: () => {
          animation.onfinish?.();
        },
        play: () => {},
        pause: () => {},
      };
      queueMicrotask(() => animation.onfinish?.());
      return animation as unknown as Animation;
    }) as typeof Element.prototype.animate;
  }
  mocks.connected = false;
  mocks.books = [];
  mocks.preferences = new Map();
  mocks.downloadEpub.mockReset();
  mocks.markDownloaded.mockClear();
  mocks.setPreference.mockClear();
  stageWidth = 500;
  stageHeight = 800;
});

afterEach(() => {
  if (mountedComponent) {
    unmount(mountedComponent);
    mountedComponent = null;
  }
  stage?.remove();
  stage = null;
  document.body.innerHTML = '';
});

describe('Library card snippets', () => {
  it('preserves distinct [data-book-open] aria-labels, .sr-only text, and 44px [data-book-actions] buttons across grid and list views', async () => {
    mocks.books = [
      makeBook({
        id: 'book-1',
        title: 'A Wizard of Earthsea',
        series: 'Earthsea Cycle',
        pages: 200,
        pagesRead: 100,
        downloadPath: 'books/book-1.epub',
        downloadStatus: 'available',
      }),
      makeBook({
        id: 'book-2',
        title: 'The Left Hand of Darkness',
        pages: 200,
        pagesRead: 0,
        downloadPath: null,
      }),
    ];

    const root = await mountLibrary();

    // Grid view: [data-book-open] includes author, distinct series, download status, and progress in aria-label and .sr-only
    const gridCard1 = getCard(root, 'book-1');
    const gridOpen1 = gridCard1.querySelector<HTMLButtonElement>('[data-book-open]');
    const gridActions1 = gridCard1.querySelector<HTMLButtonElement>('[data-book-actions]');
    expect(gridOpen1?.getAttribute('aria-label')).toBe(
      'Open A Wizard of Earthsea, by Ursula K. Le Guin, Earthsea Cycle, downloaded for offline reading, 50% complete',
    );
    expect(gridOpen1?.querySelector('.sr-only')?.textContent).toBe(
      'Open A Wizard of Earthsea, by Ursula K. Le Guin, Earthsea Cycle, downloaded for offline reading, 50% complete',
    );
    expect(gridActions1?.getAttribute('aria-label')).toBe(
      'Book actions for A Wizard of Earthsea, by Ursula K. Le Guin, Earthsea Cycle',
    );
    expect(gridActions1?.className).toContain('h-11');
    expect(gridActions1?.className).toContain('w-11');

    // Switch to List view: [data-book-open] omits progress in aria-label and .sr-only (since reading progressbar is a sibling) while keeping author/series
    switchView(root, 'List');
    const listCard1 = getCard(root, 'book-1');
    const listOpen1 = listCard1.querySelector<HTMLButtonElement>('[data-book-open]');
    const listActions1 = listCard1.querySelector<HTMLButtonElement>('[data-book-actions]');
    expect(listOpen1?.getAttribute('aria-label')).toBe(
      'Open A Wizard of Earthsea, by Ursula K. Le Guin, Earthsea Cycle, downloaded for offline reading',
    );
    expect(listOpen1?.querySelector('.sr-only')?.textContent).toBe(
      'Open A Wizard of Earthsea, by Ursula K. Le Guin, Earthsea Cycle, downloaded for offline reading',
    );
    expect(listActions1?.getAttribute('aria-label')).toBe(
      'Book actions for A Wizard of Earthsea, by Ursula K. Le Guin, Earthsea Cycle',
    );
    expect(listActions1?.className).toContain('h-11');
    expect(listActions1?.className).toContain('w-11');

    // Clicking [data-book-actions] opens the Book actions modal and restores focus on close
    listActions1?.focus();
    flushSync(() => {
      listActions1?.click();
    });
    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="book-actions-title"]',
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('#book-actions-title')?.textContent).toBe('A Wizard of Earthsea');

    const closeButton = dialog?.querySelector<HTMLButtonElement>(
      'button[aria-label="Close book actions"]',
    );
    flushSync(() => {
      closeButton?.click();
    });
    await tick();
    expect(document.activeElement).toBe(listActions1);
  });

  it('renders cover status badges, removed-from-server screen-reader descriptions, and reading progress bars with view-specific static Tailwind classes', async () => {
    mocks.books = [
      makeBook({
        id: 'book-1',
        title: 'Downloaded Book',
        pages: 200,
        pagesRead: 70,
        downloadPath: 'books/book-1.epub',
        downloadStatus: 'available',
        remoteAvailable: true,
      }),
      makeBook({
        id: 'book-2',
        title: 'Orphaned Book',
        pages: 200,
        pagesRead: 0,
        downloadPath: 'books/book-2.epub',
        downloadStatus: 'available',
        remoteAvailable: false,
      }),
    ];

    const root = await mountLibrary();

    // Grid view badges & reading progress bar
    const gridDownloaded = getCard(root, 'book-1');
    const gridPrimaryBadge = gridDownloaded.querySelector(
      '.badge-icon.preset-filled-primary-600-400',
    );
    expect(gridPrimaryBadge?.getAttribute('aria-hidden')).toBe('true');
    expect(gridPrimaryBadge?.className).toContain('left-2 top-2 h-7 w-7 p-0 shadow-md');
    expect(gridDownloaded.querySelector('.badge-icon.preset-filled-warning-500')).toBeNull();

    const gridProgress = gridDownloaded.querySelector<HTMLElement>(
      '[role="progressbar"][aria-label="Reading progress for Downloaded Book"]',
    );
    expect(gridProgress?.className).toContain(
      'pointer-events-none absolute inset-x-0 bottom-0 z-10 h-2',
    );
    expect(gridProgress?.getAttribute('aria-valuenow')).toBe('35');
    expect(gridProgress?.getAttribute('aria-valuetext')).toBe('35% complete');
    expect(gridProgress?.firstElementChild?.getAttribute('style')).toContain('width: 35%');

    const gridOrphaned = getCard(root, 'book-2');
    const gridWarningBadge = gridOrphaned.querySelector('.badge-icon.preset-filled-warning-500');
    expect(gridWarningBadge?.className).toContain('left-2 top-2 h-7 w-7 p-0 shadow-md');
    expect(gridWarningBadge?.querySelector('.sr-only')?.textContent).toBe('Removed from server');
    expect(
      gridOrphaned.querySelector<HTMLButtonElement>('[data-book-open]')?.getAttribute('aria-label'),
    ).toBe(
      'Open Orphaned Book, by Ursula K. Le Guin, downloaded for offline reading, removed from server',
    );
    expect(
      gridOrphaned
        .querySelector<HTMLButtonElement>('[data-book-actions]')
        ?.getAttribute('aria-label'),
    ).toBe('Book actions for Orphaned Book, by Ursula K. Le Guin, removed from server');
    expect(gridOrphaned.querySelector('.badge-icon.preset-filled-primary-600-400')).toBeNull();
    expect(gridOrphaned.querySelector('[role="progressbar"]')).toBeNull();

    // List view badges & reading progress bar
    switchView(root, 'List');
    const listDownloaded = getCard(root, 'book-1');
    const listPrimaryBadge = listDownloaded.querySelector(
      '.badge-icon.preset-filled-primary-600-400',
    );
    expect(listPrimaryBadge?.getAttribute('aria-hidden')).toBe('true');
    expect(listPrimaryBadge?.className).toContain('left-1 top-1 h-6 w-6 p-0');
    expect(listPrimaryBadge?.className).not.toContain('shadow-md');

    const listProgress = listDownloaded.querySelector<HTMLElement>(
      '[role="progressbar"][aria-label="Reading progress for Downloaded Book"]',
    );
    expect(listProgress?.className).toContain(
      'mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-300-700',
    );
    expect(listProgress?.getAttribute('aria-valuenow')).toBe('35');
    expect(listProgress?.getAttribute('aria-valuetext')).toBe('35% complete');

    const listOrphaned = getCard(root, 'book-2');
    const listWarningBadge = listOrphaned.querySelector('.badge-icon.preset-filled-warning-500');
    expect(listWarningBadge?.className).toContain('left-1 top-1 h-6 w-6 p-0');
    expect(listWarningBadge?.querySelector('.sr-only')?.textContent).toBe('Removed from server');
    expect(
      listOrphaned
        .querySelector<HTMLButtonElement>('[data-book-actions]')
        ?.getAttribute('aria-label'),
    ).toBe('Book actions for Orphaned Book, by Ursula K. Le Guin, removed from server');
    expect(listOrphaned.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('renders indeterminate and determinate download progress across banner, list cards, and grid spinner', async () => {
    mocks.books = [
      makeBook({
        id: 'book-1',
        title: 'The Tombs of Atuan',
        series: 'Earthsea Cycle',
        downloadPath: null,
      }),
    ];

    let reportProgress: ((percent: number | null) => void) | undefined;
    let finishDownload: ((value: { relativePath: string; size: number }) => void) | undefined;
    mocks.downloadEpub.mockImplementation(
      (_url, _apiKey, _bookKey, onProgress) =>
        new Promise((resolve) => {
          reportProgress = onProgress;
          finishDownload = resolve;
        }),
    );

    mocks.connected = true;
    const root = await mountLibrary();
    switchView(root, 'List');

    // Trigger download via the Book actions menu ("Download for offline")
    const actionsButton = getCard(root, 'book-1').querySelector<HTMLButtonElement>(
      '[data-book-actions]',
    );
    flushSync(() => {
      actionsButton?.click();
    });
    const downloadAction = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Download for offline'),
    );
    expect(downloadAction).toBeDefined();
    flushSync(() => {
      downloadAction?.click();
    });
    await tick();

    // Indeterminate state (downloadPercent === null): banner + list card both render progressbar with author + series label
    const expectedDownloadLabel =
      'Download progress for The Tombs of Atuan, by Ursula K. Le Guin, Earthsea Cycle';
    const indeterminateBars = root.querySelectorAll<HTMLElement>(
      `[role="progressbar"][aria-label="${expectedDownloadLabel}"]`,
    );
    expect(indeterminateBars).toHaveLength(2);
    expect(indeterminateBars[0]?.className).toContain(
      'h-2 w-24 overflow-hidden rounded-full bg-surface-300-700',
    );
    expect(indeterminateBars[1]?.className).toContain(
      'mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-300-700',
    );
    for (const bar of indeterminateBars) {
      expect(bar.hasAttribute('aria-valuenow')).toBe(false);
      expect(bar.getAttribute('aria-valuetext')).toBe('Download in progress');
      expect(bar.firstElementChild?.classList.contains('animate-pulse')).toBe(true);
      expect(bar.firstElementChild?.getAttribute('style')).toContain('width: 35%');
    }
    expect(
      getCard(root, 'book-1').querySelector<HTMLButtonElement>('[data-book-open]')?.disabled,
    ).toBe(true);
    expect(
      getCard(root, 'book-1')
        .querySelector<HTMLButtonElement>('[data-book-actions]')
        ?.getAttribute('aria-label'),
    ).toBe(
      'Book actions for The Tombs of Atuan, by Ursula K. Le Guin, Earthsea Cycle, download in progress',
    );

    // Determinate state (downloadPercent = 64)
    flushSync(() => {
      reportProgress?.(64);
    });
    for (const bar of indeterminateBars) {
      expect(bar.getAttribute('aria-valuenow')).toBe('64');
      expect(bar.getAttribute('aria-valuetext')).toBe('64% downloaded');
      expect(bar.firstElementChild?.classList.contains('animate-pulse')).toBe(false);
      expect(bar.firstElementChild?.getAttribute('style')).toContain('width: 64%');
    }
    expect(
      getCard(root, 'book-1')
        .querySelector<HTMLButtonElement>('[data-book-actions]')
        ?.getAttribute('aria-label'),
    ).toBe(
      'Book actions for The Tombs of Atuan, by Ursula K. Le Guin, Earthsea Cycle, 64% downloaded',
    );

    // Grid view renders both the banner progressbar and the spinner badge progressbar on the card
    switchView(root, 'Grid');
    const gridBars = root.querySelectorAll<HTMLElement>(
      `[role="progressbar"][aria-label="${expectedDownloadLabel}"]`,
    );
    expect(gridBars).toHaveLength(2);
    const gridCard = getCard(root, 'book-1');
    expect(gridCard.querySelector('svg.animate-spin')).not.toBeNull();
    expect(gridCard.querySelector<HTMLButtonElement>('[data-book-open]')?.disabled).toBe(true);
    expect(
      gridCard.querySelector<HTMLButtonElement>('[data-book-actions]')?.getAttribute('aria-label'),
    ).toBe(
      'Book actions for The Tombs of Atuan, by Ursula K. Le Guin, Earthsea Cycle, 64% downloaded',
    );

    // Finish download so pending work settles cleanly
    finishDownload?.({ relativePath: 'books/book-1.epub', size: 1024 });
    await vi.waitFor(() => {
      expect(
        getCard(root, 'book-1').querySelector<HTMLButtonElement>('[data-book-open]')?.disabled,
      ).toBe(false);
    });
  });

  it('supports Tab and Shift+Tab keyboard navigation across virtualized cards and disabled downloading cards', async () => {
    stageHeight = 140;
    mocks.preferences.set('libraryView', 'list');
    mocks.books = Array.from({ length: 8 }, (_, index) =>
      makeBook({
        id: `book-${index + 1}`,
        title: `Book ${index + 1}`,
        downloadPath: index === 4 ? null : 'books/ready.epub',
        downloadStatus: index === 4 ? 'none' : 'available',
      }),
    );

    let finishDownload: ((value: { relativePath: string; size: number }) => void) | undefined;
    mocks.downloadEpub.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDownload = resolve;
        }),
    );

    const root = await mountLibrary();

    // With 140px viewport height in list view (~152px rows + 2 overscan rows), rows 0..2 render initially
    expect(root.querySelector('article[data-book-id="book-3"]')).not.toBeNull();
    expect(root.querySelector('article[data-book-id="book-4"]')).toBeNull();

    // Forward Tab from [data-book-actions] on book-3 (index 2) scrolls to book-4 (index 3) and focuses [data-book-open]
    const actions3 = getCard(root, 'book-3').querySelector<HTMLButtonElement>(
      '[data-book-actions]',
    );
    actions3?.focus();
    const forwardEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    actions3?.dispatchEvent(forwardEvent);
    expect(forwardEvent.defaultPrevented).toBe(true);

    await vi.waitFor(() => {
      const open4 = getCard(root, 'book-4').querySelector<HTMLButtonElement>('[data-book-open]');
      expect(document.activeElement).toBe(open4);
    });

    // Start downloading book-5 (index 4) so its [data-book-open] button becomes disabled
    flushSync(() => {
      getCard(root, 'book-5').querySelector<HTMLButtonElement>('[data-book-open]')?.click();
    });
    await tick();
    expect(
      getCard(root, 'book-5').querySelector<HTMLButtonElement>('[data-book-open]')?.disabled,
    ).toBe(true);

    root.scrollTop = 0;
    root.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    await tick();

    // Scroll so book-5 is off-screen below book-4, then Tab forward into book-5: should skip disabled [data-book-open] and focus [data-book-actions]
    root.scrollTop = 152;
    root.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    await tick();
    expect(root.querySelector('article[data-book-id="book-5"]')).toBeNull();

    const actions4 = getCard(root, 'book-4').querySelector<HTMLButtonElement>(
      '[data-book-actions]',
    );
    actions4?.focus();
    const tabIntoDisabled = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    actions4?.dispatchEvent(tabIntoDisabled);
    expect(tabIntoDisabled.defaultPrevented).toBe(true);

    await vi.waitFor(() => {
      const actions5 = getCard(root, 'book-5').querySelector<HTMLButtonElement>(
        '[data-book-actions]',
      );
      expect(document.activeElement).toBe(actions5);
    });

    // Scroll down so book-4 leaves the virtual window, then Shift+Tab from [data-book-actions] on downloading book-5 crosses back to book-4 [data-book-actions]
    root.scrollTop = 7 * 152;
    const grid = root.querySelector<HTMLElement>('#library-results');
    grid?.dispatchEvent(new Event('focusout'));
    root.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    await tick();
    expect(root.querySelector('article[data-book-id="book-4"]')).toBeNull();

    const actions5AfterScroll = getCard(root, 'book-5').querySelector<HTMLButtonElement>(
      '[data-book-actions]',
    );
    actions5AfterScroll?.focus();
    const backwardEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    actions5AfterScroll?.dispatchEvent(backwardEvent);
    expect(backwardEvent.defaultPrevented).toBe(true);

    await vi.waitFor(() => {
      const actions4AfterScroll = getCard(root, 'book-4').querySelector<HTMLButtonElement>(
        '[data-book-actions]',
      );
      expect(document.activeElement).toBe(actions4AfterScroll);
    });

    finishDownload?.({ relativePath: 'books/book-5.epub', size: 1024 });
    await tick();
  });

  it('ignores redundant connected capability events while online, cancels transient reconnect bounces, and stops series-detail batches when native network drops', async () => {
    mocks.isNativePlatform = true;
    mocks.connected = true;
    mocks.books = [makeBook({ id: 'book-1', title: 'A Wizard of Earthsea' })];
    mocks.getBookSeries.mockReset().mockResolvedValue([{ id: 1 }]);
    mocks.getSeriesDetail.mockReset().mockResolvedValue({ volumes: [], incomplete: false });
    mocks.flushProgress.mockReset().mockResolvedValue(undefined);
    mocks.networkListeners.length = 0;

    try {
      await mountLibrary();
      await vi.waitFor(() => {
        expect(mocks.getBookSeries).toHaveBeenCalledTimes(1);
        expect(mocks.getSeriesDetail).toHaveBeenCalledTimes(1);
      });
      mocks.getBookSeries.mockClear();
      mocks.getSeriesDetail.mockClear();
      mocks.flushProgress.mockClear();

      const emitNetwork = (connected: boolean, connectionType = connected ? 'wifi' : 'none') => {
        mocks.connected = connected;
        for (const listener of [...mocks.networkListeners]) {
          listener({ connected, connectionType });
        }
      };

      // Android Wi-Fi -> cellular fallback fires connected=true while already online: must not trigger an unsolicited refresh
      emitNetwork(true, 'cellular');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(mocks.getBookSeries).not.toHaveBeenCalled();
      expect(mocks.flushProgress).not.toHaveBeenCalled();

      // Transient offline -> online -> offline bounce within settle window cancels reconnect work
      emitNetwork(false);
      emitNetwork(true, 'cellular');
      await new Promise((resolve) => setTimeout(resolve, 40));
      emitNetwork(false);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(mocks.getBookSeries).not.toHaveBeenCalled();
      expect(mocks.flushProgress).not.toHaveBeenCalled();

      // Genuine reconnect refreshes catalog, but aborts before getSeriesDetail if native connectivity drops mid-refresh
      mocks.getBookSeries.mockImplementationOnce(async () => {
        mocks.connected = false;
        return [{ id: 1 }];
      });
      emitNetwork(true, 'wifi');
      await vi.waitFor(() => {
        expect(mocks.getBookSeries).toHaveBeenCalledTimes(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mocks.getSeriesDetail).not.toHaveBeenCalled();

      // Once native Network.getStatus() validates connected=true (even if connected=true had already fired earlier),
      // pending reconnect work completes both catalog refresh and queued progress flush.
      mocks.getBookSeries.mockClear();
      mocks.flushProgress.mockClear();
      mocks.connected = true;
      await vi.waitFor(() => {
        expect(mocks.getBookSeries).toHaveBeenCalledTimes(1);
        expect(mocks.getSeriesDetail).toHaveBeenCalledTimes(1);
        expect(mocks.flushProgress).toHaveBeenCalledTimes(1);
      });

      // Also handles networkStatusChange({ connected: true }) arriving while Network.getStatus() is still unvalidated.
      emitNetwork(false);
      mocks.getBookSeries.mockClear();
      mocks.getSeriesDetail.mockClear();
      mocks.flushProgress.mockClear();
      for (const listener of [...mocks.networkListeners]) {
        listener({ connected: true, connectionType: 'wifi' });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(mocks.getBookSeries).not.toHaveBeenCalled();
      expect(mocks.flushProgress).not.toHaveBeenCalled();

      mocks.connected = true;
      emitNetwork(true, 'wifi');
      await vi.waitFor(() => {
        expect(mocks.getBookSeries).toHaveBeenCalledTimes(1);
        expect(mocks.getSeriesDetail).toHaveBeenCalledTimes(1);
        expect(mocks.flushProgress).toHaveBeenCalledTimes(1);
      });
    } finally {
      mocks.isNativePlatform = false;
      mocks.networkListeners.length = 0;
    }
  });
});
