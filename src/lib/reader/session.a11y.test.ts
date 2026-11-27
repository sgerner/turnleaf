// @vitest-environment jsdom

import type { Contents, Location } from 'epubjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

const { mockBook, mockRendition, resetManager } = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  const createContainer = () => {
    const el = {
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 900,
      clientWidth: 300,
    };
    return el;
  };

  const manager = {
    _onScroll: () => {},
    afterScrolled: undefined as ReturnType<typeof setTimeout> | undefined,
    container: createContainer() as unknown as HTMLElement,
    ignore: false,
    isPaginated: true,
    scrollLeft: 0,
    layout: { delta: 300, pageWidth: 300, width: 300 },
    scrollTo: vi.fn((x: number, _y: number, silent?: boolean) => {
      if (silent) manager.ignore = true;
      manager.container.scrollLeft = x;
      manager.scrollLeft = x;
    }),
    on: vi.fn((event: string, cb: () => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, cb: () => void) => {
      listeners.get(event)?.delete(cb);
    }),
    emitScroll: () => {
      for (const cb of listeners.get('scroll') ?? []) cb();
    },
  };

  const rendition = {
    manager,
    location: undefined as Location | undefined,
    hooks: {
      content: { register: vi.fn() },
      unloaded: { register: vi.fn() },
    },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    reportLocation: vi.fn(async () => {}),
    getContents: vi.fn(() => []),
    resize: vi.fn(),
    destroy: vi.fn(),
  };

  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine: {
      each: vi.fn((visit: (section: { href: string; index: number }) => void) => {
        visit({ href: 'chapter-1.xhtml', index: 0 });
        visit({ href: 'chapter-2.xhtml', index: 1 });
      }),
    },
    navigation: { toc: [] },
  };

  const resetManager = () => {
    listeners.clear();
    if (manager.afterScrolled !== undefined) {
      clearTimeout(manager.afterScrolled);
      manager.afterScrolled = undefined;
    }
    manager._onScroll = () => {};
    manager.container = createContainer() as unknown as HTMLElement;
    manager.ignore = false;
    manager.isPaginated = true;
    manager.scrollLeft = 0;
    manager.layout = { delta: 300, pageWidth: 300, width: 300 };
    rendition.location = undefined;
  };

  return { mockBook: book, mockRendition: rendition, resetManager };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => mockBook) }));

import { ReaderSession } from './session';

function makeLocation(cfi: string, page = 1, href = 'chapter-1.xhtml', index = 0): Location {
  return {
    start: {
      cfi,
      href,
      index,
      percentage: (page - 1) / 3,
      displayed: { page, total: 3 },
    },
  } as Location;
}

