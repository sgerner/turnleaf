// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';
import {
  parseKavitaXPath,
  resolveContentXPath,
  resolveKavitaPageNumber,
  toKavitaXPath,
} from './kavita-xpath';

const { mockBook, mockRendition, resetSpineSections } = vi.hoisted(() => {
  let sections = [
    { href: 'chapter-1.xhtml', load: vi.fn(), unload: vi.fn() },
    { href: 'chapter-2.xhtml', load: vi.fn(), unload: vi.fn() },
    { href: 'chapter-3.xhtml', load: vi.fn(), unload: vi.fn() },
  ];
  const rendition = {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    getContents: vi.fn(() => []),
    getRange: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    load: vi.fn(),
    spine: {
      each: vi.fn(
        (visit: (section: { href: string; load: () => void; unload: () => void }) => void) => {
          for (const section of sections) visit(section);
        },
      ),
    },
    navigation: { toc: [] },
  };
  return {
    mockBook: book,
    mockRendition: rendition,
    resetSpineSections(count = 3) {
      sections = Array.from({ length: count }, (_, index) => ({
        href: `chapter-${index + 1}.xhtml`,
        load: vi.fn(),
        unload: vi.fn(),
      }));
      return sections;
    },
  };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => mockBook) }));

import { ReaderSession } from './session';

describe('Kavita EPUB locations', () => {
  it('serializes active EPUB elements as chapter-scoped Kavita body paths without DocFragment', () => {
    expect(toKavitaXPath('/html/body/section[1]/p[4]', 2)).toBe('//body/section[1]/p[4]');
    expect(toKavitaXPath('/html/body', 0)).toBe('//body');
  });

  it('removes indexed HTML and body roots produced by EPUB documents', () => {
    expect(toKavitaXPath('/html[1]/body[1]/div[2]/p[3]', 0)).toBe('//body/div[2]/p[3]');
  });

  it('combines zero-based Kavita pageNum with chapter-scoped body paths', () => {
    expect(parseKavitaXPath('//body/section[1]/p[4]', 0)).toEqual({
      spineIndex: 0,
      contentXPath: '/html/body/section[1]/p[4]',
    });
    expect(parseKavitaXPath('/body/div[2]/p[1]', 2)).toEqual({
      spineIndex: 2,
      contentXPath: '/html/body/div[2]/p[1]',
    });
    expect(parseKavitaXPath('/html/body/p[3]', 4)).toEqual({
      spineIndex: 4,
      contentXPath: '/html/body/p[3]',
    });
    expect(parseKavitaXPath('//body', 1)).toEqual({
      spineIndex: 1,
      contentXPath: '/html/body',
    });
  });

  it('normalizes KOReader unindexed steps and text-node offset suffixes', () => {
    expect(parseKavitaXPath('//body/div/p[4]/text()[1].18', 0)).toEqual({
      spineIndex: 0,
      contentXPath: '/html/body/div[1]/p[4]',
    });
    expect(parseKavitaXPath('/body/DocFragment[2]/body/div/section/p[3]/text().0')).toEqual({
      spineIndex: 1,
      contentXPath: '/html/body/div[1]/section[1]/p[3]',
    });
  });

  it('parses Kavita Web element-ID anchors with zero-based spine indices', () => {
    expect(parseKavitaXPath('id("note-1")', 0)).toEqual({
      spineIndex: 0,
      contentXPath: 'id("note-1")',
    });
    expect(parseKavitaXPath('id("sec:1.2")/div/p[2]', 3)).toEqual({
      spineIndex: 3,
      contentXPath: 'id("sec:1.2")/div[1]/p[2]',
    });
    expect(parseKavitaXPath('//*[@id="fn-4"]/span[2]', 1)).toEqual({
      spineIndex: 1,
      contentXPath: 'id("fn-4")/span[2]',
    });
  });

  it('maps legacy DocFragment locations back to zero-based EPUB spine indices', () => {
    expect(parseKavitaXPath('//body/DocFragment[3]/body/section[1]/p[4]')).toEqual({
      spineIndex: 2,
      contentXPath: '/html/body/section[1]/p[4]',
    });
    expect(parseKavitaXPath('//body/DocFragment[3]/body/section[1]/p[4]', 3)).toEqual({
      spineIndex: 2,
      contentXPath: '/html/body/section[1]/p[4]',
    });
  });

  it('accepts legacy Kavita chapter-body locations with a trailing slash', () => {
    expect(parseKavitaXPath('//body/DocFragment[2]/body/')).toEqual({
      spineIndex: 1,
      contentXPath: '/html/body',
    });
  });

  it('resolves legacy DocFragment page numbers without overriding explicit completion', () => {
    expect(resolveKavitaPageNumber(0, '//body/p[2]', 10)).toBe(0);
    expect(resolveKavitaPageNumber(3, '//body/DocFragment[3]/body/p[2]', 10)).toBe(2);
    expect(resolveKavitaPageNumber(10, '//body/DocFragment[3]/body/p[2]', 10)).toBe(10);
  });

  it('rejects unscoped and invalid locations instead of opening the wrong chapter', () => {
    expect(parseKavitaXPath('/html/body/p[1]')).toBeNull();
    expect(parseKavitaXPath('//body/p[1]')).toBeNull();
    expect(parseKavitaXPath('id("anchor")')).toBeNull();
    expect(parseKavitaXPath('//body/DocFragment[0]/body/p[1]')).toBeNull();
  });

  it('resolves Kavita paths and element-ID anchors through XHTML-style element names', () => {
    const document = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><meta id="head-only" /></head><body><section id="sec:1.2"><p>one</p><p id="p-two">two</p></section></body></html>',
      'application/xhtml+xml',
    );
    expect(resolveContentXPath(document, '/html/body/section[1]/p[2]')?.textContent).toBe('two');
    expect(resolveContentXPath(document, '/html/body')?.localName).toBe('body');
    expect(resolveContentXPath(document, 'id("sec:1.2")/p[2]')?.textContent).toBe('two');
    expect(resolveContentXPath(document, 'id("p-two")')?.textContent).toBe('two');
    expect(resolveContentXPath(document, 'id("head-only")')).toBeNull();
  });

  it('counts XPath indices among siblings of the requested tag', () => {
    const document = new DOMParser().parseFromString(
      '<html><body><p>first</p><h2>heading</h2><p>second</p></body></html>',
      'text/html',
    );
    expect(resolveContentXPath(document, '/html/body/p[2]')?.textContent).toBe('second');
    expect(resolveContentXPath(document, '/html/body/h2[1]')?.textContent).toBe('heading');
  });
});

