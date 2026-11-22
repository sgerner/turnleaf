// @vitest-environment jsdom

import type { Contents, Location } from 'epubjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

type TestTocItem = { label: string; href: string; subitems?: TestTocItem[] };
type TestSpineSection = { href: string; index: number };

const { defaultSpineSections, mockBook, mockRendition } = vi.hoisted(() => {
  const defaultSpineSections: TestSpineSection[] = [
    { href: 'first.xhtml', index: 0 },
    { href: 'second.xhtml', index: 1 },
  ];
  const rendition = {
    hooks: {
      render: { register: vi.fn() },
      content: { register: vi.fn() },
    },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { registerCss: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    prev: vi.fn(async () => {}),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const spine = {
    sections: [...defaultSpineSections],
    each: vi.fn((visit: (section: TestSpineSection) => void) => {
      for (const section of spine.sections) {
        visit(section);
      }
    }),
  };
  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine,
    navigation: { toc: [] as TestTocItem[] },
  };
  return { defaultSpineSections, mockBook: book, mockRendition: rendition };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => mockBook) }));

import { ReaderSession, snapPageBoundary } from './session';

function getRenditionListener(
  event: 'click' | 'keydown' | 'relocated',
): (...args: unknown[]) => void {
  const listener = mockRendition.on.mock.calls.find(([name]) => name === event)?.[1];
  if (typeof listener !== 'function') {
    throw new Error(`Expected rendition listener for "${event}"`);
  }
  return listener;
}

function location(cfi: string): Location {
  return {
    start: {
      cfi,
      href: 'chapter.xhtml',
      index: 0,
      percentage: 0.2,
      displayed: { page: 2, total: 10 },
    },
  } as Location;
}

