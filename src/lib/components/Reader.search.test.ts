// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReaderSearchBatch, ReaderSearchCursor, ReaderSearchResult } from '../reader/search';
import type * as ReaderSessionModule from '../reader/session';
import type {
  ReaderLinkReturnTarget,
  ReaderLocation,
  ReaderLocationOrigin,
  TocItem,
} from '../reader/session';

const { sessionMock, getPreferencesMock, setPreferencesMock } = vi.hoisted(() => {
  const sessionMock = {
    onLocation: null as
      | ((
          location: ReaderLocation,
          origin: ReaderLocationOrigin,
          returnTarget?: ReaderLinkReturnTarget,
        ) => void)
      | null,
    onTap: null as ((zone: 'previous' | 'center' | 'next') => void) | null,
    toc: [] as TocItem[],
    open: vi.fn(),
    tableOfContents: vi.fn(() => sessionMock.toc),
    updateHighlights: vi.fn(),
    setSearchHighlight: vi.fn(),
    search: vi.fn(),
    displayCfi: vi.fn<(_cfi: string, _userNavigation?: boolean) => Promise<boolean>>(
      async () => true,
    ),
    display: vi.fn<(_href: string, _userNavigation?: boolean) => Promise<void>>(async () => {}),
    next: vi.fn(async () => {}),
    previous: vi.fn(async () => {}),
    applyAppearance: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    sessionMock,
    getPreferencesMock: vi.fn(async () => new Map<string, string>()),
    setPreferencesMock: vi.fn(async () => {}),
  };
});

vi.mock('../database/database', () => ({
  getPreferences: getPreferencesMock,
  setPreferences: setPreferencesMock,
}));

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<typeof ReaderSessionModule>();
  return {
    ...actual,
    ReaderSession: class {
      open(
        _target: HTMLElement,
        _cfi: string | null,
        _xpath: string | null,
        _percentage: number | null,
        _appearance: unknown,
        onLocation: NonNullable<typeof sessionMock.onLocation>,
        onTap: NonNullable<typeof sessionMock.onTap>,
      ): Promise<void> {
        sessionMock.onLocation = onLocation;
        sessionMock.onTap = onTap;
        return sessionMock.open();
      }
      tableOfContents = sessionMock.tableOfContents;
      updateHighlights = sessionMock.updateHighlights;
      setSearchHighlight = sessionMock.setSearchHighlight;
      search = sessionMock.search;
      displayCfi = sessionMock.displayCfi;
      display = sessionMock.display;
      next = sessionMock.next;
      previous = sessionMock.previous;
      applyAppearance = sessionMock.applyAppearance;
      destroy = sessionMock.destroy;
    },
  };
});

import Reader from './Reader.svelte';

function makeResult(index: number, query = 'Harbor', sectionIndex = 0): ReaderSearchResult {
  const excerpt = `Excerpt ${index + 1} with ${query} beside <img src=x onerror=alert(1)>`;
  return {
    cfi: `epubcfi(/6/${(sectionIndex + 1) * 2}!/4/2/${index + 1}:0)`,
    excerpt,
    segments: [
      { text: `Excerpt ${index + 1} with `, match: false },
      { text: query, match: true },
      { text: ' beside <img src=x onerror=alert(1)>', match: false },
    ],
    href: `chapter-${sectionIndex + 1}.xhtml`,
    spineIndex: sectionIndex,
  };
}

