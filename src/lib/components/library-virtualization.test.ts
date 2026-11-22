// @vitest-environment jsdom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookRecord, ServerConfig } from '../database/database';
import {
  calculateVirtualWindow,
  columnsForWidth,
  GRID_ROW_GAP_PX,
  resultsContainerHeight,
  rowHeightFor,
} from './library-virtualization';

vi.mock('svelte', async () => {
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const clientEntry = pathToFileURL(resolve('node_modules/svelte/src/index-client.js')).href;
  return import(/* @vite-ignore */ clientEntry) as Promise<Record<string, unknown>>;
});

const mockState = vi.hoisted(() => ({
  books: [] as BookRecord[],
  preferences: new Map<string, string>(),
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => {} })),
    exitApp: vi.fn(async () => {}),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: false, connectionType: 'none' })),
    addListener: vi.fn(async () => ({ remove: async () => {} })),
  },
}));

vi.mock('../downloads/native-download', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cleanupInterruptedEpubDownloads: vi.fn(async () => {}),
    verifyDownloadedEpub: vi.fn(async () => ({ webViewUrl: 'blob:test-book' })),
  };
});

vi.mock('../database/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getBooks: vi.fn(async () => mockState.books),
    getPreferences: vi.fn(async () => new Map(mockState.preferences)),
    getReadingState: vi.fn(async () => null),
    getSyncStatus: vi.fn(async () => ({
      pendingCount: 0,
      failedCount: 0,
      lastError: null,
      lastUpdatedAt: null,
    })),
    setPreference: vi.fn(async () => {}),
  };
});

vi.mock('./Reader.svelte', () => ({
  default: function MockReader(anchor: Comment, props: { onBack: () => void }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.readerBack = 'true';
    button.textContent = 'Close reader';
    button.addEventListener('click', () => props.onBack());
    anchor.before(button);
    return {
      $destroy() {
        button.remove();
      },
    };
  },
}));

import Library from './Library.svelte';

describe('calculateVirtualWindow', () => {
  it('returns an empty window for an empty library', () => {
    expect(calculateVirtualWindow(0, 2, 300, 0, 600)).toEqual({
      firstRow: 0,
      lastRow: -1,
      startIndex: 0,
      endIndex: 0,
      totalRows: 0,
      totalHeight: 0,
    });
  });

  it('keeps the viewport and overscan within the available rows', () => {
    expect(calculateVirtualWindow(25, 4, 100, 500, 200, 1)).toEqual({
      firstRow: 4,
      lastRow: 6,
      startIndex: 16,
      endIndex: 25,
      totalRows: 7,
      totalHeight: 700,
    });
  });

  it('includes the final partial row without inventing items', () => {
    expect(calculateVirtualWindow(5, 3, 240, 0, 1, 0)).toMatchObject({
      firstRow: 0,
      lastRow: 0,
      startIndex: 0,
      endIndex: 3,
      totalRows: 2,
      totalHeight: 480,
    });
    expect(calculateVirtualWindow(5, 3, 240, 300, 1, 0)).toMatchObject({
      firstRow: 1,
      lastRow: 1,
      startIndex: 3,
      endIndex: 5,
    });
  });

  it('normalizes invalid dimensions and clamps negative scroll positions', () => {
    expect(calculateVirtualWindow(3.9, 0, Number.NaN, -20, 100, -2)).toEqual({
      firstRow: 0,
      lastRow: 2,
      startIndex: 0,
      endIndex: 3,
      totalRows: 3,
      totalHeight: 3,
    });
  });

  it('keeps a valid final row when scrolling past the end', () => {
    expect(calculateVirtualWindow(5, 2, 100, 50_000, 800, 2)).toEqual({
      firstRow: 0,
      lastRow: 2,
      startIndex: 0,
      endIndex: 5,
      totalRows: 3,
      totalHeight: 300,
    });
  });
});

