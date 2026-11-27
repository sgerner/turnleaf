// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '../reader/session';
import type {
  ReaderLinkReturnTarget,
  ReaderLocation,
  ReaderLocationOrigin,
  ReaderSelection,
  ReaderSwipeDirection,
  TocItem,
} from '../reader/session';

const mockState = vi.hoisted(() => {
  const preferences = new Map<string, string>();
  let toc: TocItem[] = [{ label: 'Chapter One', href: 'ch1.xhtml', children: [] }];
  let currentLocation: ReaderLocation = {
    cfi: 'epubcfi(/6/2!/4/2:2)',
    xpath: '//body/DocFragment[1]/body/p[2]',
    href: 'ch1.xhtml',
    percentage: 0.05,
    spineIndex: 0,
    pageIndex: 1,
    pageCount: 20,
  };
  let onLocationCallback:
    | ((
        location: ReaderLocation,
        origin: ReaderLocationOrigin,
        returnTarget?: ReaderLinkReturnTarget,
      ) => void)
    | null = null;
  let onSelectionCallback: ((selection: ReaderSelection | null) => void) | null = null;
  let onSwipeCallback: ((direction: ReaderSwipeDirection) => void) | null = null;

  const sessionInstance = {
    open: vi.fn(
      async (
        _target: HTMLElement,
        _cfi: string | null,
        _xpath: string | null,
        _percentage: number | null,
        _appearance: unknown,
        onLocation: typeof onLocationCallback,
        _onTap: (zone: 'previous' | 'center' | 'next') => void,
        onSelection?: (selection: ReaderSelection | null) => void,
        _onKeyboard?: (event: KeyboardEvent) => void,
        onSwipe?: (direction: ReaderSwipeDirection) => void,
      ) => {
        onLocationCallback = onLocation;
        onSelectionCallback = onSelection ?? null;
        onSwipeCallback = onSwipe ?? null;
        onLocation?.(currentLocation, 'restore');
      },
    ),
    tableOfContents: vi.fn(() => toc),
    updateHighlights: vi.fn(),
    applyAppearance: vi.fn(),
    next: vi.fn(async () => {
      currentLocation = {
        ...currentLocation,
        cfi: `epubcfi(/6/2!/4/2:${currentLocation.pageIndex + 2})`,
        pageIndex: currentLocation.pageIndex + 1,
        percentage: (currentLocation.pageIndex + 1) / currentLocation.pageCount,
      };
      onLocationCallback?.(currentLocation, 'navigation');
    }),
    previous: vi.fn(async () => {}),
    jumpToPercentage: vi.fn(async (percentage: number) => {
      const prev = currentLocation;
      const nextIndex = Math.min(
        currentLocation.pageCount - 1,
        Math.floor(percentage * currentLocation.pageCount),
      );
      currentLocation = {
        ...currentLocation,
        cfi: `epubcfi(/6/2!/4/2:${nextIndex + 1})`,
        pageIndex: nextIndex,
        percentage,
      };
      onLocationCallback?.(currentLocation, 'jump', { cfi: prev.cfi, href: prev.href });
      return true;
    }),
    jumpToPage: vi.fn(async (pageNumber: number) => {
      const prev = currentLocation;
      const nextIndex = pageNumber - 1;
      currentLocation = {
        ...currentLocation,
        cfi: `epubcfi(/6/2!/4/2:${pageNumber})`,
        pageIndex: nextIndex,
        percentage: nextIndex / currentLocation.pageCount,
      };
      onLocationCallback?.(currentLocation, 'jump', { cfi: prev.cfi, href: prev.href });
      return true;
    }),
    displayCfi: vi.fn(async (cfi: string) => {
      const pageNumber = Number(cfi.match(/:(\d+)\)$/)?.[1] ?? 1);
      currentLocation = {
        ...currentLocation,
        cfi,
        pageIndex: pageNumber - 1,
        percentage: (pageNumber - 1) / currentLocation.pageCount,
      };
      onLocationCallback?.(currentLocation, 'navigation');
      return true;
    }),
    display: vi.fn(async () => {}),
    destroy: vi.fn(),
  };

  return {
    preferences,
    sessionInstance,
    setToc(next: TocItem[]) {
      toc = next;
    },
    emitSelection(selection: ReaderSelection | null) {
      onSelectionCallback?.(selection);
    },
    emitSwipe(direction: ReaderSwipeDirection) {
      onSwipeCallback?.(direction);
    },
    reset() {
      preferences.clear();
      toc = [{ label: 'Chapter One', href: 'ch1.xhtml', children: [] }];
      currentLocation = {
        cfi: 'epubcfi(/6/2!/4/2:2)',
        xpath: '//body/DocFragment[1]/body/p[2]',
        href: 'ch1.xhtml',
        percentage: 0.05,
        spineIndex: 0,
        pageIndex: 1,
        pageCount: 20,
      };
      onLocationCallback = null;
      onSelectionCallback = null;
      onSwipeCallback = null;
    },
  };
});

vi.mock('../database/database', () => ({
  getPreferences: vi.fn(async (keys: string[]) => {
    const result = new Map<string, string>();
    for (const key of keys) {
      const value = mockState.preferences.get(key);
      if (value !== undefined) result.set(key, value);
    }
    return result;
  }),
  setPreferences: vi.fn(async (entries: Map<string, string>) => {
    for (const [key, value] of entries) mockState.preferences.set(key, value);
  }),
}));

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    ReaderSession: vi.fn(function MockReaderSession() {
      return mockState.sessionInstance;
    }),
  };
});

