// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

type TestTocItem = { label: string; href: string; subitems?: TestTocItem[] };

const { mockBook, mockRendition } = vi.hoisted(() => {
  const rendition = {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
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

  afterEach(() => vi.unstubAllGlobals());

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

  it('reflows the rendition when the reader viewport changes size', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

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
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 480, height: 640 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    expect(mockRendition.resize).toHaveBeenCalledWith(480, 640);
    session.destroy();
  });

  it('defers viewport resize until initial open completes and preserves the restored CFI across system-bar inset changes', async () => {
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
    let rect = new DOMRect(0, 0, 412, 843);
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => rect);

    let resolveInitialDisplay!: () => void;
    mockRendition.display.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveInitialDisplay = resolve;
        }),
    );

    const session = new ReaderSession('book.epub');
    const restoredCfi = 'epubcfi(/6/4!/4/14/1:350)';
    const openPromise = session.open(
      viewport,
      restoredCfi,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    // ResizeObserver must not be attached before initial display finishes, and epubjs
    // Stage's uncontrolled window resize listener must be disabled so system-bar inset
    // changes do not drop the restored CFI.
    expect(mockBook.renderTo).toHaveBeenCalledWith(
      viewport,
      expect.objectContaining({
        width: '100%',
        height: '100%',
        resizeOnOrientationChange: false,
      }),
    );
    await Promise.resolve();
    expect(resizeCallbacks).toHaveLength(0);
    rect = new DOMRect(0, 0, 412, 880);
    expect(mockRendition.resize).not.toHaveBeenCalled();

    resolveInitialDisplay();
    await openPromise;

    expect(mockRendition.resize).toHaveBeenCalledWith(412, 880, restoredCfi);
    expect(resizeCallbacks).toHaveLength(1);

    // Even if initial pagination snapped rendition.location to an earlier column,
    // subsequent system-bar hide resizes before user navigation still target restoredCfi.
    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    relocated({
      start: {
        href: 'second.xhtml',
        index: 1,
        cfi: 'epubcfi(/6/4!/4/12/1:120)',
        displayed: { page: 2, total: 7 },
      },
    });
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 412, height: 915 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    expect(mockRendition.resize).toHaveBeenLastCalledWith(412, 915, restoredCfi);
    session.destroy();
  });

  it('detaches epubjs Stage window listeners and realigns restored CFI columns after queued resize', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });

    const stageResize = vi.fn();
    const stageOrientation = vi.fn();
    window.addEventListener('resize', stageResize);
    window.addEventListener('orientationchange', stageOrientation);

    const expandView = vi.fn();
    const runtimeRendition = mockRendition as typeof mockRendition & {
      manager?: unknown;
      q?: { enqueue: (task: () => void) => Promise<void> };
    };
    runtimeRendition.manager = {
      stage: { resizeFunc: stageResize, orientationChangeFunc: stageOrientation },
      container: document.createElement('div'),
      views: { all: () => [{ expand: expandView }] },
    };
    runtimeRendition.q = {
      enqueue: async (task: () => void) => {
        task();
      },
    };

    try {
      const viewport = document.createElement('div');
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 412, 843));

      const session = new ReaderSession('book.epub');
      const restoredCfi = 'epubcfi(/6/4!/4/14/1:350)';
      await session.open(viewport, restoredCfi, null, null, defaultAppearance, vi.fn(), vi.fn());

      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('orientationchange'));
      expect(stageResize).not.toHaveBeenCalled();
      expect(stageOrientation).not.toHaveBeenCalled();
      expect(expandView).toHaveBeenCalledTimes(1);

      mockRendition.display.mockClear();
      resizeCallbacks[0]?.(
        [{ contentRect: { width: 412, height: 880 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      resizeCallbacks[0]?.(
        [{ contentRect: { width: 412, height: 915 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockRendition.resize).toHaveBeenLastCalledWith(412, 915, restoredCfi);
      expect(expandView).toHaveBeenCalled();
      expect(mockRendition.display).toHaveBeenLastCalledWith(restoredCfi);
      session.destroy();
    } finally {
      delete runtimeRendition.manager;
      delete runtimeRendition.q;
      window.removeEventListener('resize', stageResize);
      window.removeEventListener('orientationchange', stageOrientation);
    }
  });
});
