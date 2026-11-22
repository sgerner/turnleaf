// @vitest-environment jsdom

import type { Location } from 'epubjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

interface SimulatedHarness {
  views: string[];
  activeChapter: number;
  location: Location | undefined;
  renderOptions: Record<string, unknown> | undefined;
  resizeCalls: Array<{ width: number; height: number; cfi: string | undefined }>;
  stageWindowResizeRemoved: boolean;
}

const { createBook, getHarness } = vi.hoisted(() => {
  let currentHarness: SimulatedHarness | null = null;

  function makeLocation(chapterIndex: number): Location {
    const chapterNumber = chapterIndex + 1;
    const start = {
      cfi: `epubcfi(/6/${chapterNumber * 2}!/4/2/1:0)`,
      href: `ch${chapterNumber}.xhtml`,
      index: chapterIndex,
      percentage: chapterIndex / 2,
      displayed: { page: 1, total: 1 },
    };
    return {
      start,
      end: start,
      atStart: chapterIndex === 0,
      atEnd: chapterIndex === 1,
    } as Location;
  }

  function createBookInstance() {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const rafQueue: FrameRequestCallback[] = [];
    let queueChain = Promise.resolve();
    let queueDepth = 0;

    const stageResizeListener = vi.fn();
    const stageOrientationListener = vi.fn();

    const harness: SimulatedHarness = {
      views: [],
      activeChapter: 0,
      location: undefined,
      renderOptions: undefined,
      resizeCalls: [],
      stageWindowResizeRemoved: false,
    };
    currentHarness = harness;

    const emit = (event: string, ...args: unknown[]) => {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args);
      }
    };

    const enqueue = <T>(task: () => T | Promise<T>): Promise<T> => {
      queueDepth += 1;
      rendition.q.running = true;
      const next = queueChain.then(task);
      queueChain = next.then(
        () => {
          queueDepth -= 1;
          rendition.q.running = queueDepth > 0 ? next : undefined;
        },
        () => {
          queueDepth -= 1;
          rendition.q.running = queueDepth > 0 ? next : undefined;
        },
      );
      return next;
    };

    const scheduleReportLocation = () =>
      enqueue(() => {
        requestAnimationFrame(() => {
          if (harness.views.length === 0) return;
          const located = makeLocation(harness.activeChapter);
          harness.location = located;
          rendition.location = located;
          emit('relocated', located);
        });
      });

    const displayTarget = (target?: string) =>
      enqueue(async () => {
        await Promise.resolve();
        if (target?.includes('/4!') || target === 'ch2.xhtml') {
          harness.activeChapter = 1;
        } else if (target?.includes('/2!') || target === 'ch1.xhtml' || target === undefined) {
          harness.activeChapter = 0;
        }
        harness.views = [`ch${harness.activeChapter + 1}.xhtml`];
      }).then(() => {
        void scheduleReportLocation();
      });

    const rendition = {
      hooks: { content: { register: vi.fn() } },
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(handler);
      }),
      off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(handler);
      }),
      started: Promise.resolve(),
      themes: { register: vi.fn(), select: vi.fn() },
      annotations: { highlight: vi.fn(), remove: vi.fn() },
      location: undefined as Location | undefined,
      displaying: undefined as unknown,
      q: {
        enqueue,
        running: undefined as unknown,
      },
      manager: {
        _stageSize: undefined as unknown,
        stage: {
          resizeFunc: stageResizeListener as unknown as EventListener,
          orientationChangeFunc: stageOrientationListener as unknown as EventListener,
        },
      },
      display: vi.fn((target?: string) => displayTarget(target)),
      next: vi.fn(() => {
        if (harness.views.length === 0) return Promise.resolve();
        return enqueue(async () => {
          await Promise.resolve();
          harness.activeChapter = Math.min(1, harness.activeChapter + 1);
          harness.views = [`ch${harness.activeChapter + 1}.xhtml`];
        }).then(() => {
          void scheduleReportLocation();
        });
      }),
      prev: vi.fn(() => {
        if (harness.views.length === 0) return Promise.resolve();
        return enqueue(async () => {
          await Promise.resolve();
          harness.activeChapter = Math.max(0, harness.activeChapter - 1);
          harness.views = [`ch${harness.activeChapter + 1}.xhtml`];
        }).then(() => {
          void scheduleReportLocation();
        });
      }),
      resize: vi.fn((width: number, height: number, cfi?: string) => {
        harness.resizeCalls.push({ width, height, cfi });
        // Mirrors EPUB.js DefaultViewManager.resize + Rendition.onResized:
        // views are cleared synchronously and only re-displayed if rendition.location.start exists.
        harness.views = [];
        if (rendition.location?.start) {
          void rendition.display(cfi || rendition.location.start.cfi);
        }
      }),
      destroy: vi.fn(),
    };

    void rafQueue;

    return {
      renderTo: vi.fn((_target: HTMLElement, options: Record<string, unknown>) => {
        harness.renderOptions = options;
        window.addEventListener('resize', stageResizeListener, false);
        window.addEventListener('orientationchange', stageOrientationListener, false);
        const origRemove = window.removeEventListener.bind(window);
        vi.spyOn(window, 'removeEventListener').mockImplementation(
          (
            type: string,
            listener: EventListenerOrEventListenerObject,
            optionsArg?: boolean | EventListenerOptions,
          ) => {
            if (listener === (stageResizeListener as unknown as EventListener)) {
              harness.stageWindowResizeRemoved = true;
            }
            origRemove(type, listener, optionsArg);
          },
        );
        return rendition;
      }),
      destroy: vi.fn(),
      spine: {
        each: vi.fn((visit: (section: { href: string; index: number }) => void) => {
          visit({ href: 'ch1.xhtml', index: 0 });
          visit({ href: 'ch2.xhtml', index: 1 });
        }),
      },
      navigation: { toc: [] },
    };
  }

  return {
    createBook: createBookInstance,
    getHarness: () => currentHarness!,
  };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => createBook()) }));

