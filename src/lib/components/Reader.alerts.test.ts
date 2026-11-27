// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '../reader/session';
import type {
  ReaderInspectorCallbacks,
  ReaderLinkReturnTarget,
  ReaderLocation,
  ReaderLocationOrigin,
  ReaderSelection,
  TocItem,
} from '../reader/session';

const mocks = vi.hoisted(() => {
  type OpenHandlers = {
    onRelocated: (
      location: ReaderLocation,
      origin: ReaderLocationOrigin,
      returnTarget?: ReaderLinkReturnTarget,
    ) => void;
    onZoneTap: (zone: 'previous' | 'center' | 'next') => void;
    onSelection: (selection: ReaderSelection | null) => void;
    onKeydown: (event: KeyboardEvent) => void;
    inspectors: ReaderInspectorCallbacks;
  };

  let latestHandlers: OpenHandlers | null = null;
  const openImpl = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const nextImpl = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const previousImpl = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const displayImpl = vi.fn<(target?: string) => Promise<void>>(() => Promise.resolve());
  const displayCfiImpl = vi.fn<(cfi: string) => Promise<boolean>>(() => Promise.resolve(true));
  const displayServerLocationImpl = vi.fn<(xpath: string) => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  const displayServerPercentageImpl = vi.fn<(pct: number) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const getPreferencesMock = vi.fn<(keys: string[]) => Promise<Map<string, string>>>(() =>
    Promise.resolve(new Map()),
  );
  const setPreferencesMock = vi.fn<(entries: ReadonlyMap<string, string>) => Promise<void>>(() =>
    Promise.resolve(),
  );

  class MockReaderSession {
    open = vi.fn(
      async (
        _container: HTMLElement,
        _initialCfi: string | null,
        _initialXPath: string | null,
        _initialPercentage: number | null,
        _appearance: unknown,
        onRelocated: OpenHandlers['onRelocated'],
        onZoneTap: OpenHandlers['onZoneTap'],
        onSelection: OpenHandlers['onSelection'],
        onKeydown: OpenHandlers['onKeydown'],
        inspectors: ReaderInspectorCallbacks = {},
      ) => {
        latestHandlers = { onRelocated, onZoneTap, onSelection, onKeydown, inspectors };
        await openImpl();
      },
    );
    destroy = vi.fn();
    next = () => nextImpl();
    previous = () => previousImpl();
    display = (target?: string) => displayImpl(target);
    displayCfi = (cfi: string) => displayCfiImpl(cfi);
    displayServerLocation = (xpath: string) => displayServerLocationImpl(xpath);
    displayServerPercentage = (pct: number) => displayServerPercentageImpl(pct);
    applyAppearance = vi.fn();
    updateHighlights = vi.fn();
    clearTextSelection = vi.fn();
    getVisiblePassages = vi.fn<() => ReaderSelection[]>(() => []);
    tableOfContents = vi.fn<() => TocItem[]>(() => [
      { label: 'Chapter 1', href: 'ch1.xhtml', children: [] },
    ]);
    search = vi.fn(() => Promise.resolve([]));
  }

  return {
    MockReaderSession,
    openImpl,
    nextImpl,
    previousImpl,
    displayImpl,
    displayCfiImpl,
    displayServerLocationImpl,
    displayServerPercentageImpl,
    getPreferencesMock,
    setPreferencesMock,
    getHandlers: () => latestHandlers,
    resetHandlers: () => {
      latestHandlers = null;
    },
  };
});

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    ReaderSession: mocks.MockReaderSession,
  };
});

vi.mock('../database/database', () => ({
  getPreferences: mocks.getPreferencesMock,
  setPreferences: mocks.setPreferencesMock,
}));

import Reader from './Reader.svelte';

if (typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = function animateStub() {
    let canceled = false;
    let finishHandler: ((event: AnimationPlaybackEvent) => void) | null = null;
    const animation = {
      currentTime: 0,
      cancel() {
        canceled = true;
      },
      finish() {
        if (!canceled) finishHandler?.(new Event('finish') as AnimationPlaybackEvent);
      },
      get onfinish() {
        return finishHandler;
      },
      set onfinish(handler: ((event: AnimationPlaybackEvent) => void) | null) {
        finishHandler = handler;
        if (handler) {
          queueMicrotask(() => {
            if (!canceled && finishHandler === handler) {
              handler(new Event('finish') as AnimationPlaybackEvent);
            }
          });
        }
      },
    };
    return animation as unknown as Animation;
  };
}

