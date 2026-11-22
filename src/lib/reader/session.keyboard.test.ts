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

  it('coalesces selectionchange updates, flushes on pointer end, and clears collapse immediately', async () => {
    vi.useFakeTimers();
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

    const removeSelectionListeners = vi.fn();
    const cfiFromRange = vi.fn(() => 'selected-cfi');
    const registerSelection = mockRendition.hooks.content.register.mock.calls[1]?.[0];
    const text = document.createTextNode('Chapter One');
    document.body.append(text);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.addRange(range);
    registerSelection({
      window,
      document,
      cfiFromRange,
      removeSelectionListeners,
    });

    expect(removeSelectionListeners).toHaveBeenCalledOnce();

    for (let step = 0; step < 5; step += 1) {
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(40);
    }
    expect(cfiFromRange).not.toHaveBeenCalled();
    expect(onSelection).not.toHaveBeenCalled();

    vi.advanceTimersByTime(80);
    expect(cfiFromRange).toHaveBeenCalledOnce();
    expect(onSelection).toHaveBeenLastCalledWith({ cfi: 'selected-cfi', text: 'Chapter One' });

    // Pointer-end flush resolves pending selection immediately without duplicate mouseup work.
    cfiFromRange.mockClear();
    onSelection.mockClear();
    document.dispatchEvent(new Event('selectionchange'));
    expect(cfiFromRange).not.toHaveBeenCalled();
    document.dispatchEvent(new Event('pointerup'));
    document.dispatchEvent(new Event('mouseup'));
    document.dispatchEvent(new Event('touchend'));
    expect(cfiFromRange).toHaveBeenCalledOnce();
    expect(onSelection).toHaveBeenCalledExactlyOnceWith({
      cfi: 'selected-cfi',
      text: 'Chapter One',
    });

    // Collapsing cancels any pending debounce and clears immediately.
    cfiFromRange.mockClear();
    document.dispatchEvent(new Event('selectionchange'));
    selection.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(onSelection).toHaveBeenLastCalledWith(null);
    vi.advanceTimersByTime(200);
    expect(cfiFromRange).not.toHaveBeenCalled();

    // Pending timers and listeners are cleaned up on destroy.
    selection.addRange(range);
    onSelection.mockClear();
    document.dispatchEvent(new Event('selectionchange'));
    session.destroy();
    vi.advanceTimersByTime(200);
    document.dispatchEvent(new Event('selectionchange'));
    expect(cfiFromRange).not.toHaveBeenCalled();
    expect(onSelection).not.toHaveBeenCalled();

    selection.removeAllRanges();
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

  it('renders post-theme non-interactive SVG highlights, realigns single-page reflows, and skips hit-testing on taps', async () => {
    const validCfi = 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:8)';
    const staleCfi = 'epubcfi(/6/2!/4/99/1:0,/1:0,/1:4)';
    const session = new ReaderSession('book.epub');
    session.updateHighlights([{ cfi: validCfi }, { cfi: staleCfi }]);

    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    const onTap = vi.fn();
    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), onTap);

    expect(mockRendition.annotations.highlight).not.toHaveBeenCalled();
    expect(mockRendition.annotations.remove).not.toHaveBeenCalled();

    const rendered = mockRendition.on.mock.calls.find(([name]) => name === 'rendered')?.[1];
    const removed = mockRendition.on.mock.calls.find(([name]) => name === 'removed')?.[1];
    const click = mockRendition.on.mock.calls.find(([name]) => name === 'click')?.[1];

    // Chapter with zero highlights skips SVG creation completely.
    const emptyViewElement = document.createElement('div');
    const emptyView = {
      index: 1,
      element: emptyViewElement,
      iframe: document.createElement('iframe'),
      contents: {
        document: document.implementation.createHTMLDocument('second'),
        window: { scrollX: 0, scrollY: 0 },
        resizeCheck: vi.fn(),
        range: vi.fn(),
      },
    };
    rendered({ index: 1 }, emptyView);
    expect(emptyView.contents.resizeCheck).toHaveBeenCalledOnce();
    expect(emptyViewElement.querySelector('svg')).toBeNull();

    // Chapter with highlights runs resizeCheck before reading client rects and tolerates stale CFIs.
    let currentRects = [new DOMRect(24, 48, 180, 20), new DOMRect(24, 48, 90, 20)];
    let pendingReflowRects: DOMRect[] | null = [new DOMRect(32, 76, 160, 24)];
    const contentDoc = document.implementation.createHTMLDocument('first');
    const addDocListenerSpy = vi.spyOn(contentDoc, 'addEventListener');
    const resizeCheck = vi.fn(() => {
      if (pendingReflowRects) {
        currentRects = pendingReflowRects;
        pendingReflowRects = null;
      }
    });
    const viewElement = document.createElement('div');
    viewElement.style.width = '300px';
    viewElement.style.height = '400px';
    const frame = document.createElement('iframe');
    frame.style.width = '300px';
    frame.style.height = '400px';
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    vi.spyOn(viewElement, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    const view = {
      index: 0,
      element: viewElement,
      iframe: frame,
      contents: {
        document: contentDoc,
        window: {
          frameElement: frame,
          innerWidth: 300,
          scrollX: 0,
          scrollY: 0,
          getSelection: () => ({ isCollapsed: true }),
        },
        resizeCheck,
        range: vi.fn((cfi: string) => {
          if (cfi === staleCfi) throw new Error('Stale CFI');
          return { getClientRects: () => currentRects } as unknown as Range;
        }),
      },
    };

    rendered({ index: 0 }, view);
    expect(resizeCheck).toHaveBeenCalledOnce();
    expect(addDocListenerSpy).not.toHaveBeenCalled();

    const overlay = viewElement.querySelector('svg.turnleaf-highlight-layer');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('aria-hidden')).toBe('true');
    expect(overlay?.getAttribute('pointer-events')).toBe('none');
    const rects = overlay?.querySelectorAll('g.turnleaf-highlight rect');
    expect(rects).toHaveLength(1);
    expect(rects?.[0]?.getAttribute('x')).toBe('32');
    expect(rects?.[0]?.getAttribute('y')).toBe('76');

    // Tapping performs zero mark hit-testing reads.
    const markGroup = overlay!.querySelector('g.turnleaf-highlight')!;
    const markBoundsSpy = vi.spyOn(markGroup, 'getBoundingClientRect');
    contentDoc.dispatchEvent(new Event('touchstart'));
    contentDoc.dispatchEvent(new Event('mousedown'));
    contentDoc.dispatchEvent(new Event('mouseup'));
    contentDoc.dispatchEvent(new Event('click'));
    click({ target: contentDoc.body, clientX: 260 }, view.contents);
    expect(onTap).toHaveBeenCalledExactlyOnceWith('next');
    expect(markBoundsSpy).not.toHaveBeenCalled();

    // Single-page layout change realigns highlights via resizeCheck even without view reframe.
    pendingReflowRects = [new DOMRect(40, 112, 200, 30)];
    session.applyAppearance({ ...defaultAppearance, fontSize: 28, margin: 32 });
    expect(resizeCheck).toHaveBeenCalledTimes(2);
    const realignedRect = viewElement.querySelector('g.turnleaf-highlight rect');
    expect(realignedRect?.getAttribute('x')).toBe('40');
    expect(realignedRect?.getAttribute('y')).toBe('112');
    expect(realignedRect?.getAttribute('width')).toBe('200');
    expect(realignedRect?.getAttribute('height')).toBe('30');

    // Clearing highlights removes the SVG overlay; re-adding and removing view cleans up state.
    session.updateHighlights([]);
    expect(viewElement.querySelector('svg')).toBeNull();

    session.updateHighlights([{ cfi: validCfi }]);
    expect(viewElement.querySelector('svg')).not.toBeNull();
    removed({ index: 0 }, view);
    expect(viewElement.querySelector('svg')).toBeNull();

    session.destroy();
    expect(mockRendition.off).toHaveBeenCalledWith('rendered', rendered);
    expect(mockRendition.off).toHaveBeenCalledWith('removed', removed);
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
});
