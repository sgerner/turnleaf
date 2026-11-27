// @vitest-environment jsdom

import type { Location } from 'epubjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

const { mockBook, mockRendition } = vi.hoisted(() => {
  const sections = [
    { href: 'first.xhtml', index: 0 },
    { href: 'second.xhtml', index: 1 },
  ];
  const rendition = {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    location: undefined as { start: { cfi: string } } | undefined,
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    getContents: vi.fn((): unknown[] => []),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    packaging: { navPath: '', ncxPath: '' },
    spine: {
      each: vi.fn((visit: (section: { href: string; index: number }) => void) => {
        for (const section of sections) {
          visit(section);
        }
      }),
    },
    navigation: { toc: [] },
  };
  return { mockBook: book, mockRendition: rendition };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => mockBook) }));

import { ReaderSession } from './session';

function makeLocation(cfi: string, href = 'first.xhtml', index = 0): Location {
  return {
    start: {
      cfi,
      href,
      index,
      percentage: index / 2,
      displayed: { page: 1, total: 4 },
    },
  } as Location;
}

function getRelocatedListener(): (location: Location) => void {
  const listener = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
  if (typeof listener !== 'function') {
    throw new Error('Expected relocated listener');
  }
  return listener;
}

describe('ReaderSession in-flight display abort during viewport resize', () => {
  let resizeCallbacks: ResizeObserverCallback[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    resizeCallbacks = [];
    mockRendition.display.mockImplementation(async () => {});
    mockRendition.getContents.mockReturnValue([]);
    mockRendition.location = undefined;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function createViewport(width = 360, height = 640): HTMLDivElement {
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, height));
    return viewport;
  }

  function triggerResize(width: number, height: number): void {
    resizeCallbacks[0]?.(
      [{ contentRect: { width, height } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  }

  it('aborts an in-flight display during a viewport resize and preserves the final CFI', async () => {
    const initialCfi = 'epubcfi(/6/2!/4/2/1:0)';
    const abortedTargetCfi = 'epubcfi(/6/4!/4/2/1:0)';
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');

    await session.open(
      createViewport(360, 640),
      initialCfi,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );
    const relocated = getRelocatedListener();
    mockRendition.location = { start: { cfi: initialCfi } };
    relocated(makeLocation(initialCfi, 'first.xhtml', 0));
    onLocation.mockClear();
    mockRendition.display.mockClear();

    let abortInFlightDisplay!: (reason?: unknown) => void;
    mockRendition.display.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          abortInFlightDisplay = reject;
        }),
    );
    mockRendition.resize.mockImplementationOnce(() => {
      abortInFlightDisplay(new DOMException('Display aborted during resize', 'AbortError'));
      relocated(makeLocation(initialCfi, 'first.xhtml', 0));
    });

    const inFlightDisplay = session.displayCfi(abortedTargetCfi);
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith(abortedTargetCfi);

    triggerResize(480, 720);

    await expect(inFlightDisplay).resolves.toBe(false);
    expect(mockRendition.resize).toHaveBeenCalledExactlyOnceWith(480, 720);
    expect(onLocation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cfi: initialCfi, href: 'first.xhtml' }),
      'restore',
    );

    mockRendition.display.mockClear();
    session.applyAppearance({ ...defaultAppearance, fontSize: 22 });
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith(initialCfi);

    session.destroy();
  });

  it('cancels an in-flight server-location display superseded during a resize and keeps the final CFI', async () => {
    const initialCfi = 'epubcfi(/6/2!/4/2/1:0)';
    const finalCfi = 'epubcfi(/6/4!/4/8/1:0)';
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');

    await session.open(
      createViewport(360, 640),
      initialCfi,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );
    const relocated = getRelocatedListener();
    mockRendition.location = { start: { cfi: initialCfi } };
    relocated(makeLocation(initialCfi, 'first.xhtml', 0));
    onLocation.mockClear();
    mockRendition.display.mockClear();

    let resolveInFlightChapter!: () => void;
    mockRendition.display
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveInFlightChapter = resolve;
          }),
      )
      .mockImplementationOnce(async () => {
        mockRendition.location = { start: { cfi: finalCfi } };
        relocated(makeLocation(finalCfi, 'second.xhtml', 1));
      });

    const inFlightServerDisplay = session.displayServerLocation('//body/DocFragment[2]/body/p[2]');
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('second.xhtml');

    triggerResize(520, 700);
    const replacementDisplay = session.displayCfi(finalCfi);
    resolveInFlightChapter();

    await expect(inFlightServerDisplay).resolves.toBe(false);
    await expect(replacementDisplay).resolves.toBe(true);
    expect(mockRendition.resize).toHaveBeenCalledExactlyOnceWith(520, 700);
    expect(mockRendition.display.mock.calls).toEqual([['second.xhtml'], [finalCfi]]);
    expect(onLocation.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ cfi: finalCfi, href: 'second.xhtml' }),
    );
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('navigation');

    mockRendition.display.mockClear();
    session.applyAppearance({ ...defaultAppearance, fontSize: 22 });
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith(finalCfi);

    session.destroy();
  });
});
