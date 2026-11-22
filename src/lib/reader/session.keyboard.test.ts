// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateVirtualWindow } from '../components/library-virtualization';
import { defaultAppearance } from './appearance';
import {
  TOC_OVERSCAN_ROWS,
  TOC_ROW_HEIGHT_PX,
  getRenderedTocIndices,
  indexToc,
  sectionLabelForHref,
} from './toc';

type TestTocItem = { label: string; href: string; subitems?: TestTocItem[] };

const { mockBook, mockRendition, defaultSpineHrefs } = vi.hoisted(() => {
  const spineHrefs = ['first.xhtml', 'second.xhtml'];
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
    packaging: { navPath: '' as string | false, ncxPath: '' as string | false },
    spine: {
      each: vi.fn((visit: (section: { href: string }) => void) => {
        for (const href of spineHrefs) visit({ href });
      }),
    },
    navigation: { toc: [] as TestTocItem[] },
  };
  return { mockBook: book, mockRendition: rendition, defaultSpineHrefs: spineHrefs };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => mockBook) }));

import { ReaderSession } from './session';

describe('ReaderSession keyboard navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultSpineHrefs.splice(0, defaultSpineHrefs.length, 'first.xhtml', 'second.xhtml');
    mockBook.packaging = { navPath: '', ncxPath: '' };
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

  it('normalizes subdirectory nav.xhtml and display targets to OPF-relative spine hrefs', async () => {
    defaultSpineHrefs.splice(
      0,
      defaultSpineHrefs.length,
      'Text/part-one.xhtml',
      'Text/Chapter%201.xhtml',
    );
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
    defaultSpineHrefs.splice(
      0,
      defaultSpineHrefs.length,
      ...Array.from({ length: chapterCount }, (_, idx) => `Text/ch-${idx + 1}.xhtml`),
    );
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
});
