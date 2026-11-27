// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '../reader/session';
import type {
  ReaderLinkReturnTarget,
  ReaderLocation,
  ReaderLocationOrigin,
  ReaderSelection,
  TocItem,
} from '../reader/session';

const { getPreferencesMock, setPreferencesMock } = vi.hoisted(() => ({
  getPreferencesMock: vi.fn(async () => new Map<string, string>()),
  setPreferencesMock: vi.fn(async () => {}),
}));

const sessionState = vi.hoisted(() => {
  let onLocation:
    | ((
        location: ReaderLocation,
        origin: ReaderLocationOrigin,
        returnTarget?: ReaderLinkReturnTarget,
      ) => void)
    | null = null;
  let onTap: ((zone: 'previous' | 'center' | 'next') => void) | null = null;
  let onSelection: ((selection: ReaderSelection | null) => void) | null = null;
  let onKeyboardNavigation: ((event: KeyboardEvent) => void) | null = null;
  let toc: TocItem[] = [{ label: 'Chapter 1', href: 'ch1.xhtml', children: [] }];

  const defaultOpenImplementation = async (
    _target: HTMLElement,
    _cfi: string | null,
    _xpath: string | null,
    _percentage: number | null,
    _appearance: unknown,
    locationCb: NonNullable<typeof onLocation>,
    tapCb: NonNullable<typeof onTap>,
    selectionCb?: NonNullable<typeof onSelection>,
    keyCb?: NonNullable<typeof onKeyboardNavigation>,
  ) => {
    onLocation = locationCb;
    onTap = tapCb;
    onSelection = selectionCb ?? null;
    onKeyboardNavigation = keyCb ?? null;
    locationCb(
      {
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        xpath: '//body/DocFragment[1]/body/p[1]',
        href: 'ch1.xhtml',
        percentage: 0.25,
        spineIndex: 0,
        pageIndex: 0,
        pageCount: 4,
      },
      'restore',
    );
  };

  const mockSession = {
    open: vi.fn(defaultOpenImplementation),
    next: vi.fn(async () => {}),
    previous: vi.fn(async () => {}),
    display: vi.fn(async (href: string) => {
      onLocation?.(
        {
          cfi: `epubcfi(${href})`,
          xpath: '//body/DocFragment[1]/body/p[2]',
          href,
          percentage: 0.5,
          spineIndex: 0,
          pageIndex: 1,
          pageCount: 4,
        },
        'jump',
      );
    }),
    displayCfi: vi.fn(async (cfi: string) => {
      onLocation?.(
        {
          cfi,
          xpath: '//body/DocFragment[1]/body/p[2]',
          href: 'ch1.xhtml',
          percentage: 0.5,
          spineIndex: 0,
          pageIndex: 1,
          pageCount: 4,
        },
        'jump',
      );
      return true;
    }),
    displayServerLocation: vi.fn(async () => true),
    displayServerPercentage: vi.fn(async () => true),
    tableOfContents: vi.fn(() => toc),
    updateHighlights: vi.fn(),
    getVisiblePassages: vi.fn((): ReaderSelection[] => []),
    clearSelection: vi.fn(),
    clearTextSelection: vi.fn(),
    search: vi.fn(async () => [
      {
        cfi: 'epubcfi(/6/2!/4/2/8:0)',
        excerpt: 'Matching excerpt',
        href: 'ch1.xhtml',
        spineIndex: 0,
      },
    ]),
    applyAppearance: vi.fn(),
    destroy: vi.fn(),
  };

  return {
    mockSession,
    resetOpenImplementation: () => {
      mockSession.open.mockImplementation(defaultOpenImplementation);
    },
    emitLocation: (
      location: ReaderLocation,
      origin: ReaderLocationOrigin,
      returnTarget?: ReaderLinkReturnTarget,
    ) => onLocation?.(location, origin, returnTarget),
    emitTap: (zone: 'previous' | 'center' | 'next') => onTap?.(zone),
    emitSelection: (selection: ReaderSelection | null) => onSelection?.(selection),
    emitIframeKeydown: (event: KeyboardEvent) => onKeyboardNavigation?.(event),
    setToc: (items: TocItem[]) => {
      toc = items;
    },
  };
});

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
    ReaderSession: vi.fn(function () {
      return sessionState.mockSession;
    }),
  };
});

