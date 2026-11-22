// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

type TestTocItem = { label: string; href: string; subitems?: TestTocItem[] };

const { mockBook, mockRendition } = vi.hoisted(() => {
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
  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine: {
      each: vi.fn((visit: (section: { href: string }) => void) => {
        visit({ href: 'first.xhtml' });
        visit({ href: 'second.xhtml' });
      }),
    },
    navigation: { toc: [] as TestTocItem[] },
  };
  return { mockBook: book, mockRendition: rendition };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => mockBook) }));

import { ReaderSession } from './session';

describe('ReaderSession keyboard navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBook.navigation.toc = [];
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
    const click = mockRendition.on.mock.calls.find(([name]) => name === 'click')?.[1];
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
    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
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
});
