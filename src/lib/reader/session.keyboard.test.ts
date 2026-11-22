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
    (mockRendition as unknown as { getContents?: () => unknown[] }).getContents = () => [
      activeContents,
    ];

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
    const click = mockRendition.on.mock.calls.find(([name]) => name === 'click')?.[1];
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
    delete (mockRendition as unknown as { getContents?: () => unknown[] }).getContents;
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
});