describe('ReaderSession accessibility and paginated scroll relocations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetManager();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets the book title on the EPUB iframe and guards mocked Contents without frameElement', async () => {
    const session = new ReaderSession('book.epub', 'The Left Hand of Darkness');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    const contentHook = mockRendition.hooks.content.register.mock.calls[0]?.[0] as (
      contents: Contents,
    ) => Promise<void>;
    const frame = document.createElement('iframe');
    const doc = new DOMParser().parseFromString(
      '<html><body><p>One</p></body></html>',
      'text/html',
    );

    await contentHook({
      document: doc,
      window: { frameElement: frame },
    } as unknown as Contents);
    expect(frame.getAttribute('title')).toBe('The Left Hand of Darkness');

    await expect(
      contentHook({
        document: doc,
        window: { frameElement: null },
      } as unknown as Contents),
    ).resolves.toBeUndefined();

    await expect(
      contentHook({
        document: doc,
      } as unknown as Contents),
    ).resolves.toBeUndefined();

    session.destroy();

    const fallbackSession = new ReaderSession('book.epub', '   ');
    await fallbackSession.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );
    const fallbackHook = mockRendition.hooks.content.register.mock.calls.at(-1)?.[0] as (
      contents: Contents,
    ) => Promise<void>;
    const unnamedFrame = document.createElement('iframe');
    await fallbackHook({
      document: doc,
      window: { frameElement: unnamedFrame },
    } as unknown as Contents);
    expect(unnamedFrame.getAttribute('title')).toBe('Book content');
    fallbackSession.destroy();
  });

  it('aligns columns and reports navigation for un-ignored TalkBack container scrolls', async () => {
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub', 'Sample Book');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );

    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as (
      loc: Location,
    ) => void;

    // Simulate EPUB.js leaving manager.ignore = true after a no-op scrollTo(0, 0, true) on open.
    mockRendition.manager.ignore = true;
    relocated(makeLocation('cfi-page-1', 1));
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'cfi-page-1', pageIndex: 0 }),
      'restore',
    );
    expect(mockRendition.manager.ignore).toBe(false);

    // Forward TalkBack partial scroll into column 2 (e.g. minimal scrollIntoView to 120px).
    mockRendition.manager.container.scrollLeft = 120;
    mockRendition.manager.emitScroll();

    expect(mockRendition.manager.scrollTo).toHaveBeenLastCalledWith(300, 0, true);
    expect(mockRendition.manager.container.scrollLeft).toBe(300);

    relocated(makeLocation('cfi-page-2', 2));
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'cfi-page-2', pageIndex: 1 }),
      'navigation',
    );
    // manager.ignore stays true until the pending async DOM scroll event for 300px fires.
    expect(mockRendition.manager.ignore).toBe(true);

    // An echo scroll at the already-aligned 300px offset must not re-arm navigation or emit twice.
    onLocation.mockClear();
    mockRendition.manager.emitScroll();
    relocated(makeLocation('cfi-page-2', 2));
    expect(onLocation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cfi: 'cfi-page-2', pageIndex: 1 }),
      'restore',
    );

    // Forward scroll to column 3, then backward TalkBack partial scroll into column 2 (e.g. 540px).
    mockRendition.manager.container.scrollLeft = 600;
    mockRendition.manager.emitScroll();
    relocated(makeLocation('cfi-page-3', 3));
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'cfi-page-3', pageIndex: 2 }),
      'navigation',
    );

    mockRendition.manager.container.scrollLeft = 540;
    mockRendition.manager.emitScroll();
    expect(mockRendition.manager.container.scrollLeft).toBe(300);
    relocated(makeLocation('cfi-page-2', 2));
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'cfi-page-2', pageIndex: 1 }),
      'navigation',
    );

    session.destroy();
    expect(mockRendition.manager.off).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('aligns columns and reports navigation when focusin moves across paginated columns', async () => {
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub', 'Sample Book');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );

    const contentHook = mockRendition.hooks.content.register.mock.calls[0]?.[0] as (
      contents: Contents,
    ) => Promise<void>;
    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as (
      loc: Location,
    ) => void;
    const click = mockRendition.on.mock.calls.find(([name]) => name === 'click')?.[1] as (
      event: unknown,
      contents: unknown,
    ) => void;

    const doc = new DOMParser().parseFromString(
      '<html><body><p>First</p><a id="col3-link" href="#note">Note</a></body></html>',
      'text/html',
    );
    await contentHook({
      document: doc,
      window: { frameElement: document.createElement('iframe') },
    } as unknown as Contents);

    relocated(makeLocation('cfi-col-1', 1));

    const link = doc.querySelector<HTMLAnchorElement>('#col3-link')!;
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(new DOMRect(624, 20, 80, 20));
    link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(mockRendition.manager.container.scrollLeft).toBe(600);
    expect(mockRendition.reportLocation).toHaveBeenCalledOnce();

    relocated(makeLocation('cfi-col-3', 3));
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'cfi-col-3', pageIndex: 2 }),
      'navigation',
    );

    // Focusing body must not snap scrollLeft back to column 0.
    doc.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(mockRendition.manager.container.scrollLeft).toBe(600);

    // Clicking an internal link still reports 'link' with returnTarget rather than 'navigation'.
    click(
      { target: link, clientX: 640 },
      { window: { getSelection: () => ({ isCollapsed: true }) } },
    );
    relocated(makeLocation('cfi-footnote', 1, 'chapter-2.xhtml', 1));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('link');
    expect(onLocation.mock.calls.at(-1)?.[2]).toEqual({
      cfi: 'cfi-col-3',
      href: 'chapter-1.xhtml',
    });

    session.destroy();
  });

  it('keeps restore origin for server syncs, viewport resizes, and appearance reflows', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub', 'Sample Book');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );

    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as (
      loc: Location,
    ) => void;
    relocated(makeLocation('cfi-initial', 1));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    await session.displayServerPercentage(0.6);
    relocated(makeLocation('cfi-server', 1, 'chapter-2.xhtml', 1));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    await session.displayServerLocation('//body/DocFragment[1]/body/p[1]');
    relocated(makeLocation('cfi-server-xpath', 1, 'chapter-1.xhtml', 0));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    resizeCallbacks[0]?.(
      [{ contentRect: { width: 360, height: 640 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    relocated(makeLocation('cfi-resized', 2, 'chapter-2.xhtml', 1));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    session.applyAppearance({ ...defaultAppearance, fontSize: defaultAppearance.fontSize + 4 });
    relocated(makeLocation('cfi-reflowed', 3, 'chapter-2.xhtml', 1));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    session.destroy();
  });

  it('tracks capture-phase container scroll events when a rendition has no manager emitter', async () => {
    (mockRendition.manager as { _onScroll?: (() => void) | undefined })._onScroll = undefined;
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    const container = document.createElement('div');
    Object.defineProperty(container, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(container, 'clientWidth', { value: 300, configurable: true });
    viewport.append(container);
    mockRendition.manager.container = container;

    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub', 'Sample Book');
    await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());
    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as (
      loc: Location,
    ) => void;

    relocated(makeLocation('cfi-1', 1));

    // Ignored scroll must stay 'restore'.
    mockRendition.manager.ignore = true;
    container.scrollLeft = 300;
    container.dispatchEvent(new Event('scroll'));
    relocated(makeLocation('cfi-ignored', 2));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    // Un-ignored scroll snaps to next column and reports 'navigation'.
    container.scrollLeft = 420;
    container.dispatchEvent(new Event('scroll'));
    expect(container.scrollLeft).toBe(600);
    relocated(makeLocation('cfi-3', 3));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('navigation');

    session.destroy();
  });

  it('emits exactly one navigation update per assistive column move under DefaultViewManager scroll timers', async () => {
    vi.useFakeTimers();
    try {
      const viewport = document.createElement('div');
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
      const container = document.createElement('div');
      container.className = 'epub-container';
      Object.defineProperty(container, 'scrollWidth', { value: 1200, configurable: true });
      Object.defineProperty(container, 'clientWidth', { value: 300, configurable: true });
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
      const frame = document.createElement('iframe');
      const frameRect = vi
        .spyOn(frame, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(-300, 0, 1200, 500));
      container.append(frame);
      viewport.append(container);

      mockRendition.manager.container = container;

      // Mirror EPUB.js DefaultViewManager.scrollTo + onScroll + 20ms afterScrolled -> reportLocation.
      const pendingEchoScrolls: number[] = [];
      mockRendition.manager.scrollTo.mockImplementation(
        (x: number, _y: number, silent?: boolean) => {
          const changed = container.scrollLeft !== x;
          if (silent) mockRendition.manager.ignore = true;
          container.scrollLeft = x;
          mockRendition.manager.scrollLeft = x;
          if (changed) pendingEchoScrolls.push(x);
        },
      );
      const flushDomScrolls = () => {
        while (pendingEchoScrolls.length > 0) {
          pendingEchoScrolls.shift();
          container.dispatchEvent(new Event('scroll'));
        }
      };
      container.addEventListener('scroll', () => {
        mockRendition.manager.scrollLeft = container.scrollLeft;
        if (!mockRendition.manager.ignore) {
          mockRendition.manager.emitScroll();
          if (mockRendition.manager.afterScrolled !== undefined) {
            clearTimeout(mockRendition.manager.afterScrolled);
          }
          mockRendition.manager.afterScrolled = setTimeout(() => {
            mockRendition.manager.afterScrolled = undefined;
            void mockRendition.reportLocation();
          }, 20);
        } else {
          mockRendition.manager.ignore = false;
        }
      });

      const onLocation = vi.fn();
      const session = new ReaderSession('book.epub', 'Sample Book');
      await session.open(viewport, 'cfi-col-2', null, null, defaultAppearance, onLocation, vi.fn());
      const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as (
        loc: Location,
      ) => void;
      mockRendition.reportLocation.mockImplementation(async () => {
        const page = Math.round(container.scrollLeft / 300) + 1;
        relocated(makeLocation(`cfi-col-${page}`, page));
      });
      const contentHook = mockRendition.hooks.content.register.mock.calls[0]?.[0] as (
        contents: Contents,
      ) => Promise<void>;

      // 1. Initial open to saved page 2 sets scrollTo(300, 0, true) before relocated and before async DOM scroll.
      mockRendition.manager.scrollTo(300, 0, true);
      relocated(makeLocation('cfi-col-2', 2));
      expect(mockRendition.manager.ignore).toBe(true);
      flushDomScrolls();
      vi.advanceTimersByTime(50);

      expect(onLocation).toHaveBeenCalledTimes(1);
      expect(onLocation).toHaveBeenLastCalledWith(
        expect.objectContaining({ cfi: 'cfi-col-2' }),
        'restore',
      );

      // 2. TalkBack un-ignored column swipe (300 -> 420) snaps to 600 and emits exactly one 'navigation'.
      onLocation.mockClear();
      container.scrollLeft = 420;
      container.dispatchEvent(new Event('scroll'));
      expect(container.scrollLeft).toBe(600);
      frameRect.mockReturnValue(new DOMRect(-600, 0, 1200, 500));
      flushDomScrolls();
      await vi.advanceTimersByTimeAsync(50);

      const scrollNavCalls = onLocation.mock.calls.filter(([, origin]) => origin === 'navigation');
      expect(scrollNavCalls).toHaveLength(1);
      expect(scrollNavCalls[0]?.[0]).toEqual(expect.objectContaining({ cfi: 'cfi-col-3' }));

      // 3. Intermediate scroll followed immediately by off-screen link focus cancels stale afterScrolled
      //    and emits exactly one 'navigation' for the link's destination column.
      const doc = document.implementation.createHTMLDocument('chapter');
      const col4Link = doc.createElement('a');
      col4Link.setAttribute('href', '#col4');
      col4Link.textContent = 'Column 4 link';
      vi.spyOn(col4Link, 'getClientRects').mockReturnValue([
        new DOMRect(940, 40, 90, 18),
      ] as unknown as DOMRectList);
      const customFocusable = doc.createElement('span');
      customFocusable.setAttribute('tabindex', '0');
      vi.spyOn(customFocusable, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
      vi.spyOn(customFocusable, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(320, 40, 60, 18),
      );
      doc.body.append(col4Link, customFocusable);

      await contentHook({
        window: { frameElement: frame },
        document: doc,
        sectionIndex: 0,
        cfiFromRange: () => 'cfi-col-4',
      } as unknown as Contents);

      onLocation.mockClear();
      mockRendition.display.mockImplementationOnce(async () => {
        mockRendition.manager.scrollTo(900, 0, true);
        frameRect.mockReturnValue(new DOMRect(-900, 0, 1200, 500));
        relocated(makeLocation('cfi-col-4', 4));
      });

      container.scrollLeft = 520;
      container.dispatchEvent(new Event('scroll'));
      expect(mockRendition.manager.afterScrolled).toBeDefined();

      col4Link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(mockRendition.manager.afterScrolled).toBeUndefined();
      await Promise.resolve();
      await Promise.resolve();
      flushDomScrolls();
      await vi.advanceTimersByTimeAsync(50);

      const offscreenFocusNavCalls = onLocation.mock.calls.filter(
        ([, origin]) => origin === 'navigation',
      );
      expect(offscreenFocusNavCalls).toHaveLength(1);
      expect(offscreenFocusNavCalls[0]?.[0]).toEqual(expect.objectContaining({ cfi: 'cfi-col-4' }));

      // 4. Direct column focus fallback (alignFocusToColumn) cancels any pending timer and emits once.
      onLocation.mockClear();
      (doc as unknown as { createRange?: undefined }).createRange = undefined;
      container.scrollLeft = 780;
      container.dispatchEvent(new Event('scroll'));
      expect(mockRendition.manager.afterScrolled).toBeDefined();

      customFocusable.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(mockRendition.manager.afterScrolled).toBeUndefined();
      expect(container.scrollLeft).toBe(300);
      await Promise.resolve();
      flushDomScrolls();
      await vi.advanceTimersByTimeAsync(50);

      const columnFocusNavCalls = onLocation.mock.calls.filter(
        ([, origin]) => origin === 'navigation',
      );
      expect(columnFocusNavCalls).toHaveLength(1);
      expect(columnFocusNavCalls[0]?.[0]).toEqual(expect.objectContaining({ cfi: 'cfi-col-2' }));

      session.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves link tabindex restoration, Tab-blur selection guard, and unloaded/destroy cleanup', async () => {
    const viewport = document.createElement('div');
    const container = document.createElement('div');
    container.className = 'epub-container';
    const frame = document.createElement('iframe');
    container.append(frame);
    viewport.append(container);
    document.body.append(viewport);
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 400));

    const onSelection = vi.fn();
    const onKeyboardNavigation = vi.fn();
    const session = new ReaderSession('book.epub', 'Cleanup Book');
    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
      onSelection,
      onKeyboardNavigation,
    );

    const primaryHook = mockRendition.hooks.content.register.mock.calls[0]?.[0] as (
      contents: Contents,
    ) => Promise<void>;
    const selectionHook = mockRendition.hooks.content.register.mock.calls[1]?.[0] as (
      contents: Contents,
    ) => void;
    const unloadedHook = mockRendition.hooks.unloaded.register.mock.calls[0]?.[0] as (view: {
      contents?: Contents;
    }) => void;

    const doc = document.implementation.createHTMLDocument('section-1');
    const offscreenLink = doc.createElement('a');
    offscreenLink.setAttribute('href', '#note');
    offscreenLink.setAttribute('tabindex', '0');
    offscreenLink.textContent = 'Offscreen note';
    vi.spyOn(offscreenLink, 'getClientRects').mockReturnValue([
      new DOMRect(640, 30, 80, 18),
    ] as unknown as DOMRectList);
    doc.body.append(offscreenLink);

    let collapsed = false;
    let selectedString = 'Highlighted sentence';
    const winListeners = new Map<string, Set<() => void>>();
    const mockContents = {
      window: {
        frameElement: frame,
        getSelection: () => ({
          isCollapsed: collapsed,
          rangeCount: collapsed ? 0 : 1,
          toString: () => selectedString,
          getRangeAt: () => doc.createRange(),
        }),
        addEventListener: (event: string, cb: () => void) => {
          const set = winListeners.get(event) ?? new Set();
          set.add(cb);
          winListeners.set(event, set);
        },
        removeEventListener: (event: string, cb: () => void) => {
          winListeners.get(event)?.delete(cb);
        },
      },
      document: doc,
      sectionIndex: 0,
      cfiFromRange: () => 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:20)',
    } as unknown as Contents;

    await primaryHook(mockContents);
    selectionHook(mockContents);

    expect(offscreenLink.getAttribute('tabindex')).toBe('-1');
    expect(offscreenLink.getAttribute('data-turnleaf-tabindex')).toBe('0');

    // Selection reported, preserved across Tab-induced window blur, then cleared on non-Tab collapse.
    doc.dispatchEvent(new Event('selectionchange'));
    expect(onSelection).toHaveBeenLastCalledWith({
      cfi: 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:20)',
      text: 'Highlighted sentence',
    });

    onSelection.mockClear();
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    for (const cb of winListeners.get('blur') ?? []) cb();
    collapsed = true;
    selectedString = '';
    doc.dispatchEvent(new Event('selectionchange'));
    expect(onSelection).not.toHaveBeenCalled();

    doc.dispatchEvent(new Event('mousedown'));
    doc.dispatchEvent(new Event('selectionchange'));
    expect(onSelection).toHaveBeenCalledWith(null);

    // Unloading the section restores saved tabindex and detaches focus/selection listeners.
    onSelection.mockClear();
    mockRendition.display.mockClear();
    unloadedHook({ contents: mockContents });

    expect(offscreenLink.getAttribute('tabindex')).toBe('0');
    expect(offscreenLink.hasAttribute('data-turnleaf-tabindex')).toBe(false);

    collapsed = false;
    selectedString = 'After unload';
    doc.dispatchEvent(new Event('selectionchange'));
    offscreenLink.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(onSelection).not.toHaveBeenCalled();
    expect(mockRendition.display).not.toHaveBeenCalled();

    // Register a second section and verify destroy() cleans up timers, rendition events, and remaining contents.
    const doc2 = document.implementation.createHTMLDocument('section-2');
    const offscreenLink2 = doc2.createElement('a');
    offscreenLink2.setAttribute('href', '#note-2');
    vi.spyOn(offscreenLink2, 'getClientRects').mockReturnValue([
      new DOMRect(640, 30, 80, 18),
    ] as unknown as DOMRectList);
    doc2.body.append(offscreenLink2);
    const mockContents2 = {
      window: { frameElement: frame, getSelection: () => null },
      document: doc2,
      sectionIndex: 1,
      cfiFromRange: () => 'cfi-2',
    } as unknown as Contents;
    await primaryHook(mockContents2);
    expect(offscreenLink2.getAttribute('tabindex')).toBe('-1');

    mockRendition.manager.afterScrolled = setTimeout(() => {}, 10_000);
    session.destroy();

    expect(mockRendition.manager.afterScrolled).toBeUndefined();
    expect(offscreenLink2.getAttribute('tabindex')).toBeNull();
    expect(offscreenLink2.hasAttribute('data-turnleaf-tabindex')).toBe(false);
    expect(mockRendition.manager.off).toHaveBeenCalledWith('scroll', expect.any(Function));
    for (const eventName of ['relocated', 'rendered', 'resized', 'click', 'keydown']) {
      expect(mockRendition.off).toHaveBeenCalledWith(eventName, expect.any(Function));
    }

    viewport.remove();
  });
});
