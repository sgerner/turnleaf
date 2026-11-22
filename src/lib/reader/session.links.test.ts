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
    getContents: vi.fn(() => []),
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

describe('ReaderSession internal links', () => {
  it('reports link jumps with a one-tap return location and does not retain stale origins', async () => {
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

  it('distinguishes page turns from explicit display and CFI jumps', async () => {
    vi.clearAllMocks();
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

    relocated(location('page-1'));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    rendition.next.mockImplementationOnce(async () => {
      relocated(location('page-2'));
    });
    await session.next();
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('navigation');

    rendition.prev.mockImplementationOnce(async () => {
      relocated(location('page-1'));
    });
    await session.previous();
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('navigation');

    rendition.display.mockImplementationOnce(async () => {
      relocated(location('chapter-start'));
    });
    await session.display('chapter.xhtml');
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('jump');

    rendition.display.mockImplementationOnce(async () => {
      relocated(location('chapter-start'));
    });
    await expect(session.displayCfi('chapter-start')).resolves.toBe(true);
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('jump');

    relocated(location('reflow-cfi'));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');
    session.destroy();
  });

  it('collapses active iframe selection ranges on clearSelection', async () => {
    vi.clearAllMocks();
    const removeHookRanges = vi.fn();
    const removeRenditionRanges = vi.fn();
    rendition.getContents.mockReturnValueOnce([
      {
        window: {
          closed: false,
          getSelection: () => ({ removeAllRanges: removeRenditionRanges }),
        },
      },
    ] as never);

    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    const registerSelection = rendition.hooks.content.register.mock.calls[1]?.[0];
    registerSelection({
      window: { closed: false, getSelection: () => ({ removeAllRanges: removeHookRanges }) },
      document: new Document(),
      cfiFromRange: () => 'cfi-1',
    });

    session.clearSelection();
    expect(removeHookRanges).toHaveBeenCalledOnce();
    expect(removeRenditionRanges).toHaveBeenCalledOnce();
    session.destroy();
  });
});