import { ReaderSession } from './session';

describe('ReaderSession queued resize and relocation coordination', () => {
  let resizeCallbacks: ResizeObserverCallback[] = [];
  let pendingRafs: FrameRequestCallback[] = [];

  beforeEach(() => {
    resizeCallbacks = [];
    pendingRafs = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      pendingRafs.push(callback);
      return pendingRafs.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function flushAnimationFrames(maxRounds = 12): Promise<void> {
    for (let round = 0; round < maxRounds; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (pendingRafs.length === 0) continue;
      const batch = pendingRafs.splice(0, pendingRafs.length);
      for (const callback of batch) callback(performance.now());
    }
  }

  function triggerResize(width: number, height: number): void {
    resizeCallbacks[0]?.(
      [{ contentRect: { width, height } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  }

  function createViewport(width = 412, height = 867): HTMLDivElement {
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, height));
    return viewport;
  }

  it('defers immersive-chrome viewport resizes during initial open until initial relocation settles', async () => {
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    const viewport = createViewport(412, 867);

    await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());
    const harness = getHarness();

    expect(harness.renderOptions).toMatchObject({
      width: 412,
      height: 867,
      resizeOnOrientationChange: false,
    });
    expect(harness.stageWindowResizeRemoved).toBe(true);
    expect(harness.views).toEqual(['ch1.xhtml']);
    expect(harness.location).toBeUndefined();

    // Android immersive system-bar inset update arrives before EPUB.js runs its RAF relocation.
    triggerResize(412, 915);
    expect(harness.resizeCalls).toHaveLength(0);
    expect(harness.views).toEqual(['ch1.xhtml']);

    await flushAnimationFrames();

    expect(harness.resizeCalls).toEqual([
      { width: 412, height: 915, cfi: 'epubcfi(/6/2!/4/2/1:0)' },
    ]);
    expect(harness.views).toEqual(['ch1.xhtml']);
    expect(onLocation).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'ch1.xhtml', percentage: 0 }),
      'restore',
    );
    session.destroy();
  });

  it('preserves target chapter and navigation origin when a viewport resize arrives mid-page-turn', async () => {
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    const viewport = createViewport(412, 867);

    await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());
    await flushAnimationFrames();
    onLocation.mockClear();

    await session.next();
    const harness = getHarness();
    expect(harness.views).toEqual(['ch2.xhtml']);

    // Resize arrives after next() swapped views to ch2, before ch2's RAF relocation updates rendition.location.
    triggerResize(412, 915);
    expect(harness.resizeCalls).toHaveLength(0);

    await flushAnimationFrames();

    expect(harness.views).toEqual(['ch2.xhtml']);
    expect(harness.resizeCalls).toEqual([
      { width: 412, height: 915, cfi: 'epubcfi(/6/4!/4/2/1:0)' },
    ]);
    expect(onLocation).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'ch2.xhtml', percentage: 0.5 }),
      'navigation',
    );
    session.destroy();
  });

  it('waits for initial relocation and startup resize before executing next() so navigation progress is saved', async () => {
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    const viewport = createViewport(412, 867);

    await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());

    // Both immersive resize and user "Next page" click arrive before Chapter 1's RAF relocation runs.
    triggerResize(412, 915);
    const nextPromise = session.next();

    await flushAnimationFrames();
    await nextPromise;
    await flushAnimationFrames();

    const harness = getHarness();
    expect(harness.views).toEqual(['ch2.xhtml']);
    expect(onLocation).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'ch1.xhtml', percentage: 0 }),
      'restore',
    );
    expect(onLocation).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'ch2.xhtml', percentage: 0.5 }),
      'navigation',
    );
    session.destroy();
  });
});