function makeLocation(cfi: string, href = 'chapter-1.xhtml', spineIndex = 0): ReaderLocation {
  return {
    cfi,
    xpath: `//body/DocFragment[${spineIndex + 1}]/body/p[1]`,
    href,
    percentage: 0.15,
    spineIndex,
    pageIndex: 1,
    pageCount: 10,
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

describe('Reader search workflow and floating match bar', () => {
  let target: HTMLDivElement;
  let component: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.animate) {
      Element.prototype.animate = () => {
        const animation = {
          onfinish: null as (() => void) | null,
          cancel: () => {},
          finish: () => animation.onfinish?.(),
        };
        queueMicrotask(() => animation.onfinish?.());
        return animation as unknown as Animation;
      };
    }
    sessionMock.onLocation = null;
    sessionMock.onTap = null;
    sessionMock.toc = [
      { label: 'Chapter 1', href: 'chapter-1.xhtml', children: [] },
      { label: 'Chapter 2', href: 'chapter-2.xhtml', children: [] },
      { label: 'Chapter 3', href: 'chapter-3.xhtml', children: [] },
    ];
    sessionMock.open.mockResolvedValue(undefined);
    sessionMock.displayCfi.mockImplementation(async (cfi: string, userNavigation = true) => {
      sessionMock.onLocation?.(
        makeLocation(cfi, 'chapter-2.xhtml', 1),
        userNavigation ? 'navigation' : 'restore',
      );
      return true;
    });
    sessionMock.display.mockImplementation(async (href: string, userNavigation = true) => {
      sessionMock.onLocation?.(
        makeLocation(`fallback-${href}`, href, 0),
        userNavigation ? 'navigation' : 'restore',
      );
    });

    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    if (component) {
      unmount(component);
      component = null;
    }
    target.remove();
  });

  async function openSearchPanel(): Promise<void> {
    const reveal = target.querySelector<HTMLButtonElement>('.reader-top-reveal');
    reveal?.click();
    flushSync();
    const searchBtn = target.querySelector<HTMLButtonElement>('[aria-controls="reader-search"]');
    searchBtn?.click();
    await flushAsync();
  }

  it('renders <mark> highlights without HTML injection, steps matches, reopens focused row on 1 / N, and returns with href fallback without syncing transient jumps to Kavita', async () => {
    const onRelocated = vi.fn();
    const backHandlers: Array<() => boolean> = [];

    const results = [
      makeResult(0, 'Harbor', 0),
      makeResult(1, 'harbor', 1),
      makeResult(2, 'HARBOR', 2),
    ];
    sessionMock.search.mockResolvedValueOnce({
      results,
      scannedChapters: 3,
      skippedChapters: 0,
      totalChapters: 3,
      nextCursor: null,
    } satisfies ReaderSearchBatch);

    component = mount(Reader, {
      target,
      props: {
        bookUrl: 'book.epub',
        bookId: 'book-1',
        title: 'Test Book',
        onBack: vi.fn(),
        onRelocated,
        registerBackHandler: (handler) => {
          backHandlers.push(handler);
          return () => {
            backHandlers.length = 0;
          };
        },
      },
    });
    await flushAsync();

    // Reader starts on pre-search origin location.
    sessionMock.onLocation?.(makeLocation('origin-cfi', 'origin.xhtml', 0), 'restore');
    flushSync();

    await openSearchPanel();

    const input = target.querySelector<HTMLInputElement>('#reader-search-query')!;
    input.value = 'harbor';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    target
      .querySelector<HTMLFormElement>('#reader-search form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushAsync();

    // Semantic <mark> tags rendered and hostile HTML kept as literal text.
    const marks = target.querySelectorAll('#reader-search mark.reader-search-excerpt-match');
    expect(marks).toHaveLength(3);
    expect(marks[0]?.textContent).toBe('Harbor');
    expect(target.querySelector('#reader-search img')).toBeNull();

    // Selecting result #1 navigates to CFI, sets transient highlight, closes dialog, and shows match bar.
    const resultButtons = target.querySelectorAll<HTMLButtonElement>(
      '[data-reader-focus="search-result"]',
    );
    resultButtons[0]?.click();
    await flushAsync();

    expect(target.querySelector('#reader-search')).toBeNull();
    expect(sessionMock.displayCfi).toHaveBeenCalledWith(results[0]!.cfi, false);
    expect(sessionMock.setSearchHighlight).toHaveBeenLastCalledWith(results[0]!.cfi);

    const matchBar = target.querySelector<HTMLElement>('[data-reader-search-bar]');
    expect(matchBar).not.toBeNull();
    expect(matchBar?.classList.contains('hidden')).toBe(false);

    // Tap zones are NOT inert while the non-modal match bar is visible.
    const tapZones = target.querySelector<HTMLElement>('.tap-zones');
    expect(tapZones?.inert).toBeFalsy();

    const prevBtn = matchBar!.querySelector<HTMLButtonElement>(
      '[aria-label="Previous search match"]',
    )!;
    const counterBtn = matchBar!.querySelector<HTMLButtonElement>('.reader-search-bar-counter')!;
    const nextBtn = matchBar!.querySelector<HTMLButtonElement>('[aria-label="Next search match"]')!;
    const returnBtn = matchBar!.querySelector<HTMLButtonElement>(
      '[aria-label="Return to pre-search reading location"]',
    )!;
    const closeBtn = matchBar!.querySelector<HTMLButtonElement>(
      '[aria-label="Close search match bar"]',
    )!;

    expect(prevBtn).toBeTruthy();
    expect(counterBtn.textContent?.trim()).toBe('1 / 3');
    expect(nextBtn).toBeTruthy();
    expect(returnBtn.disabled).toBe(false);
    expect(closeBtn).toBeTruthy();

    // Stepping Next and Previous moves active highlight and updates 1 / N without erasing origin or syncing to Kavita.
    nextBtn.click();
    await flushAsync();
    expect(counterBtn.textContent?.trim()).toBe('2 / 3');
    expect(sessionMock.setSearchHighlight).toHaveBeenLastCalledWith(results[1]!.cfi);

    prevBtn.click();
    await flushAsync();
    expect(counterBtn.textContent?.trim()).toBe('1 / 3');
    expect(sessionMock.setSearchHighlight).toHaveBeenLastCalledWith(results[0]!.cfi);

    nextBtn.click();
    await flushAsync();
    expect(counterBtn.textContent?.trim()).toBe('2 / 3');

    // Tapping 2 / 3 reopens search dialog and focuses the active result entry (index 1).
    counterBtn.click();
    await flushAsync();
    const reopenedDialog = target.querySelector<HTMLElement>('#reader-search');
    expect(reopenedDialog).not.toBeNull();
    const activeRow = reopenedDialog!.querySelector<HTMLButtonElement>(
      '[data-reader-focus="search-result"][data-reader-focus-id="1"]',
    )!;
    expect(activeRow.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(activeRow);

    // Android Back first closes the reopened search panel while preserving the match bar.
    expect(backHandlers[0]?.()).toBe(true);
    await flushAsync();
    expect(target.querySelector('#reader-search')).toBeNull();
    expect(target.querySelector('[data-reader-search-bar]')).not.toBeNull();

    // Make origin CFI fail on return to verify href fallback logic matching returnToLink.
    sessionMock.displayCfi.mockImplementationOnce(async () => false);
    returnBtn.click();
    await flushAsync();

    expect(sessionMock.displayCfi).toHaveBeenCalledWith('origin-cfi', false);
    expect(sessionMock.display).toHaveBeenCalledWith('origin.xhtml', false);
    expect(sessionMock.setSearchHighlight).toHaveBeenLastCalledWith(null);
    expect(target.querySelector('[data-reader-search-bar]')).toBeNull();

    // Transient search jumps and return never synced transient state to Kavita via onRelocated.
    expect(onRelocated).not.toHaveBeenCalled();
  });

  it('shows skipped-chapter truncation notice at 100 matches and appends the next batch on click', async () => {
    const firstBatch = Array.from({ length: 100 }, (_, i) => makeResult(i, 'Harbor', 0));
    const secondBatch = [makeResult(100, 'Harbor', 2), makeResult(101, 'Harbor', 3)];
    const resumeCursor: ReaderSearchCursor = { sectionIndex: 2, matchIndex: 0 };

    sessionMock.search
      .mockResolvedValueOnce({
        results: firstBatch,
        scannedChapters: 2,
        skippedChapters: 6,
        totalChapters: 8,
        nextCursor: resumeCursor,
      } satisfies ReaderSearchBatch)
      .mockResolvedValueOnce({
        results: secondBatch,
        scannedChapters: 6,
        skippedChapters: 0,
        totalChapters: 8,
        nextCursor: null,
      } satisfies ReaderSearchBatch);

    component = mount(Reader, {
      target,
      props: {
        bookUrl: 'book.epub',
        bookId: 'book-2',
        title: 'Long Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    await flushAsync();
    await openSearchPanel();

    const input = target.querySelector<HTMLInputElement>('#reader-search-query')!;
    input.value = 'Harbor';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    target
      .querySelector<HTMLFormElement>('#reader-search form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushAsync();

    expect(target.textContent).toContain('6 chapters skipped');
    expect(target.textContent).toContain('6 chapters remain unsearched');

    const loadMoreBtn = target.querySelector<HTMLButtonElement>(
      '[data-reader-focus="search-more"]',
    )!;
    expect(loadMoreBtn.textContent?.trim()).toBe('Search remaining chapters');

    loadMoreBtn.focus();
    loadMoreBtn.click();
    await flushAsync();

    expect(sessionMock.search).toHaveBeenNthCalledWith(
      2,
      'Harbor',
      expect.any(AbortSignal),
      100,
      resumeCursor,
    );
    expect(target.querySelectorAll('[data-reader-focus="search-result"]')).toHaveLength(102);
    expect(target.querySelector('[data-reader-focus="search-more"]')).toBeNull();
    expect(target.textContent).toContain('102 matches shown.');
  });

  it('keeps continuation chapter counts cumulative across zero-match, sparse-match, and mid-chapter batches', async () => {
    const cursorAfterFirst: ReaderSearchCursor = { sectionIndex: 25, matchIndex: 0 };
    const cursorMidChapter: ReaderSearchCursor = { sectionIndex: 35, matchIndex: 2 };
    const cursorAfterThird: ReaderSearchCursor = { sectionIndex: 50, matchIndex: 0 };

    sessionMock.search
      .mockResolvedValueOnce({
        results: [],
        scannedChapters: 25,
        skippedChapters: 35,
        totalChapters: 60,
        nextCursor: cursorAfterFirst,
      } satisfies ReaderSearchBatch)
      .mockResolvedValueOnce({
        results: [makeResult(0, 'Harbor', 35), makeResult(1, 'Harbor', 35)],
        scannedChapters: 11,
        skippedChapters: 24,
        totalChapters: 60,
        nextCursor: cursorMidChapter,
      } satisfies ReaderSearchBatch)
      .mockResolvedValueOnce({
        results: [makeResult(2, 'Harbor', 35)],
        scannedChapters: 15,
        skippedChapters: 10,
        totalChapters: 60,
        nextCursor: cursorAfterThird,
      } satisfies ReaderSearchBatch)
      .mockResolvedValueOnce({
        results: [],
        scannedChapters: 10,
        skippedChapters: 0,
        totalChapters: 60,
        nextCursor: null,
      } satisfies ReaderSearchBatch);

    component = mount(Reader, {
      target,
      props: {
        bookUrl: 'book.epub',
        bookId: 'book-cumulative',
        title: 'Large Anthology',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    await flushAsync();
    await openSearchPanel();

    const input = target.querySelector<HTMLInputElement>('#reader-search-query')!;
    input.value = 'Harbor';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    target
      .querySelector<HTMLFormElement>('#reader-search form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushAsync();

    // Zero-match chapter-bounded batch offers continuation instead of claiming the whole book has no matches.
    expect(target.textContent).toContain(
      'No matches found in 25 of 60 chapters (35 chapters skipped).',
    );
    expect(target.textContent).toContain(
      'Search paused after 25 of 60 chapters. 35 chapters remain unsearched.',
    );

    const loadMoreBtn = target.querySelector<HTMLButtonElement>(
      '[data-reader-focus="search-more"]',
    )!;
    loadMoreBtn.focus();
    loadMoreBtn.click();
    await flushAsync();

    // Batch 2 scanned 11 new chapters (25 + 11 = 36) and stopped mid-chapter 35.
    expect(target.textContent).toContain(
      '2 matches shown across 36 of 60 chapters (24 chapters skipped).',
    );
    expect(target.textContent).toContain(
      'Search paused after 2 matches (36 of 60 chapters). 24 chapters remain unsearched.',
    );
    expect(document.activeElement).toBe(
      target.querySelector<HTMLButtonElement>('[data-reader-focus="search-more"]'),
    );

    // Batch 3 resumed mid-chapter 35 (cursor.matchIndex = 2) across 15 sections -> 14 newly scanned chapters (36 + 14 = 50).
    target.querySelector<HTMLButtonElement>('[data-reader-focus="search-more"]')!.click();
    await flushAsync();
    expect(target.textContent).toContain(
      '3 matches shown across 50 of 60 chapters (10 chapters skipped).',
    );

    // Batch 4 finishes final 10 chapters with 0 additional matches -> 3 total matches, banner gone, focus kept inside modal.
    target.querySelector<HTMLButtonElement>('[data-reader-focus="search-more"]')!.click();
    await flushAsync();
    expect(target.querySelector('[data-reader-focus="search-more"]')).toBeNull();
    expect(target.textContent).toContain('3 matches shown.');
    expect(document.activeElement).toBe(
      target.querySelector<HTMLButtonElement>(
        '[data-reader-focus="search-result"][data-reader-focus-id="2"]',
      ),
    );

    // Purely absent query across multiple batches shows "No matches found." only after final batch and returns focus to query input.
    sessionMock.search
      .mockResolvedValueOnce({
        results: [],
        scannedChapters: 25,
        skippedChapters: 15,
        totalChapters: 40,
        nextCursor: { sectionIndex: 25, matchIndex: 0 },
      } satisfies ReaderSearchBatch)
      .mockResolvedValueOnce({
        results: [],
        scannedChapters: 15,
        skippedChapters: 0,
        totalChapters: 40,
        nextCursor: null,
      } satisfies ReaderSearchBatch);

    input.value = 'NonexistentWord';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    target
      .querySelector<HTMLFormElement>('#reader-search form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushAsync();

    expect(target.textContent).toContain(
      'No matches found in 25 of 40 chapters (15 chapters skipped).',
    );
    const absentMoreBtn = target.querySelector<HTMLButtonElement>(
      '[data-reader-focus="search-more"]',
    )!;
    absentMoreBtn.focus();
    absentMoreBtn.click();
    await flushAsync();

    expect(target.querySelector('[data-reader-focus="search-more"]')).toBeNull();
    expect(target.textContent).toContain('No matches found.');
    expect(document.activeElement).toBe(input);
  });

  it('supports Escape dismissal and Android Back pre-search return without syncing transient state', async () => {
    const onRelocated = vi.fn();
    const backHandlers: Array<() => boolean> = [];
    const results = [makeResult(0, 'Harbor', 0), makeResult(1, 'Harbor', 1)];

    sessionMock.search.mockResolvedValue({
      results,
      scannedChapters: 2,
      skippedChapters: 0,
      totalChapters: 2,
      nextCursor: null,
    } satisfies ReaderSearchBatch);

    component = mount(Reader, {
      target,
      props: {
        bookUrl: 'book.epub',
        bookId: 'book-3',
        title: 'Back Escape Book',
        onBack: vi.fn(),
        onRelocated,
        registerBackHandler: (handler) => {
          backHandlers.push(handler);
          return () => {
            backHandlers.length = 0;
          };
        },
      },
    });
    await flushAsync();

    sessionMock.onLocation?.(makeLocation('page-before-search', 'ch1.xhtml', 0), 'restore');
    flushSync();

    await openSearchPanel();
    const input = target.querySelector<HTMLInputElement>('#reader-search-query')!;
    input.value = 'Harbor';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    target
      .querySelector<HTMLFormElement>('#reader-search form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushAsync();

    target.querySelectorAll<HTMLButtonElement>('[data-reader-focus="search-result"]')[0]?.click();
    await flushAsync();
    expect(target.querySelector('[data-reader-search-bar]')).not.toBeNull();

    // Escape dismisses the floating match bar even when focus is on a button inside the match bar.
    const counterBtn = target.querySelector<HTMLButtonElement>('.reader-search-bar-counter')!;
    counterBtn.focus();
    counterBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushAsync();

    expect(target.querySelector('[data-reader-search-bar]')).toBeNull();
    expect(sessionMock.setSearchHighlight).toHaveBeenLastCalledWith(null);
    expect(onRelocated).not.toHaveBeenCalled();

    // Open search again, select a result, and use Android Back to return to pre-search reading page.
    sessionMock.onLocation?.(makeLocation('second-origin-cfi', 'ch1.xhtml', 0), 'restore');
    flushSync();
    await openSearchPanel();
    target.querySelectorAll<HTMLButtonElement>('[data-reader-focus="search-result"]')[1]?.click();
    await flushAsync();
    expect(target.querySelector('[data-reader-search-bar]')).not.toBeNull();

    sessionMock.displayCfi.mockClear();
    expect(backHandlers[0]?.()).toBe(true);
    await flushAsync();

    expect(sessionMock.displayCfi).toHaveBeenCalledWith('second-origin-cfi', false);
    expect(sessionMock.setSearchHighlight).toHaveBeenLastCalledWith(null);
    expect(target.querySelector('[data-reader-search-bar]')).toBeNull();
    expect(onRelocated).not.toHaveBeenCalled();
  });

  it('opens a modal alertdialog when stepping to an unavailable match and restores focus to the match bar on dismiss', async () => {
    const results = [makeResult(0, 'Harbor', 0), makeResult(1, 'Harbor', 1)];
    sessionMock.search.mockResolvedValueOnce({
      results,
      scannedChapters: 2,
      skippedChapters: 0,
      totalChapters: 2,
      nextCursor: null,
    } satisfies ReaderSearchBatch);

    component = mount(Reader, {
      target,
      props: {
        bookUrl: 'book.epub',
        bookId: 'book-4',
        title: 'Alert Focus Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    await flushAsync();

    sessionMock.onLocation?.(makeLocation('origin-cfi', 'ch1.xhtml', 0), 'restore');
    flushSync();

    await openSearchPanel();
    const input = target.querySelector<HTMLInputElement>('#reader-search-query')!;
    input.value = 'Harbor';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    target
      .querySelector<HTMLFormElement>('#reader-search form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushAsync();

    target.querySelectorAll<HTMLButtonElement>('[data-reader-focus="search-result"]')[0]?.click();
    await flushAsync();

    const matchBar = target.querySelector<HTMLElement>('[data-reader-search-bar]')!;
    const nextBtn = matchBar.querySelector<HTMLButtonElement>('[aria-label="Next search match"]')!;

    sessionMock.displayCfi.mockResolvedValueOnce(false);
    sessionMock.display.mockRejectedValueOnce(new Error('Missing chapter'));

    nextBtn.focus();
    nextBtn.click();
    await flushAsync();

    const errorDialog = target.querySelector<HTMLElement>(
      '[role="alertdialog"][aria-modal="true"]',
    );
    expect(errorDialog).not.toBeNull();
    expect(errorDialog?.textContent).toContain(
      'This search result is no longer available in the current EPUB.',
    );
    expect(matchBar.classList.contains('hidden')).toBe(true);
    expect(matchBar.inert).toBe(true);

    const dismissBtn = Array.from(errorDialog!.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent?.trim() === 'Dismiss',
    )!;
    expect(document.activeElement).toBe(dismissBtn);

    dismissBtn.click();
    await flushAsync();

    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    expect(matchBar.classList.contains('hidden')).toBe(false);
    expect(matchBar.inert).toBe(false);
    expect(document.activeElement).toBe(nextBtn);
  });
});
