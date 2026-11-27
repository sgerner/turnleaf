// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { MAX_ANNOTATIONS, type StoredAnnotation } from '../reader/annotations';
import { MAX_BOOKMARKS, type StoredReaderLocation } from '../reader/bookmarks';
import type * as SessionModule from '../reader/session';
import type {
  ReaderLinkReturnTarget,
  ReaderLocation,
  ReaderLocationOrigin,
  ReaderSelection,
} from '../reader/session';

type CapturedSessionCallbacks = {
  onLocation: (
    location: ReaderLocation,
    origin: ReaderLocationOrigin,
    returnTarget?: ReaderLinkReturnTarget,
  ) => void;
  onTap: (zone: 'previous' | 'center' | 'next') => void;
  onSelection: ((selection: ReaderSelection | null) => void) | undefined;
  onKeyboardNavigation: ((event: KeyboardEvent) => void) | undefined;
};

const {
  getPreferencesMock,
  setPreferencesMock,
  openSessionMock,
  destroySessionMock,
  applyAppearanceMock,
  updateHighlightsMock,
  clearTextSelectionMock,
  getVisiblePassagesMock,
  displayCfiMock,
  sessionState,
} = vi.hoisted(() => ({
  getPreferencesMock: vi.fn(),
  setPreferencesMock: vi.fn(),
  openSessionMock: vi.fn(),
  destroySessionMock: vi.fn(),
  applyAppearanceMock: vi.fn(),
  updateHighlightsMock: vi.fn(),
  clearTextSelectionMock: vi.fn(),
  getVisiblePassagesMock: vi.fn<() => ReaderSelection[]>(() => []),
  displayCfiMock: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
  sessionState: {
    callbacks: null as CapturedSessionCallbacks | null,
  },
}));

vi.mock('svelte/transition', () => ({
  fade: () => ({ duration: 0 }),
  fly: () => ({ duration: 0 }),
}));

vi.mock('../database/database', () => ({
  getPreferences: getPreferencesMock,
  setPreferences: setPreferencesMock,
}));

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    ReaderSession: class MockReaderSession {
      open = async (...args: unknown[]) => {
        sessionState.callbacks = {
          onLocation: args[5] as CapturedSessionCallbacks['onLocation'],
          onTap: args[6] as CapturedSessionCallbacks['onTap'],
          onSelection: args[7] as CapturedSessionCallbacks['onSelection'],
          onKeyboardNavigation: args[8] as CapturedSessionCallbacks['onKeyboardNavigation'],
        };
        return await openSessionMock(...args);
      };
      tableOfContents = () => [];
      updateHighlights = updateHighlightsMock;
      applyAppearance = applyAppearanceMock;
      clearTextSelection = clearTextSelectionMock;
      getVisiblePassages = getVisiblePassagesMock;
      displayCfi = displayCfiMock;
      next = vi.fn(() => Promise.resolve());
      previous = vi.fn(() => Promise.resolve());
      destroy = destroySessionMock;
    },
  };
});

import Reader from './Reader.svelte';

function makeLocation(overrides: Partial<ReaderLocation> = {}): ReaderLocation {
  return {
    cfi: 'epubcfi(/6/2!/4/2/1:0)',
    xpath: '/1/body/p[1]',
    href: 'chapter-1.xhtml',
    percentage: 0.25,
    spineIndex: 0,
    pageIndex: 0,
    pageCount: 2,
    ...overrides,
  };
}

