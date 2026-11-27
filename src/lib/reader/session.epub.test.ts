// @vitest-environment jsdom

import type { Contents, Location } from 'epubjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateVirtualWindow } from '../components/library-virtualization';
import { defaultAppearance, type Appearance } from './appearance';
import {
  TOC_OVERSCAN_ROWS,
  TOC_ROW_HEIGHT_PX,
  getRenderedTocIndices,
  indexToc,
  sectionLabelForHref,
} from './toc';

type TestTocItem = { label: string; href: string; subitems?: TestTocItem[] };
type TestSpineSection = { href: string; index: number };

const { defaultSpineSections, mockBook, mockRendition } = vi.hoisted(() => {
  const defaultSpineSections: TestSpineSection[] = [
    { href: 'first.xhtml', index: 0 },
    { href: 'second.xhtml', index: 1 },
  ];
  const rendition = {
    hooks: { content: { register: vi.fn() }, unloaded: { register: vi.fn() } },
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
    packaging: { navPath: '' as string | false, ncxPath: '' as string | false },
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
    mockRendition.display.mockImplementation(async () => {});
    mockRendition.resize.mockImplementation(() => {});
    mockRendition.getContents.mockReturnValue([]);
    (mockRendition as { views?: unknown }).views = undefined;
    mockBook.packaging = { navPath: '', ncxPath: '' };
    mockBook.navigation.toc = [];
    mockBook.spine.sections = [...defaultSpineSections];
    mockRendition.location = undefined;
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

    // Link or page relocation cancels pending debounce and clears active selection immediately.
    const relocated = getRenditionListener('relocated');
    const click = getRenditionListener('click');
    relocated(location('source-cfi'));
    selection.addRange(range);
    vi.advanceTimersByTime(0);
    cfiFromRange.mockClear();
    onSelection.mockClear();
    document.dispatchEvent(new Event('selectionchange'));
    const internalLink = document.createElement('a');
    internalLink.setAttribute('href', '#footnote');
    click(
      { target: internalLink, clientX: 100 },
      { window: { getSelection: () => ({ isCollapsed: true }) } },
    );
    relocated(location('destination-cfi'));
    expect(onSelection).toHaveBeenCalledExactlyOnceWith(null);
    vi.advanceTimersByTime(200);
    expect(cfiFromRange).not.toHaveBeenCalled();

    // Pending timers and listeners are cleaned up on destroy.
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

  it('keeps the selected passage active when Tab blurs the EPUB iframe', async () => {
    vi.useFakeTimers();
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
    vi.advanceTimersByTime(120);
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

    // Pressing Tab before the 120 ms selection debounce fires flushes immediately and keeps selection on blur.
    onSelection.mockClear();
    collapsed = false;
    doc.dispatchEvent(new Event('selectionchange'));
    expect(onSelection).not.toHaveBeenCalled();
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(onSelection).toHaveBeenCalledExactlyOnceWith({
      cfi: 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:25)',
      text: 'Selected with Shift+Arrow',
    });
    highlightButton.focus();
    contentsWindow.dispatchEvent(new Event('blur'));
    collapsed = true;
    doc.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(200);
    expect(onSelection).toHaveBeenCalledTimes(1);

    // clearTextSelection resets the Tab-blur guard and cancels pending timers; Escape flushes before key handling.
    session.clearTextSelection();
    doc.dispatchEvent(new Event('selectionchange'));
    expect(onSelection).toHaveBeenLastCalledWith(null);
    onSelection.mockClear();
    collapsed = false;
    doc.dispatchEvent(new Event('selectionchange'));
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onSelection).toHaveBeenCalledExactlyOnceWith({
      cfi: 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:25)',
      text: 'Selected with Shift+Arrow',
    });

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

  it('normalizes subdirectory nav.xhtml and display targets to OPF-relative spine hrefs', async () => {
    mockBook.spine.sections = [
      { href: 'Text/part-one.xhtml', index: 0 },
      { href: 'Text/Chapter%201.xhtml', index: 1 },
    ];
    mockBook.packaging = { navPath: 'Text/nav.xhtml', ncxPath: false };
    mockBook.navigation.toc = [
      {
        label: 'Part One',
        href: 'part-one.xhtml#opening',
        subitems: [{ label: 'Chapter One', href: 'Chapter 1.xhtml#scene-1' }],
      },
    ];

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

    const toc = session.tableOfContents();
    expect(toc).toEqual([
      {
        label: 'Part One',
        href: 'Text/part-one.xhtml#opening',
        children: [{ label: 'Chapter One', href: 'Text/Chapter%201.xhtml#scene-1', children: [] }],
      },
    ]);

    mockRendition.display.mockClear();
    await session.display('Chapter 1.xhtml#scene-1');
    expect(mockRendition.display).toHaveBeenCalledWith('Text/Chapter%201.xhtml#scene-1');
    session.destroy();
  });

  it('indexes and windows a 1,500-chapter table of contents without scanning every row', () => {
    const chapterCount = 1_500;
    mockBook.spine.sections = Array.from({ length: chapterCount }, (_, index) => ({
      href: `Text/ch-${index + 1}.xhtml`,
      index,
    }));
    mockBook.packaging = { navPath: 'Text/nav.xhtml', ncxPath: 'toc.ncx' };
    mockBook.navigation.toc = Array.from({ length: chapterCount }, (_, idx) => ({
      label: `Chapter ${idx + 1}`,
      href: `ch-${idx + 1}.xhtml#start`,
    }));

    const session = new ReaderSession('book.epub');
    const indexed = indexToc(session.tableOfContents());
    expect(indexed.items).toHaveLength(chapterCount);
    expect(sectionLabelForHref(indexed.labels, 'Text/ch-1200.xhtml', 1_199)).toBe('Chapter 1200');
    expect(sectionLabelForHref(indexed.labels, 'Text/missing.xhtml', 1_499)).toBe('Section 1500');

    const activeRow = indexed.firstRowBySectionHref.get('Text/ch-900.xhtml')!;
    expect(activeRow).toBe(899);

    const window = calculateVirtualWindow(
      indexed.items.length,
      1,
      TOC_ROW_HEIGHT_PX,
      activeRow * TOC_ROW_HEIGHT_PX,
      384,
      TOC_OVERSCAN_ROWS,
    );
    const rendered = getRenderedTocIndices(indexed.items.length, window, -1);

    expect(rendered[0]).toBe(0);
    expect(rendered.at(-1)).toBe(1_499);
    expect(rendered).toContain(activeRow);
    expect(rendered.length).toBeLessThan(25);
    session.destroy();
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

    // Chapter with zero highlights skips resizeCheck and SVG creation completely.
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
    expect(emptyView.contents.resizeCheck).not.toHaveBeenCalled();
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

    // Single-page layout change realigns highlights via resizeCheck even without view reframe, including publisherStyles toggles.
    pendingReflowRects = [new DOMRect(40, 112, 200, 30)];
    session.applyAppearance({ ...defaultAppearance, fontSize: 28, margin: 32 });
    expect(resizeCheck).toHaveBeenCalledTimes(2);
    const realignedRect = viewElement.querySelector('g.turnleaf-highlight rect');
    expect(realignedRect?.getAttribute('x')).toBe('40');
    expect(realignedRect?.getAttribute('y')).toBe('112');
    expect(realignedRect?.getAttribute('width')).toBe('200');
    expect(realignedRect?.getAttribute('height')).toBe('30');

    pendingReflowRects = [new DOMRect(28, 96, 224, 28)];
    session.applyAppearance({
      ...defaultAppearance,
      fontSize: 28,
      margin: 32,
      publisherStyles: false,
    });
    expect(resizeCheck).toHaveBeenCalledTimes(3);
    const publisherOverrideRect = viewElement.querySelector('g.turnleaf-highlight rect');
    expect(publisherOverrideRect?.getAttribute('x')).toBe('28');
    expect(publisherOverrideRect?.getAttribute('y')).toBe('96');
    expect(publisherOverrideRect?.getAttribute('width')).toBe('224');
    expect(publisherOverrideRect?.getAttribute('height')).toBe('28');

    // Clearing highlights removes the SVG overlay; re-adding and unloading/removing view cleans up state.
    session.updateHighlights([]);
    expect(viewElement.querySelector('svg')).toBeNull();

    session.updateHighlights([{ cfi: validCfi }]);
    expect(viewElement.querySelector('svg')).not.toBeNull();
    const unloaded = mockRendition.hooks.unloaded.register.mock.calls[0]?.[0];
    unloaded?.(view);
    expect(viewElement.querySelector('svg')).toBeNull();

    rendered({ index: 0 }, view);
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

  it('aborts an in-flight display during a resize, cleans up the aborted view, and reports the final CFI', async () => {
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

    const firstHighlightCfi = 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:8)';
    const secondHighlightCfi = 'epubcfi(/6/4!/4/2/1:0,/1:0,/1:8)';
    const initialCfi = 'epubcfi(/6/2!/4/2/1:0)';
    const targetCfi = 'epubcfi(/6/4!/4/2/1:0)';
    const finalCfi = 'epubcfi(/6/2!/4/2/1:6)';

    const viewport = document.createElement('div');
    const container = document.createElement('div');
    container.className = 'epub-container';
    viewport.append(container);
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));

    let activeViews: unknown[] = [];
    (mockRendition as { views?: () => unknown[] }).views = () => activeViews;

    const onLocation = vi.fn();
    const onSelection = vi.fn();
    const session = new ReaderSession('book.epub');
    session.updateHighlights([{ cfi: firstHighlightCfi }, { cfi: secondHighlightCfi }]);

    await session.open(
      viewport,
      initialCfi,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
      onSelection,
    );

    const prepareContents = mockRendition.hooks.content.register.mock.calls[0]?.[0];
    const registerSelection = mockRendition.hooks.content.register.mock.calls[1]?.[0];
    const rendered = mockRendition.on.mock.calls.find(([name]) => name === 'rendered')?.[1];
    const resized = mockRendition.on.mock.calls.find(([name]) => name === 'resized')?.[1];
    const relocated = getRenditionListener('relocated');

    const makeView = (sectionIndex: number, rect: DOMRect) => {
      const element = document.createElement('div');
      const iframe = document.createElement('iframe');
      element.append(iframe);
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 480, 640));
      vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 480, 640));
      const doc = document.implementation.createHTMLDocument(`section-${sectionIndex}`);
      const paragraph = doc.createElement('p');
      paragraph.textContent = `Section ${sectionIndex} passage`;
      doc.body.append(paragraph);
      const contentsWindow = new EventTarget() as Window & EventTarget;
      Object.defineProperties(contentsWindow, {
        frameElement: { value: iframe, configurable: true },
        scrollX: { value: 0 },
        scrollY: { value: 0 },
        getSelection: {
          value: () => ({
            isCollapsed: false,
            rangeCount: 1,
            toString: () => paragraph.textContent ?? '',
            getRangeAt: () => {
              const range = doc.createRange();
              range.selectNodeContents(paragraph);
              return range;
            },
          }),
        },
      });
      const contents = {
        document: doc,
        window: contentsWindow,
        sectionIndex,
        resizeCheck: vi.fn(),
        cfiFromRange: () => `epubcfi(/6/${(sectionIndex + 1) * 2}!/4/2/1:0,/1:0,/1:7)`,
        range: () => ({ getClientRects: () => [rect] }) as unknown as Range,
      };
      return {
        index: sectionIndex,
        displayed: true as boolean,
        element,
        iframe,
        contents: contents as typeof contents | undefined,
        rawContents: contents,
      };
    };

    const initialView = makeView(0, new DOMRect(20, 32, 160, 20));
    container.append(initialView.element);
    activeViews = [initialView];
    await prepareContents(initialView.rawContents);
    registerSelection(initialView.rawContents);
    rendered({ index: 0 }, initialView);
    relocated({
      start: {
        cfi: initialCfi,
        href: 'first.xhtml',
        index: 0,
        percentage: 0,
        displayed: { page: 1, total: 4 },
      },
    } as Location);

    expect(initialView.element.querySelector('svg.turnleaf-highlight-layer')).not.toBeNull();

    // Start a debounced selection on Chapter 1, then kick off an in-flight display to Chapter 2.
    initialView.rawContents.document.dispatchEvent(new Event('selectionchange'));
    onLocation.mockClear();
    onSelection.mockClear();

    const abortedView = makeView(1, new DOMRect(24, 40, 180, 22));
    let rejectInFlightDisplay: ((reason?: unknown) => void) | null = null;
    mockRendition.display.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          container.append(abortedView.element);
          activeViews = [abortedView];
          rejectInFlightDisplay = reject;
        }),
    );

    const inFlightDisplay = session.displayCfi(targetCfi);

    // Resize arrives while displayCfi(targetCfi) is still in flight, clearing views and aborting the display.
    mockRendition.resize.mockImplementationOnce(() => {
      initialView.displayed = false;
      initialView.contents = undefined;
      initialView.element.remove();
      abortedView.element.remove();
      activeViews = [];
      rejectInFlightDisplay?.(new Error('Display aborted by resize'));
      resized?.();
    });

    resizeCallbacks[0]?.(
      [{ contentRect: { width: 480, height: 640 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    expect(mockRendition.resize).toHaveBeenCalledWith(480, 640);
    expect(await inFlightDisplay).toBe(false);

    // Late callbacks from the orphaned view must not render overlays, run resizeCheck, or attach listeners.
    await prepareContents(abortedView.rawContents);
    registerSelection(abortedView.rawContents);
    rendered({ index: 1 }, abortedView);
    abortedView.rawContents.document.dispatchEvent(new Event('selectionchange'));
    expect(abortedView.rawContents.resizeCheck).not.toHaveBeenCalled();
    expect(abortedView.element.querySelector('svg')).toBeNull();
    expect(initialView.element.querySelector('svg')).toBeNull();

    // The resize reflow completes on Chapter 1 and reports the final reflowed CFI as a restore.
    const resizedView = makeView(0, new DOMRect(36, 64, 240, 24));
    container.append(resizedView.element);
    activeViews = [resizedView];
    await prepareContents(resizedView.rawContents);
    registerSelection(resizedView.rawContents);
    rendered({ index: 0 }, resizedView);
    relocated({
      start: {
        cfi: finalCfi,
        href: 'first.xhtml',
        index: 0,
        percentage: 0.1,
        displayed: { page: 1, total: 6 },
      },
    } as Location);

    vi.advanceTimersByTime(200);

    expect(onSelection).toHaveBeenCalledExactlyOnceWith(null);
    expect(resizedView.rawContents.resizeCheck).toHaveBeenCalledOnce();
    const resizedRect = resizedView.element.querySelector('g.turnleaf-highlight rect');
    expect(resizedRect?.getAttribute('x')).toBe('36');
    expect(resizedRect?.getAttribute('y')).toBe('64');
    expect(onLocation).toHaveBeenCalledOnce();
    expect(onLocation.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        cfi: finalCfi,
        href: 'first.xhtml',
        spineIndex: 0,
        pageIndex: 0,
        pageCount: 6,
      }),
    );
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

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
      { publisherStyles: false },
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
});
