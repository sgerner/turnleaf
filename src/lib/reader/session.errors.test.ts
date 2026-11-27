// @vitest-environment jsdom

import type { Book, Location } from 'epubjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

type Listener = (...args: unknown[]) => void;

const { book, rendition, emitBook, emitRendition, resetMocks } = vi.hoisted(() => {
  const bookListeners = new Map<string, Set<Listener>>();
  const renditionListeners = new Map<string, Set<Listener>>();

  const addListener = (map: Map<string, Set<Listener>>, event: string, listener: Listener) => {
    let set = map.get(event);
    if (!set) {
      set = new Set();
      map.set(event, set);
    }
    set.add(listener);
  };

  const removeListener = (map: Map<string, Set<Listener>>, event: string, listener: Listener) => {
    map.get(event)?.delete(listener);
  };

  const emit = (map: Map<string, Set<Listener>>, event: string, ...args: unknown[]) => {
    for (const listener of [...(map.get(event) ?? [])]) {
      listener(...args);
    }
  };

  const rendition = {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn((event: string, listener: Listener) => {
      addListener(renditionListeners, event, listener);
    }),
    off: vi.fn((event: string, listener: Listener) => {
      removeListener(renditionListeners, event, listener);
    }),
    started: Promise.resolve() as Promise<void>,
    location: undefined as Location | undefined,
    currentLocation: vi.fn((): Location | undefined => undefined),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async (_target?: string) => {}),
    next: vi.fn(async () => {}),
    prev: vi.fn(async () => {}),
    getContents: vi.fn(() => []),
    resize: vi.fn(),
    destroy: vi.fn(),
  };

  const book = {
    on: vi.fn((event: string, listener: Listener) => {
      addListener(bookListeners, event, listener);
    }),
    off: vi.fn((event: string, listener: Listener) => {
      removeListener(bookListeners, event, listener);
    }),
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine: {
      each: vi.fn((visit: (section: { href: string; index: number }) => void) => {
        visit({ href: 'chapter-1.xhtml', index: 0 });
        visit({ href: 'chapter-2.xhtml', index: 1 });
      }),
    },
  };

  const resetMocks = () => {
    bookListeners.clear();
    renditionListeners.clear();
    vi.clearAllMocks();
    rendition.started = Promise.resolve();
    rendition.location = undefined;
    rendition.currentLocation.mockReturnValue(undefined);
    rendition.display.mockImplementation(async () => {});
    rendition.next.mockImplementation(async () => {});
    rendition.prev.mockImplementation(async () => {});
    rendition.getContents.mockReturnValue([]);
    rendition.resize.mockReset();
  };

  return {
    book,
    rendition,
    emitBook: (event: string, ...args: unknown[]) => emit(bookListeners, event, ...args),
    emitRendition: (event: string, ...args: unknown[]) => emit(renditionListeners, event, ...args),
    resetMocks,
  };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => book) }));

import {
  READER_DISPLAY_TIMEOUT_MS,
  READER_OPEN_TIMEOUT_MS,
  ReaderSession,
  withEpubRetryParam,
} from './session';

function location(cfi: string, href = 'chapter-1.xhtml'): Location {
  return {
    start: {
      cfi,
      href,
      index: 0,
      percentage: 0.1,
      displayed: { page: 1, total: 5 },
    },
  } as Location;
}

