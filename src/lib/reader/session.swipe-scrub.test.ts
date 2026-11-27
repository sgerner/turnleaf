// @vitest-environment jsdom

import type { Contents, Location } from 'epubjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

type MockSection = { href: string; index: number; pageCount: number };

const state = vi.hoisted(() => {
  let sections: MockSection[] = [];
  let sectionIndex = 0;
  let page = 1;
  let pageWidth = 400;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  function locationObject(): Location {
    const section = sections[sectionIndex] ?? sections[0]!;
    const cfi = `epubcfi(/6/${(section.index + 1) * 2}!/4/2:${page})`;
    return {
      start: {
        cfi,
        href: section.href,
        index: section.index,
        location: page,
        percentage: (page - 1) / Math.max(1, section.pageCount),
        displayed: { page, total: section.pageCount },
      },
      end: {
        cfi,
        href: section.href,
        index: section.index,
        location: page,
        percentage: page / Math.max(1, section.pageCount),
        displayed: { page, total: section.pageCount },
      },
      atStart: sectionIndex === 0 && page === 1,
      atEnd: sectionIndex === sections.length - 1 && page >= section.pageCount,
    } as Location;
  }

  function emit(event: string, ...args: unknown[]): void {
    for (const handler of listeners.get(event) ?? []) handler(...args);
  }

  function syncLocation(): Location {
    const loc = locationObject();
    rendition.location = loc;
    emit('relocated', loc);
    return loc;
  }

  const manager = {
    layout: {
      get delta() {
        return pageWidth;
      },
    },
    views: {
      first: () => ({ width: () => (sections[sectionIndex]?.pageCount ?? 1) * pageWidth }),
    },
    moveTo: vi.fn((offset: { left: number; top: number }) => {
      const total = sections[sectionIndex]?.pageCount ?? 1;
      page = Math.max(0, Math.min(total - 1, Math.floor(offset.left / pageWidth))) + 1;
      rendition.location = locationObject();
    }),
  };

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
    manager,
    currentLocation: vi.fn(() => rendition.location),
    reportLocation: vi.fn(async () => {
      syncLocation();
    }),
    display: vi.fn(async (target?: string) => {
      if (!target) {
        sectionIndex = 0;
        page = 1;
      } else if (target.startsWith('epubcfi(')) {
        const match = target.match(/\/6\/(\d+)!\/4\/2:(\d+)/);
        if (match) {
          sectionIndex = Math.max(0, Number(match[1]) / 2 - 1);
          page = Number(match[2]);
        }
      } else {
        const found = sections.findIndex((item) => item.href === target);
        if (found < 0) throw new Error('No Section Found');
        sectionIndex = found;
        page = 1;
      }
      syncLocation();
    }),
    next: vi.fn(async () => {
      const section = sections[sectionIndex]!;
      if (page < section.pageCount) page += 1;
      else if (sectionIndex < sections.length - 1) {
        sectionIndex += 1;
        page = 1;
      }
      syncLocation();
    }),
    prev: vi.fn(async () => {
      if (page > 1) page -= 1;
      else if (sectionIndex > 0) {
        sectionIndex -= 1;
        page = sections[sectionIndex]!.pageCount;
      }
      syncLocation();
    }),
    resize: vi.fn(),
    destroy: vi.fn(),
  };

  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine: {
      each: vi.fn((visit: (section: { href: string; index: number }) => void) => {
        for (const section of sections) visit({ href: section.href, index: section.index });
      }),
    },
    navigation: { toc: [] },
  };

  return {
    book,
    rendition,
    manager,
    emit,
    setPosition(nextSectionIndex: number, nextPage: number, nextWidth = pageWidth) {
      sectionIndex = nextSectionIndex;
      page = nextPage;
      pageWidth = nextWidth;
      return syncLocation();
    },
    reset(nextSections?: MockSection[]) {
      sections = nextSections ?? [
        { href: 'chapter-1.xhtml', index: 0, pageCount: 40 },
        { href: 'chapter-2.xhtml', index: 1, pageCount: 100 },
      ];
      sectionIndex = 0;
      page = 1;
      pageWidth = 400;
      listeners.clear();
      rendition.location = undefined;
    },
  };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => state.book) }));

import { ReaderSession, resolveSectionPageIndex, resolveSpinePercentageTarget } from './session';

function makeContents(collapsed = true): Contents {
  const frame = document.createElement('iframe');
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 640));
  return {
    document,
    window: {
      frameElement: frame,
      innerWidth: 360,
      getSelection: () => ({ isCollapsed: collapsed }),
    },
  } as unknown as Contents;
}

function touchGesture(
  target: EventTarget,
  contents: Contents,
  id: number,
  points: Array<[number, number]>,
): void {
  const [startX, startY] = points[0]!;
  state.emit(
    'touchstart',
    { target, touches: [{ identifier: id, clientX: startX, clientY: startY }] },
    contents,
  );
  for (const [x, y] of points.slice(1)) {
    state.emit(
      'touchmove',
      { target, touches: [{ identifier: id, clientX: x, clientY: y }] },
      contents,
    );
  }
  const [endX, endY] = points.at(-1)!;
  state.emit(
    'touchend',
    { target, touches: [], changedTouches: [{ identifier: id, clientX: endX, clientY: endY }] },
    contents,
  );
}

