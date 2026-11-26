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
    next: vi.fn(async () => {}),
    prev: vi.fn(async () => {}),
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

  it('defers viewport resizes while open is awaiting initial location readiness and flushes the latest size afterward', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    let resolveDisplay = () => {};
    const displayGate = new Promise<void>((resolve) => {
      resolveDisplay = resolve;
    });
    const rawManagerResize = vi.fn();
    const queuedRendition = {
      location: undefined as Location | undefined,
      manager: {
        isRendered: () => true,
        resize: rawManagerResize,
      },
      q: {
        running: false,
        length: () => 0,
        enqueue: vi.fn((task: () => Promise<void>) => task()),
      },
      hooks: { content: { register: vi.fn() } },
      on: vi.fn(),
      off: vi.fn(),
      started: Promise.resolve(),
      themes: { register: vi.fn(), select: vi.fn() },
      annotations: { highlight: vi.fn(), remove: vi.fn() },
      display: vi.fn(() => displayGate),
      resize: vi.fn((width?: number, height?: number) => {
        queuedRendition.manager.resize(width, height);
      }),
      destroy: vi.fn(),
    };
    mockBook.renderTo.mockReturnValueOnce(queuedRendition as unknown as typeof mockRendition);

    const viewport = document.createElement('div');
    let currentRect = new DOMRect(0, 0, 411, 842);
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => currentRect);

    const session = new ReaderSession('book.epub');
    const openPromise = session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );
    await Promise.resolve();

    currentRect = new DOMRect(0, 0, 411, 880);
    queuedRendition.manager.resize();
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 411, height: 880 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    currentRect = new DOMRect(0, 0, 411, 914);
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 411, height: 914 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    expect(rawManagerResize).not.toHaveBeenCalled();
    expect(queuedRendition.resize).not.toHaveBeenCalled();

    resolveDisplay();
    await openPromise;
    expect(queuedRendition.resize).not.toHaveBeenCalled();

    const relocated = queuedRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as
      ((value: Location) => void) | undefined;
    const initialLocation = location('epubcfi(/6/2!/4/2/1:0)');
    queuedRendition.location = initialLocation;
    relocated?.(initialLocation);

    await vi.waitFor(() => {
      expect(queuedRendition.resize).toHaveBeenCalledExactlyOnceWith(411, 914);
    });
    expect(rawManagerResize).toHaveBeenCalledExactlyOnceWith(411, 914, undefined);
    session.destroy();
  });

  it('keeps userNavigationPending intact when open emits its queued relocated event after next starts', async () => {
    let resolveNext = () => {};
    const nextGate = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    const queuedRendition = {
      location: undefined as Location | undefined,
      q: {
        running: false,
        length: () => 0,
        enqueue: vi.fn((task: () => Promise<void>) => task()),
      },
      hooks: { content: { register: vi.fn() } },
      on: vi.fn(),
      off: vi.fn(),
      started: Promise.resolve(),
      themes: { register: vi.fn(), select: vi.fn() },
      annotations: { highlight: vi.fn(), remove: vi.fn() },
      display: vi.fn(async () => {}),
      next: vi.fn(() => nextGate),
      resize: vi.fn(),
      destroy: vi.fn(),
    };
    mockBook.renderTo.mockReturnValueOnce(queuedRendition as unknown as typeof mockRendition);

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
    const relocated = queuedRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as
      ((value: Location) => void) | undefined;

    const nextPromise = session.next();

    const chapter1Location = {
      start: {
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        href: 'first.xhtml',
        index: 0,
        percentage: 0,
        displayed: { page: 1, total: 1 },
      },
    } as Location;
    queuedRendition.location = chapter1Location;
    relocated?.(chapter1Location);

    resolveNext();
    await nextPromise;

    const chapter2Location = {
      start: {
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        href: 'second.xhtml',
        index: 1,
        percentage: 0.5,
        displayed: { page: 1, total: 1 },
      },
    } as Location;
    queuedRendition.location = chapter2Location;
    relocated?.(chapter2Location);

    expect(onLocation).toHaveBeenCalledTimes(2);
    expect(onLocation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cfi: 'epubcfi(/6/2!/4/2/1:0)', spineIndex: 0 }),
      'restore',
    );
    expect(onLocation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cfi: 'epubcfi(/6/4!/4/2/1:0)', spineIndex: 1 }),
      'navigation',
    );
    session.destroy();
  });

  it('defers viewport resizes arriving between next() resolution and Chapter 2 relocated emission', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const rawManagerResize = vi.fn();
    const queuedRendition = {
      location: undefined as Location | undefined,
      manager: {
        isRendered: () => true,
        resize: rawManagerResize,
      },
      q: {
        running: false,
        length: () => 0,
        enqueue: vi.fn((task: () => Promise<void>) => task()),
      },
      hooks: { content: { register: vi.fn() } },
      on: vi.fn(),
      off: vi.fn(),
      started: Promise.resolve(),
      themes: { register: vi.fn(), select: vi.fn() },
      annotations: { highlight: vi.fn(), remove: vi.fn() },
      display: vi.fn(async () => {}),
      next: vi.fn(async () => {}),
      resize: vi.fn((width?: number, height?: number) => {
        queuedRendition.manager.resize(width, height);
      }),
      destroy: vi.fn(),
    };
    mockBook.renderTo.mockReturnValueOnce(queuedRendition as unknown as typeof mockRendition);

    const viewport = document.createElement('div');
    let currentRect = new DOMRect(0, 0, 411, 842);
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => currentRect);

    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());
    const relocated = queuedRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as
      ((value: Location) => void) | undefined;

    const chapter1Location = {
      start: {
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        href: 'first.xhtml',
        index: 0,
        percentage: 0,
        displayed: { page: 1, total: 1 },
      },
    } as Location;
    queuedRendition.location = chapter1Location;
    relocated?.(chapter1Location);

    // next() resolves while queuedRendition.location is still Chapter 1 (awaiting RAF)
    await session.next();

    // Android system-bar / Stage resize arrives before Chapter 2's relocated event
    currentRect = new DOMRect(0, 0, 411, 914);
    queuedRendition.manager.resize();
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 411, height: 914 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    expect(queuedRendition.resize).not.toHaveBeenCalled();
    expect(rawManagerResize).not.toHaveBeenCalled();

    // Chapter 2 RAF relocation fires; deferred resize flushes with Chapter 2 active
    const chapter2Location = {
      start: {
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        href: 'second.xhtml',
        index: 1,
        percentage: 0.5,
        displayed: { page: 1, total: 1 },
      },
    } as Location;
    queuedRendition.location = chapter2Location;
    relocated?.(chapter2Location);

    await vi.waitFor(() => {
      expect(queuedRendition.resize).toHaveBeenCalledExactlyOnceWith(411, 914);
    });
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'epubcfi(/6/4!/4/2/1:0)', spineIndex: 1 }),
      'navigation',
    );
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

  it('captures the rendered start CFI before next runs so a queued relocation firing with the new chapter reports navigation', async () => {
    let resolveNext = () => {};
    const nextGate = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    const chapter1Location = {
      start: {
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        href: 'first.xhtml',
        index: 0,
        percentage: 0,
        displayed: { page: 1, total: 1 },
      },
    } as Location;
    const chapter2Location = {
      start: {
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        href: 'second.xhtml',
        index: 1,
        percentage: 0.5,
        displayed: { page: 1, total: 1 },
      },
    } as Location;
    let liveRenderedLocation: Location = chapter1Location;

    const queuedRendition = {
      location: undefined as Location | undefined,
      manager: {
        isRendered: () => true,
        currentLocation: () => liveRenderedLocation,
        resize: vi.fn(),
      },
      located: (raw: unknown) => raw as Location,
      q: {
        running: false,
        length: () => 0,
        enqueue: vi.fn((task: () => Promise<void>) => task()),
      },
      hooks: { content: { register: vi.fn() } },
      on: vi.fn(),
      off: vi.fn(),
      started: Promise.resolve(),
      themes: { register: vi.fn(), select: vi.fn() },
      annotations: { highlight: vi.fn(), remove: vi.fn() },
      display: vi.fn(async () => {}),
      next: vi.fn(() => {
        liveRenderedLocation = chapter2Location;
        return nextGate;
      }),
      resize: vi.fn(),
      destroy: vi.fn(),
    };
    mockBook.renderTo.mockReturnValueOnce(queuedRendition as unknown as typeof mockRendition);

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
    const relocated = queuedRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as
      ((value: Location) => void) | undefined;

    // Start next() before open()'s initial rAF relocation ran; manager synchronously advances view to Chapter 2
    const nextPromise = session.next();

    // open()'s queued rAF fires just before nextGate resolves and observes liveRenderedLocation (Chapter 2)
    queuedRendition.location = chapter2Location;
    relocated?.(chapter2Location);

    resolveNext();
    await nextPromise;

    // next()'s own rAF fires afterward on the same Chapter 2 CFI
    relocated?.(chapter2Location);

    expect(onLocation).toHaveBeenCalledTimes(2);
    expect(onLocation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cfi: 'epubcfi(/6/4!/4/2/1:0)', spineIndex: 1 }),
      'navigation',
    );
    expect(onLocation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cfi: 'epubcfi(/6/4!/4/2/1:0)', spineIndex: 1 }),
      'restore',
    );
    session.destroy();
  });

  it('clears stale selection when CFI changes across resize or navigation while keeping unchanged-CFI selections', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    mockBook.spine.sections = [
      { href: 'first.xhtml', index: 0 },
      { href: 'second.xhtml', index: 1 },
    ];
    const viewport = document.createElement('div');
    const container = document.createElement('div');
    container.className = 'epub-container';
    const frame = document.createElement('iframe');
    container.append(frame);
    viewport.append(container);
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 640));
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 640));
    const frameRect = vi
      .spyOn(frame, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 720, 640));

    const onLocation = vi.fn();
    const onSelection = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
      onSelection,
    );
    const prepareContents = mockRendition.hooks.content.register.mock.calls[0]?.[0];
    const relocated = getRenditionListener('relocated');

    const doc = document.implementation.createHTMLDocument('chapter');
    const secondColumnLink = doc.createElement('a');
    secondColumnLink.setAttribute('href', '#note');
    secondColumnLink.textContent = 'Note';
    vi.spyOn(secondColumnLink, 'getClientRects').mockReturnValue([
      new DOMRect(400, 40, 60, 18),
    ] as unknown as DOMRectList);
    doc.body.append(secondColumnLink);
    await prepareContents({
      window: { frameElement: frame },
      document: doc,
      sectionIndex: 0,
      cfiFromRange: () => 'cfi',
    });

    const initialLocation = location('epubcfi(/6/2!/4/2/1:0)');
    mockRendition.location = initialLocation;
    relocated(initialLocation);
    expect(secondColumnLink.getAttribute('tabindex')).toBe('-1');
    onSelection.mockClear();

    // Resize that keeps the same start CFI must not wipe an active selection.
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 400, height: 640 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    expect(mockRendition.resize).toHaveBeenCalledWith(400, 640);
    relocated(initialLocation);
    expect(onSelection).not.toHaveBeenCalled();

    // Resize reflow that shifts to a new column/CFI clears stale selection and syncs visible links.
    container.scrollLeft = 360;
    frameRect.mockReturnValue(new DOMRect(-360, 0, 720, 640));
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 420, height: 640 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    const shiftedLocation = location('epubcfi(/6/2!/4/4/1:0)');
    mockRendition.location = shiftedLocation;
    relocated(shiftedLocation);
    expect(onSelection).toHaveBeenCalledExactlyOnceWith(null);
    expect(secondColumnLink.getAttribute('tabindex')).toBeNull();
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'epubcfi(/6/2!/4/4/1:0)' }),
      'restore',
    );

    // Explicit page turn also clears selection and reports navigation origin.
    onSelection.mockClear();
    await session.next();
    relocated({
      start: {
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        href: 'second.xhtml',
        index: 1,
        percentage: 0.5,
        displayed: { page: 1, total: 2 },
      },
    } as Location);
    expect(onSelection).toHaveBeenCalledExactlyOnceWith(null);
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'epubcfi(/6/4!/4/2/1:0)', spineIndex: 1 }),
      'navigation',
    );
    session.destroy();
  });

  it('preserves link return semantics across deferred viewport resizes and layout reflows without leaking stale link origins', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    mockBook.spine.sections = [{ href: 'chapter.xhtml', index: 0 }];
    const rawManagerResize = vi.fn();
    const queuedRendition = {
      location: undefined as Location | undefined,
      manager: {
        isRendered: () => true,
        resize: rawManagerResize,
      },
      q: {
        running: false,
        length: () => 0,
        enqueue: vi.fn((task: () => Promise<void>) => task()),
      },
      hooks: { content: { register: vi.fn() } },
      on: vi.fn(),
      off: vi.fn(),
      started: Promise.resolve(),
      themes: { register: vi.fn(), select: vi.fn() },
      annotations: { highlight: vi.fn(), remove: vi.fn() },
      display: vi.fn(async () => {}),
      next: vi.fn(async () => {}),
      resize: vi.fn((width?: number, height?: number) => {
        queuedRendition.manager.resize(width, height);
      }),
      destroy: vi.fn(),
    };
    mockBook.renderTo.mockReturnValueOnce(queuedRendition as unknown as typeof mockRendition);

    const viewport = document.createElement('div');
    let currentRect = new DOMRect(0, 0, 411, 842);
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => currentRect);

    const onLocation = vi.fn();
    const onSelection = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
      onSelection,
    );
    const relocated = queuedRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as
      ((value: Location) => void) | undefined;
    const click = queuedRendition.on.mock.calls.find(([name]) => name === 'click')?.[1] as
      ((event: unknown, contents: unknown) => void) | undefined;

    const source = {
      start: {
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        href: 'chapter.xhtml',
        index: 0,
        percentage: 0,
        displayed: { page: 1, total: 4 },
      },
    } as Location;
    queuedRendition.location = source;
    relocated?.(source);
    onSelection.mockClear();

    const footnoteLink = document.createElement('a');
    footnoteLink.setAttribute('href', '#footnote-1');
    click?.(
      { target: footnoteLink, clientX: 80 },
      { window: { getSelection: () => ({ isCollapsed: true }) } },
    );

    // Viewport resize arrives mid-link-jump: must defer until link destination relocation settles.
    currentRect = new DOMRect(0, 0, 411, 914);
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 411, height: 914 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    expect(queuedRendition.resize).not.toHaveBeenCalled();

    const destination = {
      start: {
        cfi: 'epubcfi(/6/2!/4/18/1:0)',
        href: 'chapter.xhtml',
        index: 0,
        percentage: 0.75,
        displayed: { page: 4, total: 4 },
      },
    } as Location;
    queuedRendition.location = destination;
    relocated?.(destination);

    expect(onSelection).toHaveBeenCalledExactlyOnceWith(null);
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('link');
    expect(onLocation.mock.calls.at(-1)?.[2]).toEqual({
      cfi: 'epubcfi(/6/2!/4/2/1:0)',
      href: 'chapter.xhtml',
    });

    await vi.waitFor(() => {
      expect(queuedRendition.resize).toHaveBeenCalledExactlyOnceWith(411, 914);
    });

    // Post-resize relocation and appearance reflow report 'restore' without leaking 'link' or clearing return targets via 'navigation'.
    relocated?.(destination);
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');
    expect(onLocation.mock.calls.at(-1)).toHaveLength(2);

    queuedRendition.display.mockClear();
    session.applyAppearance({ ...defaultAppearance, fontSize: 22 });
    expect(queuedRendition.display).toHaveBeenCalledExactlyOnceWith('epubcfi(/6/2!/4/18/1:0)');
    relocated?.(destination);
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');
    expect(onLocation.mock.calls.at(-1)).toHaveLength(2);

    // Clicking a same-CFI anchor while a layout reflow is pending clears pending link state so it never leaks.
    queuedRendition.display.mockClear();
    click?.(
      { target: footnoteLink, clientX: 80 },
      { window: { getSelection: () => ({ isCollapsed: true }) } },
    );
    session.applyAppearance({ ...defaultAppearance, fontSize: 24 });
    expect(queuedRendition.display).not.toHaveBeenCalled();

    relocated?.(destination);
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');
    expect(onLocation.mock.calls.at(-1)).toHaveLength(2);
    expect(queuedRendition.display).toHaveBeenCalledExactlyOnceWith('epubcfi(/6/2!/4/18/1:0)');

    const afterReflow = {
      start: {
        cfi: 'epubcfi(/6/2!/4/20/1:0)',
        href: 'chapter.xhtml',
        index: 0,
        percentage: 0.8,
        displayed: { page: 4, total: 5 },
      },
    } as Location;
    queuedRendition.location = afterReflow;
    relocated?.(afterReflow);
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');
    expect(onLocation.mock.calls.at(-1)).toHaveLength(2);

    session.destroy();
  });
});