describe('ReaderSession error events, timeouts, and retry URLs', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects open immediately when openFailed was emitted before open runs', async () => {
    const session = new ReaderSession('corrupt.epub');
    emitBook('openFailed', new Error('Cannot load book at corrupt.epub'));

    await expect(
      session.open(
        document.createElement('div'),
        null,
        null,
        null,
        defaultAppearance,
        vi.fn(),
        vi.fn(),
      ),
    ).rejects.toThrow('Cannot load book at corrupt.epub');
    expect(book.renderTo).not.toHaveBeenCalled();

    session.destroy();
    expect(book.off).toHaveBeenCalledWith('openFailed', expect.any(Function));
  });

  it('rejects open when openFailed fires while rendition.started is pending', async () => {
    rendition.started = new Promise<void>(() => {});
    const session = new ReaderSession('corrupt.epub');

    const opening = session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );
    emitBook('openFailed', new Error('Cannot load book at corrupt.epub'));

    await expect(opening).rejects.toThrow('Cannot load book at corrupt.epub');

    session.destroy();
    expect(book.off).toHaveBeenCalledWith('openFailed', expect.any(Function));
    expect(rendition.off).toHaveBeenCalledWith('displayerror', expect.any(Function));
    expect(rendition.off).toHaveBeenCalledWith('displayError', expect.any(Function));
  });

  it('times out cleanly when Book.unpack stalls and rendition.started never settles', async () => {
    vi.useFakeTimers();
    rendition.started = new Promise<void>(() => {});
    const session = new ReaderSession('stalled.epub');

    const opening = session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );
    const assertion = expect(opening).rejects.toThrow('Timed out while opening this EPUB.');

    await vi.advanceTimersByTimeAsync(READER_OPEN_TIMEOUT_MS);
    await assertion;

    session.destroy();
  });

  it('preserves fallback from a stale saved CFI on displayerror and rejects if the first chapter fails', async () => {
    rendition.display.mockImplementation((target?: string) => {
      if (target === 'epubcfi(/6/99!/4/2)') {
        emitRendition('displayerror', new Error('Missing saved section'));
        return new Promise<void>(() => {});
      }
      return Promise.resolve();
    });

    const session = new ReaderSession('updated.epub');
    await expect(
      session.open(
        document.createElement('div'),
        'epubcfi(/6/99!/4/2)',
        null,
        0.6,
        defaultAppearance,
        vi.fn(),
        vi.fn(),
      ),
    ).resolves.toBeUndefined();
    expect(rendition.display).toHaveBeenNthCalledWith(1, 'epubcfi(/6/99!/4/2)');
    expect(rendition.display).toHaveBeenNthCalledWith(2, 'chapter-2.xhtml');
    session.destroy();

    resetMocks();
    rendition.display.mockImplementation(() => {
      emitRendition('displayerror', new Error('Unreadable spine chapter'));
      return new Promise<void>(() => {});
    });

    const brokenSession = new ReaderSession('broken-chapter.epub');
    await expect(
      brokenSession.open(
        document.createElement('div'),
        null,
        null,
        null,
        defaultAppearance,
        vi.fn(),
        vi.fn(),
      ),
    ).rejects.toThrow('Unreadable spine chapter');
    brokenSession.destroy();
  });

  it('rejects navigate on displayerror, displayError, and timeouts while resetting pending navigation state', async () => {
    vi.useFakeTimers();
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

    emitRendition('relocated', location('start-cfi'));
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'start-cfi' }),
      'restore',
    );

    rendition.next.mockImplementation(() => {
      emitRendition('displayerror', new Error('Chapter inflation failed'));
      return new Promise<void>(() => {});
    });
    await expect(session.next()).rejects.toThrow('Chapter inflation failed');

    emitRendition('relocated', location('after-failed-next-cfi'));
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'after-failed-next-cfi' }),
      'restore',
    );

    const click = rendition.on.mock.calls.find(([name]) => name === 'click')?.[1] as Listener;
    const internalLink = document.createElement('a');
    internalLink.setAttribute('href', '#note-1');
    click(
      { target: internalLink, clientX: 120 },
      { window: { getSelection: () => ({ isCollapsed: true }) } },
    );

    rendition.display.mockImplementation(() => {
      emitRendition('displayError', new Error('Broken link target'));
      return new Promise<void>(() => {});
    });
    await expect(session.display('chapter-2.xhtml')).rejects.toThrow('Broken link target');

    emitRendition('relocated', location('after-failed-display-cfi'));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');
    expect(onLocation.mock.calls.at(-1)).toHaveLength(2);

    rendition.prev.mockImplementation(() => new Promise<void>(() => {}));
    const prevAttempt = session.previous();
    const prevAssertion = expect(prevAttempt).rejects.toThrow(
      'Timed out while displaying this section.',
    );
    await vi.advanceTimersByTimeAsync(READER_DISPLAY_TIMEOUT_MS);
    await prevAssertion;

    emitRendition('relocated', location('after-timeout-cfi'));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    expect(await session.displayCfi('epubcfi(/6/4!/4/2)')).toBe(false);
    expect(await session.displayServerLocation('//body/DocFragment[1]/body/p[1]')).toBe(false);

    session.destroy();
  });

  it('clears pending timers and settles without unhandled rejections when destroyed mid-startup', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      rendition.started = new Promise<void>(() => {});
      const session = new ReaderSession('closing.epub');
      const opening = session.open(
        document.createElement('div'),
        null,
        null,
        null,
        defaultAppearance,
        vi.fn(),
        vi.fn(),
      );

      expect(vi.getTimerCount()).toBe(1);
      session.destroy();
      expect(vi.getTimerCount()).toBe(0);

      await expect(opening).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(READER_OPEN_TIMEOUT_MS * 2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('appends dot-free integer retry query parameters that preserve epubjs .epub detection', async () => {
    const { default: realEpub } = await vi.importActual<{ default: () => Book }>('epubjs');
    const parserBook = realEpub();

    const initialUrl =
      'https://localhost/_capacitor_file_/data/user/0/app.turnleaf/files/books/42.epub';
    const firstRetry = withEpubRetryParam(initialUrl, 1);
    const secondRetry = withEpubRetryParam(firstRetry, 2);
    const floatInputRetry = withEpubRetryParam(
      'capacitor://localhost/_capacitor_file_/books/42.epub#cover',
      3.75,
    );

    expect(firstRetry).toBe(`${initialUrl}?retry=1`);
    expect(secondRetry).toBe(`${initialUrl}?retry=2`);
    expect(floatInputRetry).toBe(
      'capacitor://localhost/_capacitor_file_/books/42.epub?retry=3#cover',
    );
    expect(new URL(firstRetry).search).not.toContain('.');
    expect(new URL(secondRetry).search).not.toContain('.');
    expect(new URL(floatInputRetry).search).not.toContain('.');

    expect(parserBook.determineType(firstRetry)).toBe('epub');
    expect(parserBook.determineType(secondRetry)).toBe('epub');
    expect(parserBook.determineType(floatInputRetry)).toBe('epub');
    parserBook.destroy();
  });

  it('re-displays the restored CFI when epubjs emits resized before relocated populates rendition.location', async () => {
    const savedCfi = 'epubcfi(/6/4!/4/2/1:0)';
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      savedCfi,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    expect(rendition.display).toHaveBeenCalledTimes(1);
    expect(rendition.display).toHaveBeenLastCalledWith(savedCfi);

    // Simulate epub.js clearing views on resize before requestAnimationFrame sets rendition.location.
    emitRendition('resized', { width: 412, height: 915 });
    await Promise.resolve();

    expect(rendition.display).toHaveBeenCalledTimes(2);
    expect(rendition.display).toHaveBeenLastCalledWith(savedCfi);

    // Once relocated populates rendition.location, epub.js handles its own resize redisplay.
    const nextLocation = location(savedCfi, 'chapter-2.xhtml');
    rendition.location = nextLocation;
    emitRendition('relocated', nextLocation);
    emitRendition('resized', { width: 412, height: 900 });
    await Promise.resolve();

    expect(rendition.display).toHaveBeenCalledTimes(2);
    session.destroy();
  });

  it('defers ResizeObserver reflows until rendition attachment and in-flight startup display finish', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    let resolveStarted!: () => void;
    rendition.started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveInitialDisplay!: () => void;
    const savedCfi = 'epubcfi(/6/4!/4/2/1:0)';
    rendition.display.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveInitialDisplay = resolve;
        }),
    );
    rendition.resize.mockImplementation((width: number, height: number) => {
      emitRendition('resized', { width, height });
    });

    const session = new ReaderSession('book.epub');
    const opening = session.open(
      document.createElement('div'),
      savedCfi,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    // ResizeObserver firing before rendition.started / attached must not call rendition.resize yet.
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 412, height: 900 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    expect(rendition.resize).not.toHaveBeenCalled();

    resolveStarted();
    await vi.waitFor(() => {
      expect(rendition.display).toHaveBeenCalledWith(savedCfi);
    });
    emitRendition('attached');

    // ResizeObserver firing while initial display(savedCfi) is still in flight must also be deferred.
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 412, height: 915 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    expect(rendition.resize).not.toHaveBeenCalled();

    resolveInitialDisplay();
    await opening;

    // Once initial display finishes, only the latest pending size is flushed and savedCfi is preserved.
    expect(rendition.resize).toHaveBeenCalledTimes(1);
    expect(rendition.resize).toHaveBeenCalledWith(412, 915);
    expect(rendition.display).toHaveBeenCalledTimes(2);
    expect(rendition.display).toHaveBeenNthCalledWith(2, savedCfi);
    session.destroy();
  });

  it('defers ResizeObserver reflows after next() until relocated updates rendition.location', async () => {
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

    const chapter1 = location('epubcfi(/6/2!/4/2/1:0)', 'chapter-1.xhtml');
    rendition.location = chapter1;
    emitRendition('relocated', chapter1);

    await session.next();

    // ResizeObserver firing right after next() resolves (while rendition.location is still chapter 1)
    // must wait until relocated updates rendition.location to chapter 2.
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 412, height: 915 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    expect(rendition.resize).not.toHaveBeenCalled();

    const chapter2 = location('epubcfi(/6/4!/4/2/1:0)', 'chapter-2.xhtml');
    rendition.location = chapter2;
    emitRendition('relocated', chapter2);

    expect(rendition.resize).toHaveBeenCalledTimes(1);
    expect(rendition.resize).toHaveBeenCalledWith(412, 915);
    session.destroy();
  });

  it('preserves navigation origin for chapter 2 when next() starts before chapter 1 relocated RAF runs', async () => {
    const onLocation = vi.fn();
    const chapter1 = location('epubcfi(/6/2!/4/2/1:0)', 'chapter-1.xhtml');
    const chapter2 = location('epubcfi(/6/4!/4/2/1:0)', 'chapter-2.xhtml');
    rendition.currentLocation.mockReturnValue(chapter1);

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

    // User turns to chapter 2 before chapter 1's requestAnimationFrame relocated fires.
    await session.next();

    // Delayed chapter 1 relocated must report 'restore' without consuming userNavigationPending.
    emitRendition('relocated', chapter1);
    expect(onLocation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cfi: chapter1.start.cfi }),
      'restore',
    );

    // Subsequent chapter 2 relocated must still report 'navigation' so progress is persisted.
    emitRendition('relocated', chapter2);
    expect(onLocation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cfi: chapter2.start.cfi }),
      'navigation',
    );
    session.destroy();
  });
});