describe('ReaderSession Kavita restoration and matching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSpineSections(3);
    mockRendition.display.mockImplementation(async () => {});
    mockRendition.getContents.mockReturnValue([]);
  });

  it('restores chapter-scoped and ID-anchored Kavita locations using zero-based serverPageNum without loading extra chapters', async () => {
    const sections = resetSpineSections(3);
    const chapterDoc = new DOMParser().parseFromString(
      '<html><body><div id="intro"><p>first</p><p>target</p></div></body></html>',
      'text/html',
    );
    mockRendition.getContents.mockReturnValue([
      {
        sectionIndex: 1,
        document: chapterDoc,
        cfiFromRange: vi.fn(() => 'epubcfi(/6/4!/4/2/4)'),
      } as never,
    ]);

    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      'id("intro")/p[2]',
      0.5,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      1,
    );

    expect(mockRendition.display).toHaveBeenNthCalledWith(1, 'chapter-2.xhtml');
    expect(mockRendition.display).toHaveBeenNthCalledWith(2, 'epubcfi(/6/4!/4/2/4)');
    expect(sections[0]?.load).not.toHaveBeenCalled();
    expect(sections[2]?.load).not.toHaveBeenCalled();
    session.destroy();
  });

  it('maps zero-based chapter percentages accurately across small and large spine counts', async () => {
    resetSpineSections(49);
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      null,
      1 / 49,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('chapter-2.xhtml');
    session.destroy();

    vi.clearAllMocks();
    resetSpineSections(2000);
    const largeSession = new ReaderSession('large.epub');
    await largeSession.open(
      document.createElement('div'),
      null,
      null,
      1999 / 2000,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('chapter-2000.xhtml');
    largeSession.destroy();
  });

  it('matches active chapter elements against both canonical body paths and ID-anchored locators', async () => {
    resetSpineSections(3);
    const chapterDoc = new DOMParser().parseFromString(
      '<html><body><section id="sec-1"><p>first</p><p id="para-2">second</p></section></body></html>',
      'text/html',
    );
    const secondParagraph = chapterDoc.getElementById('para-2')!;
    mockRendition.getRange.mockReturnValue({ startContainer: secondParagraph });
    mockRendition.getContents.mockReturnValue([
      {
        sectionIndex: 0,
        document: chapterDoc,
      } as never,
    ]);

    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      'epubcfi(/6/2!/4/2/4)',
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );
    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    relocated?.({
      start: {
        cfi: 'epubcfi(/6/2!/4/2/4)',
        href: 'chapter-1.xhtml',
        index: 0,
        displayed: { page: 1, total: 3 },
      },
    });

    expect(session.matchesServerLocation('//body/section[1]/p[2]', 0)).toBe(true);
    expect(session.matchesServerLocation('id("para-2")', 0)).toBe(true);
    expect(session.matchesServerLocation('id("sec-1")/p[2]', 0)).toBe(true);
    expect(session.matchesServerLocation('//body/section[1]/p[2]', 1)).toBe(false);
    session.destroy();
  });
});
