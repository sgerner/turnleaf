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

import { ReaderSession } from './session';

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
});