describe('ReaderSession swipe navigation and intra-chapter percentage targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.reset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('turns forward/backward on horizontal swipes, suppresses trailing clicks, and keeps stationary taps', async () => {
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 640));
    const onLocation = vi.fn();
    const onTap = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(viewport, null, null, null, defaultAppearance, onLocation, onTap);

    const contents = makeContents(true);
    const paragraph = document.createElement('p');

    touchGesture(paragraph, contents, 1, [
      [280, 300],
      [100, 310],
    ]);
    await Promise.resolve();
    expect(state.rendition.next).toHaveBeenCalledOnce();
    expect(onLocation.mock.calls.at(-1)?.[0]).toMatchObject({ pageIndex: 1, pageCount: 40 });

    state.emit('click', new MouseEvent('click', { clientX: 100, clientY: 310 }), contents);
    expect(onTap).not.toHaveBeenCalled();

    touchGesture(paragraph, contents, 2, [
      [300, 300],
      [302, 301],
    ]);
    state.emit('click', new MouseEvent('click', { clientX: 302, clientY: 301 }), contents);
    expect(onTap).toHaveBeenCalledExactlyOnceWith('next');

    touchGesture(paragraph, contents, 3, [
      [80, 300],
      [240, 292],
    ]);
    await Promise.resolve();
    expect(state.rendition.prev).toHaveBeenCalledOnce();
    session.destroy();
  });

  it('supports outer viewport swipes and ignores multi-touch, vertical drift, links, and active selection', async () => {
    const viewport = document.createElement('div');
    const onSwipe = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      onSwipe,
    );

    for (const [type, x, y] of [
      ['pointerdown', 260, 200],
      ['pointermove', 120, 205],
      ['pointerup', 120, 205],
    ] as const) {
      viewport.dispatchEvent(
        Object.assign(new Event(type), {
          pointerId: 7,
          pointerType: 'touch',
          clientX: x,
          clientY: y,
        }),
      );
    }
    expect(onSwipe).toHaveBeenCalledExactlyOnceWith('next');
    onSwipe.mockClear();

    const paragraph = document.createElement('p');
    const link = document.createElement('a');
    link.setAttribute('href', '#note');
    const cleanContents = makeContents(true);

    // Multi-touch gesture (second finger joins mid-swipe, lifts before first)
    state.emit(
      'touchstart',
      { target: paragraph, touches: [{ identifier: 1, clientX: 260, clientY: 200 }] },
      cleanContents,
    );
    state.emit(
      'touchstart',
      {
        target: paragraph,
        touches: [
          { identifier: 1, clientX: 240, clientY: 200 },
          { identifier: 2, clientX: 120, clientY: 210 },
        ],
      },
      cleanContents,
    );
    state.emit(
      'touchend',
      {
        target: paragraph,
        touches: [{ identifier: 1, clientX: 140, clientY: 200 }],
        changedTouches: [{ identifier: 2, clientX: 120, clientY: 210 }],
      },
      cleanContents,
    );
    state.emit(
      'touchend',
      {
        target: paragraph,
        touches: [],
        changedTouches: [{ identifier: 1, clientX: 100, clientY: 200 }],
      },
      cleanContents,
    );

    // Excessive vertical drift, interactive link target, and non-collapsed selection
    touchGesture(paragraph, cleanContents, 3, [
      [240, 200],
      [140, 290],
    ]);
    touchGesture(link, cleanContents, 4, [
      [260, 200],
      [100, 200],
    ]);
    touchGesture(paragraph, makeContents(false), 5, [
      [80, 200],
      [220, 200],
    ]);

    expect(onSwipe).not.toHaveBeenCalled();
    session.destroy();
  });

  it('inverts intra-chapter semantic percentage and lands on target intra-chapter pages', async () => {
    expect(resolveSpinePercentageTarget((1 + 0 / 30) / 49, 49)?.sectionIndex).toBe(1);
    const mid = resolveSpinePercentageTarget((1 + 3 / 7) / 3, 3)!;
    expect([mid.sectionIndex, resolveSectionPageIndex(mid.sectionProgress, 7)]).toEqual([1, 3]);
    expect(resolveSectionPageIndex(resolveSpinePercentageTarget(1, 4)!.sectionProgress, 25)).toBe(
      24,
    );

    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      null,
      0.975,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );

    expect(state.manager.moveTo).toHaveBeenCalledWith({ left: 95 * 400, top: 0 }, 100 * 400);
    expect(onLocation.mock.calls.at(-1)?.[0]).toMatchObject({
      href: 'chapter-2.xhtml',
      spineIndex: 1,
      pageIndex: 95,
      pageCount: 100,
    });
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');
    const beforeScrubCfi = onLocation.mock.calls.at(-1)?.[0].cfi;

    // Cross-chapter scrub to 25% -> chapter-1.xhtml pageIndex 20 (page 21 of 40)
    onLocation.mockClear();
    expect(await session.jumpToPercentage(0.25)).toBe(true);
    const jumpCalls = onLocation.mock.calls.filter(([, origin]) => origin === 'jump');
    expect(jumpCalls).toHaveLength(1);
    expect(jumpCalls[0]).toEqual([
      expect.objectContaining({ href: 'chapter-1.xhtml', pageIndex: 20, pageCount: 40 }),
      'jump',
      { cfi: beforeScrubCfi, href: 'chapter-2.xhtml' },
    ]);

    // Intra-chapter page jump to page 12 -> pageIndex 11 (single relocation, no section reload)
    const beforePageJumpCfi = jumpCalls[0]![0].cfi;
    onLocation.mockClear();
    expect(await session.jumpToPage(12)).toBe(true);
    expect(onLocation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ href: 'chapter-1.xhtml', pageIndex: 11, pageCount: 40 }),
      'jump',
      { cfi: beforePageJumpCfi, href: 'chapter-1.xhtml' },
    );

    // Server percentage sync within the open book
    onLocation.mockClear();
    expect(await session.displayServerPercentage(0.2)).toBe(true);
    expect(onLocation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ href: 'chapter-1.xhtml', pageIndex: 16, pageCount: 40 }),
      'restore',
    );

    session.destroy();
  });

  it('aborts an in-flight display during a viewport resize and preserves the resized CFI', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );

    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 640));
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(
      viewport,
      'epubcfi(/6/2!/4/2:6)',
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );
    expect(onLocation.mock.calls.at(-1)?.[0].cfi).toBe('epubcfi(/6/2!/4/2:6)');

    // 1. In-flight jumpToPercentage display rejected/aborted when ResizeObserver resizes viewport
    let notifyDisplayStarted!: () => void;
    const displayStarted = new Promise<void>((resolve) => {
      notifyDisplayStarted = resolve;
    });
    let abortInFlightDisplay!: (reason?: unknown) => void;
    state.rendition.display.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          abortInFlightDisplay = reject;
          notifyDisplayStarted();
        }),
    );
    state.rendition.resize.mockImplementationOnce((width: number) => {
      abortInFlightDisplay(new DOMException('Display aborted by resize', 'AbortError'));
      state.emit('resized', { width, height: 640 });
      queueMicrotask(() => {
        state.setPosition(0, 3, width);
      });
    });

    state.manager.moveTo.mockClear();
    onLocation.mockClear();
    const abortedJump = session.jumpToPercentage(0.75);
    await displayStarted;
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 800, height: 640 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    expect(await abortedJump).toBe(false);
    await Promise.resolve();
    expect(state.manager.moveTo).not.toHaveBeenCalled();
    expect(onLocation.mock.calls.map(([, origin]) => origin)).toEqual(['restore']);
    expect(onLocation.mock.calls.at(-1)?.[0].cfi).toBe('epubcfi(/6/2!/4/2:3)');
    expect(state.rendition.location?.start.cfi).toBe('epubcfi(/6/2!/4/2:3)');

    // 2. In-flight display superseded/aborted by epub.js early-resolve resize reflow + displayCfi abort
    let notifyEarlyStarted!: () => void;
    const earlyStarted = new Promise<void>((resolve) => {
      notifyEarlyStarted = resolve;
    });
    let finishEarlyDisplay!: () => void;
    state.rendition.display.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishEarlyDisplay = resolve;
          notifyEarlyStarted();
        }),
    );
    state.rendition.resize.mockImplementationOnce((width: number) => {
      finishEarlyDisplay();
      state.emit('resized', { width, height: 640 });
      state.setPosition(0, 6, width);
    });

    const inFlightJump2 = session.jumpToPercentage(0.9);
    await earlyStarted;
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 400, height: 640 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    expect(await inFlightJump2).toBe(false);
    expect(state.manager.moveTo).not.toHaveBeenCalled();
    expect(onLocation.mock.calls.at(-1)?.[0].cfi).toBe('epubcfi(/6/2!/4/2:6)');
    expect(state.rendition.location?.start.cfi).toBe('epubcfi(/6/2!/4/2:6)');

    // 3. In-flight displayCfi aborted during resize preserves resized CFI
    let rejectCfiDisplay!: (reason?: unknown) => void;
    state.rendition.display.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCfiDisplay = reject;
        }),
    );
    state.rendition.resize.mockImplementationOnce((width: number) => {
      rejectCfiDisplay(new DOMException('Display aborted by resize', 'AbortError'));
      state.emit('resized', { width, height: 640 });
      setTimeout(() => {
        state.setPosition(0, 4, width);
      }, 0);
    });

    onLocation.mockClear();
    const abortedCfiDisplay = session.displayCfi('epubcfi(/6/4!/4/2:50)');
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 600, height: 640 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    expect(await abortedCfiDisplay).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onLocation.mock.calls.map(([, origin]) => origin)).toEqual(['restore']);
    expect(onLocation.mock.calls.at(-1)?.[0].cfi).toBe('epubcfi(/6/2!/4/2:4)');
    expect(state.rendition.location?.start.cfi).toBe('epubcfi(/6/2!/4/2:4)');

    session.destroy();
  });
});