import Reader from './Reader.svelte';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('Reader.svelte scrubbing, page jumps, empty TOC controls, and one-tap return', () => {
  let host: HTMLDivElement;
  let component: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.reset();
    Element.prototype.animate = vi.fn(() => {
      const animation = {
        finished: Promise.resolve(),
        cancel: vi.fn(),
        onfinish: null as ((event: AnimationPlaybackEvent) => void) | null,
      };
      queueMicrotask(() => animation.onfinish?.(new Event('finish') as AnimationPlaybackEvent));
      return animation as unknown as Animation;
    });
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(() => {
    if (component) {
      unmount(component);
      component = null;
    }
    host.remove();
  });

  async function mountReader(bookId = 'book-1'): Promise<void> {
    component = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:book',
        bookId,
        title: 'Novel',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    await flushAsync();
  }

  function showControls(): void {
    flushSync(() => {
      host
        .querySelector<HTMLButtonElement>('.reader-top-reveal[aria-label="Show reading controls"]')!
        .click();
    });
  }

  it('keeps .reader-progress non-interactive while hidden, scrubs when open, and restores previous CFI in one tap', async () => {
    await mountReader('book-1');

    expect(host.querySelector('.reader-progress')?.getAttribute('role')).toBe('progressbar');
    expect(host.querySelector('[aria-label="Scrub book reading progress"]')).toBeNull();

    showControls();
    const pageIndicator = host.querySelector<HTMLButtonElement>('[aria-controls="reader-jump"]')!;
    expect(pageIndicator.textContent).toContain('Page 2 of 20 · 5%');

    const scrubber = host.querySelector<HTMLInputElement>(
      '[aria-label="Scrub book reading progress"]',
    )!;
    scrubber.value = '60';
    flushSync(() => {
      scrubber.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushAsync();

    expect(mockState.sessionInstance.jumpToPercentage).toHaveBeenCalledWith(0.6);
    expect(pageIndicator.textContent).toContain('Page 13 of 20 · 60%');

    const savedHistory = JSON.parse(mockState.preferences.get('readerHistory:book-1') ?? '[]');
    expect(savedHistory.map((item: { cfi: string }) => item.cfi)).toContain('epubcfi(/6/2!/4/2:2)');

    const returnBtn = host.querySelector<HTMLButtonElement>(
      '[aria-label="Return to previous reading position"]',
    )!;
    flushSync(() => returnBtn.click());
    await flushAsync();

    expect(mockState.sessionInstance.displayCfi).toHaveBeenCalledWith('epubcfi(/6/2!/4/2:2)');
    expect(host.querySelector('[aria-label="Return to previous reading position"]')).toBeNull();
  });

  it('validates and jumps to pages and percentages from both #reader-jump and empty TOC', async () => {
    await mountReader('book-2');
    showControls();

    const pageIndicator = host.querySelector<HTMLButtonElement>('[aria-controls="reader-jump"]')!;
    flushSync(() => pageIndicator.click());

    const jumpDialog = host.querySelector('#reader-jump')!;
    const pageInput = jumpDialog.querySelector<HTMLInputElement>('#reader-jump-page-input')!;
    pageInput.value = '99';
    flushSync(() => {
      pageInput.dispatchEvent(new Event('input', { bubbles: true }));
      pageInput
        .closest('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(jumpDialog.textContent).toContain('Enter a page between 1 and 20.');

    pageInput.value = '15';
    flushSync(() => {
      pageInput.dispatchEvent(new Event('input', { bubbles: true }));
      pageInput
        .closest('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    expect(mockState.sessionInstance.jumpToPage).toHaveBeenCalledWith(15);
    expect(host.querySelector('#reader-jump')).toBeNull();

    flushSync(() => pageIndicator.click());
    const percentInput = host.querySelector<HTMLInputElement>('#reader-jump-percent-input')!;
    percentInput.value = '40';
    flushSync(() => {
      percentInput.dispatchEvent(new Event('input', { bubbles: true }));
      percentInput
        .closest('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    expect(mockState.sessionInstance.jumpToPercentage).toHaveBeenCalledWith(0.4);

    unmount(component!);
    component = null;
    mockState.reset();
    mockState.setToc([]);
    await mountReader('book-empty-toc');
    showControls();
    flushSync(() => {
      host.querySelector<HTMLButtonElement>('[aria-controls="reader-contents"]')!.click();
    });

    const emptyTocPageInput = host.querySelector<HTMLInputElement>('#reader-empty-toc-page-input')!;
    emptyTocPageInput.value = '9';
    flushSync(() => {
      emptyTocPageInput.dispatchEvent(new Event('input', { bubbles: true }));
      emptyTocPageInput
        .closest('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    expect(mockState.sessionInstance.jumpToPage).toHaveBeenCalledWith(9);
    expect(host.querySelector('[aria-label="Return to previous reading position"]')).not.toBeNull();
  });

  it('turns pages on session swipe unless text is selected or a dialog panel is open', async () => {
    await mountReader('book-swipe');

    mockState.emitSwipe('next');
    await flushAsync();
    expect(mockState.sessionInstance.next).toHaveBeenCalledOnce();

    flushSync(() => {
      mockState.emitSelection({ cfi: 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:5)', text: 'Words' });
    });
    mockState.emitSwipe('next');
    await flushAsync();
    expect(mockState.sessionInstance.next).toHaveBeenCalledOnce();
  });
});
