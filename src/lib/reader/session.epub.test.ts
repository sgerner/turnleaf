// @vitest-environment jsdom

import type { Contents, Location } from 'epubjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance, type Appearance } from './appearance';

type TestTocItem = { label: string; href: string; subitems?: TestTocItem[] };
type TestSpineSection = { href: string; index: number };

const { defaultSpineSections, mockBook, mockRendition } = vi.hoisted(() => {
  const defaultSpineSections: TestSpineSection[] = [
    { href: 'first.xhtml', index: 0 },
    { href: 'second.xhtml', index: 1 },
  ];
  const rendition = {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    location: undefined as { start: { cfi: string } } | undefined,
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    getContents: vi.fn((): unknown[] => []),
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

import { ReaderSession, resolveReaderKeyboardAction } from './session';

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
    mockRendition.getContents.mockReturnValue([]);
    mockBook.navigation.toc = [];
    mockBook.spine.sections = [...defaultSpineSections];
    mockRendition.location = undefined;
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

  it('ignores Shift+Arrow selection keys and open panels while clearing selection on Escape', () => {
    expect(resolveReaderKeyboardAction(new KeyboardEvent('keydown', { key: 'ArrowRight' }))).toBe(
      'next',
    );
    expect(resolveReaderKeyboardAction(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))).toBe(
      'previous',
    );
    expect(
      resolveReaderKeyboardAction(
        new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true }),
      ),
    ).toBeNull();
    expect(
      resolveReaderKeyboardAction(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true }),
      ),
    ).toBeNull();
    expect(
      resolveReaderKeyboardAction(new KeyboardEvent('keydown', { key: ' ', shiftKey: true })),
    ).toBeNull();
    expect(
      resolveReaderKeyboardAction(new KeyboardEvent('keydown', { key: 'ArrowRight' }), {
        hasOpenPanel: true,
      }),
    ).toBeNull();
    expect(
      resolveReaderKeyboardAction(new KeyboardEvent('keydown', { key: 'Escape' }), {
        hasOpenPanel: true,
        hasSelection: true,
      }),
    ).toBeNull();

    const actionButton = document.createElement('button');
    document.body.append(actionButton);
    const escapeOnButton = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(escapeOnButton, 'target', { value: actionButton });
    expect(resolveReaderKeyboardAction(escapeOnButton, { hasSelection: true })).toBe(
      'clear-selection',
    );
    expect(resolveReaderKeyboardAction(escapeOnButton, { hasSelection: false })).toBeNull();
    actionButton.remove();
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

  it('keeps the selected passage active when Tab blurs the EPUB iframe', async () => {
    const session = new ReaderSession('book.epub');
    const onSelection = vi.fn();
    const viewport = document.createElement('div');
    const frame = document.createElement('iframe');
    const highlightButton = document.createElement('button');
    viewport.append(frame);
    document.body.append(viewport, highlightButton);

    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
      onSelection,
    );

    const registerSelection = mockRendition.hooks.content.register.mock.calls[1]?.[0];
    const doc = document.implementation.createHTMLDocument('chapter');
    const paragraph = doc.createElement('p');
    paragraph.textContent = 'Selected with Shift+Arrow';
    doc.body.append(paragraph);

    let collapsed = false;
    const contentsWindow = new EventTarget() as Window & EventTarget;
    Object.defineProperties(contentsWindow, {
      frameElement: { value: frame },
      getSelection: {
        value: () =>
          collapsed
            ? { isCollapsed: true, rangeCount: 0, toString: () => '' }
            : {
                isCollapsed: false,
                rangeCount: 1,
                toString: () => 'Selected with Shift+Arrow',
                getRangeAt: () => {
                  const range = doc.createRange();
                  range.selectNodeContents(paragraph);
                  return range;
                },
              },
      },
    });

    registerSelection({
      window: contentsWindow,
      document: doc,
      cfiFromRange: () => 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:25)',
    });

    doc.dispatchEvent(new Event('selectionchange'));
    expect(onSelection).toHaveBeenLastCalledWith({
      cfi: 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:25)',
      text: 'Selected with Shift+Arrow',
    });

    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    highlightButton.focus();
    contentsWindow.dispatchEvent(new Event('blur'));
    collapsed = true;
    doc.dispatchEvent(new Event('selectionchange'));

    expect(onSelection).toHaveBeenCalledTimes(1);

    doc.dispatchEvent(new Event('mousedown'));
    doc.dispatchEvent(new Event('selectionchange'));
    expect(onSelection).toHaveBeenLastCalledWith(null);

    session.destroy();
    viewport.remove();
    highlightButton.remove();
  });

  it('lists visible block passages and falls back to the current location CFI range for bare text', async () => {
    const session = new ReaderSession('book.epub');
    const viewport = document.createElement('div');
    const container = document.createElement('div');
    container.className = 'epub-container';
    const frame = document.createElement('iframe');
    container.append(frame);
    viewport.append(container);
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 400));

    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn());
    const prepareContents = mockRendition.hooks.content.register.mock.calls[0]?.[0];
    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];

    const doc = document.implementation.createHTMLDocument('chapter');
    const quote = doc.createElement('blockquote');
    const first = doc.createElement('p');
    first.textContent = 'Visible opening passage';
    vi.spyOn(first, 'getClientRects').mockReturnValue([
      new DOMRect(24, 20, 240, 40),
    ] as unknown as DOMRectList);
    quote.append(first);

    const second = doc.createElement('p');
    second.textContent = 'Next column passage';
    vi.spyOn(second, 'getClientRects').mockReturnValue([
      new DOMRect(340, 20, 240, 40),
    ] as unknown as DOMRectList);
    doc.body.append(quote, second);

    await prepareContents({
      window: { frameElement: frame },
      document: doc,
      sectionIndex: 0,
      range: () => {
        const range = doc.createRange();
        range.selectNodeContents(doc.body);
        return range;
      },
      cfiFromRange: (range: Range) =>
        range.toString().includes('Bare chapter text') ? '' : `cfi:${range.toString().trim()}`,
    });

    relocated({
      start: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/2/1:0)',
        displayed: { page: 1, total: 3 },
      },
      end: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/2/1:23)',
        displayed: { page: 1, total: 3 },
      },
    });

    expect(session.getVisiblePassages()).toEqual([
      { cfi: 'cfi:Visible opening passage', text: 'Visible opening passage' },
    ]);

    // Bare text inside <div> without matching block tags falls back to start.cfi..end.cfi.
    doc.body.innerHTML = '<div>Bare chapter text without paragraph tags</div>';
    relocated({
      start: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        displayed: { page: 2, total: 3 },
      },
      end: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/1:40)',
        displayed: { page: 2, total: 3 },
      },
    });

    expect(session.getVisiblePassages()).toEqual([
      {
        cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:40)',
        text: 'Bare chapter text without paragraph tags',
      },
    ]);

    session.destroy();
  });

  it('clears the active EPUB text selection', async () => {
    const session = new ReaderSession('book.epub');
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Selected passage';
    document.body.append(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection?.addRange(range);

    mockRendition.getContents.mockReturnValue([{ document, window } as unknown as Contents]);
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    session.clearTextSelection();

    expect(selection?.rangeCount).toBe(0);
    session.destroy();
    paragraph.remove();
  });

  it('does not offer whole-chapter text as a page passage without viewport or location geometry', async () => {
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
    const prepareContents = mockRendition.hooks.content.register.mock.calls[0]?.[0];
    const relocated = getRenditionListener('relocated');
    const doc = document.implementation.createHTMLDocument('chapter');
    doc.body.innerHTML = '<p>Current page passage</p><p>Later chapter text</p>';

    await prepareContents({
      window: { frameElement: document.createElement('iframe') },
      document: doc,
      sectionIndex: 0,
      cfiFromRange: (range: Range) => `cfi:${range.toString().trim()}`,
    });
    relocated({
      start: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        displayed: { page: 1, total: 4 },
      },
      end: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/1:24)',
        displayed: { page: 1, total: 4 },
      },
    });

    expect(session.getVisiblePassages()).toEqual([]);
    session.destroy();
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

  it('scopes Tab order to visible columns without aria-hidden or inert and restores tabindex on destroy', async () => {
    mockBook.spine.sections = [{ href: 'chapter.xhtml', index: 0 }];
    const session = new ReaderSession('book.epub');
    const viewport = document.createElement('div');
    const container = document.createElement('div');
    container.className = 'epub-container';
    const frame = document.createElement('iframe');
    container.append(frame);
    viewport.append(container);
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    const frameRect = vi
      .spyOn(frame, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 900, 400));

    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn());
    const prepareContents = mockRendition.hooks.content.register.mock.calls[0]?.[0];
    const relocated = getRenditionListener('relocated');

    const doc = document.implementation.createHTMLDocument('chapter');
    const firstPageLink = doc.createElement('a');
    firstPageLink.setAttribute('href', '#note-1');
    firstPageLink.textContent = 'First page note';
    vi.spyOn(firstPageLink, 'getClientRects').mockReturnValue([
      new DOMRect(40, 30, 80, 18),
    ] as unknown as DOMRectList);

    const wrappingLink = doc.createElement('a');
    wrappingLink.setAttribute('href', '#note-wrap');
    wrappingLink.setAttribute('tabindex', '0');
    wrappingLink.textContent = 'Wrapping link';
    vi.spyOn(wrappingLink, 'getClientRects').mockReturnValue([
      new DOMRect(240, 360, 56, 18),
      new DOMRect(312, 20, 64, 18),
    ] as unknown as DOMRectList);

    const thirdPageLink = doc.createElement('a');
    thirdPageLink.setAttribute('href', '#note-3');
    thirdPageLink.textContent = 'Third page note';
    vi.spyOn(thirdPageLink, 'getClientRects').mockReturnValue([
      new DOMRect(640, 50, 90, 18),
    ] as unknown as DOMRectList);

    doc.body.append(firstPageLink, wrappingLink, thirdPageLink);
    await prepareContents({
      window: { frameElement: frame },
      document: doc,
      sectionIndex: 0,
      cfiFromRange: () => 'cfi',
    });

    // Page 1 (0..300): firstPageLink and wrappingLink are visible; thirdPageLink is off-screen.
    expect(firstPageLink.getAttribute('tabindex')).toBeNull();
    expect(wrappingLink.getAttribute('tabindex')).toBe('0');
    expect(thirdPageLink.getAttribute('tabindex')).toBe('-1');
    expect(thirdPageLink.getAttribute('data-turnleaf-tabindex')).toBe('');
    expect(thirdPageLink.hasAttribute('aria-hidden')).toBe(false);
    expect(thirdPageLink.hasAttribute('inert')).toBe(false);

    // Page 2 (300..600): wrappingLink stays tabbable across the column break; firstPageLink becomes -1.
    frameRect.mockReturnValue(new DOMRect(-300, 0, 900, 400));
    container.scrollLeft = 300;
    relocated(location('page-2-cfi'));

    expect(firstPageLink.getAttribute('tabindex')).toBe('-1');
    expect(firstPageLink.getAttribute('data-turnleaf-tabindex')).toBe('');
    expect(wrappingLink.getAttribute('tabindex')).toBe('0');
    expect(wrappingLink.hasAttribute('data-turnleaf-tabindex')).toBe(false);
    expect(thirdPageLink.getAttribute('tabindex')).toBe('-1');

    // Page 3 (600..900): wrappingLink becomes -1 (preserving original tabindex="0"); thirdPageLink restores.
    frameRect.mockReturnValue(new DOMRect(-600, 0, 900, 400));
    container.scrollLeft = 600;
    relocated(location('page-3-cfi'));

    expect(wrappingLink.getAttribute('tabindex')).toBe('-1');
    expect(wrappingLink.getAttribute('data-turnleaf-tabindex')).toBe('0');
    expect(thirdPageLink.getAttribute('tabindex')).toBeNull();
    expect(thirdPageLink.hasAttribute('data-turnleaf-tabindex')).toBe(false);

    session.destroy();
    expect(firstPageLink.getAttribute('tabindex')).toBeNull();
    expect(firstPageLink.hasAttribute('data-turnleaf-tabindex')).toBe(false);
    expect(wrappingLink.getAttribute('tabindex')).toBe('0');
    expect(wrappingLink.hasAttribute('data-turnleaf-tabindex')).toBe(false);
  });

  it('locks scrollLeft to the active stride and navigates on off-screen link focus', async () => {
    mockBook.spine.sections = [{ href: 'chapter.xhtml', index: 0 }];
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    const viewport = document.createElement('div');
    const container = document.createElement('div');
    container.className = 'epub-container';
    const frame = document.createElement('iframe');
    container.append(frame);
    viewport.append(container);
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 366, 600));
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 366, 600));
    const frameRect = vi
      .spyOn(frame, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 1464, 600));

    await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());
    const prepareContents = mockRendition.hooks.content.register.mock.calls[0]?.[0];
    const relocated = getRenditionListener('relocated');

    const doc = document.implementation.createHTMLDocument('chapter');
    const wrappingLink = doc.createElement('a');
    wrappingLink.setAttribute('href', '#wrap');
    wrappingLink.textContent = 'Wrapping column link';
    vi.spyOn(wrappingLink, 'getClientRects').mockReturnValue([
      new DOMRect(280, 560, 80, 18),
      new DOMRect(390, 20, 70, 18),
    ] as unknown as DOMRectList);

    const offscreenLink = doc.createElement('a');
    offscreenLink.setAttribute('href', '#later');
    offscreenLink.textContent = 'Later chapter link';
    vi.spyOn(offscreenLink, 'getClientRects').mockReturnValue([
      new DOMRect(1050, 80, 110, 18),
    ] as unknown as DOMRectList);

    doc.body.append(wrappingLink, offscreenLink);
    await prepareContents({
      window: { frameElement: frame },
      document: doc,
      sectionIndex: 0,
      cfiFromRange: (range: Range) =>
        range.toString().includes('Later')
          ? 'epubcfi(/6/2!/4/4/1:0,/1:0,/1:18)'
          : 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:20)',
    });

    container.scrollLeft = 0;
    relocated(location('page-1-cfi'));
    mockRendition.display.mockClear();

    // Browser focus nudging scrollLeft on a wrapping link snaps back to active stride (0) without navigating.
    container.scrollLeft = 134;
    wrappingLink.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    container.dispatchEvent(new Event('scroll'));
    expect(container.scrollLeft).toBe(0);
    expect(mockRendition.display).not.toHaveBeenCalled();

    // Focusing an off-screen link (e.g. TalkBack/VoiceOver link list) snaps scrollLeft and calls display(cfi) via navigate.
    mockRendition.display.mockImplementationOnce(async () => {
      container.scrollLeft = 732;
      frameRect.mockReturnValue(new DOMRect(-732, 0, 1464, 600));
      relocated({
        start: {
          cfi: 'epubcfi(/6/2!/4/4/1:0)',
          href: 'chapter.xhtml',
          index: 0,
          percentage: 0.5,
          displayed: { page: 3, total: 4 },
        },
      } as Location);
    });

    container.scrollLeft = 1023;
    offscreenLink.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await vi.waitFor(() => {
      expect(mockRendition.display).toHaveBeenCalledWith('epubcfi(/6/2!/4/4/1:0,/1:0,/1:18)');
    });

    expect(container.scrollLeft).toBe(732);
    expect(offscreenLink.getAttribute('tabindex')).toBeNull();
    expect(onLocation.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        cfi: 'epubcfi(/6/2!/4/4/1:0)',
        pageIndex: 2,
        pageCount: 4,
      }),
    );
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('navigation');

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

  it('normalizes horizontal paginated scrollLeft quantization at fractional devicePixelRatio without skipping pages or misreporting restored columns', async () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'offsetWidth', { value: 411, configurable: true });
    Object.defineProperty(container, 'scrollWidth', { value: 2055, configurable: true });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 411.4285888671875, 914),
    );
    let rawScrollLeft = 0;
    Object.defineProperty(container, 'scrollLeft', {
      get: () => rawScrollLeft,
      set: (value: number) => {
        // Emulate Chromium 2.625 DPR quantization (Math.round(x * 2.625) / 2.625)
        rawScrollLeft = Math.round(value * 2.625) / 2.625;
      },
      configurable: true,
    });

    const sectionNextSpy = vi.fn();
    const mappingPageSpy = vi.fn(
      (_contents: unknown, _cfiBase: string, start: number, end: number) => ({
        start: `cfi-${start}`,
        end: `cfi-${end}`,
      }),
    );
    const manager = {
      isPaginated: true,
      settings: { axis: 'horizontal', direction: 'ltr', fullsize: false },
      layout: {
        delta: 411,
        width: 411,
        pageWidth: 411,
        count: (width: number) => ({ pages: Math.round(width / 411) }),
      },
      container,
      views: { length: 1 },
      mapping: { page: mappingPageSpy },
      visible: () => [
        {
          section: { index: 1, href: 'second.xhtml', cfiBase: '/6/4' },
          position: () => new DOMRect(-rawScrollLeft, 0, 2877, 914),
          width: () => 2877,
          contents: {},
        },
      ],
      scrollTo: vi.fn((x: number) => {
        container.scrollLeft = x;
      }),
      next: vi.fn(() => {
        sectionNextSpy();
        return undefined;
      }),
      prev: vi.fn(() => undefined),
      paginatedLocation: vi.fn(() => []),
    };

    const runtimeRendition = mockRendition as typeof mockRendition & {
      manager?: unknown;
      next?: () => Promise<void>;
      prev?: () => Promise<void>;
    };
    runtimeRendition.manager = manager;
    runtimeRendition.next = vi.fn(async () => {
      await manager.next();
    });
    runtimeRendition.prev = vi.fn(async () => {
      await manager.prev();
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

      // Advance across all 5 pages of a 2055px chapter at 2.625 DPR without skipping page 5
      await session.next(); // -> page 2 (411.0476)
      await session.next(); // -> page 3 (822.0952)
      await session.next(); // -> page 4 (1233.1428)
      expect(sectionNextSpy).not.toHaveBeenCalled();
      await session.next(); // -> page 5 (1644.1905) — must NOT skip to next section!
      expect(sectionNextSpy).not.toHaveBeenCalled();
      expect(manager.scrollTo).toHaveBeenLastCalledWith(1644, 0, true);

      // Next turn from page 5 advances to the following spine section
      await session.next();
      expect(sectionNextSpy).toHaveBeenCalledOnce();

      // Simulate restoring page 6 of 7 (x = 2055 -> 2054.8571 at 2.625 DPR)
      container.scrollLeft = 2055;
      expect(container.scrollLeft).toBeLessThan(2055);
      const sections = manager.paginatedLocation() as Array<{
        pages: number[];
        totalPages: number;
      }>;
      expect(sections[0]?.pages).toEqual([6]);
      expect(sections[0]?.totalPages).toBe(7);
      expect(mappingPageSpy).toHaveBeenLastCalledWith({}, '/6/4', 2055, 2466);

      session.destroy();
    } finally {
      delete runtimeRendition.manager;
      delete runtimeRendition.next;
      delete runtimeRendition.prev;
    }
  });

  it('waits for pending navigation relocation frame before applying queued ResizeObserver reflow', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });

    const runtimeRendition = mockRendition as typeof mockRendition & {
      q?: { enqueue: (task: () => void) => Promise<void> };
      next?: () => Promise<void>;
    };
    runtimeRendition.q = {
      enqueue: async (task: () => void) => {
        task();
      },
    };
    runtimeRendition.next = vi.fn(async () => {});

    try {
      const viewport = document.createElement('div');
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 412, 843));
      const session = new ReaderSession('book.epub');
      await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn());

      const relocated = getRenditionListener('relocated');
      relocated(location('epubcfi(/6/2!/4/2/1:0)'));

      // Start a page turn whose reportLocation RAF has not fired yet
      const navPromise = session.next();
      await Promise.resolve();

      // Fire ResizeObserver mid-turn before RAF updates relocated CFI
      resizeCallbacks[0]?.(
        [{ contentRect: { width: 412, height: 898 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      expect(mockRendition.resize).not.toHaveBeenCalled();

      // Deliver relocated CFI on the animation frame, then flush
      relocated(location('epubcfi(/6/2!/4/8/1:0)'));
      rafCallbacks.at(-1)?.(16);
      await navPromise;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockRendition.resize).toHaveBeenCalledWith(412, 898, 'epubcfi(/6/2!/4/8/1:0)');
      session.destroy();
    } finally {
      delete runtimeRendition.q;
      delete runtimeRendition.next;
    }
  });

  it('registers themes on initial mount and mode updates without reflowing the CFI', async () => {
    const unopened = new ReaderSession('book.epub');
    unopened.applyAppearance(defaultAppearance);
    expect(mockRendition.themes.register).not.toHaveBeenCalled();
    expect(mockRendition.themes.select).not.toHaveBeenCalled();
    expect(mockRendition.display).not.toHaveBeenCalled();
    unopened.destroy();
    vi.clearAllMocks();

    mockRendition.location = { start: { cfi: 'epubcfi(/6/2!/4/2/1:0)' } };
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

    expect(mockRendition.themes.register).toHaveBeenCalledExactlyOnceWith(
      'turnleaf',
      expect.objectContaining({
        a: { color: '--color-primary-700 !important' },
      }),
    );
    expect(mockRendition.themes.select).toHaveBeenCalledExactlyOnceWith('turnleaf');
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith();

    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    relocated({
      start: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        displayed: { page: 1, total: 4 },
      },
    });
    vi.clearAllMocks();

    session.applyAppearance({ ...defaultAppearance, mode: 'dark' });
    expect(mockRendition.themes.register).toHaveBeenCalledExactlyOnceWith(
      'turnleaf',
      expect.objectContaining({
        a: { color: '--color-primary-300 !important' },
      }),
    );
    expect(mockRendition.themes.select).toHaveBeenCalledExactlyOnceWith('turnleaf');
    expect(mockRendition.display).not.toHaveBeenCalled();
    session.destroy();
  });

  it('re-registers the theme and preserves the current CFI across layout updates', async () => {
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
    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    relocated({
      start: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        displayed: { page: 1, total: 4 },
      },
    });

    const layoutPatches: Array<Partial<Appearance>> = [
      { fontFamily: 'sans' },
      { fontSize: 22 },
      { lineHeight: 1.8 },
      { margin: 32 },
      { bottomMargin: 16 },
      { paragraphSpacing: 1.0 },
      { alignment: 'justify' },
      { hyphenation: true },
    ];

    let current = { ...defaultAppearance };
    for (const patch of layoutPatches) {
      vi.clearAllMocks();
      current = { ...current, ...patch };
      session.applyAppearance(current);
      expect(mockRendition.themes.register).toHaveBeenCalledOnce();
      expect(mockRendition.themes.select).toHaveBeenCalledExactlyOnceWith('turnleaf');
      expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('epubcfi(/6/2!/4/2/1:0)');
    }
    session.destroy();
  });

  it('skips theme registration and CFI reflow for non-theme appearance toggles', async () => {
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
    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    relocated({
      start: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        displayed: { page: 1, total: 4 },
      },
    });
    vi.clearAllMocks();

    let current = { ...defaultAppearance };
    for (const patch of [
      {},
      { publisherStyles: false },
      { progressBar: false },
      { keepAwake: true },
      { volumeButtons: true },
    ] satisfies Array<Partial<Appearance>>) {
      current = { ...current, ...patch };
      session.applyAppearance(current);
    }

    expect(mockRendition.themes.register).not.toHaveBeenCalled();
    expect(mockRendition.themes.select).not.toHaveBeenCalled();
    expect(mockRendition.display).not.toHaveBeenCalled();
    session.destroy();
  });

  it('defers CFI preservation until pending user navigation settles', async () => {
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
    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    relocated({
      start: {
        href: 'first.xhtml',
        index: 0,
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        displayed: { page: 1, total: 4 },
      },
    });

    await session.display('second.xhtml');
    vi.clearAllMocks();

    session.applyAppearance({ ...defaultAppearance, fontSize: 24 });
    expect(mockRendition.themes.register).toHaveBeenCalledOnce();
    expect(mockRendition.themes.select).toHaveBeenCalledExactlyOnceWith('turnleaf');
    expect(mockRendition.display).not.toHaveBeenCalled();

    relocated({
      start: {
        href: 'second.xhtml',
        index: 1,
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        displayed: { page: 1, total: 4 },
      },
    });
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('epubcfi(/6/4!/4/2/1:0)');
    session.destroy();
  });

  it('waits for async section render and content hooks during navigation and re-reports location when view width expands', async () => {
    const managerListeners = new Map<string, (...args: unknown[]) => void>();
    let currentWidth = 360;
    const view = {
      width: vi.fn(() => currentWidth),
      expand: vi.fn(() => {
        currentWidth = 1080;
      }),
    };
    const reportLocation = vi.fn(async () => {});
    const next = vi.fn(async () => {
      managerListeners.get('added')?.(view);
    });
    const runtimeRendition = mockRendition as typeof mockRendition & {
      q?: { enqueue: (task: () => void) => Promise<void> };
      next?: typeof next;
      reportLocation?: typeof reportLocation;
      manager?: {
        stage: object;
        container: HTMLElement;
        on: (event: string, listener: (...args: unknown[]) => void) => void;
        off: (event: string, listener: (...args: unknown[]) => void) => void;
        views: { all: () => Array<typeof view> };
      };
    };
    runtimeRendition.q = {
      enqueue: async (task) => {
        task();
      },
    };
    runtimeRendition.next = next;
    runtimeRendition.reportLocation = reportLocation;
    runtimeRendition.manager = {
      stage: {},
      container: document.createElement('div'),
      on: (event, listener) => {
        managerListeners.set(event, listener);
      },
      off: (event) => {
        managerListeners.delete(event);
      },
      views: { all: () => [view] },
    };

    try {
      const session = new ReaderSession('book.epub');
      const viewport = document.createElement('div');
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 640));
      const onLocation = vi.fn();
      await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());
      const relocated = getRenditionListener('relocated');
      relocated({
        start: {
          href: 'first.xhtml',
          index: 0,
          cfi: 'epubcfi(/6/2!/4/2/1:0)',
          displayed: { page: 1, total: 2 },
        },
      });
      onLocation.mockClear();

      reportLocation.mockImplementationOnce(async () => {
        relocated({
          start: {
            href: 'second.xhtml',
            index: 1,
            cfi: 'epubcfi(/6/4!/4/14/1:350)',
            displayed: { page: 3, total: 7 },
          },
        });
      });
      next.mockImplementationOnce(async () => {
        managerListeners.get('added')?.(view);
        relocated({
          start: {
            href: 'second.xhtml',
            index: 1,
            cfi: 'epubcfi(/6/4!/4/14/1:350)',
            displayed: { page: 3, total: 6 },
          },
        });
      });

      const rendered = mockRendition.on.mock.calls.find(([name]) => name === 'rendered')?.[1];
      let settled = false;
      const navPromise = session.next().then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(next).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(reportLocation).not.toHaveBeenCalled();

      rendered?.({}, view);
      await navPromise;

      expect(view.expand).toHaveBeenCalledOnce();
      expect(reportLocation).toHaveBeenCalledOnce();
      expect(onLocation).toHaveBeenLastCalledWith(
        expect.objectContaining({
          cfi: 'epubcfi(/6/4!/4/14/1:350)',
          pageIndex: 2,
          pageCount: 7,
        }),
        'navigation',
      );
      expect(onLocation.mock.calls.at(-1)).toHaveLength(2);
      session.destroy();
    } finally {
      delete runtimeRendition.q;
      delete runtimeRendition.next;
      delete runtimeRendition.reportLocation;
      delete runtimeRendition.manager;
    }
  });

  it('re-aligns restored CFI when epub.js manager emits a late view resize after open', async () => {
    const managerListeners = new Map<string, (...args: unknown[]) => void>();
    const reportLocation = vi.fn(async () => {});
    const runtimeRendition = mockRendition as typeof mockRendition & {
      reportLocation?: typeof reportLocation;
      manager?: {
        stage: object;
        container: HTMLElement;
        on: (event: string, listener: (...args: unknown[]) => void) => void;
        off: (event: string, listener: (...args: unknown[]) => void) => void;
        views: { all: () => Array<{ expand: () => void }> };
      };
    };
    runtimeRendition.reportLocation = reportLocation;
    runtimeRendition.manager = {
      stage: {},
      container: document.createElement('div'),
      on: (event, listener) => {
        managerListeners.set(event, listener);
      },
      off: (event) => {
        managerListeners.delete(event);
      },
      views: { all: () => [{ expand: vi.fn() }] },
    };

    try {
      const session = new ReaderSession('book.epub');
      const viewport = document.createElement('div');
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 640));
      await session.open(
        viewport,
        'epubcfi(/6/4!/4/14/1:350)',
        null,
        null,
        defaultAppearance,
        vi.fn(),
        vi.fn(),
      );
      mockRendition.display.mockClear();

      managerListeners.get('resize')?.();
      expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('epubcfi(/6/4!/4/14/1:350)');
      expect(reportLocation).not.toHaveBeenCalled();

      session.destroy();
    } finally {
      delete runtimeRendition.reportLocation;
      delete runtimeRendition.manager;
    }
  });
});