describe('Reader mount lifecycle', () => {
  let target: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.callbacks = null;
    getPreferencesMock.mockResolvedValue(new Map());
    setPreferencesMock.mockResolvedValue(undefined);
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

  it('reports true on mount and false on destroy through onMountChange', async () => {
    const onMountChange = vi.fn<(isMounted: boolean) => void>();

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-1',
        title: 'Test Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onMountChange,
      },
    });
    flushSync();

    expect(target.querySelector('.reader-shell')).not.toBeNull();
    expect(onMountChange).toHaveBeenCalledTimes(1);
    expect(onMountChange).toHaveBeenNthCalledWith(1, true);

    await vi.waitFor(() => {
      expect(openSessionMock).toHaveBeenCalledOnce();
    });

    await unmount(mounted);
    mounted = null;

    expect(onMountChange).toHaveBeenCalledTimes(2);
    expect(onMountChange).toHaveBeenNthCalledWith(2, false);
  });

  it('still reports mount and destroy transitions when opening the EPUB fails', async () => {
    openSessionMock.mockRejectedValueOnce(new Error('corrupt epub'));
    const onMountChange = vi.fn<(isMounted: boolean) => void>();

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:broken-book',
        bookId: 'book-2',
        title: 'Broken Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onMountChange,
      },
    });
    flushSync();

    expect(onMountChange).toHaveBeenCalledWith(true);

    await vi.waitFor(() => {
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        'This EPUB could not be opened.',
      );
    });
    expect(onMountChange).toHaveBeenCalledTimes(1);

    await unmount(mounted);
    mounted = null;

    expect(onMountChange).toHaveBeenCalledTimes(2);
    expect(onMountChange).toHaveBeenLastCalledWith(false);
  });

  it('mounts and unmounts cleanly when onMountChange is omitted', async () => {
    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:optional-book',
        bookId: 'book-3',
        title: 'Optional Callback Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(openSessionMock).toHaveBeenCalledOnce();
    });

    await unmount(mounted);
    mounted = null;
    expect(destroySessionMock).toHaveBeenCalledOnce();
  });

  it('preserves selection and note drafts across close, navigation, and resize/reflow while clearing unedited selections on navigation', async () => {
    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:draft-book',
        bookId: 'book-draft',
        title: 'Draft Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(sessionState.callbacks).not.toBeNull();
    });

    const shell = target.querySelector<HTMLElement>('.reader-shell');
    expect(shell?.style.getPropertyValue('--reader-margin')).toBe('24px');

    sessionState.callbacks!.onLocation(makeLocation(), 'restore');
    sessionState.callbacks!.onSelection?.({
      cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:14)',
      text: 'Selected passage',
    });
    flushSync();

    expect(target.querySelector('.reader-selection-banner')).not.toBeNull();

    // Without a draft, navigation clears selectedText.
    sessionState.callbacks!.onLocation(
      makeLocation({ cfi: 'epubcfi(/6/2!/4/4/1:0)', pageIndex: 1 }),
      'navigation',
    );
    flushSync();
    expect(target.querySelector('.reader-selection-banner')).toBeNull();

    // Open Notes with an active selection and verify restore/resize reflow while open keeps it.
    sessionState.callbacks!.onSelection?.({
      cfi: 'epubcfi(/6/2!/4/4,/1:0,/1:18)',
      text: 'Guarded quote',
    });
    flushSync();
    target.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')?.click();
    flushSync();
    target.querySelector<HTMLButtonElement>('[aria-controls="reader-annotations"]')?.click();
    flushSync();

    expect(target.querySelector('#reader-annotations')?.textContent).toContain('Guarded quote');

    // Simulate soft-keyboard / viewport resize reflow before typing a draft.
    sessionState.callbacks!.onSelection?.(null);
    sessionState.callbacks!.onLocation(
      makeLocation({ cfi: 'epubcfi(/6/2!/4/4/1:6)', pageIndex: 1 }),
      'restore',
    );
    flushSync();
    expect(target.querySelector('#reader-annotations')?.textContent).toContain('Guarded quote');

    // Type a selection note draft; closing, resizing/reflowing, and navigating must preserve both.
    const draftTextarea = target.querySelector<HTMLTextAreaElement>(
      '#reader-annotations textarea',
    )!;
    draftTextarea.value = 'In-progress selection note';
    draftTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    target.querySelector<HTMLButtonElement>('[aria-label="Close highlights and notes"]')?.click();
    flushSync();

    expect(target.querySelector('#reader-annotations')).toBeNull();
    expect(target.querySelector('.reader-selection-banner')).not.toBeNull();

    // Simulate margin slider / viewport resize reflow + navigation while panel is closed.
    sessionState.callbacks!.onSelection?.(null);
    sessionState.callbacks!.onLocation(
      makeLocation({ cfi: 'epubcfi(/6/2!/4/6/1:0)', percentage: 0.5 }),
      'restore',
    );
    sessionState.callbacks!.onLocation(
      makeLocation({ cfi: 'epubcfi(/6/4!/4/2/1:0)', href: 'chapter-2.xhtml', percentage: 0.6 }),
      'navigation',
    );
    flushSync();

    expect(target.querySelector('.reader-selection-banner')).not.toBeNull();

    // Reopen Notes and confirm both selectedText and annotationDraft survived.
    target.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')?.click();
    flushSync();
    target.querySelector<HTMLButtonElement>('[aria-controls="reader-annotations"]')?.click();
    flushSync();

    expect(target.querySelector('#reader-annotations')?.textContent).toContain('Guarded quote');
    expect(target.querySelector<HTMLTextAreaElement>('#reader-annotations textarea')?.value).toBe(
      'In-progress selection note',
    );
  });

  it('caps bookmarks at MAX_BOOKMARKS with an alert and allows adding after deleting one', async () => {
    const fullBookmarks: StoredReaderLocation[] = Array.from(
      { length: MAX_BOOKMARKS },
      (_, index) => ({
        id: `epubcfi(/6/2!/4/${index + 1})|chapter-1.xhtml`,
        cfi: `epubcfi(/6/2!/4/${index + 1})`,
        href: 'chapter-1.xhtml',
        percentage: 0.1,
        label: `Bookmark ${index + 1}`,
        savedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    getPreferencesMock.mockResolvedValueOnce(
      new Map([[`readerBookmarks:book-bm`, JSON.stringify(fullBookmarks)]]),
    );

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:bm-book',
        bookId: 'book-bm',
        title: 'Bookmark Cap Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(sessionState.callbacks).not.toBeNull();
    });

    sessionState.callbacks!.onLocation(
      makeLocation({ cfi: 'epubcfi(/6/9!/4/2/1:0)', href: 'overflow.xhtml' }),
      'restore',
    );
    flushSync();

    target.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')?.click();
    flushSync();
    target.querySelector<HTMLButtonElement>('[aria-controls="reader-bookmarks"]')?.click();
    flushSync();

    setPreferencesMock.mockClear();
    target.querySelector<HTMLButtonElement>('[data-reader-focus="bookmark-current"]')?.click();
    flushSync();

    expect(target.querySelector('#reader-bookmarks [role="alert"]')?.textContent).toContain(
      `You can save up to ${MAX_BOOKMARKS} bookmarks per book.`,
    );
    expect(setPreferencesMock).not.toHaveBeenCalled();

    // Deleting a bookmark clears the limit message and frees a slot.
    target.querySelector<HTMLButtonElement>('[aria-label="Delete Bookmark 1"]')?.click();
    flushSync();
    expect(target.querySelector('#reader-bookmarks [role="alert"]')).toBeNull();

    target.querySelector<HTMLButtonElement>('[data-reader-focus="bookmark-current"]')?.click();
    flushSync();

    expect(target.querySelector('#reader-bookmarks [role="alert"]')).toBeNull();
    expect(
      target.querySelector<HTMLButtonElement>('[data-reader-focus="bookmark-current"]')
        ?.textContent,
    ).toContain('Remove bookmark at this page');
  });

  it('caps annotations at MAX_ANNOTATIONS, retains annotationDrafts across navigation and reflow, and updates --reader-margin', async () => {
    const fullAnnotations: StoredAnnotation[] = Array.from(
      { length: MAX_ANNOTATIONS },
      (_, index) => ({
        id: `2026:epubcfi(/6/2!/4/${index + 1})`,
        cfi: `epubcfi(/6/2!/4/${index + 1})`,
        excerpt: `Saved quote ${index + 1}`,
        note: `Saved note ${index + 1}`,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    getPreferencesMock.mockResolvedValueOnce(
      new Map([[`readerAnnotations:book-ann`, JSON.stringify(fullAnnotations)]]),
    );

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:ann-book',
        bookId: 'book-ann',
        title: 'Annotation Cap Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(sessionState.callbacks).not.toBeNull();
    });

    sessionState.callbacks!.onLocation(makeLocation(), 'restore');
    sessionState.callbacks!.onSelection?.({
      cfi: 'epubcfi(/6/9!/4/2,/1:0,/1:10)',
      text: 'Overflow highlight',
    });
    flushSync();

    setPreferencesMock.mockClear();
    const bannerButtons = Array.from(
      target.querySelectorAll<HTMLButtonElement>('.reader-selection-banner button'),
    );
    const highlightBtn = bannerButtons.find((btn) => btn.textContent?.trim() === 'Highlight')!;
    highlightBtn.click();
    flushSync();

    // Opens annotations panel with limit alert without falsely reporting or persisting a save.
    expect(target.querySelector('#reader-annotations')).not.toBeNull();
    expect(target.querySelector('#reader-annotations [role="alert"]')?.textContent).toContain(
      `You can save up to ${MAX_ANNOTATIONS} highlights per book.`,
    );
    expect(setPreferencesMock).not.toHaveBeenCalled();

    // Start editing an existing highlight's note and verify annotationDrafts survives close, margin slider change, and navigation.
    target.querySelector<HTMLButtonElement>('[aria-label="Edit note for Saved quote 1"]')?.click();
    flushSync();
    const noteEditor = target.querySelector<HTMLTextAreaElement>(
      '[data-reader-focus="annotation-editor"]',
    )!;
    noteEditor.value = 'Edited note surviving reflow';
    noteEditor.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    // Switch to Reading appearance and change Page margins -> updates --reader-margin.
    target.querySelector<HTMLButtonElement>('[aria-controls="reader-appearance"]')?.click();
    flushSync();
    const marginInput = target.querySelector<HTMLInputElement>('[aria-label="Page margins"]')!;
    marginInput.value = '48';
    marginInput.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    const shell = target.querySelector<HTMLElement>('.reader-shell')!;
    expect(shell.style.getPropertyValue('--reader-margin')).toBe('48px');

    // Simulate viewport resize reflow + page navigation while note edit is in progress.
    sessionState.callbacks!.onLocation(
      makeLocation({ cfi: 'epubcfi(/6/2!/4/8/1:0)', pageIndex: 1 }),
      'restore',
    );
    sessionState.callbacks!.onLocation(
      makeLocation({ cfi: 'epubcfi(/6/4!/4/2/1:0)', href: 'chapter-2.xhtml' }),
      'navigation',
    );
    flushSync();

    // Reopen Notes: in-progress note edit in annotationDrafts is still intact!
    target.querySelector<HTMLButtonElement>('[aria-controls="reader-annotations"]')?.click();
    flushSync();
    expect(
      target.querySelector<HTMLTextAreaElement>('[data-reader-focus="annotation-editor"]')?.value,
    ).toBe('Edited note surviving reflow');

    // Delete one highlight to free a slot, then save a new highlight.
    target
      .querySelector<HTMLButtonElement>('[aria-label="Delete highlight Saved quote 2"]')
      ?.click();
    flushSync();

    sessionState.callbacks!.onSelection?.({
      cfi: 'epubcfi(/6/9!/4/2,/1:0,/1:10)',
      text: 'Overflow highlight',
    });
    flushSync();
    target
      .querySelector<HTMLFormElement>('#reader-annotations form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    flushSync();

    expect(target.querySelector('#reader-annotations [role="alert"]')).toBeNull();
    expect(target.querySelector('#reader-annotations')?.textContent).toContain('Highlight saved.');
  });
});
