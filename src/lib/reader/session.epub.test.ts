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
    mockBook.navigation.toc = [];
    mockBook.spine.sections = [...defaultSpineSections];
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
      location?: { start?: { cfi: string } } | undefined;
    };
    renditionWithManager.manager = {};
    renditionWithManager.location = undefined;

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
      delete renditionWithManager.location;
      mockRendition.display.mockImplementation(async () => {});
    }
  });

  it('does not let a delayed initial restore relocation consume pending next-page user navigation', async () => {
    const renditionWithNext = mockRendition as typeof mockRendition & {
      next?: () => Promise<void>;
      getContents?: () => unknown[];
    };
    renditionWithNext.next = vi.fn(async () => {});
    renditionWithNext.getContents = () => [
      {
        document,
        window: { getSelection: () => ({ isCollapsed: true }) },
        sectionIndex: 0,
      },
    ];

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
      delete renditionWithNext.getContents;
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