function isMarkedInert(element: Element | null): boolean {
  if (!element) return false;
  return element.hasAttribute('inert') || Boolean((element as HTMLElement).inert);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
  await tick();
  flushSync();
}

describe('Reader alert modals and focus containment', () => {
  let target: HTMLDivElement;
  let mounted: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.resetHandlers();
    mocks.openImpl.mockReset().mockResolvedValue(undefined);
    mocks.nextImpl.mockReset().mockResolvedValue(undefined);
    mocks.previousImpl.mockReset().mockResolvedValue(undefined);
    mocks.displayImpl.mockReset().mockResolvedValue(undefined);
    mocks.displayCfiImpl.mockReset().mockResolvedValue(true);
    mocks.displayServerLocationImpl.mockReset().mockResolvedValue(true);
    mocks.displayServerPercentageImpl.mockReset().mockResolvedValue(undefined);
    mocks.getPreferencesMock.mockReset().mockResolvedValue(new Map());
    mocks.setPreferencesMock.mockReset().mockResolvedValue(undefined);

    document.body.innerHTML = '';
    target = document.createElement('div');
    document.body.append(target);
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 844,
    });
  });

  afterEach(() => {
    if (mounted) {
      unmount(mounted);
      mounted = null;
    }
    vi.useRealTimers();
  });

  it('mounts a z-40 sync conflict alertdialog after delayed sync, pauses auto-hide, closes subpanels, and restores focus', async () => {
    let resolveSync!: (value: {
      xpath: string | null;
      percentage: number | null;
      accept: () => Promise<void>;
    }) => void;
    const onSyncLatest = vi.fn(
      () =>
        new Promise<{
          xpath: string | null;
          percentage: number | null;
          accept: () => Promise<void>;
        }>((resolve) => {
          resolveSync = resolve;
        }),
    );

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-1',
        title: 'Test Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onSyncLatest,
      },
    });
    await settle();

    mocks.getHandlers()?.onRelocated(
      {
        cfi: 'epubcfi(/6/2!/4/2)',
        xpath: '/body/DocFragment[1]/body/p[1]',
        href: 'ch1.xhtml',
        percentage: 0.15,
        spineIndex: 0,
        pageIndex: 0,
        pageCount: 4,
      },
      'restore',
    );
    await settle();

    const revealBtn = target.querySelector<HTMLButtonElement>(
      '.reader-top-reveal[aria-label="Show reading controls"]',
    );
    expect(revealBtn).not.toBeNull();
    revealBtn!.focus();
    revealBtn!.click();
    await settle();

    // Open Contents subpanel first, then trigger Sync to verify openSyncConfirmation closes subpanels
    const contentsBtn = target.querySelector<HTMLButtonElement>(
      '[aria-controls="reader-contents"]',
    );
    contentsBtn!.click();
    await settle();
    expect(target.querySelector('#reader-contents')).not.toBeNull();
    const closeContentsBtn = target.querySelector<HTMLButtonElement>(
      '[aria-label="Close table of contents"]',
    );
    closeContentsBtn!.click();
    await settle();

    const syncBtn = target.querySelector<HTMLButtonElement>(
      '[aria-label="Sync latest reading position"]',
    );
    expect(syncBtn).not.toBeNull();
    syncBtn!.focus();
    syncBtn!.click();
    await settle();

    expect(syncBtn!.disabled).toBe(true);

    // Advance past the 5s chrome auto-hide window while sync is still in flight
    vi.advanceTimersByTime(6_000);
    await settle();
    expect(target.querySelector('.reader-overlay')).not.toBeNull();

    // Also verify that even if controls were hidden before conflict resolution, the z-40 alertdialog still mounts
    resolveSync({
      xpath: '/body/DocFragment[2]/body/p[4]',
      percentage: 0.65,
      accept: vi.fn(() => Promise.resolve()),
    });
    await settle();

    const dialog = target.querySelector<HTMLElement>('[role="alertdialog"][aria-modal="true"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.closest('.z-40')).not.toBeNull();
    expect(dialog!.closest('.reader-overlay')).toBeNull();

    expect(isMarkedInert(target.querySelector('.reader-viewport'))).toBe(true);
    expect(isMarkedInert(target.querySelector('.tap-zones'))).toBe(true);
    expect(isMarkedInert(target.querySelector('.reader-progress-reveal'))).toBe(true);
    expect(isMarkedInert(target.querySelector('.reader-overlay'))).toBe(true);

    const stayButton = Array.from(dialog!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Stay here'),
    );
    expect(document.activeElement).toBe(stayButton);

    stayButton!.click();
    await settle();

    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    expect(syncBtn!.disabled).toBe(false);
    expect(document.activeElement).toBe(syncBtn);

    // Auto-hide timer resumes once confirmation closes
    vi.advanceTimersByTime(5_000);
    await settle();
    expect(target.querySelector('.reader-overlay')).toBeNull();
  });

  it('renders sync conflict alertdialog when controls are hidden and falls back to topRevealButton', async () => {
    let resolveSync!: (value: {
      xpath: string | null;
      percentage: number | null;
      accept: () => Promise<void>;
    }) => void;
    const onSyncLatest = vi.fn(
      () =>
        new Promise<{
          xpath: string | null;
          percentage: number | null;
          accept: () => Promise<void>;
        }>((resolve) => {
          resolveSync = resolve;
        }),
    );

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-1',
        title: 'Test Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onSyncLatest,
      },
    });
    await settle();

    target
      .querySelector<HTMLButtonElement>('.reader-top-reveal[aria-label="Show reading controls"]')!
      .click();
    await settle();

    const syncBtn = target.querySelector<HTMLButtonElement>(
      '[aria-label="Sync latest reading position"]',
    )!;
    syncBtn.focus();
    syncBtn.click();
    await settle();

    // User taps center zone to hide controls before sync resolves
    mocks.getHandlers()?.onZoneTap('center');
    await settle();
    expect(target.querySelector('.reader-overlay')).toBeNull();

    resolveSync({
      xpath: '/body/DocFragment[2]/body/p[2]',
      percentage: 0.5,
      accept: vi.fn(() => Promise.resolve()),
    });
    await settle();

    const dialog = target.querySelector<HTMLElement>('[role="alertdialog"][aria-modal="true"]');
    expect(dialog).not.toBeNull();
    expect(isMarkedInert(target.querySelector('.reader-top-reveal'))).toBe(true);

    dialog!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle();

    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    const topReveal = target.querySelector<HTMLButtonElement>('.reader-top-reveal');
    expect(document.activeElement).toBe(topReveal);
  });

  it('focuses Retry download immediately on startupOpenFailed, traps Tab order, preserves diagnostics on turn, and re-focuses on retry failure', async () => {
    mocks.openImpl.mockRejectedValueOnce(new Error('Invalid zip'));
    let rejectRetry!: (reason?: unknown) => void;
    const onRetryDownload = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRetry = reject;
        }),
    );
    const onBack = vi.fn();
    let backHandler = null as (() => boolean) | null;

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:corrupt-book',
        bookId: 'book-corrupt',
        title: 'Corrupt Book',
        onBack,
        onRelocated: vi.fn(),
        onRetryDownload,
        registerBackHandler: (handler) => {
          backHandler = handler;
          return () => {
            backHandler = null;
          };
        },
      },
    });
    await settle();

    const dialog = target.querySelector<HTMLElement>('[role="alertdialog"][aria-modal="true"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.closest('.z-40')).not.toBeNull();
    expect(dialog!.textContent).toContain(
      'This EPUB could not be opened. The download may be incomplete or corrupted.',
    );

    const buttons = Array.from(dialog!.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Retry download', 'Back']);
    expect(document.activeElement).toBe(buttons[0]);

    expect(isMarkedInert(target.querySelector('.reader-viewport'))).toBe(true);
    expect(isMarkedInert(target.querySelector('.tap-zones'))).toBe(true);
    expect(isMarkedInert(target.querySelector('.reader-top-reveal'))).toBe(true);
    expect(isMarkedInert(target.querySelector('.reader-progress-reveal'))).toBe(true);

    // Tab wraps strictly between Retry download and Back
    buttons[1]!.focus();
    const tabForward = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    dialog!.dispatchEvent(tabForward);
    expect(document.activeElement).toBe(buttons[0]);

    const tabBackward = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    dialog!.dispatchEvent(tabBackward);
    expect(document.activeElement).toBe(buttons[1]);

    // Page navigation keys and tap-zone clicks do not overwrite startupOpenFailed diagnostic text
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    target.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click();
    await settle();
    expect(dialog!.textContent).toContain(
      'This EPUB could not be opened. The download may be incomplete or corrupted.',
    );

    // Trigger Retry download; Escape/Back do not exit while retryingReader is true
    buttons[0]!.click();
    await settle();
    expect(buttons[0]!.disabled).toBe(true);

    dialog!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    backHandler?.();
    expect(onBack).not.toHaveBeenCalled();

    // Retry fails again -> updates error text and restores focus to Retry download
    rejectRetry(new Error('Kavita offline during retry.'));
    await settle();

    expect(dialog!.textContent).toContain('Kavita offline during retry.');
    expect(buttons[0]!.disabled).toBe(false);
    expect(document.activeElement).toBe(buttons[0]);

    // Escape on fatal startup error routes to onBack when not retrying
    dialog!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('Recovers from runtime errors at 320x256 via Dismiss, Escape, and Back while preserving open bookmarks and restoring opener focus', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 320 });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 256,
    });

    const savedBookmarks = JSON.stringify([
      {
        id: 'epubcfi(/6/8!/4/2)|missing.xhtml',
        cfi: 'epubcfi(/6/8!/4/2)',
        href: 'missing.xhtml',
        percentage: 0.8,
        label: 'Missing chapter bookmark',
        savedAt: '2026-11-20T00:00:00.000Z',
      },
    ]);
    mocks.getPreferencesMock.mockResolvedValue(
      new Map([['readerBookmarks:book-runtime', savedBookmarks]]),
    );

    const onBack = vi.fn();
    let backHandler = null as (() => boolean) | null;
    const onSyncLatest = vi.fn(() =>
      Promise.resolve({
        xpath: '/body/DocFragment[3]/body/p[1]',
        percentage: 0.75,
        accept: () => Promise.reject(new Error('Sync position could not load.')),
      }),
    );

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-runtime',
        title: 'Reflow Book',
        onBack,
        onRelocated: vi.fn(),
        onSyncLatest,
        registerBackHandler: (handler) => {
          backHandler = handler;
          return () => {
            backHandler = null;
          };
        },
      },
    });
    await settle();

    // Open Marks (#reader-bookmarks) inside .reader-overlay
    target
      .querySelector<HTMLButtonElement>('.reader-top-reveal[aria-label="Show reading controls"]')!
      .click();
    await settle();
    target.querySelector<HTMLButtonElement>('[aria-controls="reader-bookmarks"]')!.click();
    await settle();

    const bookmarkBtn = target.querySelector<HTMLButtonElement>(
      '[data-reader-focus="bookmark-location"]',
    );
    expect(bookmarkBtn).not.toBeNull();

    mocks.displayCfiImpl.mockRejectedValueOnce(new Error('Missing CFI'));
    bookmarkBtn!.focus();
    bookmarkBtn!.click();
    await settle();

    const errorDialog = target.querySelector<HTMLElement>(
      '[role="alertdialog"][aria-modal="true"]',
    );
    expect(errorDialog).not.toBeNull();
    expect(errorDialog!.closest('.z-40')).not.toBeNull();
    expect(errorDialog!.className).toContain('max-h-[calc(100dvh-2rem)]');
    expect(errorDialog!.className).toContain('overflow-auto');
    expect(errorDialog!.textContent).toContain(
      'This saved location is no longer available in the current EPUB.',
    );

    // .reader-overlay and #reader-bookmarks stay mounted behind the z-40 alertdialog and become inert
    const overlay = target.querySelector('.reader-overlay');
    expect(overlay).not.toBeNull();
    expect(isMarkedInert(overlay)).toBe(true);
    expect(target.querySelector('#reader-bookmarks')).not.toBeNull();

    const dismissBtn = Array.from(errorDialog!.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent?.trim() === 'Dismiss',
    );
    expect(dismissBtn).not.toBeUndefined();
    expect(document.activeElement).toBe(dismissBtn);

    // Dismiss clears runtime error, keeps #reader-bookmarks open, and restores focus to the bookmark button
    dismissBtn!.click();
    await settle();

    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
    expect(target.querySelector('#reader-bookmarks')).not.toBeNull();
    expect(isMarkedInert(target.querySelector('.reader-overlay'))).toBe(false);
    expect(document.activeElement).toBe(bookmarkBtn);

    // Close bookmarks, trigger link jump, and verify Return to link runtime error restores focus on Back
    target.querySelector<HTMLButtonElement>('[aria-label="Close bookmarks and history"]')!.click();
    await settle();

    mocks.getHandlers()?.onRelocated(
      {
        cfi: 'epubcfi(/6/4!/4/2)',
        xpath: '/body/DocFragment[2]/body/p[1]',
        href: 'ch2.xhtml',
        percentage: 0.4,
        spineIndex: 1,
        pageIndex: 0,
        pageCount: 2,
      },
      'link',
      { cfi: 'epubcfi(/6/2!/4/2)', href: 'ch1.xhtml' },
    );
    await settle();

    const returnLinkBtn = target.querySelector<HTMLButtonElement>(
      '[aria-label="Return to the location before this link"]',
    );
    expect(returnLinkBtn).not.toBeNull();
    mocks.displayCfiImpl.mockRejectedValueOnce(new Error('Link target gone'));
    returnLinkBtn!.focus();
    returnLinkBtn!.click();
    await settle();

    expect(target.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'The location before this link is no longer available in the current EPUB.',
    );
    expect(
      target.querySelector('[aria-label="Return to the location before this link"]'),
    ).toBeNull();

    backHandler?.();
    await settle();

    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
    const remountedReturnLinkBtn = target.querySelector<HTMLButtonElement>(
      '[aria-label="Return to the location before this link"]',
    );
    expect(remountedReturnLinkBtn).not.toBeNull();
    expect(document.activeElement).toBe(remountedReturnLinkBtn);

    // Verify failed confirmSyncLocation skips showControls() when controls were hidden
    const syncBtn = target.querySelector<HTMLButtonElement>(
      '[aria-label="Sync latest reading position"]',
    )!;
    syncBtn.focus();
    syncBtn.click();
    await settle();

    // Hide controls before confirming sync location
    mocks.getHandlers()?.onZoneTap('center');
    await settle();
    expect(target.querySelector('.reader-overlay')).toBeNull();

    const confirmBtn = Array.from(
      target.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((btn) => btn.textContent?.includes('Go to latest position'))!;
    confirmBtn.click();
    await settle();

    expect(target.querySelector('.reader-overlay')).toBeNull();
    const syncErrorDialog = target.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(syncErrorDialog?.textContent).toContain('Sync position could not load.');

    syncErrorDialog!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle();

    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    expect(target.querySelector('.reader-overlay')).toBeNull();
    expect(document.activeElement).toBe(target.querySelector('.reader-top-reveal'));
  });

  it('keeps z-40 sync alert focus and inert boundaries intact when an inspector opens and closes while a sync alert is raised', async () => {
    const onSyncLatest = vi.fn(() =>
      Promise.resolve({
        xpath: '/body/DocFragment[2]/body/p[3]',
        percentage: 0.55,
        accept: vi.fn(() => Promise.resolve()),
      }),
    );

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-sync-inspector',
        title: 'Inspector Sync Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onSyncLatest,
      },
    });
    await settle();

    const viewport = target.querySelector<HTMLElement>('.reader-viewport')!;
    const iframe = document.createElement('iframe');
    viewport.append(iframe);
    const childDoc = iframe.contentDocument!;
    const footnoteLink = childDoc.createElement('a');
    footnoteLink.href = '#fn-1';
    childDoc.body.append(footnoteLink);

    // Reveal controls and trigger Sync to raise the z-40 sync conflict alertdialog
    target
      .querySelector<HTMLButtonElement>('.reader-top-reveal[aria-label="Show reading controls"]')!
      .click();
    await settle();

    const syncBtn = target.querySelector<HTMLButtonElement>(
      '[aria-label="Sync latest reading position"]',
    )!;
    syncBtn.focus();
    syncBtn.click();
    await settle();

    const syncDialog = target.querySelector<HTMLElement>(
      '.z-40 [role="alertdialog"][aria-modal="true"]',
    );
    expect(syncDialog).not.toBeNull();
    const stayBtn = Array.from(syncDialog!.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent?.includes('Stay here'),
    )!;
    const goToLatestBtn = Array.from(
      syncDialog!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((btn) => btn.textContent?.includes('Go to latest position'))!;
    expect(document.activeElement).toBe(stayBtn);
    expect(isMarkedInert(viewport)).toBe(true);
    expect(isMarkedInert(target.querySelector('.reader-overlay'))).toBe(true);

    // Move keyboard focus to the second button inside the z-40 sync alertdialog
    goToLatestBtn.focus();
    expect(document.activeElement).toBe(goToLatestBtn);

    // 1. Open and close an inspector (#reader-footnote) WHILE the sync alert remains raised
    mocks.getHandlers()?.inspectors.onFootnote?.(
      {
        title: 'Footnote 1',
        paragraphs: ['Inspector content opened behind active sync alert.'],
      },
      footnoteLink,
    );
    await settle();

    const footnoteDialog = target.querySelector<HTMLElement>('#reader-footnote');
    expect(footnoteDialog).not.toBeNull();
    expect(isMarkedInert(target.querySelector('.reader-overlay'))).toBe(true);
    expect(isMarkedInert(viewport)).toBe(true);
    expect(document.activeElement).toBe(goToLatestBtn);

    // Close the inspector while the sync alert is still raised; active button focus in z-40 alert is preserved
    target.querySelector<HTMLButtonElement>('[aria-label="Close footnote"]')!.click();
    await settle();

    expect(target.querySelector('#reader-footnote')).toBeNull();
    expect(target.querySelector('.z-40 [role="alertdialog"]')).toBe(syncDialog);
    expect(isMarkedInert(viewport)).toBe(true);
    expect(isMarkedInert(target.querySelector('.reader-overlay'))).toBe(true);
    expect(document.activeElement).toBe(goToLatestBtn);
    expect(childDoc.activeElement).not.toBe(footnoteLink);

    // If focus somehow left the alert before closing an inspector, fallback returns focus into the z-40 alert
    mocks.getHandlers()?.inspectors.onFootnote?.(
      {
        title: 'Footnote 1b',
        paragraphs: ['Inspector closed after focus blurred outside alert.'],
      },
      footnoteLink,
    );
    await settle();
    goToLatestBtn.blur();
    target.querySelector<HTMLButtonElement>('[aria-label="Close footnote"]')!.click();
    await settle();
    expect(document.activeElement).toBe(stayBtn);

    // 2. Open an inspector again while sync alert is raised, dismiss sync alert first, then close inspector
    mocks.getHandlers()?.inspectors.onFootnote?.(
      {
        title: 'Footnote 2',
        paragraphs: ['Footnote remaining after sync alert dismissal.'],
      },
      footnoteLink,
    );
    await settle();
    expect(target.querySelector('#reader-footnote')).not.toBeNull();
    expect(document.activeElement).toBe(stayBtn);

    // Dismissing the top-level sync alert un-inerts .reader-overlay and moves focus to #reader-footnote
    stayBtn.click();
    await settle();

    expect(target.querySelector('.z-40 [role="alertdialog"]')).toBeNull();
    expect(target.querySelector('#reader-footnote')).not.toBeNull();
    expect(isMarkedInert(target.querySelector('.reader-overlay'))).toBe(false);
    expect(isMarkedInert(viewport)).toBe(true);
    const closeFootnoteBtn = target.querySelector<HTMLButtonElement>(
      '[aria-label="Close footnote"]',
    )!;
    expect(document.activeElement).toBe(closeFootnoteBtn);

    // Closing #reader-footnote now un-inerts .reader-viewport and restores focus to the iframe opener
    closeFootnoteBtn.click();
    await settle();

    expect(target.querySelector('#reader-footnote')).toBeNull();
    expect(isMarkedInert(viewport)).toBe(false);
    expect(childDoc.activeElement).toBe(footnoteLink);
  });
});