describe('columnsForWidth, rowHeightFor, and resultsContainerHeight', () => {
  it('selects responsive column counts for grid mode and single column for list mode', () => {
    expect(columnsForWidth(360, 'grid')).toBe(2);
    expect(columnsForWidth(640, 'grid')).toBe(3);
    expect(columnsForWidth(768, 'grid')).toBe(4);
    expect(columnsForWidth(1024, 'grid')).toBe(5);
    expect(columnsForWidth(1280, 'list')).toBe(1);
    expect(columnsForWidth(360, 'list')).toBe(1);
  });

  it('scales grid row height across 16px and 32px fonts and 1.067 text scaling', () => {
    // 1024px wide, 5 columns -> cardWidth = (1024 - 64) / 5 = 192 -> coverHeight = 288
    expect(rowHeightFor(1024, 5, 'grid', 16, 1)).toBe(400);
    expect(rowHeightFor(1024, 5, 'grid', 16, 1.067)).toBe(406);
    expect(rowHeightFor(1024, 5, 'grid', 32, 1)).toBe(480);
    expect(rowHeightFor(1024, 5, 'grid', 32, 1.067)).toBe(492);

    // Preserves full 32px row gap above 2-line title + 1-line author at 1.067 scaling
    const scaledGridCard32 = 288 + 32 * (1 + 2.75 * 1.067 + 1.25 * 1.067 * 1.067);
    expect(rowHeightFor(1024, 5, 'grid', 32, 1.067) - scaledGridCard32).toBeGreaterThanOrEqual(
      GRID_ROW_GAP_PX,
    );
  });

  it('scales list row height across 16px and 32px fonts and 1.067 text scaling without clipping', () => {
    expect(rowHeightFor(1024, 1, 'list', 16, 1)).toBe(152);
    expect(rowHeightFor(1024, 1, 'list', 16, 1.067)).toBe(160);
    expect(rowHeightFor(1024, 1, 'list', 32, 1)).toBe(304);
    expect(rowHeightFor(1024, 1, 'list', 32, 1.067)).toBe(320);

    // Worst-case list card (p-3 + 2-line title + author + series + download bar + progress bar)
    for (const rootFontPx of [16, 32]) {
      const worstCaseCardHeight = rootFontPx * (3.75 + 2.75 * 1.067 + 2.25 * 1.067 * 1.067);
      expect(rowHeightFor(600, 1, 'list', rootFontPx, 1.067)).toBeGreaterThanOrEqual(
        Math.ceil(worstCaseCardHeight + rootFontPx * 0.75),
      );
    }
  });

  it('normalizes non-finite or non-positive font sizes and text scaling', () => {
    expect(rowHeightFor(1024, 5, 'grid', 0, Number.NaN)).toBe(400);
    expect(rowHeightFor(1024, 1, 'list', -16, 0)).toBe(152);
  });

  it('subtracts GRID_ROW_GAP_PX only in grid mode for resultsContainerHeight', () => {
    expect(resultsContainerHeight(0, 'grid')).toBe(0);
    expect(resultsContainerHeight(0, 'list')).toBe(0);
    expect(resultsContainerHeight(16, 'grid')).toBe(0);
    expect(resultsContainerHeight(Number.NaN, 'list')).toBe(0);

    for (const bookCount of [500, 5_000, 10_000]) {
      const gridRowHeight = rowHeightFor(1024, 5, 'grid', 16, 1.067);
      const gridWindow = calculateVirtualWindow(bookCount, 5, gridRowHeight, 0, 900);
      expect(resultsContainerHeight(gridWindow.totalHeight, 'grid')).toBe(
        gridWindow.totalHeight - GRID_ROW_GAP_PX,
      );

      const listRowHeight = rowHeightFor(1024, 1, 'list', 16, 1.067);
      const listWindow = calculateVirtualWindow(bookCount, 1, listRowHeight, 0, 900);
      expect(resultsContainerHeight(listWindow.totalHeight, 'list')).toBe(listWindow.totalHeight);
    }
  });
});

