// @vitest-environment jsdom

import ePub, { type Book, type Location, type Rendition } from 'epubjs';
import JSZip from 'jszip';
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

async function buildTestEpub(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-epub-concurrency</dc:identifier>
    <dc:title>Concurrency Fixture</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`,
  );
  zip.file(
    'OEBPS/text/chapter1.xhtml',
    `<!doctype html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head>
<body><p id="c1">First chapter opening paragraph.</p></body></html>`,
  );
  zip.file(
    'OEBPS/text/chapter2.xhtml',
    `<!doctype html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 2</title></head>
<body><p id="c2">Second chapter opening paragraph.</p></body></html>`,
  );
  return zip.generateAsync({ type: 'arraybuffer' });
}

function setupJsdomEpubEnvironment(
  getViewportSize: () => { width: number; height: number } = () => ({ width: 360, height: 640 }),
): { resizeCallbacks: ResizeObserverCallback[] } {
  const resizeCallbacks: ResizeObserverCallback[] = [];
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
    observe(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('innerWidth', 1024);
  vi.stubGlobal('innerHeight', 1024);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

  const patchWindowGeometry = (win: Window & typeof globalThis) => {
    win.scrollTo = (() => {}) as typeof win.scrollTo;
    const rangeProto = win.Range?.prototype as
      | (Range & {
          getBoundingClientRect?: () => DOMRect;
          getClientRects?: () => DOMRectList;
        })
      | undefined;
    if (rangeProto && typeof rangeProto.getBoundingClientRect !== 'function') {
      rangeProto.getBoundingClientRect = () => new DOMRect(0, 0, 240, 120);
    }
    if (rangeProto && typeof rangeProto.getClientRects !== 'function') {
      rangeProto.getClientRects = () => [new DOMRect(0, 0, 240, 120)] as unknown as DOMRectList;
    }
    const elementProto = win.HTMLElement?.prototype;
    if (elementProto) {
      elementProto.getBoundingClientRect = function (this: HTMLElement) {
        const { width, height } = getViewportSize();
        const styleWidth = Number.parseFloat(this.style?.width || '');
        const styleHeight = Number.parseFloat(this.style?.height || '');
        return new DOMRect(
          0,
          0,
          Number.isFinite(styleWidth) && styleWidth > 0 ? styleWidth : Math.min(240, width),
          Number.isFinite(styleHeight) && styleHeight > 0 ? styleHeight : Math.min(120, height),
        );
      };
    }
  };

  patchWindowGeometry(window);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const { width, height } = getViewportSize();
    const styleWidth = Number.parseFloat(this.style?.width || '');
    const styleHeight = Number.parseFloat(this.style?.height || '');
    return new DOMRect(
      0,
      0,
      Number.isFinite(styleWidth) && styleWidth > 0 ? styleWidth : width,
      Number.isFinite(styleHeight) && styleHeight > 0 ? styleHeight : height,
    );
  });

  const originalAppendChild = Node.prototype.appendChild;
  vi.spyOn(Node.prototype, 'appendChild').mockImplementation(function <T extends Node>(
    this: Node,
    child: T,
  ): T {
    const result = originalAppendChild.call(this, child) as T;
    if (child.nodeName === 'IFRAME') {
      const frame = child as unknown as HTMLIFrameElement;
      if (frame.contentWindow) {
        patchWindowGeometry(frame.contentWindow as Window & typeof globalThis);
      }
      frame.addEventListener(
        'load',
        () => {
          if (frame.contentWindow) {
            patchWindowGeometry(frame.contentWindow as Window & typeof globalThis);
          }
        },
        { once: true },
      );
    }
    return result;
  });

  return { resizeCallbacks };
}

describe('ReaderSession error events, timeouts, and retry URLs', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('aborts a display that is in flight during a resize and checks the final CFI', async () => {
    const { default: realEpub } = await vi.importActual<{ default: typeof ePub }>('epubjs');
    const epubBuffer = await buildTestEpub();

    let viewportWidth = 360;
    let viewportHeight = 640;
    const { resizeCallbacks } = setupJsdomEpubEnvironment(() => ({
      width: viewportWidth,
      height: viewportHeight,
    }));
    const viewport = document.createElement('div');
    document.body.appendChild(viewport);

    let realBook!: Book;
    let realRendition!: Rendition;
    let pauseChapter2 = false;
    let chapter2EnteredLoad: (() => void) | null = null;
    const pausedChapter2: { reject: ((reason?: unknown) => void) | null } = { reject: null };

    vi.mocked(ePub).mockImplementationOnce(() => {
      realBook = realEpub(epubBuffer);
      const originalLoad = realBook.load.bind(realBook);
      realBook.load = ((path: string) => {
        if (pauseChapter2 && path.includes('chapter2.xhtml')) {
          return new Promise<unknown>((_resolve, reject) => {
            pausedChapter2.reject = reject;
            chapter2EnteredLoad?.();
          });
        }
        return originalLoad(path);
      }) as typeof realBook.load;
      const originalRenderTo = realBook.renderTo.bind(realBook);
      realBook.renderTo = ((element: Element, options?: Parameters<Book['renderTo']>[1]) => {
        realRendition = originalRenderTo(element, options);
        return realRendition;
      }) as Book['renderTo'];
      return realBook;
    });

    const onLocation = vi.fn();
    const session = new ReaderSession('lorem-ipsum.epub', { displayTimeoutMs: 500 });

    try {
      await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());
      await vi.waitFor(() => {
        expect(onLocation).toHaveBeenCalled();
      });

      const initialLocation = onLocation.mock.calls.at(-1)?.[0] as { cfi: string; href: string };
      expect(initialLocation.href).toContain('chapter1.xhtml');
      expect(initialLocation.cfi).toMatch(/^epubcfi\(/);
      const initialCfi = initialLocation.cfi;

      onLocation.mockClear();
      pauseChapter2 = true;
      const chapter2InFlight = new Promise<void>((resolveLoad) => {
        chapter2EnteredLoad = resolveLoad;
      });

      const abortedNavigation = session.display('text/chapter2.xhtml');
      await chapter2InFlight;

      // Resize while chapter 2 display is in flight: EPUB.js clears views, aborts the in-flight
      // displaying promise, and queues a re-display of the pre-resize CFI.
      viewportWidth = 480;
      viewportHeight = 640;
      resizeCallbacks[0]?.(
        [{ contentRect: { width: 480, height: 640 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      pauseChapter2 = false;
      pausedChapter2.reject?.(new DOMException('Aborted in-flight chapter load', 'AbortError'));

      await expect(abortedNavigation).resolves.toBeUndefined();
      await vi.waitFor(() => {
        expect(onLocation).toHaveBeenCalled();
      });

      const finalAfterResize = onLocation.mock.calls.at(-1);
      expect(finalAfterResize?.[0]).toEqual(
        expect.objectContaining({
          cfi: initialCfi,
          href: initialLocation.href,
        }),
      );
      expect(finalAfterResize?.[1]).toBe('restore');
      expect(realRendition.location?.start?.cfi).toBe(initialCfi);

      // Verify navigation state is clean after the resize-aborted display.
      onLocation.mockClear();
      await session.display('text/chapter2.xhtml');
      await vi.waitFor(() => {
        expect(onLocation).toHaveBeenCalledWith(
          expect.objectContaining({ href: 'text/chapter2.xhtml' }),
          'navigation',
        );
      });
      expect(onLocation.mock.calls.at(-1)?.[0].cfi).not.toBe(initialCfi);
    } finally {
      session.destroy();
      viewport.remove();
    }
  });

  it('unblocks EPUB.js queued displays after displayerror and display timeouts without rejecting queued operations', async () => {
    const { default: realEpub } = await vi.importActual<{ default: typeof ePub }>('epubjs');
    const epubBuffer = await buildTestEpub();
    setupJsdomEpubEnvironment();

    const viewport = document.createElement('div');
    document.body.appendChild(viewport);

    let chapter2Mode: 'error' | 'stall' | 'ok' = 'error';

    vi.mocked(ePub).mockImplementationOnce(() => {
      const realBook = realEpub(epubBuffer);
      const originalLoad = realBook.load.bind(realBook);
      realBook.load = ((path: string) => {
        if (path.includes('chapter2.xhtml')) {
          if (chapter2Mode === 'error') {
            return Promise.reject(new Error('Corrupt chapter 2 stream'));
          }
          if (chapter2Mode === 'stall') {
            return new Promise<unknown>(() => {});
          }
        }
        return originalLoad(path);
      }) as typeof realBook.load;
      return realBook;
    });

    const onLocation = vi.fn();
    const session = new ReaderSession('lorem-ipsum.epub', { displayTimeoutMs: 60 });

    try {
      await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());
      await vi.waitFor(() => {
        expect(onLocation).toHaveBeenCalled();
      });

      // Queue next() behind a failing display() on real rendition.q: only display() rejects,
      // settleRenditionDisplaying unblocks rendition.q, and next() resolves cleanly.
      const failingDisplay = session.display('text/chapter2.xhtml');
      const queuedNext = session.next();

      await expect(failingDisplay).rejects.toThrow('Corrupt chapter 2 stream');
      await expect(queuedNext).resolves.toBeUndefined();

      // Now stall chapter 2 to trigger displayTimeoutMs and verify rendition.q still unblocks.
      chapter2Mode = 'stall';
      await expect(session.display('text/chapter2.xhtml')).rejects.toThrow(
        'Timed out while displaying this section.',
      );

      chapter2Mode = 'ok';
      onLocation.mockClear();
      await expect(session.display('text/chapter2.xhtml')).resolves.toBeUndefined();
      await vi.waitFor(() => {
        expect(onLocation).toHaveBeenCalledWith(
          expect.objectContaining({ href: 'text/chapter2.xhtml' }),
          'navigation',
        );
      });
    } finally {
      session.destroy();
      viewport.remove();
    }
  });

  it('stops queued EPUB.js rendition tasks and pending location frames when destroyed', async () => {
    const { default: realEpub } = await vi.importActual<{ default: typeof ePub }>('epubjs');
    const epubBuffer = await buildTestEpub();
    setupJsdomEpubEnvironment();

    const unhandled: unknown[] = [];
    const uncaught: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUncaught);

    const viewport = document.createElement('div');
    document.body.appendChild(viewport);

    vi.mocked(ePub).mockImplementationOnce(() => {
      return realEpub(epubBuffer);
    });

    const onLocation = vi.fn();
    const session = new ReaderSession('lorem-ipsum.epub');

    try {
      await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());
      const pendingDisplay = session.display('text/chapter2.xhtml');
      const pendingNext = session.next();

      onLocation.mockClear();
      session.destroy();

      await expect(pendingDisplay).resolves.toBeUndefined();
      await expect(pendingNext).resolves.toBeUndefined();
      await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame(undefined)));
      await new Promise((resolveTick) => setTimeout(resolveTick, 30));

      expect(onLocation).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      process.off('uncaughtException', onUncaught);
      viewport.remove();
    }
  });
});
