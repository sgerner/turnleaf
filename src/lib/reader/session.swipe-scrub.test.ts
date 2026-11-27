// @vitest-environment jsdom

import type { Contents, Location } from 'epubjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

type MockSection = { href: string; index: number; pageCount: number };

const state = vi.hoisted(() => {
  let sections: MockSection[] = [
    { href: 'chapter-1.xhtml', index: 0, pageCount: 40 },
    { href: 'chapter-2.xhtml', index: 1, pageCount: 100 },
  ];
  let currentSectionIndex = 0;
  let currentPage = 1;
  let useManagerMoveTo = true;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  function currentLocationObject(): Location {
    const section = sections[currentSectionIndex] ?? sections[0]!;
    return {
      start: {
        cfi: `epubcfi(/6/${(section.index + 1) * 2}!/4/2:${currentPage})`,
        href: section.href,
        index: section.index,
        location: currentPage,
        percentage: (currentPage - 1) / Math.max(1, section.pageCount),
        displayed: {
          page: currentPage,
          total: section.pageCount,
        },
      },
      end: {
        cfi: `epubcfi(/6/${(section.index + 1) * 2}!/4/2:${currentPage})`,
        href: section.href,
        index: section.index,
        location: currentPage,
        percentage: currentPage / Math.max(1, section.pageCount),
        displayed: {
          page: currentPage,
          total: section.pageCount,
        },
      },
      atStart: currentSectionIndex === 0 && currentPage === 1,
      atEnd:
        currentSectionIndex === sections.length - 1 &&
        currentPage >= (sections[currentSectionIndex]?.pageCount ?? 1),
    } as Location;
  }

  function emit(event: string, ...args: unknown[]): void {
    for (const handler of listeners.get(event) ?? []) {
      handler(...args);
    }
  }

  const manager = {
    layout: { delta: 400 },
    views: {
      first: () => ({
        width: () => (sections[currentSectionIndex]?.pageCount ?? 1) * 400,
      }),
    },
    moveTo: vi.fn((offset: { left: number; top: number }) => {
      const total = sections[currentSectionIndex]?.pageCount ?? 1;
      const pageIndex = Math.max(0, Math.min(total - 1, Math.floor(offset.left / 400)));
      currentPage = pageIndex + 1;
      rendition.location = currentLocationObject();
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
    get manager() {
      return useManagerMoveTo ? manager : undefined;
    },
    currentLocation: vi.fn(() => currentLocationObject()),
    reportLocation: vi.fn(async () => {
      const loc = currentLocationObject();
      rendition.location = loc;
      emit('relocated', loc);
    }),
    display: vi.fn(async (target?: string) => {
      if (!target) {
        currentSectionIndex = 0;
        currentPage = 1;
      } else if (target.startsWith('epubcfi(')) {
        const match = target.match(/\/6\/(\d+)!\/4\/2:(\d+)/);
        if (match) {
          currentSectionIndex = Math.max(0, Number(match[1]) / 2 - 1);
          currentPage = Number(match[2]);
        }
      } else {
        const found = sections.findIndex((item) => item.href === target);
        if (found < 0) throw new Error('No Section Found');
        currentSectionIndex = found;
        currentPage = 1;
      }
      const loc = currentLocationObject();
      rendition.location = loc;
      emit('relocated', loc);
    }),
    next: vi.fn(async () => {
      const section = sections[currentSectionIndex]!;
      if (currentPage < section.pageCount) {
        currentPage += 1;
      } else if (currentSectionIndex < sections.length - 1) {
        currentSectionIndex += 1;
        currentPage = 1;
      }
      const loc = currentLocationObject();
      rendition.location = loc;
      emit('relocated', loc);
    }),
    prev: vi.fn(async () => {
      if (currentPage > 1) {
        currentPage -= 1;
      } else if (currentSectionIndex > 0) {
        currentSectionIndex -= 1;
        currentPage = sections[currentSectionIndex]!.pageCount;
      }
      const loc = currentLocationObject();
      rendition.location = loc;
      emit('relocated', loc);
    }),
    resize: vi.fn(),
    destroy: vi.fn(),
  };

  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine: {
      each: vi.fn((visit: (section: { href: string; index: number }) => void) => {
        for (const section of sections) {
          visit({ href: section.href, index: section.index });
        }
      }),
    },
    navigation: { toc: [] },
  };

  return {
    book,
    rendition,
    manager,
    emit,
    reset(nextSections?: MockSection[], withManager = true) {
      sections = nextSections ?? [
        { href: 'chapter-1.xhtml', index: 0, pageCount: 40 },
        { href: 'chapter-2.xhtml', index: 1, pageCount: 100 },
      ];
      currentSectionIndex = 0;
      currentPage = 1;
      useManagerMoveTo = withManager;
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

describe('ReaderSession swipe navigation and intra-chapter percentage targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.reset();
  });

  it('turns forward on left swipe and backward on right swipe inside the EPUB iframe without duplicate click turns', async () => {
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 640));
    const onLocation = vi.fn();
    const onTap = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(viewport, null, null, null, defaultAppearance, onLocation, onTap);

    const contents = makeContents(true);
    const paragraph = document.createElement('p');

    // Left swipe: 280 -> 100 turns forward one page (page 1 -> page 2)
    state.emit(
      'touchstart',
      {
        target: paragraph,
        touches: [{ identifier: 1, clientX: 280, clientY: 300 }],
        changedTouches: [{ identifier: 1, clientX: 280, clientY: 300 }],
      },
      contents,
    );
    state.emit(
      'touchmove',
      {
        target: paragraph,
        touches: [{ identifier: 1, clientX: 100, clientY: 310 }],
        changedTouches: [{ identifier: 1, clientX: 100, clientY: 310 }],
      },
      contents,
    );
    state.emit(
      'touchend',
      {
        target: paragraph,
        touches: [],
        changedTouches: [{ identifier: 1, clientX: 100, clientY: 310 }],
      },
      contents,
    );
    await Promise.resolve();
    expect(state.rendition.next).toHaveBeenCalledOnce();
    expect(onLocation.mock.calls.at(-1)?.[0]).toMatchObject({ pageIndex: 1, pageCount: 40 });

    // Trailing synthesized click immediately after swipe is suppressed
    state.emit('click', new MouseEvent('click', { clientX: 100, clientY: 310 }), contents);
    expect(onTap).not.toHaveBeenCalled();

    // Subsequent stationary tap still works
    state.emit(
      'touchstart',
      {
        target: paragraph,
        touches: [{ identifier: 2, clientX: 300, clientY: 300 }],
        changedTouches: [{ identifier: 2, clientX: 300, clientY: 300 }],
      },
      contents,
    );
    state.emit(
      'touchend',
      {
        target: paragraph,
        touches: [],
        changedTouches: [{ identifier: 2, clientX: 302, clientY: 301 }],
      },
      contents,
    );
    state.emit('click', new MouseEvent('click', { clientX: 302, clientY: 301 }), contents);
    expect(onTap).toHaveBeenCalledExactlyOnceWith('next');

    // Right swipe: 80 -> 240 turns backward one page
    state.emit(
      'touchstart',
      {
        target: paragraph,
        touches: [{ identifier: 3, clientX: 80, clientY: 300 }],
        changedTouches: [{ identifier: 3, clientX: 80, clientY: 300 }],
      },
      contents,
    );
    state.emit(
      'touchmove',
      {
        target: paragraph,
        touches: [{ identifier: 3, clientX: 240, clientY: 292 }],
        changedTouches: [{ identifier: 3, clientX: 240, clientY: 292 }],
      },
      contents,
    );
    state.emit(
      'touchend',
      {
        target: paragraph,
        touches: [],
        changedTouches: [{ identifier: 3, clientX: 240, clientY: 292 }],
      },
      contents,
    );
    await Promise.resolve();
    expect(state.rendition.prev).toHaveBeenCalledOnce();

    session.destroy();
  });

  it('turns pages when swiping horizontally across the outer viewport element', async () => {
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

    const start = new Event('pointerdown') as PointerEvent;
    Object.assign(start, { pointerId: 7, pointerType: 'touch', clientX: 260, clientY: 200 });
    const move = new Event('pointermove') as PointerEvent;
    Object.assign(move, { pointerId: 7, pointerType: 'touch', clientX: 120, clientY: 205 });
    const end = new Event('pointerup') as PointerEvent;
    Object.assign(end, { pointerId: 7, pointerType: 'touch', clientX: 120, clientY: 205 });

    viewport.dispatchEvent(start);
    viewport.dispatchEvent(move);
    viewport.dispatchEvent(end);

    expect(onSwipe).toHaveBeenCalledExactlyOnceWith('next');
    session.destroy();
  });

  it('ignores multi-touch gestures, vertical drift, interactive controls, and active text selection', async () => {
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

    const paragraph = document.createElement('p');
    const link = document.createElement('a');
    link.setAttribute('href', '#note');

    // 1. Multi-touch pinch/two-finger drag (second finger touches mid-gesture, then lifts first)
    const cleanContents = makeContents(true);
    state.emit(
      'touchstart',
      {
        target: paragraph,
        touches: [{ identifier: 1, clientX: 260, clientY: 200 }],
      },
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

    // 2. Diagonal/vertical drift exceeds threshold
    state.emit(
      'touchstart',
      {
        target: paragraph,
        touches: [{ identifier: 3, clientX: 240, clientY: 200 }],
      },
      cleanContents,
    );
    state.emit(
      'touchmove',
      {
        target: paragraph,
        touches: [{ identifier: 3, clientX: 140, clientY: 290 }],
      },
      cleanContents,
    );
    state.emit(
      'touchend',
      {
        target: paragraph,
        touches: [],
        changedTouches: [{ identifier: 3, clientX: 140, clientY: 290 }],
      },
      cleanContents,
    );

    // 3. Swipe starting on an interactive link
    state.emit(
      'touchstart',
      {
        target: link,
        touches: [{ identifier: 4, clientX: 260, clientY: 200 }],
      },
      cleanContents,
    );
    state.emit(
      'touchend',
      {
        target: link,
        touches: [],
        changedTouches: [{ identifier: 4, clientX: 100, clientY: 200 }],
      },
      cleanContents,
    );

    // 4. Dragging across words to create a highlight (non-collapsed selection)
    const selectedContents = makeContents(false);
    state.emit(
      'touchstart',
      {
        target: paragraph,
        touches: [{ identifier: 5, clientX: 80, clientY: 200 }],
      },
      cleanContents,
    );
    state.emit(
      'touchmove',
      {
        target: paragraph,
        touches: [{ identifier: 5, clientX: 220, clientY: 200 }],
      },
      selectedContents,
    );
    state.emit(
      'touchend',
      {
        target: paragraph,
        touches: [],
        changedTouches: [{ identifier: 5, clientX: 220, clientY: 200 }],
      },
      selectedContents,
    );

    expect(onSwipe).not.toHaveBeenCalled();
    session.destroy();
  });

  it('inverts intra-chapter semantic percentage accurately across spine and page boundaries', () => {
    // 49 sections: section 1, page 1 (0-based pageIndex 0)
    const pct = (1 + 0 / 30) / 49;
    const spineTarget = resolveSpinePercentageTarget(pct, 49);
    expect(spineTarget?.sectionIndex).toBe(1);
    expect(resolveSectionPageIndex(spineTarget!.sectionProgress, 30)).toBe(0);

    // 3 sections: section 1, pageIndex 3 of 7
    const pctMid = (1 + 3 / 7) / 3;
    const midTarget = resolveSpinePercentageTarget(pctMid, 3);
    expect(midTarget?.sectionIndex).toBe(1);
    expect(resolveSectionPageIndex(midTarget!.sectionProgress, 7)).toBe(3);

    // 100% lands on final page of final section
    const endTarget = resolveSpinePercentageTarget(1, 4);
    expect(endTarget).toEqual({ sectionIndex: 3, sectionProgress: 1 });
    expect(resolveSectionPageIndex(endTarget!.sectionProgress, 25)).toBe(24);
  });

  it('opens target intra-chapter pages for server percentage syncs and user jumps instead of truncating to page 1', async () => {
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');

    // Open at serverPercentage = 0.975 -> section 1 (index 1), sectionProgress = 0.95 -> pageIndex 95 (page 96 of 100)
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

    // User scrubs to 25% -> section 0 (40 pages), sectionProgress = 0.5 -> pageIndex 20 (page 21 of 40)
    onLocation.mockClear();
    const jumped = await session.jumpToPercentage(0.25);
    expect(jumped).toBe(true);
    expect(onLocation).toHaveBeenCalledOnce();
    expect(onLocation.mock.calls[0]?.[0]).toMatchObject({
      href: 'chapter-1.xhtml',
      spineIndex: 0,
      pageIndex: 20,
      pageCount: 40,
    });
    expect(onLocation.mock.calls[0]?.[1]).toBe('jump');
    expect(onLocation.mock.calls[0]?.[2]).toEqual({
      cfi: beforeScrubCfi,
      href: 'chapter-2.xhtml',
    });

    // User jumps to page 12 in current 40-page chapter -> pageIndex 11
    const beforePageJumpCfi = onLocation.mock.calls[0]?.[0].cfi;
    onLocation.mockClear();
    const pageJumped = await session.jumpToPage(12);
    expect(pageJumped).toBe(true);
    expect(onLocation).toHaveBeenCalledOnce();
    expect(onLocation.mock.calls[0]?.[0]).toMatchObject({
      href: 'chapter-1.xhtml',
      pageIndex: 11,
      pageCount: 40,
    });
    expect(onLocation.mock.calls[0]?.[1]).toBe('jump');
    expect(onLocation.mock.calls[0]?.[2]).toEqual({
      cfi: beforePageJumpCfi,
      href: 'chapter-1.xhtml',
    });

    session.destroy();
  });

  it('resolves displayServerPercentage to the target intra-chapter page even without manager.moveTo', async () => {
    state.reset([{ href: 'single-long-chapter.xhtml', index: 0, pageCount: 50 }], false);
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

    onLocation.mockClear();
    const moved = await session.displayServerPercentage(0.8);
    expect(moved).toBe(true);
    expect(onLocation).toHaveBeenCalledOnce();
    expect(onLocation.mock.calls[0]?.[0]).toMatchObject({
      href: 'single-long-chapter.xhtml',
      pageIndex: 40,
      pageCount: 50,
    });
    expect(onLocation.mock.calls[0]?.[1]).toBe('restore');

    session.destroy();
  });
});
