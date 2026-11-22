// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

type MockMatch = { cfi: string; excerpt: string };

type MockSpineSection = {
  href: string;
  index: number;
  contents?: unknown;
  load: ReturnType<typeof vi.fn>;
  unload: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
};

const { mockBook, mockRendition, setSections } = vi.hoisted(() => {
  let sections: MockSpineSection[] = [];
  const rendition = {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const book = {
    load: vi.fn(async () => document),
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine: {
      each: vi.fn((visit: (section: MockSpineSection) => void) => {
        for (const section of sections) visit(section);
      }),
    },
    navigation: { toc: [] },
  };
  return {
    mockBook: book,
    mockRendition: rendition,
    setSections: (next: MockSpineSection[]) => {
      sections = next;
    },
  };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => mockBook) }));

import { ReaderSession } from './session';

function makeSection(
  index: number,
  matches: MockMatch[],
  options: { wasLoaded?: boolean; onLoad?: () => void } = {},
): MockSpineSection {
  return {
    href: `chapter-${index + 1}.xhtml`,
    index,
    contents: options.wasLoaded ? {} : undefined,
    load: vi.fn(async () => {
      options.onLoad?.();
    }),
    unload: vi.fn(),
    search: vi.fn(() => matches),
  };
}

describe('ReaderSession search batches and transient highlights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSections([]);
  });

  it('caps search batches, reports chapter counts, resumes mid-section and across sections, and unloads unrendered chapters', async () => {
    const ch1 = makeSection(
      0,
      [
        { cfi: 'cfi-1', excerpt: `${'a'.repeat(450)} Harbor light` },
        { cfi: 'cfi-2', excerpt: 'Second harbor match' },
      ],
      { wasLoaded: true },
    );
    const ch2 = makeSection(1, [
      { cfi: 'cfi-3', excerpt: 'Third harbor match' },
      { cfi: 'cfi-4', excerpt: 'Fourth harbor match' },
    ]);
    const ch3 = makeSection(2, [{ cfi: 'cfi-5', excerpt: 'Fifth harbor match' }]);
    const ch4 = makeSection(3, []);
    setSections([ch1, ch2, ch3, ch4]);

    const session = new ReaderSession('book.epub');

    const first = await session.search('harbor', undefined, 3);
    expect(first.results.map((item) => item.cfi)).toEqual(['cfi-1', 'cfi-2', 'cfi-3']);
    expect(first.results[0]?.excerpt.toLowerCase()).toContain('harbor');
    expect(first.results[0]?.segments).toContainEqual({ text: 'Harbor', match: true });
    expect(first.scannedChapters).toBe(2);
    expect(first.skippedChapters).toBe(2);
    expect(first.totalChapters).toBe(4);
    expect(first.nextCursor).toEqual({ sectionIndex: 1, matchIndex: 1 });

    // Rendered section stays loaded; unrendered section unloads in finally even on early batch return.
    expect(ch1.unload).not.toHaveBeenCalled();
    expect(ch2.unload).toHaveBeenCalledOnce();
    expect(ch3.load).not.toHaveBeenCalled();
    expect(ch4.load).not.toHaveBeenCalled();

    const second = await session.search('harbor', undefined, 3, first.nextCursor);
    expect(second.results.map((item) => item.cfi)).toEqual(['cfi-4', 'cfi-5']);
    expect(second.scannedChapters).toBe(3);
    expect(second.skippedChapters).toBe(0);
    expect(second.totalChapters).toBe(4);
    expect(second.nextCursor).toBeNull();
    expect(ch2.unload).toHaveBeenCalledTimes(2);
    expect(ch3.unload).toHaveBeenCalledOnce();
    expect(ch4.unload).toHaveBeenCalledOnce();

    session.destroy();
  });

  it('does not report truncation when the batch limit lands on the final match of the final chapter', async () => {
    const ch1 = makeSection(0, [{ cfi: 'cfi-1', excerpt: 'Harbor one' }]);
    const ch2 = makeSection(1, [
      { cfi: 'cfi-2', excerpt: 'Harbor two' },
      { cfi: '', excerpt: 'Ignored empty cfi' },
    ]);
    setSections([ch1, ch2]);

    const session = new ReaderSession('book.epub');
    const batch = await session.search('harbor', undefined, 2);

    expect(batch.results).toHaveLength(2);
    expect(batch.scannedChapters).toBe(2);
    expect(batch.skippedChapters).toBe(0);
    expect(batch.nextCursor).toBeNull();

    session.destroy();
  });

  it('honors AbortSignal cancellation during batch continuation and still unloads unrendered chapters', async () => {
    const controller = new AbortController();
    const ch1 = makeSection(0, [{ cfi: 'cfi-1', excerpt: 'Harbor one' }]);
    const ch2 = makeSection(1, [{ cfi: 'cfi-2', excerpt: 'Harbor two' }], {
      onLoad: () => controller.abort(),
    });
    const ch3 = makeSection(2, [{ cfi: 'cfi-3', excerpt: 'Harbor three' }]);
    setSections([ch1, ch2, ch3]);

    const session = new ReaderSession('book.epub');
    const first = await session.search('harbor', undefined, 1);
    expect(first.nextCursor).toEqual({ sectionIndex: 1, matchIndex: 0 });

    await expect(
      session.search('harbor', controller.signal, 1, first.nextCursor),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(ch2.unload).toHaveBeenCalledOnce();
    expect(ch3.load).not.toHaveBeenCalled();

    session.destroy();
  });

  it('applies a distinct transient search highlight and restores overlapping user highlights on move and clear', async () => {
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

    const sharedCfi = 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:6)';
    const secondCfi = 'epubcfi(/6/4!/4/2/1:0,/1:4,/1:10)';

    session.updateHighlights([{ cfi: sharedCfi }]);
    expect(mockRendition.annotations.highlight).toHaveBeenLastCalledWith(
      sharedCfi,
      {},
      undefined,
      'turnleaf-highlight',
      { fill: '#facc15', 'fill-opacity': '0.38' },
    );

    mockRendition.annotations.highlight.mockClear();
    mockRendition.annotations.remove.mockClear();

    // Activating search highlight on an existing user highlight replaces the single EPUB.js slot cleanly.
    session.setSearchHighlight(sharedCfi);
    expect(mockRendition.annotations.remove).toHaveBeenCalledWith(sharedCfi, 'highlight');
    expect(mockRendition.annotations.highlight).toHaveBeenCalledWith(
      sharedCfi,
      {},
      undefined,
      'turnleaf-search-highlight',
      expect.objectContaining({ fill: '#0ea5e9' }),
    );

    mockRendition.annotations.highlight.mockClear();
    mockRendition.annotations.remove.mockClear();

    // Stepping to another match restores the overlapping user highlight on sharedCfi.
    session.setSearchHighlight(secondCfi);
    expect(mockRendition.annotations.remove).toHaveBeenCalledWith(sharedCfi, 'highlight');
    expect(mockRendition.annotations.highlight).toHaveBeenNthCalledWith(
      1,
      sharedCfi,
      {},
      undefined,
      'turnleaf-highlight',
      { fill: '#facc15', 'fill-opacity': '0.38' },
    );
    expect(mockRendition.annotations.highlight).toHaveBeenNthCalledWith(
      2,
      secondCfi,
      {},
      undefined,
      'turnleaf-search-highlight',
      expect.objectContaining({ fill: '#0ea5e9' }),
    );

    mockRendition.annotations.highlight.mockClear();
    mockRendition.annotations.remove.mockClear();

    // Clearing the transient search highlight removes secondCfi without deleting sharedCfi.
    session.setSearchHighlight(null);
    expect(mockRendition.annotations.remove).toHaveBeenCalledExactlyOnceWith(
      secondCfi,
      'highlight',
    );
    expect(mockRendition.annotations.highlight).not.toHaveBeenCalled();

    session.destroy();
  });
});