describe('Library virtual DOM caching and containment', () => {
  const server: ServerConfig = {
    id: 'server-1',
    displayName: 'Test Kavita',
    baseUrl: 'https://kavita.example.com',
    credentialRef: 'cred-1',
    kavitaVersion: '0.8.0',
    lastConnectedAt: '2026-01-01T00:00:00.000Z',
  };

  let rafCallbacks: FrameRequestCallback[];
  let nextRafId: number;
  let mountedInstance: Record<string, unknown> | null = null;

  function buildBooks(count: number): BookRecord[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `book-${String(i).padStart(4, '0')}`,
      serverId: server.id,
      libraryId: 1,
      seriesId: i + 1,
      volumeId: i + 1,
      chapterId: i + 1,
      title: `Book ${String(i).padStart(4, '0')}`,
      author: `Author ${i}`,
      series: `Series ${i}`,
      descriptionHtml: null,
      format: 'EPUB',
      pages: 200,
      pagesRead: 40,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastReadAt: null,
      downloadStatus: i === 0 ? 'available' : 'none',
      downloadPath: i === 0 ? 'books/book-0000.epub' : null,
      fileSize: i === 0 ? 1024 : null,
      remoteAvailable: true,
    }));
  }

  async function flushFrames(): Promise<void> {
    await tick();
    await Promise.resolve();
    while (rafCallbacks.length > 0) {
      const batch = rafCallbacks.splice(0, rafCallbacks.length);
      for (const callback of batch) callback(16);
      await tick();
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.fontSize = '16px';
    document.documentElement.style.setProperty('--text-scaling', '1.067');
    mockState.books = buildBooks(80);
    mockState.preferences = new Map();
    rafCallbacks = [];
    nextRafId = 1;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextRafId++;
      rafCallbacks.push(callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    Element.prototype.animate = vi.fn(() => {
      const animation = {
        onfinish: null as (() => void) | null,
        cancel: vi.fn(),
        finish: vi.fn(),
      };
      queueMicrotask(() => animation.onfinish?.());
      return animation as unknown as Animation;
    });
  });

  afterEach(async () => {
    if (mountedInstance) {
      await unmount(mountedInstance);
      mountedInstance = null;
    }
    vi.restoreAllMocks();
  });

  it('runs zero getComputedStyle, getBoundingClientRect, or closest calls during scroll and focus updates', async () => {
    const stage = document.createElement('div');
    stage.className = 'app-stage';
    Object.defineProperty(stage, 'clientWidth', { configurable: true, get: () => 1024 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, get: () => 800 });
    let stageScrollTop = 0;
    Object.defineProperty(stage, 'scrollTop', {
      configurable: true,
      get: () => stageScrollTop,
      set: (value: number) => {
        stageScrollTop = value;
      },
    });
    stage.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        right: 1024,
        bottom: 800,
        width: 1024,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.append(stage);

    let listTopOffset = 220;
    const origGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === stage) {
        return {
          top: 0,
          left: 0,
          right: 1024,
          bottom: 800,
          width: 1024,
          height: 800,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (this.id === 'library-results') {
        const top = listTopOffset - stageScrollTop;
        return {
          top,
          left: 0,
          right: 1024,
          bottom: top + 6000,
          width: 1024,
          height: 6000,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return origGetBoundingClientRect.call(this);
    });

    mountedInstance = mount(Library, {
      target: stage,
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

    await vi.waitFor(() => {
      expect(stage.querySelector('#library-results article')).not.toBeNull();
    });
    await flushFrames();

    const results = stage.querySelector<HTMLElement>('#library-results')!;
    expect(results.style.contain).toBe('layout style');
    expect(results.style.height).toBe(`${16 * 406 - GRID_ROW_GAP_PX}px`);

    const firstRowEl = results.firstElementChild as HTMLElement;
    expect(firstRowEl.style.contain).toBe('size layout style');
    expect(firstRowEl.style.contain).not.toContain('paint');
    expect(firstRowEl.style.height).toBe('406px');

    const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle');
    const getBoundingClientRectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    const closestSpy = vi.spyOn(Element.prototype, 'closest');
    getComputedStyleSpy.mockClear();
    getBoundingClientRectSpy.mockClear();
    closestSpy.mockClear();

    // Scroll within the same row window, then far down across multiple rows
    for (const nextScrollTop of [40, 120, 2600, 4200]) {
      stageScrollTop = nextScrollTop;
      stage.dispatchEvent(new Event('scroll'));
      await flushFrames();
    }

    expect(results.querySelector('[data-book-index="40"]')).not.toBeNull();
    expect(results.querySelector('[data-book-index="0"]')).toBeNull();
    expect(getComputedStyleSpy).not.toHaveBeenCalled();
    expect(getBoundingClientRectSpy).not.toHaveBeenCalled();
    expect(closestSpy).not.toHaveBeenCalled();

    // Focus updates on book controls must not schedule rAF or query DOM geometry/selectors
    const rafSpy = vi.mocked(window.requestAnimationFrame);
    rafSpy.mockClear();

    const card40 = results.querySelector<HTMLElement>('[data-book-index="40"]')!;
    const openBtn = card40.querySelector<HTMLButtonElement>('[data-book-open]')!;
    const actionsBtn = card40.querySelector<HTMLButtonElement>('[data-book-actions]')!;

    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => openBtn });
    openBtn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await tick();

    // Transition focus from openBtn to actionsBtn inside the same row via relatedTarget
    openBtn.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: actionsBtn }));
    actionsBtn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await tick();

    expect(rafSpy).not.toHaveBeenCalled();
    expect(getComputedStyleSpy).not.toHaveBeenCalled();
    expect(getBoundingClientRectSpy).not.toHaveBeenCalled();
    expect(closestSpy).not.toHaveBeenCalled();

    // Scroll back to top: row 8 (containing book 40) stays rendered while focused
    stageScrollTop = 0;
    stage.dispatchEvent(new Event('scroll'));
    await flushFrames();
    expect(results.querySelector('[data-book-index="40"]')).not.toBeNull();
    expect(getComputedStyleSpy).not.toHaveBeenCalled();
    expect(getBoundingClientRectSpy).not.toHaveBeenCalled();
    expect(closestSpy).not.toHaveBeenCalled();

    // Blur out to search input outside #library-results -> focused offscreen row unmounts without rAF
    rafSpy.mockClear();
    const searchInput = stage.querySelector<HTMLInputElement>('#library-search')!;
    actionsBtn.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: searchInput }),
    );
    await tick();

    expect(results.querySelector('[data-book-index="40"]')).toBeNull();
    expect(rafSpy).not.toHaveBeenCalled();
    expect(getComputedStyleSpy).not.toHaveBeenCalled();
    expect(getBoundingClientRectSpy).not.toHaveBeenCalled();
    expect(closestSpy).not.toHaveBeenCalled();

    // Switch to list mode: container uses full totalHeight without subtracting GRID_ROW_GAP_PX
    const listButton = Array.from(stage.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'List',
    )!;
    listButton.click();
    await flushFrames();
    expect(results.style.height).toBe(`${80 * 160}px`);

    // Banner mutation inside .app-stage refreshes cached listTop
    listTopOffset = 900;
    const banner = document.createElement('div');
    stage.prepend(banner);
    await Promise.resolve();
    await flushFrames();

    getComputedStyleSpy.mockClear();
    getBoundingClientRectSpy.mockClear();
    closestSpy.mockClear();

    stageScrollTop = 900 + 160 * 10;
    stage.dispatchEvent(new Event('scroll'));
    await flushFrames();
    expect(results.querySelector('[data-book-index="10"]')).not.toBeNull();
    expect(getComputedStyleSpy).not.toHaveBeenCalled();
    expect(getBoundingClientRectSpy).not.toHaveBeenCalled();
    expect(closestSpy).not.toHaveBeenCalled();

    // Root 200% font scaling mutation refreshes rowHeight to 320px in list mode
    document.documentElement.style.fontSize = '32px';
    await Promise.resolve();
    await flushFrames();
    expect(results.style.height).toBe(`${80 * 320}px`);
  });

  it('falls back to window dimensions without .app-stage and refreshes metrics after closeReader', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    let winScrollY = 0;
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      get: () => winScrollY,
    });
    vi.spyOn(window, 'scrollBy').mockImplementation(((options?: ScrollToOptions | number) => {
      if (typeof options === 'object' && options?.top) {
        winScrollY += options.top;
      }
    }) as typeof window.scrollBy);

    const host = document.createElement('div');
    document.body.append(host);

    const origGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.id === 'library-results') {
        const top = 180 - winScrollY;
        return {
          top,
          left: 0,
          right: 800,
          bottom: top + 5000,
          width: 800,
          height: 5000,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return origGetBoundingClientRect.call(this);
    });

    mountedInstance = mount(Library, {
      target: host,
      props: {
        server,
        apiKey: 'test-key',
        theme: 'eink',
        mode: 'light',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });

    await vi.waitFor(() => {
      expect(host.querySelector('#library-results article')).not.toBeNull();
    });
    await flushFrames();

    const results = host.querySelector<HTMLElement>('#library-results')!;
    // 800px window width -> 4 columns
    const expectedRowHeight = rowHeightFor(800, 4, 'grid', 16, 1.067);
    expect((results.firstElementChild as HTMLElement).style.height).toBe(`${expectedRowHeight}px`);

    const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle');
    const getBoundingClientRectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    const closestSpy = vi.spyOn(Element.prototype, 'closest');
    getComputedStyleSpy.mockClear();
    getBoundingClientRectSpy.mockClear();
    closestSpy.mockClear();

    winScrollY = 180 + expectedRowHeight * 6;
    window.dispatchEvent(new Event('scroll'));
    await flushFrames();

    expect(results.querySelector('[data-book-index="24"]')).not.toBeNull();
    expect(getComputedStyleSpy).not.toHaveBeenCalled();
    expect(getBoundingClientRectSpy).not.toHaveBeenCalled();
    expect(closestSpy).not.toHaveBeenCalled();

    // Open downloaded book-0000 in Reader, resize/scale while reader is open, then closeReader
    winScrollY = 0;
    window.dispatchEvent(new Event('scroll'));
    await flushFrames();

    const firstOpenButton = host.querySelector<HTMLButtonElement>(
      '[data-book-index="0"] [data-book-open]',
    )!;
    firstOpenButton.click();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-reader-back]')).not.toBeNull();
    });

    // Change window width to 1024px (5 columns) while #library-results is unmounted
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    document.documentElement.style.fontSize = '32px';

    host.querySelector<HTMLButtonElement>('[data-reader-back]')!.click();
    await vi.waitFor(() => {
      expect(host.querySelector('#library-results article')).not.toBeNull();
    });
    await flushFrames();

    const remountedResults = host.querySelector<HTMLElement>('#library-results')!;
    expect((remountedResults.firstElementChild as HTMLElement).style.height).toBe(
      `${rowHeightFor(1024, 5, 'grid', 32, 1.067)}px`,
    );
  });
});