describe('ReaderSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBook.navigation.toc = [];
    mockBook.spine.sections = [...defaultSpineSections];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('forwards EPUB iframe key events to the reader and removes the listener on destroy', async () => {
    const onKeyboardNavigation = vi.fn();
    const session = new ReaderSession('book.epub');

    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
      undefined,
      onKeyboardNavigation,
    );

    expect(mockRendition.on).toHaveBeenCalledWith('keydown', onKeyboardNavigation);
    session.destroy();
    expect(mockRendition.off).toHaveBeenCalledWith('keydown', onKeyboardNavigation);
    expect(mockBook.destroy).toHaveBeenCalledOnce();
  });

  it('turns pages on ordinary content clicks while leaving links and text selection available', async () => {
    const onTap = vi.fn();
    const session = new ReaderSession('book.epub');
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), onTap);
    const click = getRenditionListener('click');
    const frame = document.createElement('iframe');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    const contents = {
      window: {
        frameElement: frame,
        innerWidth: 300,
        getSelection: () => ({ isCollapsed: true }),
      },
    };
    click({ target: document.createElement('a'), clientX: 250 }, contents);
    click(
      { target: document.createElement('p'), clientX: 250 },
      {
        window: {
          frameElement: frame,
          innerWidth: 300,
          getSelection: () => ({ isCollapsed: false }),
        },
      },
    );
    expect(onTap).not.toHaveBeenCalled();

    click({ target: document.createElement('p'), clientX: 250 }, contents);
    expect(onTap).toHaveBeenCalledExactlyOnceWith('next');
    session.destroy();
  });

  it('reports selection collapse to clear the reader selection actions', async () => {
    const session = new ReaderSession('book.epub');
    const onSelection = vi.fn();
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
      onSelection,
    );

    const registerSelection = mockRendition.hooks.content.register.mock.calls[1]?.[0];
    const text = document.createTextNode('Chapter One');
    document.body.append(text);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.addRange(range);
    registerSelection({ window, document, cfiFromRange: () => 'selected-cfi' });

    document.dispatchEvent(new Event('selectionchange'));
    expect(onSelection).toHaveBeenLastCalledWith({ cfi: 'selected-cfi', text: 'Chapter One' });
    selection.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(onSelection).toHaveBeenLastCalledWith(null);

    session.destroy();
    text.remove();
  });

  it('indexes the spine once across repeated relocation events', async () => {
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );
    const relocated = getRenditionListener('relocated');
    const start = { href: 'second.xhtml', index: 1, cfi: '', displayed: { page: 1, total: 4 } };
    relocated({ start });
    relocated({ start: { ...start, displayed: { page: 2, total: 4 } } });

    expect(mockBook.spine.each).toHaveBeenCalledOnce();
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ percentage: 0.625 }),
      'restore',
    );
    session.destroy();
  });

  it('keeps nested EPUB navigation entries in the table of contents', () => {
    mockBook.navigation.toc = [
      {
        label: 'Part One',
        href: 'part-one.xhtml',
        subitems: [{ label: 'Chapter One', href: 'chapter-one.xhtml' }],
      },
    ];

    expect(new ReaderSession('book.epub').tableOfContents()).toEqual([
      {
        label: 'Part One',
        href: 'part-one.xhtml',
        children: [{ label: 'Chapter One', href: 'chapter-one.xhtml', children: [] }],
      },
    ]);
  });

  it('adds and removes persistent CFI highlights in the EPUB rendition', async () => {
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    session.updateHighlights([{ cfi: 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:8)' }]);
    expect(mockRendition.annotations.highlight).toHaveBeenCalledWith(
      'epubcfi(/6/2!/4/2/1:0,/1:0,/1:8)',
      {},
      undefined,
      'turnleaf-highlight',
      { fill: '#facc15', 'fill-opacity': '0.38' },
    );

    session.updateHighlights([]);
    expect(mockRendition.annotations.remove).toHaveBeenCalledWith(
      'epubcfi(/6/2!/4/2/1:0,/1:0,/1:8)',
      'highlight',
    );
    session.destroy();
  });

  it('debounces ResizeObserver callbacks during drags and restores the active CFI once settled', async () => {
    vi.useFakeTimers();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const viewport = document.createElement('div');
    const session = new ReaderSession('book.epub');
    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn());

    expect(mockBook.renderTo).toHaveBeenCalledWith(
      viewport,
      expect.objectContaining({
        gap: 0,
        flow: 'paginated',
        spread: 'none',
        allowScriptedContent: false,
      }),
    );

    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    relocated({
      start: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/8:0)',
        displayed: { page: 3, total: 6 },
      },
    });
    mockRendition.display.mockClear();

    for (const width of [340, 324, 308, 292, 278]) {
      resizeCallbacks[0]?.(
        [{ contentRect: { width, height: 640 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      vi.advanceTimersByTime(40);
    }
    expect(mockRendition.resize).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(mockRendition.resize).toHaveBeenCalledExactlyOnceWith(
      278,
      640,
      'epubcfi(/6/2!/4/2/8:0)',
    );
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('epubcfi(/6/2!/4/2/8:0)');
    session.destroy();
  });

  it('defers ResizeObserver reflow until initial relocation arrives so unlocated views are not cleared', async () => {
    vi.useFakeTimers();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 780));
    const session = new ReaderSession('book.epub');
    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn());
    expect(mockBook.renderTo).toHaveBeenCalledWith(
      viewport,
      expect.objectContaining({
        width: 360,
        height: 780,
        resizeOnOrientationChange: false,
      }),
    );
    mockRendition.display.mockClear();

    // SystemBars / safe-area inset resize arrives after display() resolved, before rAF relocated.
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 360, height: 748 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    vi.advanceTimersByTime(150);
    expect(mockRendition.resize).not.toHaveBeenCalled();

    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    relocated({
      start: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/2:0)',
        displayed: { page: 1, total: 4 },
      },
    });

    expect(mockRendition.resize).toHaveBeenCalledExactlyOnceWith(
      360,
      748,
      'epubcfi(/6/2!/4/2/2:0)',
    );
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('epubcfi(/6/2!/4/2/2:0)');
    session.destroy();
  });

  it('defers ResizeObserver reflow while user navigation is pending and preserves the destination CFI', async () => {
    vi.useFakeTimers();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 780));
    const session = new ReaderSession('book.epub');
    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn());

    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    relocated({
      start: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/2:0)',
        displayed: { page: 1, total: 4 },
      },
    });
    mockRendition.display.mockClear();

    await session.next();
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 360, height: 748 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    vi.advanceTimersByTime(150);
    expect(mockRendition.resize).not.toHaveBeenCalled();

    relocated({
      start: {
        href: 'second.xhtml',
        index: 1,
        cfi: 'epubcfi(/6/4!/4/2/2:0)',
        displayed: { page: 1, total: 4 },
      },
    });

    expect(mockRendition.resize).toHaveBeenCalledExactlyOnceWith(
      360,
      748,
      'epubcfi(/6/4!/4/2/2:0)',
    );
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('epubcfi(/6/4!/4/2/2:0)');
    session.destroy();
  });

  it('ignores initial ResizeObserver callback matching open() viewport dimensions', async () => {
    vi.useFakeTimers();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {
        resizeCallbacks[0]?.(
          [{ contentRect: { width: 360, height: 780 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      }
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 780));
    const session = new ReaderSession('book.epub');
    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn());
    mockRendition.display.mockClear();

    vi.advanceTimersByTime(500);
    expect(mockRendition.resize).not.toHaveBeenCalled();
    expect(mockRendition.display).not.toHaveBeenCalled();
    session.destroy();
  });

  it('waits for EPUB.js queue and animation frames before fallback resize so slow-frame page turns are preserved', async () => {
    vi.useFakeTimers();
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const managedRendition = Object.assign(mockRendition, {
      manager: {
        _stageSize: { width: 360, height: 780 } as { width: number; height: number } | undefined,
      },
      q: { running: true as boolean | undefined, _q: [() => {}] as Array<() => void> },
    });

    try {
      const onLocation = vi.fn();
      const viewport = document.createElement('div');
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 780));
      const session = new ReaderSession('book.epub');
      await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());
      mockRendition.display.mockClear();

      // Android SystemBars / ReaderChrome resize arrives before initial rAF relocation finishes.
      resizeCallbacks[0]?.(
        [{ contentRect: { width: 360, height: 804 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      vi.advanceTimersByTime(150);

      // User turns to page 2 while initial relocation and EPUB.js queue are still in flight on slow frames.
      await session.next();
      vi.advanceTimersByTime(300);

      // Even after 300ms (> 250ms fallback timer), slow animation frames have not drained, so page turn must not be reset.
      expect(mockRendition.resize).not.toHaveBeenCalled();
      expect(mockRendition.display).not.toHaveBeenCalled();

      managedRendition.q.running = undefined;
      managedRendition.q._q = [];

      const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
      relocated({
        start: {
          href: 'first.xhtml',
          index: 0,
          cfi: 'epubcfi(/6/2!/4/2/6:0)',
          displayed: { page: 2, total: 2 },
        },
      });

      expect(onLocation).toHaveBeenCalledWith(
        expect.objectContaining({
          cfi: 'epubcfi(/6/2!/4/2/6:0)',
          pageIndex: 1,
          percentage: 0.25,
        }),
        'navigation',
      );
      expect(mockRendition.resize).toHaveBeenCalledExactlyOnceWith(
        360,
        804,
        'epubcfi(/6/2!/4/2/6:0)',
      );
      session.destroy();
    } finally {
      delete (managedRendition as { manager?: unknown }).manager;
      delete (managedRendition as { q?: unknown }).q;
    }
  });

  it('replaces #epubjs-inserted-css-turnleaf with 7 rules and zero duplicates across 10 slider ticks', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const epubDoc = frame.contentDocument!;
    const addStylesheetCss = (serializedCss: string, key: string) => {
      const id = `epubjs-inserted-css-${key}`;
      let styleEl = epubDoc.getElementById(id) as HTMLStyleElement | null;
      if (!styleEl) {
        styleEl = epubDoc.createElement('style');
        styleEl.id = id;
        epubDoc.head.appendChild(styleEl);
      }
      styleEl.innerHTML = serializedCss;
      return true;
    };
    mockRendition.themes.registerCss.mockImplementation((name: string, css: string) => {
      addStylesheetCss(css, name);
    });

    const session = new ReaderSession('book.epub');
    try {
      await session.open(
        document.createElement('div'),
        null,
        null,
        null,
        defaultAppearance,
        vi.fn(),
        vi.fn(),
      );

      for (let tick = 1; tick <= 10; tick += 1) {
        session.applyAppearance({
          ...defaultAppearance,
          margin: 8 + tick * 4,
          bottomMargin: tick * 4,
          fontSize: 16 + tick,
          paragraphSpacing: Number((tick * 0.1).toFixed(1)),
        });
      }

      const styleNodes = epubDoc.querySelectorAll('#epubjs-inserted-css-turnleaf');
      expect(styleNodes).toHaveLength(1);
      const styleEl = styleNodes[0] as HTMLStyleElement;
      expect(styleEl.textContent).not.toContain('safe-area-inset');
      expect(styleEl.textContent).toContain('padding-bottom: 40px !important;');

      const sheet = styleEl.sheet!;
      expect(sheet.cssRules).toHaveLength(7);
      for (const rule of Array.from(sheet.cssRules)) {
        const declarations = rule.cssText
          .slice(rule.cssText.indexOf('{') + 1, rule.cssText.lastIndexOf('}'))
          .split(';')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => entry.slice(0, entry.indexOf(':')).trim());
        expect(new Set(declarations).size).toBe(declarations.length);
      }
    } finally {
      session.destroy();
      frame.remove();
    }
  });

  it('applies theme CSS and expands views synchronously in hooks.render before multi-page CFI positioning', async () => {
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      'epubcfi(/6/2!/4/2/4/1:264)',
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    const renderHook = mockRendition.hooks.render.register.mock.calls[0]?.[0];
    expect(renderHook).toBeTypeOf('function');

    const callOrder: string[] = [];
    const addStylesheetCss = vi.fn((css: string, key: string) => {
      callOrder.push(`addStylesheetCss:${key}:${css.includes('font-size: 18px !important;')}`);
      return true;
    });
    const expand = vi.fn(() => {
      callOrder.push('expand');
    });

    renderHook({
      contents: { addStylesheetCss },
      expand,
    });

    expect(callOrder).toEqual(['addStylesheetCss:turnleaf:true', 'expand']);
    session.destroy();
  });

  it('realigns an active multi-page CFI if async EPUB stylesheet sanitization expands column width', async () => {
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      'epubcfi(/6/2!/4/2/4/1:264)',
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );
    mockRendition.display.mockClear();

    const hardenHook = mockRendition.hooks.content.register.mock.calls[0]?.[0];
    const epubDoc = new DOMParser().parseFromString(
      '<html><head><link rel="stylesheet" href="data:text/css,body%7Bline-height:2%7D" /></head><body><p>Page two</p></body></html>',
      'text/html',
    );
    let currentWidth = 364;
    const addStylesheetCss = vi.fn(() => true);
    const expand = vi.fn(() => {
      currentWidth = 728;
    });

    await hardenHook({
      document: epubDoc,
      addStylesheetCss,
      expand,
      textWidth: () => currentWidth,
    });

    expect(addStylesheetCss).toHaveBeenCalledWith(expect.any(String), 'turnleaf');
    expect(expand).toHaveBeenCalledOnce();
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('epubcfi(/6/2!/4/2/4/1:264)');
    session.destroy();
  });

  it('snaps subpixel horizontal pagination offsets on fractional-DPR viewports without skipping pages or clamping page index', async () => {
    expect(snapPageBoundary(363.80950927734375, 364)).toBe(364);
    expect(snapPageBoundary(362.6666564941406, 363)).toBe(363);
    expect(snapPageBoundary(363.047607421875, 363)).toBe(363);
    expect(snapPageBoundary(0.190476, 364)).toBe(0);
    expect(snapPageBoundary(180, 364)).toBe(180);

    const container = document.createElement('div');
    let scrollLeft = 363.80950927734375;
    let scrollWidth = 728;
    const offsetWidth = 364;
    Object.defineProperty(container, 'scrollLeft', {
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
      configurable: true,
    });
    Object.defineProperty(container, 'scrollWidth', {
      get: () => scrollWidth,
      configurable: true,
    });
    Object.defineProperty(container, 'offsetWidth', {
      get: () => offsetWidth,
      configurable: true,
    });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(24, 52, 364, 496));

    const mappingPage = vi.fn(
      (_contents: unknown, _cfiBase: string, start: number, end: number) => ({
        start: `epubcfi(/6/2!/4/2/4/1:${start})`,
        end: `epubcfi(/6/2!/4/2/4/1:${end})`,
      }),
    );
    const origNext = vi.fn(async () => {});
    const origPrev = vi.fn(async () => {});
    const origMoveTo = vi.fn();
    const scrollTo = vi.fn((x: number) => {
      scrollLeft = x;
    });

    const managedRendition = Object.assign(mockRendition, {
      manager: {
        isPaginated: true,
        settings: { axis: 'horizontal', direction: 'ltr', fullsize: false },
        container,
        layout: {
          width: 364,
          pageWidth: 364,
          delta: 364,
          count: (width: number) => ({
            spreads: Math.ceil(width / 364),
            pages: Math.ceil(width / 364),
          }),
        },
        mapping: { page: mappingPage },
        views: { length: 1 },
        visible: () => [
          {
            section: { index: 0, href: 'first.xhtml', cfiBase: '/6/2!' },
            contents: {} as never,
            position: () => new DOMRect(24 - scrollLeft, 52, scrollWidth, 496),
            width: () => scrollWidth,
          },
        ],
        scrollTo,
        next: origNext,
        prev: origPrev,
        moveTo: origMoveTo,
        paginatedLocation: vi.fn(() => []),
      },
    });

    try {
      const session = new ReaderSession('book.epub');
      await session.open(
        document.createElement('div'),
        null,
        null,
        null,
        defaultAppearance,
        vi.fn(),
        vi.fn(),
      );

      // Page 2 of a 2-page chapter with Pixel 6 2.625 DPR quantized scrollLeft = 363.8095 (< 364)
      const page2Location = managedRendition.manager.paginatedLocation();
      expect(mappingPage).toHaveBeenCalledWith(expect.anything(), '/6/2!', 364, 728);
      expect(page2Location).toEqual([
        {
          index: 0,
          href: 'first.xhtml',
          pages: [2],
          totalPages: 2,
          mapping: {
            start: 'epubcfi(/6/2!/4/2/4/1:364)',
            end: 'epubcfi(/6/2!/4/2/4/1:728)',
          },
        },
      ]);

      // On the last page of a 2-page chapter, next() delegates to section transition
      await managedRendition.manager.next();
      expect(origNext).toHaveBeenCalledOnce();

      // On a 3-page chapter where Page 2 scrollLeft rounded up (364.1905 > 364), next() lands on Page 3 instead of skipping it
      scrollWidth = 1092;
      scrollLeft = 364.19049072265625;
      origNext.mockClear();
      scrollTo.mockClear();
      managedRendition.manager.next();
      expect(origNext).not.toHaveBeenCalled();
      expect(scrollTo).toHaveBeenCalledExactlyOnceWith(728, 0, true);

      // prev() from subpixel Page 2 returns cleanly to 0 without leaving subpixel residue
      scrollLeft = 364.19049072265625;
      scrollTo.mockClear();
      managedRendition.manager.prev();
      expect(origPrev).not.toHaveBeenCalled();
      expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0, true);

      // moveTo() snaps subpixel column start (363.8095 -> 364) when restoring a Page 2 CFI
      managedRendition.manager.moveTo({ left: 363.80950927734375, top: 0 }, 728);
      expect(origMoveTo).toHaveBeenCalledExactlyOnceWith({ left: 364, top: 0 }, 728);

      session.destroy();
    } finally {
      delete (managedRendition as { manager?: unknown }).manager;
    }
  });

  it('reports link jumps with a one-tap return location and does not retain stale origins', async () => {
    mockBook.spine.sections = [{ href: 'chapter.xhtml', index: 0 }];
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );
    const relocated = getRenditionListener('relocated');
    const click = getRenditionListener('click');
    const contents = {
      window: { getSelection: () => ({ isCollapsed: true }) },
    };
    const source = location('source-cfi');
    const destination = location('destination-cfi');
    relocated(source);

    const internalLink = document.createElement('a');
    internalLink.setAttribute('href', '#footnote');
    click({ target: internalLink, clientX: 100 }, contents);
    relocated(destination);

    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('link');
    expect(onLocation.mock.calls.at(-1)?.[2]).toEqual({
      cfi: 'source-cfi',
      href: 'chapter.xhtml',
    });

    const externalLink = document.createElement('a');
    externalLink.setAttribute('href', 'https://example.org');
    click({ target: externalLink, clientX: 100 }, contents);
    relocated(location('later-cfi'));

    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');
    expect(onLocation.mock.calls.at(-1)).toHaveLength(2);
    session.destroy();
  });

  it('keeps the tap zones in the same places as the EPUB iframe scrolls', async () => {
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 0, 300, 400));
    const frame = document.createElement('iframe');
    const frameRect = vi.spyOn(frame, 'getBoundingClientRect');
    const contents = {
      window: { frameElement: frame, innerWidth: 1200, getSelection: () => null },
    } as unknown as Contents;
    const onTap = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), onTap);
    const click = getRenditionListener('click');

    for (const offset of [0, 300, 600, 900]) {
      frameRect.mockReturnValue(new DOMRect(20 - offset, 0, 1200, 400));
      for (const x of [20, 150, 280]) {
        click(new MouseEvent('click', { clientX: offset + x }), contents);
      }
    }

    expect(onTap.mock.calls).toEqual(
      Array.from({ length: 4 }, () => [['previous'], ['center'], ['next']]).flat(),
    );
    session.destroy();
  });

  it('measures tap zones against the outer .reader-shell when .reader-viewport is inset', async () => {
    const shell = document.createElement('main');
    shell.className = 'reader-shell';
    const viewport = document.createElement('div');
    viewport.className = 'reader-viewport';
    shell.append(viewport);
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 844));
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(56, 8, 278, 772));

    const frame = document.createElement('iframe');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(56, 8, 1112, 772));
    const contents = {
      window: { frameElement: frame, innerWidth: 1112, getSelection: () => null },
    } as unknown as Contents;
    const onTap = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), onTap);
    const click = getRenditionListener('click');

    // Screen x = 56 + 60 = 116 (< 0.33 * 390 = 128.7 => previous, even though 60 / 278 = 0.215)
    // Screen x = 56 + 80 = 136 (between 128.7 and 261.3 => center, whereas 80 / 278 = 0.287 would have been previous)
    // Screen x = 56 + 215 = 271 (> 0.67 * 390 = 261.3 => next)
    for (const clientX of [60, 80, 215]) {
      click(new MouseEvent('click', { clientX }), contents);
    }

    expect(onTap.mock.calls).toEqual([['previous'], ['center'], ['next']]);
    session.destroy();
  });
});
