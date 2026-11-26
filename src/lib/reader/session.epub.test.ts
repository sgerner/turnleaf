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
    display: vi.fn(async (_target?: string) => {}),
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

import {
  parseExternalLink,
  ReaderSession,
  resolveReaderKeyboardAction,
  sanitizeEpubDocument,
  validateExternalBrowserUrl,
  validateExternalLaunchUrl,
} from './session';

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

  it('defers viewport resizes while initial display is in flight and re-displays when manager views clear before location settles', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    let resolveInitialDisplay!: () => void;
    let displayCallCount = 0;
    mockRendition.display.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          displayCallCount += 1;
          if (displayCallCount === 1) {
            resolveInitialDisplay = resolve;
          } else {
            resolve();
          }
        }),
    );
    const renditionWithManager = mockRendition as typeof mockRendition & {
      manager?: Record<string, unknown> | undefined;
    };
    renditionWithManager.manager = {};
    mockRendition.location = undefined;

    try {
      const viewport = document.createElement('div');
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 412, 851));

      const session = new ReaderSession('book.epub');
      const openPromise = session.open(
        viewport,
        'epubcfi(/6/4!/4/2)',
        null,
        null,
        defaultAppearance,
        vi.fn(),
        vi.fn(),
      );

      await vi.waitFor(() => {
        expect(mockRendition.display).toHaveBeenCalledTimes(1);
      });

      resizeCallbacks[0]?.(
        [{ contentRect: { width: 412, height: 915 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      expect(mockRendition.resize).not.toHaveBeenCalled();

      resolveInitialDisplay();
      await openPromise;

      expect(mockRendition.resize).toHaveBeenCalledWith(412, 915);
      expect(mockRendition.display).toHaveBeenCalledTimes(2);
      expect(mockRendition.display).toHaveBeenNthCalledWith(2, 'epubcfi(/6/4!/4/2)');
      session.destroy();
    } finally {
      delete renditionWithManager.manager;
      mockRendition.location = undefined;
      mockRendition.display.mockImplementation(async () => {});
    }
  });

  it('does not let a delayed initial restore relocation consume pending next-page user navigation', async () => {
    const renditionWithNext = mockRendition as typeof mockRendition & {
      next?: () => Promise<void>;
    };
    renditionWithNext.next = vi.fn(async () => {});
    mockRendition.getContents.mockReturnValue([
      {
        document,
        window: { getSelection: () => ({ isCollapsed: true }) },
        sectionIndex: 0,
      },
    ]);

    try {
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
      await session.next();

      // Chapter 1's queued requestAnimationFrame relocation arrives before Chapter 2's relocation.
      relocated({
        start: {
          cfi: 'epubcfi(/6/2!/4/2/1:0)',
          href: 'first.xhtml',
          index: 0,
          percentage: 0,
          displayed: { page: 1, total: 1 },
        },
      } as Location);
      relocated({
        start: {
          cfi: 'epubcfi(/6/4!/4/2/1:0)',
          href: 'second.xhtml',
          index: 1,
          percentage: 0.5,
          displayed: { page: 1, total: 1 },
        },
      } as Location);

      expect(onLocation).toHaveBeenCalledTimes(2);
      expect(onLocation.mock.calls[0]?.[0]).toMatchObject({
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        spineIndex: 0,
      });
      expect(onLocation.mock.calls[0]?.[1]).toBe('restore');
      expect(onLocation.mock.calls[1]?.[0]).toMatchObject({
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        spineIndex: 1,
      });
      expect(onLocation.mock.calls[1]?.[1]).toBe('navigation');
      session.destroy();
    } finally {
      delete renditionWithNext.next;
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

  it('validates http, https, and mailto URLs while rejecting unsafe or credentialed links', () => {
    expect(parseExternalLink('https://example.org/docs?q=1')).toEqual({
      href: 'https://example.org/docs?q=1',
      scheme: 'https:',
    });
    expect(parseExternalLink('http://example.org/page')).toEqual({
      href: 'http://example.org/page',
      scheme: 'http:',
    });
    expect(parseExternalLink('mailto:reader@example.org?subject=Note')).toEqual({
      href: 'mailto:reader@example.org?subject=Note',
      scheme: 'mailto:',
    });

    expect(parseExternalLink('https://user:pass@example.org/')).toBeNull();
    expect(parseExternalLink('javascript:alert(1)')).toBeNull();
    expect(parseExternalLink('file:///etc/passwd')).toBeNull();
    expect(parseExternalLink('//evil.example/path')).toBeNull();
    expect(parseExternalLink('mailto:not-an-email')).toBeNull();
    expect(parseExternalLink('https://example.org/%E0%A4%A')).toBeNull();

    expect(validateExternalBrowserUrl('https://example.org/ref')).toBe('https://example.org/ref');
    expect(validateExternalBrowserUrl('mailto:reader@example.org')).toBeNull();
    expect(validateExternalLaunchUrl('mailto:reader@example.org')).toBe(
      'mailto:reader@example.org',
    );
  });

  it('routes sanitized external links, hidden EPUB 3 footnotes, and chapter figures to inspectors while preserving visible section jumps', async () => {
    mockBook.spine.sections = [{ href: 'chapter.xhtml', index: 0 }];
    const onLocation = vi.fn();
    const onTap = vi.fn();
    const onExternalLink = vi.fn();
    const onFootnote = vi.fn();
    const onFigure = vi.fn();
    const session = new ReaderSession('book.epub');
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 640));

    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      onTap,
      undefined,
      undefined,
      { onExternalLink, onFootnote, onFigure },
    );

    const registeredTheme = mockRendition.themes.register.mock.calls.at(-1)?.[1] as Record<
      string,
      Record<string, string>
    >;
    expect(registeredTheme['a[href], a[data-turnleaf-external-href]']).toMatchObject({
      'text-decoration': 'underline !important',
    });
    expect(registeredTheme['a:not([href]):not([data-turnleaf-external-href])']).toMatchObject({
      color: 'inherit !important',
      'text-decoration': 'none !important',
    });

    const hardenHook = mockRendition.hooks.content.register.mock.calls[0]?.[0] as (
      contents: unknown,
    ) => Promise<void>;
    const relocated = getRenditionListener('relocated');

    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <p>
          <a id="ext" href="https://example.org/reference">Reference site</a>
          <a id="mail" href="mailto:author@example.org">Email author</a>
          <a id="unsafe" href="javascript:alert(1)">Unsafe prose</a>
          <a id="noteref" epub:type="noteref" href="#fn-1">[1]</a>
          <a id="jump" href="#part-2">Jump to section</a>
        </p>
        <h2 id="part-2">Part Two</h2>
        <aside id="fn-1" epub:type="footnote" hidden>
          <p><a epub:type="backlink" href="#noteref">↩</a> Clarifying footnote text without leaving the page.</p>
        </aside>
        <figure>
          <img id="chart" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" alt=" Orbit diagram " />
          <figcaption>Figure 1: Orbital eccentricity across epochs.</figcaption>
        </figure>
        <figure>
          <svg id="vector" width="240" height="120" xmlns="http://www.w3.org/2000/svg">
            <title>Phase plot</title>
            <path d="M 0 0 L 120 60" stroke="currentColor" />
          </svg>
          <figcaption>Figure 2: Phase trajectory.</figcaption>
        </figure>
        <figure>
          <svg id="wrapped-bitmap" viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">
            <image href="blob:http://localhost/diagram-bitmap" width="800" height="600" />
          </svg>
          <figcaption>Figure 3: Wrapped bitmap diagram.</figcaption>
        </figure>
      </body></html>`,
      'text/html',
    );

    const contents = {
      document: doc,
      window: {
        getSelection: () => ({ isCollapsed: true }),
      },
      sectionIndex: 0,
    };
    await hardenHook(contents);
    relocated(location('source-cfi'));

    const ext = doc.getElementById('ext')!;
    expect(ext.hasAttribute('href')).toBe(false);
    expect(ext.getAttribute('role')).toBe('link');
    expect(ext.getAttribute('tabindex')).toBe('0');
    expect(ext.getAttribute('data-turnleaf-external-href')).toBe('https://example.org/reference');

    const unsafe = doc.getElementById('unsafe')!;
    expect(unsafe.hasAttribute('href')).toBe(false);
    expect(unsafe.hasAttribute('role')).toBe(false);
    expect(unsafe.hasAttribute('tabindex')).toBe(false);
    expect(unsafe.hasAttribute('data-turnleaf-external-href')).toBe(false);

    ext.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onExternalLink).toHaveBeenCalledExactlyOnceWith(
      {
        href: 'https://example.org/reference',
        scheme: 'https:',
        label: 'Reference site',
      },
      ext,
    );

    const mail = doc.getElementById('mail')!;
    mail.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(onExternalLink).toHaveBeenLastCalledWith(
      {
        href: 'mailto:author@example.org',
        scheme: 'mailto:',
        label: 'Email author',
      },
      mail,
    );

    const noteref = doc.getElementById('noteref')!;
    let epubDefaultClickRan = false;
    noteref.addEventListener('click', () => {
      epubDefaultClickRan = true;
    });
    noteref.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(epubDefaultClickRan).toBe(false);
    expect(onFootnote).toHaveBeenCalledExactlyOnceWith(
      {
        title: 'Footnote 1',
        paragraphs: ['Clarifying footnote text without leaving the page.'],
      },
      noteref,
    );

    const chart = doc.getElementById('chart')!;
    expect(chart.getAttribute('role')).toBe('button');
    expect(chart.getAttribute('tabindex')).toBe('0');
    chart.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onFigure).toHaveBeenCalledExactlyOnceWith(
      {
        src: expect.stringContaining('data:image/png;base64,'),
        alt: 'Orbit diagram',
        caption: 'Figure 1: Orbital eccentricity across epochs.',
      },
      chart,
    );

    const vector = doc.getElementById('vector')!;
    expect(vector.getAttribute('role')).toBe('button');
    vector.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    expect(onFigure).toHaveBeenLastCalledWith(
      {
        src: expect.stringContaining('data:image/svg+xml;charset=utf-8,'),
        alt: 'Phase plot',
        caption: 'Figure 2: Phase trajectory.',
      },
      vector,
    );

    const wrappedBitmap = doc.getElementById('wrapped-bitmap')!;
    expect(wrappedBitmap.getAttribute('role')).toBe('button');
    wrappedBitmap.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onFigure).toHaveBeenLastCalledWith(
      {
        src: 'blob:http://localhost/diagram-bitmap',
        alt: 'Figure 3: Wrapped bitmap diagram.',
        caption: 'Figure 3: Wrapped bitmap diagram.',
      },
      wrappedBitmap,
    );

    // Visible non-footnote internal link still navigates normally with Return to link tracking
    const click = getRenditionListener('click');
    const jump = doc.getElementById('jump')!;
    click({ target: jump, clientX: 120 }, contents);
    relocated(location('part-2-cfi'));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('link');
    expect(onLocation.mock.calls.at(-1)?.[2]).toEqual({
      cfi: 'source-cfi',
      href: 'chapter.xhtml',
    });
    expect(onTap).not.toHaveBeenCalled();

    await sanitizeEpubDocument(doc);
    session.destroy();
  });

  it('renders accessible 44x44 highlight overlay buttons without mutating chapter text and routes taps to #reader-annotations', async () => {
    const onTap = vi.fn();
    const onHighlight = vi.fn();
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 560));

    const chapterDoc = new DOMParser().parseFromString(
      '<!doctype html><html><body><p id="p1">Highlighted passage on current page.</p><p id="p2">Offscreen passage.</p></body></html>',
      'text/html',
    );
    const initialHtml = chapterDoc.body.innerHTML;

    const frame = document.createElement('iframe');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 560));

    const visibleCfi = 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:19)';
    const offscreenCfi = 'epubcfi(/6/2!/4/4/1:0,/1:0,/1:17)';

    const visibleRange = chapterDoc.createRange();
    visibleRange.selectNodeContents(chapterDoc.getElementById('p1')!);
    visibleRange.getClientRects = () => [new DOMRect(40, 80, 120, 20)] as unknown as DOMRectList;

    const offscreenRange = chapterDoc.createRange();
    offscreenRange.selectNodeContents(chapterDoc.getElementById('p2')!);
    offscreenRange.getClientRects = () => [new DOMRect(380, 80, 120, 20)] as unknown as DOMRectList;

    const activeContents = {
      document: chapterDoc,
      window: {
        frameElement: frame,
        getSelection: () => ({ isCollapsed: true }),
      },
      range: (cfi: string) => {
        if (cfi === visibleCfi) return visibleRange;
        if (cfi === offscreenCfi) return offscreenRange;
        return null;
      },
      cfiFromRange: (range: Range) => {
        const text = range.toString();
        return text.includes('Highlighted passage') ? visibleCfi : offscreenCfi;
      },
    };
    mockRendition.getContents.mockReturnValue([activeContents]);

    const session = new ReaderSession('book.epub');
    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      onTap,
      undefined,
      undefined,
      { onHighlight },
    );

    session.updateHighlights([
      {
        id: 'ann-1',
        cfi: visibleCfi,
        excerpt: 'Highlighted passage',
        note: '',
      },
      {
        id: 'ann-2',
        cfi: offscreenCfi,
        excerpt: 'Offscreen passage',
        note: 'Later page',
      },
    ]);

    // Chapter DOM text nodes remain completely unmutated so CFIs and XPath walks stay exact
    expect(chapterDoc.body.innerHTML).toBe(initialHtml);

    const buttons = viewport.querySelectorAll<HTMLButtonElement>(
      'button.turnleaf-highlight-target',
    );
    expect(buttons).toHaveLength(1);
    const button = buttons[0]!;
    expect(button.getAttribute('aria-controls')).toBe('reader-annotations');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-label')).toBe('Highlight: “Highlighted passage”, no note');
    expect(Number.parseInt(button.style.width, 10)).toBeGreaterThanOrEqual(44);
    expect(Number.parseInt(button.style.height, 10)).toBeGreaterThanOrEqual(44);

    // Updating note reuses the existing button element and announces the note
    session.updateHighlights([
      {
        id: 'ann-1',
        cfi: visibleCfi,
        excerpt: 'Highlighted passage',
        note: 'Compare with chapter 3',
      },
    ]);
    expect(viewport.querySelector('button.turnleaf-highlight-target')).toBe(button);
    expect(button.getAttribute('aria-label')).toBe(
      'Highlight: “Highlighted passage”, with note: Compare with chapter 3',
    );

    button.click();
    expect(onHighlight).toHaveBeenCalledExactlyOnceWith(visibleCfi, button);
    expect(onTap).not.toHaveBeenCalled();

    // Clicking inside the highlighted range inside the EPUB iframe also opens Notes instead of turning pages
    const click = getRenditionListener('click');
    click(
      {
        target: chapterDoc.getElementById('p1'),
        clientX: 60,
        clientY: 90,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      },
      activeContents,
    );
    expect(onHighlight).toHaveBeenCalledTimes(2);
    expect(onTap).not.toHaveBeenCalled();

    // getVisiblePassages returns only visible prose blocks on the current page
    const createRangeSpy = vi.spyOn(chapterDoc, 'createRange').mockImplementation(() => {
      let selected: Node | null = null;
      const fakeRange = {
        selectNodeContents(node: Node) {
          selected = node;
        },
        setStart(node: Node) {
          expect(node.nodeType).toBe(3);
          selected = node.parentElement ?? node;
        },
        setEnd() {},
        getClientRects() {
          const isFirst = (selected as Element | null)?.id === 'p1';
          return [
            isFirst ? new DOMRect(40, 80, 120, 20) : new DOMRect(380, 80, 120, 20),
          ] as unknown as DOMRectList;
        },
        toString() {
          return selected?.textContent ?? '';
        },
      };
      return fakeRange as unknown as Range;
    });
    expect(session.getVisiblePassages()).toEqual([
      {
        cfi: visibleCfi,
        text: 'Highlighted passage on current page.',
      },
    ]);
    createRangeSpy.mockRestore();

    session.destroy();
  });

  it('unlocks EPUB.js contents.viewport pinch-zoom clamps during layout updates', async () => {
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

    const hardenHook = mockRendition.hooks.content.register.mock.calls[0]?.[0] as (
      contents: unknown,
    ) => Promise<void>;
    const doc = new DOMParser().parseFromString(
      '<!doctype html><html><head><meta name="viewport" content="width=320, height=560, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"></head><body><p>Hello</p></body></html>',
      'text/html',
    );
    const viewportSpy = vi.fn((options?: Record<string, string>) => options ?? {});
    const contents = {
      document: doc,
      viewport: viewportSpy,
    };

    await hardenHook(contents);
    contents.viewport({
      width: '320px',
      height: '560px',
      scale: '1.0',
      minimum: '0.5',
      maximum: '1.0',
      scalable: 'no',
    });

    expect(viewportSpy).toHaveBeenCalledWith({
      width: '320px',
      height: '560px',
      scale: '1.0',
      minimum: '0.5',
      scalable: 'yes',
    });
    const metaContent = doc.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
    expect(metaContent).not.toContain('user-scalable=no');
    expect(metaContent).not.toContain('maximum-scale');

    session.destroy();
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
        'a[href], a[data-turnleaf-external-href]': {
          color: '--color-primary-700 !important',
          'text-decoration': 'underline !important',
          cursor: 'pointer',
        },
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
        'a[href], a[data-turnleaf-external-href]': {
          color: '--color-primary-300 !important',
          'text-decoration': 'underline !important',
          cursor: 'pointer',
        },
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

  it('detaches EPUB.js Stage window resize listeners so Android inset resizes cannot race next-page navigation', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const unserializedStageResize = Object.assign(
      vi.fn(() => {
        // Simulates EPUB.js Stage window resize firing mid-next() and snapping back to Chapter 1.
        mockRendition.display('epubcfi(/6/2!/4/2/1:0)');
      }),
      { cancel: vi.fn() },
    );
    window.addEventListener('resize', unserializedStageResize, false);

    let resolveNext!: () => void;
    const renditionWithManager = mockRendition as typeof mockRendition & {
      next?: () => Promise<void>;
      manager?: { stage?: { resizeFunc?: typeof unserializedStageResize } };
    };
    renditionWithManager.next = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveNext = resolve;
        }),
    );
    renditionWithManager.manager = {
      stage: { resizeFunc: unserializedStageResize },
    };

    try {
      const viewport = document.createElement('div');
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 411, 850));

      const session = new ReaderSession('book.epub');
      await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn());
      expect(unserializedStageResize.cancel).toHaveBeenCalledOnce();

      const relocated = getRenditionListener('relocated');
      relocated({
        start: {
          cfi: 'epubcfi(/6/2!/4/2/1:0)',
          href: 'first.xhtml',
          index: 0,
          percentage: 0,
          displayed: { page: 1, total: 1 },
        },
      } as Location);
      mockRendition.display.mockClear();

      const nextPromise = session.next();
      window.dispatchEvent(new Event('resize'));
      resizeCallbacks[0]?.(
        [{ contentRect: { width: 411, height: 914 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );

      expect(unserializedStageResize).not.toHaveBeenCalled();
      expect(mockRendition.resize).not.toHaveBeenCalled();

      mockRendition.location = { start: { cfi: 'epubcfi(/6/4!/4/2/1:0)' } };
      relocated({
        start: {
          cfi: 'epubcfi(/6/4!/4/2/1:0)',
          href: 'second.xhtml',
          index: 1,
          percentage: 0.5,
          displayed: { page: 1, total: 1 },
        },
      } as Location);
      resolveNext();
      await nextPromise;

      expect(mockRendition.resize).toHaveBeenCalledExactlyOnceWith(411, 914);
      expect(mockRendition.display).not.toHaveBeenCalledWith('epubcfi(/6/2!/4/2/1:0)');
      session.destroy();
    } finally {
      window.removeEventListener('resize', unserializedStageResize, false);
      delete renditionWithManager.next;
      delete renditionWithManager.manager;
      mockRendition.location = undefined;
    }
  });
});