import Reader from './Reader.svelte';

function makeLocation(cfi: string, pageIndex = 1): ReaderLocation {
  return {
    cfi,
    xpath: '//body/DocFragment[1]/body/p[2]',
    href: 'ch1.xhtml',
    percentage: 0.4,
    spineIndex: 0,
    pageIndex,
    pageCount: 4,
  };
}

async function flushReader(): Promise<void> {
  await Promise.resolve();
  await tick();
  await Promise.resolve();
  await tick();
}

describe('Reader overlays, focus, keyboard shortcuts, and Back navigation', () => {
  let host: HTMLDivElement;
  let instance: Record<string, unknown> | null = null;
  let backHandler: (() => boolean) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    backHandler = null;
    host = document.createElement('div');
    document.body.append(host);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(async () => {
    if (instance) {
      await unmount(instance);
      instance = null;
    }
    host.remove();
  });

  async function renderReader(overrides: Record<string, unknown> = {}) {
    const onBack = vi.fn();
    const onRelocated = vi.fn();
    instance = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:book',
        bookId: 'book-1',
        title: 'Test Book',
        onBack,
        onRelocated,
        registerBackHandler: (handler: () => boolean) => {
          backHandler = handler;
          return () => {
            if (backHandler === handler) backHandler = null;
          };
        },
        ...overrides,
      },
    });
    await flushReader();
    return { onBack, onRelocated };
  }

  it('keeps Return to link across page turns without opening chrome and dismisses overlays in Back order', async () => {
    const { onBack } = await renderReader();

    sessionState.emitLocation(makeLocation('footnote-1', 2), 'link', {
      cfi: 'source-cfi',
      href: 'ch1.xhtml',
    });
    await flushReader();

    expect(host.querySelector('[data-controls]')).toBeNull();
    expect(
      host.querySelector('[aria-label="Return to the location before this link"]'),
    ).not.toBeNull();

    // Turning pages inside a multi-page footnote preserves Return to link.
    sessionState.emitLocation(makeLocation('footnote-2', 3), 'navigation');
    await flushReader();
    expect(
      host.querySelector('[aria-label="Return to the location before this link"]'),
    ).not.toBeNull();

    // Activate chrome, a dialog, and a text selection to verify full Back dismissal order.
    host.querySelector<HTMLButtonElement>('.reader-top-reveal')!.click();
    await flushReader();
    host.querySelector<HTMLButtonElement>('[aria-controls="reader-appearance"]')!.click();
    await flushReader();
    sessionState.emitSelection({ cfi: 'sel-cfi', text: 'Selected passage' });
    await flushReader();

    expect(host.querySelector('#reader-appearance')).not.toBeNull();

    // 1. Back dismisses the open dialog first without clearing selectedText or linkReturnTarget.
    expect(backHandler?.()).toBe(true);
    await flushReader();
    expect(host.querySelector('#reader-appearance')).toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Selected text"]')).not.toBeNull();
    expect(host.querySelector('[data-controls]')).not.toBeNull();

    // 2. Back dismisses selectedText and collapses active iframe ranges.
    expect(backHandler?.()).toBe(true);
    await flushReader();
    expect(host.querySelector('[role="group"][aria-label="Selected text"]')).toBeNull();
    expect(sessionState.mockSession.clearSelection).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-controls]')).not.toBeNull();

    // 3. Back dismisses reader chrome without falling through into showControls().
    expect(backHandler?.()).toBe(true);
    await flushReader();
    expect(host.querySelector('[data-controls]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('.reader-top-reveal'));
    expect(
      host.querySelector('[aria-label="Return to the location before this link"]'),
    ).not.toBeNull();

    // 4. Back returns to the saved link origin without reopening chrome or exiting the reader.
    expect(backHandler?.()).toBe(true);
    await flushReader();
    expect(sessionState.mockSession.displayCfi).toHaveBeenCalledWith('source-cfi');
    expect(host.querySelector('[aria-label="Return to the location before this link"]')).toBeNull();
    expect(host.querySelector('[data-controls]')).toBeNull();
    expect(onBack).not.toHaveBeenCalled();

    // 5. Final Back exits the reader.
    expect(backHandler?.()).toBe(true);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('clears Return to link when jumping to contents, bookmarks, search results, highlights, or synced positions', async () => {
    const onSyncLatest = vi.fn(async () => ({
      xpath: '//body/DocFragment[1]/body/p[4]',
      percentage: 0.85,
      accept: vi.fn(async () => {}),
    }));
    await renderReader({ onSyncLatest });

    const setLinkOrigin = async () => {
      sessionState.emitLocation(makeLocation('footnote-cfi'), 'link', {
        cfi: 'origin-cfi',
        href: 'ch1.xhtml',
      });
      await flushReader();
      expect(
        host.querySelector('[aria-label="Return to the location before this link"]'),
      ).not.toBeNull();
    };

    // Jump via Contents
    await setLinkOrigin();
    host.querySelector<HTMLButtonElement>('.reader-top-reveal')!.click();
    await flushReader();
    host.querySelector<HTMLButtonElement>('[aria-controls="reader-contents"]')!.click();
    await flushReader();
    host.querySelector<HTMLButtonElement>('#reader-contents ul button')!.click();
    await flushReader();
    expect(host.querySelector('[aria-label="Return to the location before this link"]')).toBeNull();

    // Jump via Bookmark
    await setLinkOrigin();
    host.querySelector<HTMLButtonElement>('[aria-controls="reader-bookmarks"]')!.click();
    await flushReader();
    host.querySelector<HTMLButtonElement>('[data-reader-focus="bookmark-current"]')!.click();
    await flushReader();
    host.querySelector<HTMLButtonElement>('[data-reader-focus="bookmark-location"]')!.click();
    await flushReader();
    expect(host.querySelector('[aria-label="Return to the location before this link"]')).toBeNull();

    // Jump via Search result
    await setLinkOrigin();
    host.querySelector<HTMLButtonElement>('[aria-controls="reader-search"]')!.click();
    await flushReader();
    const searchInput = host.querySelector<HTMLInputElement>('#reader-search-query')!;
    searchInput.value = 'Matching';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    host
      .querySelector<HTMLFormElement>('#reader-search form')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await flushReader();
    host.querySelector<HTMLButtonElement>('[aria-label="Search results"] button')!.click();
    await flushReader();
    expect(host.querySelector('[aria-label="Return to the location before this link"]')).toBeNull();

    // Jump via Saved highlight
    sessionState.emitSelection({ cfi: 'hl-cfi', text: 'Saved highlight text' });
    await flushReader();
    const highlightBtn = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Selected text"] button'),
    ).find((btn) => btn.textContent?.trim() === 'Highlight')!;
    highlightBtn.click();
    await flushReader();
    await setLinkOrigin();
    host.querySelector<HTMLButtonElement>('[aria-controls="reader-annotations"]')!.click();
    await flushReader();
    host.querySelector<HTMLButtonElement>('#reader-annotations article > button')!.click();
    await flushReader();
    expect(host.querySelector('[aria-label="Return to the location before this link"]')).toBeNull();

    // Jump via Synced position
    await setLinkOrigin();
    host.querySelector<HTMLButtonElement>('[aria-label="Sync latest reading position"]')!.click();
    await flushReader();
    const goLatest = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((btn) => btn.textContent?.includes('Go to latest position'))!;
    goLatest.click();
    await flushReader();
    expect(host.querySelector('[aria-label="Return to the location before this link"]')).toBeNull();
  });

  it('closes only the active panel on Escape without wiping selectedText, then dismisses selectedText and chrome', async () => {
    await renderReader();

    sessionState.emitSelection({ cfi: 'sel-cfi', text: 'Keep selection' });
    await flushReader();

    host.querySelector<HTMLButtonElement>('.reader-top-reveal')!.click();
    await flushReader();
    const textButton = host.querySelector<HTMLButtonElement>(
      '[aria-controls="reader-appearance"]',
    )!;
    textButton.focus();
    textButton.click();
    await flushReader();

    // Dispatch Escape from the EPUB iframe listener (non-modal-trapped path)
    const escapePanel = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    sessionState.emitIframeKeydown(escapePanel);
    await flushReader();

    expect(escapePanel.defaultPrevented).toBe(true);
    expect(host.querySelector('#reader-appearance')).toBeNull();
    // closeAnnotations() was NOT called unconditionally, so selectedText stays intact and focus returns to Text
    expect(host.querySelector('[role="group"][aria-label="Selected text"]')).not.toBeNull();
    expect(document.activeElement).toBe(textButton);

    // Pressing Escape on a focused button dismisses selectedText first
    const escapeSelection = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    textButton.dispatchEvent(escapeSelection);
    await flushReader();

    expect(escapeSelection.defaultPrevented).toBe(true);
    expect(host.querySelector('[role="group"][aria-label="Selected text"]')).toBeNull();
    expect(host.querySelector('[data-controls]')).not.toBeNull();

    // Pressing Escape again while focused on a toolbar button dismisses chrome and focuses topRevealButton
    const escapeChrome = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    textButton.dispatchEvent(escapeChrome);
    await flushReader();

    expect(escapeChrome.defaultPrevented).toBe(true);
    expect(host.querySelector('[data-controls]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('.reader-top-reveal'));
  });

  it('retains focus when unmounting Highlight, Copy text, Return to link, and inline annotation controls', async () => {
    await renderReader();

    // 1. Highlight while controls hidden -> focuses topRevealButton
    sessionState.emitSelection({ cfi: 'cfi-1', text: 'First quote' });
    await flushReader();
    const highlightButton = host.querySelector<HTMLButtonElement>(
      '[role="group"][aria-label="Selected text"] button',
    )!;
    highlightButton.focus();
    highlightButton.click();
    await flushReader();
    expect(document.activeElement).toBe(host.querySelector('.reader-top-reveal'));

    // 2. Copy text while controls visible -> focuses first toolbar control
    host.querySelector<HTMLButtonElement>('.reader-top-reveal')!.click();
    await flushReader();
    sessionState.emitSelection({ cfi: 'cfi-2', text: 'Copied quote' });
    await flushReader();
    const copyButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Selected text"] button'),
    ).find((btn) => btn.textContent?.trim() === 'Copy text')!;
    copyButton.focus();
    copyButton.click();
    await flushReader();
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Back to library"]'));

    // 3. Return to link while controls hidden -> focuses topRevealButton
    backHandler?.(); // hide chrome
    await flushReader();
    sessionState.emitLocation(makeLocation('fn-1'), 'link', {
      cfi: 'back-cfi',
      href: 'ch1.xhtml',
    });
    await flushReader();
    const returnButton = host.querySelector<HTMLButtonElement>(
      '[aria-label="Return to the location before this link"]',
    )!;
    returnButton.focus();
    returnButton.click();
    await flushReader();
    expect(document.activeElement).toBe(host.querySelector('.reader-top-reveal'));

    // 4. Inside #reader-annotations: Cancel and Save highlight preserve focus inside the dialog
    sessionState.emitSelection({ cfi: 'cfi-3', text: 'Annotated quote' });
    await flushReader();
    const addNoteButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Selected text"] button'),
    ).find((btn) => btn.textContent?.trim() === 'Add note')!;
    addNoteButton.click();
    await flushReader();

    const annotationsDialog = host.querySelector<HTMLElement>('#reader-annotations')!;
    const cancelButton = Array.from(
      annotationsDialog.querySelectorAll<HTMLButtonElement>('form button'),
    ).find((btn) => btn.textContent?.trim() === 'Cancel')!;
    cancelButton.focus();
    cancelButton.click();
    await flushReader();

    expect(annotationsDialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);

    // Re-trigger selection while dialog is open and submit Save highlight
    sessionState.emitSelection({ cfi: 'cfi-4', text: 'Second saved quote' });
    await flushReader();
    annotationsDialog
      .querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await flushReader();

    expect(annotationsDialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement)?.getAttribute('aria-label')).toBe(
      'Edit note for Second saved quote',
    );

    // Modal Escape trap still works because focus remained inside #reader-annotations
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await flushReader();
    expect(host.querySelector('#reader-annotations')).toBeNull();
  });

  it('allows arrow and page keys on reader buttons and scopes Space page turns to Next page and prose', async () => {
    await renderReader();

    const prevButton = host.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')!;
    const nextButton = host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!;
    const revealButton = host.querySelector<HTMLButtonElement>('.reader-top-reveal')!;

    prevButton.focus();
    prevButton.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(sessionState.mockSession.next).toHaveBeenCalledTimes(1);

    nextButton.focus();
    nextButton.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }),
    );
    expect(sessionState.mockSession.previous).toHaveBeenCalledTimes(1);

    // Space on Next page turns to next page and prevents duplicate default click
    const spaceOnNext = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    nextButton.dispatchEvent(spaceOnNext);
    expect(spaceOnNext.defaultPrevented).toBe(true);
    expect(sessionState.mockSession.next).toHaveBeenCalledTimes(2);

    // Space on Previous page or other reader buttons is NOT intercepted for next-page turns
    const spaceOnPrev = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    prevButton.dispatchEvent(spaceOnPrev);
    expect(spaceOnPrev.defaultPrevented).toBe(false);
    expect(sessionState.mockSession.next).toHaveBeenCalledTimes(2);

    const spaceOnReveal = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    revealButton.dispatchEvent(spaceOnReveal);
    expect(spaceOnReveal.defaultPrevented).toBe(false);
    expect(sessionState.mockSession.next).toHaveBeenCalledTimes(2);

    // Shift+Arrow selection keys do not turn pages
    const shiftRight = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    sessionState.emitIframeKeydown(shiftRight);
    expect(shiftRight.defaultPrevented).toBe(false);
    expect(sessionState.mockSession.next).toHaveBeenCalledTimes(2);
  });

  it('retains modal focus when saving a visible page passage without an active text selection', async () => {
    sessionState.mockSession.getVisiblePassages.mockReturnValueOnce([
      { cfi: 'epubcfi(/6/2!/4/2/2:0)', text: 'Keyboard-selected visible passage' },
    ]);
    await renderReader();

    host.querySelector<HTMLButtonElement>('.reader-top-reveal')!.click();
    await flushReader();
    host.querySelector<HTMLButtonElement>('[aria-controls="reader-annotations"]')!.click();
    await flushReader();

    const annotationsDialog = host.querySelector<HTMLElement>('#reader-annotations')!;
    expect(
      annotationsDialog.querySelector('select[aria-label="Passage on this page"]'),
    ).not.toBeNull();

    annotationsDialog
      .querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await flushReader();

    expect(annotationsDialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement)?.getAttribute('aria-label')).toBe(
      'Edit note for Keyboard-selected visible passage',
    );
  });

  it('stacks bottom overlays in one container above reading progress and lifts above footer details', async () => {
    const onSyncLatest = vi.fn(async () => null);
    await renderReader({ onSyncLatest });

    host.querySelector<HTMLButtonElement>('.reader-top-reveal')!.click();
    await flushReader();
    host.querySelector<HTMLButtonElement>('[aria-label="Sync latest reading position"]')!.click();
    await flushReader();

    sessionState.emitLocation(makeLocation('fn-stack'), 'link', {
      cfi: 'origin-stack',
      href: 'ch1.xhtml',
    });
    sessionState.emitSelection({ cfi: 'sel-stack', text: 'Stacked selection' });
    await flushReader();

    const container = host.querySelector<HTMLElement>('.reader-bottom-overlays');
    expect(container).not.toBeNull();
    expect(container!.classList.contains('reader-bottom-overlays-lifted')).toBe(false);
    expect(container!.querySelector('[role="status"]')?.textContent).toContain(
      'Reading progress synced.',
    );
    expect(container!.querySelector('[role="group"][aria-label="Selected text"]')).not.toBeNull();
    expect(
      container!.querySelector('[aria-label="Return to the location before this link"]'),
    ).not.toBeNull();

    // Revealing the footer lifts the bottom overlay container above .reader-bottom
    host.querySelector<HTMLButtonElement>('.reader-progress-reveal')!.click();
    await flushReader();
    expect(host.querySelector('.reader-bottom')).not.toBeNull();
    expect(container!.classList.contains('reader-bottom-overlays-lifted')).toBe(true);
  });
});

describe('Reader mount lifecycle', () => {
  let target: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;
  const openSessionMock = sessionState.mockSession.open;
  const destroySessionMock = sessionState.mockSession.destroy;

  beforeEach(() => {
    vi.clearAllMocks();
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
    sessionState.resetOpenImplementation();
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
      expect(target.querySelector('[role="alertdialog"]')?.textContent).toContain(
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
});
