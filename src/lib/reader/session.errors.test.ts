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
    rendition.display.mockImplementation(async () => {});
    rendition.next.mockImplementation(async () => {});
    rendition.prev.mockImplementation(async () => {});
    rendition.getContents.mockReturnValue([]);
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
});
