// @vitest-environment jsdom

import type { Location } from 'epubjs';
import { describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

const { book, rendition } = vi.hoisted(() => {
  const rendition = {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    prev: vi.fn(async () => {}),
    currentLocation: vi.fn((): unknown => undefined),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine: {
      each: vi.fn((visit: (section: { href: string; index: number }) => void) => {
        visit({ href: 'chapter.xhtml', index: 0 });
      }),
    },
  };
  return { book, rendition };
});

vi.mock('epubjs', () => ({ default: () => book }));

import { ReaderSession } from './session';

function location(cfi: string, page = 2): Location {
  return {
    start: {
      cfi,
      href: 'chapter.xhtml',
      index: 0,
      percentage: 0.2,
      displayed: { page, total: 10 },
    },
  } as Location;
}

describe('ReaderSession internal links', () => {
  it('reports link jumps with a one-tap return location and does not retain stale origins', async () => {
    vi.clearAllMocks();
    rendition.currentLocation.mockReturnValue(undefined);
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
    const relocated = rendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    const click = rendition.on.mock.calls.find(([name]) => name === 'click')?.[1];
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

  it('flushes the final page turn when session.destroy() runs immediately after session.next()', async () => {
    vi.clearAllMocks();
    let activeLocation: unknown = location('page-2-cfi', 2);
    rendition.currentLocation.mockImplementation(() => activeLocation);
    let resolveNext!: () => void;
    rendition.next.mockImplementationOnce(() => {
      activeLocation = location('page-3-cfi', 3);
      return new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    });

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
    const relocated = rendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    relocated(location('page-2-cfi', 2));
    onLocation.mockClear();

    const pendingTurn = session.next();
    session.destroy();
    resolveNext();
    await pendingTurn;

    expect(onLocation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cfi: 'page-3-cfi', pageIndex: 2 }),
      'navigation',
    );
  });

  it('reports awaited page turns before animation-frame relocated events and skips duplicate RAF callbacks', async () => {
    vi.clearAllMocks();
    let activeLocation: unknown = location('page-2-cfi', 2);
    rendition.currentLocation.mockImplementation(() => activeLocation);
    rendition.next.mockImplementationOnce(async () => {
      activeLocation = location('page-3-cfi', 3);
    });

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
    const relocated = rendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    relocated(location('page-2-cfi', 2));
    onLocation.mockClear();

    await session.next();
    expect(onLocation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cfi: 'page-3-cfi', pageIndex: 2 }),
      'navigation',
    );

    // Simulate EPUB.js's deferred requestAnimationFrame relocated callback for the same turn.
    relocated(location('page-3-cfi', 3));
    expect(onLocation).toHaveBeenCalledOnce();

    session.destroy();
    expect(onLocation).toHaveBeenCalledOnce();
  });

  it('ignores undefined and promise currentLocation() results until rendition is ready', async () => {
    vi.clearAllMocks();
    rendition.currentLocation.mockReturnValueOnce(undefined);
    rendition.next.mockImplementationOnce(async () => {
      rendition.currentLocation.mockReturnValueOnce(Promise.resolve(location('async-cfi', 3)));
    });

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
    const relocated = rendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    relocated(location('page-2-cfi', 2));
    onLocation.mockClear();

    await session.next();
    expect(onLocation).not.toHaveBeenCalled();

    relocated(location('async-cfi', 3));
    expect(onLocation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cfi: 'async-cfi', pageIndex: 2 }),
      'navigation',
    );
    session.destroy();
  });
});
