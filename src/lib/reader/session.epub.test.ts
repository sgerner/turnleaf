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
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    resize: vi.fn(),
    destroy: vi.fn(),
    location: undefined as Location | { start: { cfi: string } } | undefined,
    manager: undefined as { views?: { length?: number } } | undefined,
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
  event: 'click' | 'keydown' | 'relocated' | 'resized',
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
    mockRendition.location = undefined;
    mockRendition.manager = undefined;
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

  it('defers viewport resize while an unlocated EPUB view awaits its initial relocation', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    mockRendition.manager = { views: { length: 1 } };

    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 412, 867));
    const session = new ReaderSession('book.epub');
    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn());

    expect(mockBook.renderTo).toHaveBeenCalledWith(
      viewport,
      expect.objectContaining({
        width: 412,
        height: 867,
        resizeOnOrientationChange: false,
      }),
    );

    resizeCallbacks[0]?.(
      [{ contentRect: { width: 412, height: 915 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    expect(mockRendition.resize).not.toHaveBeenCalled();

    const initialLocation = location('epubcfi(/6/2!/4/2/1:0)');
    mockRendition.location = initialLocation;
    const relocated = getRenditionListener('relocated');
    relocated(initialLocation);

    expect(mockRendition.resize).toHaveBeenCalledExactlyOnceWith(
      412,
      915,
      'epubcfi(/6/2!/4/2/1:0)',
    );
    session.destroy();
  });

  it('waits for an unlocated initial view relocation before recording a user page turn', async () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    mockRendition.manager = { views: { length: 1 } };

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
    const nextPromise = session.next();
    expect(mockRendition.next).not.toHaveBeenCalled();

    const firstChapter = location('epubcfi(/6/2!/4/2/1:0)');
    mockRendition.location = firstChapter;
    relocated(firstChapter);
    rafCallbacks.shift()?.(16);
    await nextPromise;

    expect(mockRendition.next).toHaveBeenCalledOnce();
    const secondChapter = location('epubcfi(/6/4!/4/2/1:0)');
    mockRendition.location = secondChapter;
    relocated(secondChapter);

    expect(onLocation.mock.calls[0]?.[1]).toBe('restore');
    expect(onLocation.mock.calls[1]?.[1]).toBe('navigation');
    expect(onLocation.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ cfi: 'epubcfi(/6/4!/4/2/1:0)' }),
    );
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

  it('keeps waiting across multiple animation frames until initial relocation actually fires', async () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    mockRendition.manager = { views: { length: 1 } };

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
    const nextPromise = session.next();

    // Even if multiple animation frames elapse (EPUB.js Queue tick + reportLocation rAF)
    // before relocated emits, next() must not arm userNavigationPending prematurely.
    rafCallbacks.shift()?.(16);
    rafCallbacks.shift()?.(32);
    await Promise.resolve();
    expect(mockRendition.next).not.toHaveBeenCalled();

    const firstChapter = location('epubcfi(/6/2!/4/2/1:0)');
    mockRendition.location = firstChapter;
    relocated(firstChapter);
    await nextPromise;

    expect(mockRendition.next).toHaveBeenCalledOnce();
    const secondChapter = location('epubcfi(/6/4!/4/2/1:0)');
    mockRendition.location = secondChapter;
    relocated(secondChapter);

    expect(onLocation.mock.calls.map((call) => [call[0].cfi, call[1]])).toEqual([
      ['epubcfi(/6/2!/4/2/1:0)', 'restore'],
      ['epubcfi(/6/4!/4/2/1:0)', 'navigation'],
    ]);
    session.destroy();
  });

  it('waits for an in-flight resize relocation before turning to the next chapter', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    mockRendition.manager = { views: { length: 1 } };

    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 412, 867));
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());

    resizeCallbacks[0]?.(
      [{ contentRect: { width: 412, height: 915 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    const relocated = getRenditionListener('relocated');
    const resized = getRenditionListener('resized');
    mockRendition.resize.mockImplementationOnce(() => {
      resized();
    });

    const firstChapter = location('epubcfi(/6/2!/4/2/1:0)');
    mockRendition.location = firstChapter;
    relocated(firstChapter);
    expect(mockRendition.resize).toHaveBeenCalledExactlyOnceWith(
      412,
      915,
      'epubcfi(/6/2!/4/2/1:0)',
    );

    const nextPromise = session.next();
    await Promise.resolve();
    expect(mockRendition.next).not.toHaveBeenCalled();

    // Resized re-display of Chapter 1 finishes relocating first as 'restore'.
    relocated(firstChapter);
    await nextPromise;
    expect(mockRendition.next).toHaveBeenCalledOnce();

    const secondChapter = location('epubcfi(/6/4!/4/2/1:0)');
    mockRendition.location = secondChapter;
    relocated(secondChapter);

    expect(onLocation.mock.calls.map((call) => [call[0].cfi, call[1]])).toEqual([
      ['epubcfi(/6/2!/4/2/1:0)', 'restore'],
      ['epubcfi(/6/2!/4/2/1:0)', 'restore'],
      ['epubcfi(/6/4!/4/2/1:0)', 'navigation'],
    ]);
    session.destroy();
  });

  it('does not flush the resize fallback timer with a stale CFI while user navigation is pending', async () => {
    vi.useFakeTimers();
    try {
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
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 412, 867));
      const onLocation = vi.fn();
      const session = new ReaderSession('book.epub');
      await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());

      const relocated = getRenditionListener('relocated');
      const firstChapter = location('epubcfi(/6/2!/4/2/1:0)');
      mockRendition.location = firstChapter;
      relocated(firstChapter);

      await session.next();
      resizeCallbacks[0]?.(
        [{ contentRect: { width: 412, height: 915 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );

      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockRendition.resize).not.toHaveBeenCalled();

      const secondChapter = location('epubcfi(/6/4!/4/2/1:0)');
      mockRendition.location = secondChapter;
      relocated(secondChapter);

      expect(mockRendition.resize).toHaveBeenCalledExactlyOnceWith(
        412,
        915,
        'epubcfi(/6/4!/4/2/1:0)',
      );
      expect(onLocation).toHaveBeenLastCalledWith(
        expect.objectContaining({ cfi: 'epubcfi(/6/4!/4/2/1:0)' }),
        'navigation',
      );
      session.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
