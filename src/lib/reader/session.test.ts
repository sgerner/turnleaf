// @vitest-environment jsdom

import type { Contents as EpubContents } from 'epubjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';
import { parseKavitaXPath, resolveContentXPath, toKavitaXPath } from './kavita-xpath';

const PAGE_WIDTH = 300;

const { testState, mockBook, mockRendition } = vi.hoisted(() => {
  const state = {
    sections: [] as Array<{ href: string; index: number; contents: EpubContents }>,
    activeSectionIndex: 0,
    displayedPage: 1,
  };
  const rendition = {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() } as {
      register: (...args: unknown[]) => void;
      select: (name: string) => void;
    },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    location: undefined as { start: { cfi: string } } | undefined,
    getContents: vi.fn(() => {
      const active = state.sections[state.activeSectionIndex];
      return active ? [active.contents] : [];
    }),
    display: vi.fn(async (target?: string) => {
      if (!target) {
        state.activeSectionIndex = 0;
        state.displayedPage = 1;
        return;
      }
      if (target.startsWith('epubcfi(')) {
        const active = state.sections[state.activeSectionIndex];
        if (!active) throw new Error('No active section');
        const offset = await active.contents.locationOf(target);
        state.displayedPage = Math.floor(offset.left / PAGE_WIDTH) + 1;
        return;
      }
      const found = state.sections.find((section) => section.href === target);
      if (!found) throw new Error(`Unknown section: ${target}`);
      state.activeSectionIndex = found.index;
      state.displayedPage = 1;
    }),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine: {
      each: vi.fn((visit: (section: { href: string; index: number }) => void) => {
        for (const section of state.sections) {
          visit({ href: section.href, index: section.index });
        }
      }),
    },
    navigation: { toc: [] },
  };
  return { testState: state, mockBook: book, mockRendition: rendition };
});

vi.mock('epubjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    default: vi.fn(() => mockBook),
  };
});

import { Book, Contents, Rendition } from 'epubjs';
import { ReaderSession } from './session';

function createSectionContents(
  xhtml: string,
  index: number,
  pagePositions: Record<string, number> = {},
): EpubContents {
  const doc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
  Object.defineProperty(doc, 'defaultView', { value: window, configurable: true });
  for (const [selector, page] of Object.entries(pagePositions)) {
    const element = doc.querySelector(selector);
    if (!element) throw new Error(`Missing selector in test fixture: ${selector}`);
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(
      new DOMRect((page - 1) * PAGE_WIDTH, 0, PAGE_WIDTH, 400),
    );
  }
  const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0);
  try {
    return new Contents(doc, doc.body, `/6/${(index + 1) * 2}[section-${index + 1}]`, index);
  } finally {
    rafSpy.mockRestore();
  }
}
describe('Kavita EPUB locations', () => {
  it('adds the one-based Kavita spine fragment to an EPUB content path', () => {
    expect(toKavitaXPath('/html/body/section[1]/p[4]', 2)).toBe(
      '//body/DocFragment[3]/body/section[1]/p[4]',
    );
  });

  it('removes indexed HTML and body roots produced by EPUB documents', () => {
    expect(toKavitaXPath('/html[1]/body[1]/div[2]/p[3]', 0)).toBe(
      '//body/DocFragment[1]/body/div[2]/p[3]',
    );
  });

  it('maps a Kavita location back to a zero-based EPUB spine and content path', () => {
    expect(parseKavitaXPath('//body/DocFragment[3]/body/section[1]/p[4]')).toEqual({
      spineIndex: 2,
      contentXPath: '/html/body/section[1]/p[4]',
    });
  });

  it('accepts Kavita chapter-body locations with a trailing slash', () => {
    expect(parseKavitaXPath('//body/DocFragment[2]/body/')).toEqual({
      spineIndex: 1,
      contentXPath: '/html/body',
    });
  });

  it('rejects unscoped and invalid locations instead of opening the wrong chapter', () => {
    expect(parseKavitaXPath('/html/body/p[1]')).toBeNull();
    expect(parseKavitaXPath('//body/DocFragment[0]/body/p[1]')).toBeNull();
  });

  it('resolves Kavita paths through XHTML-style element names', () => {
    const document = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><section><p>one</p><p>two</p></section></body></html>',
      'application/xhtml+xml',
    );
    expect(resolveContentXPath(document, '/html/body/section[1]/p[2]')?.textContent).toBe('two');
    expect(resolveContentXPath(document, '/html/body')?.localName).toBe('body');
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

describe('ReaderSession XPath restoration', () => {
  const originalRangeRect = Range.prototype.getBoundingClientRect;
  let createdContents: EpubContents[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    testState.activeSectionIndex = 0;
    testState.displayedPage = 1;
    Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
      const container =
        this.startContainer.nodeType === Node.ELEMENT_NODE
          ? (this.startContainer as Element)
          : this.startContainer.parentElement;
      return container?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0);
    };

    const chapterOne = createSectionContents(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body>
        <section id="main">
          <p id="opening">Page one opening</p>
          <p id="plain-p">Second page paragraph</p>
          <p id="styled-p"><em id="nested-em"><span>Third page emphasis</span></em></p>
          <blockquote id="quote-block">
            <p id="quote-p">Fourth page quote</p>
          </blockquote>
          <figure id="media-figure">
            <img src="map.png" alt="World map" />
          </figure>
          <hr id="scene-break" />
        </section>
        <section id="nested-section">
          <h2 id="section-heading">Seventh page section</h2>
        </section>
        <section id="ornament-section">
          <img src="ornament.png" alt="" />
        </section>
      </body></html>`,
      0,
      {
        '#opening': 1,
        '#plain-p': 2,
        '#nested-em span': 3,
        '#quote-p': 4,
        '#media-figure': 5,
        '#scene-break': 6,
        '#section-heading': 7,
        '#ornament-section': 8,
      },
    );

    const chapterTwo = createSectionContents(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body>
        <figure id="hero-image"><img src="hero.png" alt="" /></figure>
        <p id="after-hero">Page two chapter body text</p>
      </body></html>`,
      1,
      {
        '#hero-image': 1,
        '#after-hero': 2,
      },
    );

    const chapterThree = createSectionContents(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Chapter three</p></body></html>`,
      2,
    );

    const chapterFour = createSectionContents(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Chapter four fallback</p></body></html>`,
      3,
    );

    createdContents = [chapterOne, chapterTwo, chapterThree, chapterFour];
    testState.sections = [
      { href: 'chapter-one.xhtml', index: 0, contents: chapterOne },
      { href: 'chapter-two.xhtml', index: 1, contents: chapterTwo },
      { href: 'chapter-three.xhtml', index: 2, contents: chapterThree },
      { href: 'chapter-four.xhtml', index: 3, contents: chapterFour },
    ];
  });

  afterEach(() => {
    for (const contents of createdContents) {
      contents.destroy();
    }
    createdContents = [];
    testState.sections = [];
    if (originalRangeRect) {
      Range.prototype.getBoundingClientRect = originalRangeRect;
    } else {
      Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    }
  });

  it.each([
    {
      label: '<p>',
      xpath: '//body/DocFragment[1]/body/section[1]/p[2]',
      expectedPage: 2,
      expectedTextStep: true,
    },
    {
      label: '<p> wrapping <em>',
      xpath: '//body/DocFragment[1]/body/section[1]/p[3]',
      expectedPage: 3,
      expectedTextStep: true,
    },
    {
      label: '<em>',
      xpath: '//body/DocFragment[1]/body/section[1]/p[3]/em[1]',
      expectedPage: 3,
      expectedTextStep: true,
    },
    {
      label: '<blockquote>',
      xpath: '//body/DocFragment[1]/body/section[1]/blockquote[1]',
      expectedPage: 4,
      expectedTextStep: true,
    },
    {
      label: '<figure>',
      xpath: '//body/DocFragment[1]/body/section[1]/figure[1]',
      expectedPage: 5,
      expectedTextStep: false,
    },
    {
      label: '<hr>',
      xpath: '//body/DocFragment[1]/body/section[1]/hr[1]',
      expectedPage: 6,
      expectedTextStep: false,
    },
    {
      label: '<section> with nested text',
      xpath: '//body/DocFragment[1]/body/section[2]',
      expectedPage: 7,
      expectedTextStep: true,
    },
    {
      label: '<section> without text',
      xpath: '//body/DocFragment[1]/body/section[3]',
      expectedPage: 8,
      expectedTextStep: false,
    },
  ])(
    'restores multi-page chapters via displayServerLocation and Contents.locationOf for $label',
    async ({ xpath, expectedPage, expectedTextStep }) => {
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
      mockRendition.display.mockClear();

      const restored = await session.displayServerLocation(xpath);
      expect(restored).toBe(true);
      expect(mockRendition.display).toHaveBeenCalledTimes(2);
      expect(mockRendition.display).toHaveBeenNthCalledWith(1, 'chapter-one.xhtml');

      const cfi = mockRendition.display.mock.calls[1]?.[0] as string;
      expect(cfi).toMatch(/^epubcfi\(/);
      if (expectedTextStep) {
        expect(cfi).toMatch(/\/1:\d+\)$/);
      } else {
        expect(cfi).not.toContain('/1:0');
      }

      const chapterOneContents = testState.sections[0]!.contents;
      expect(chapterOneContents.range(cfi)).not.toBeNull();
      expect(await chapterOneContents.locationOf(cfi)).toEqual({
        left: (expectedPage - 1) * PAGE_WIDTH,
        top: 0,
      });
      expect(testState.displayedPage).toBe(expectedPage);

      session.destroy();
    },
  );

  it('restores multi-page XPath targets during open without falling back to serverPercentage', async () => {
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      '//body/DocFragment[1]/body/section[1]/figure[1]',
      0.85,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    expect(testState.activeSectionIndex).toBe(0);
    expect(testState.displayedPage).toBe(5);
    expect(mockRendition.display).not.toHaveBeenCalledWith('chapter-four.xhtml');
    session.destroy();
  });

  it('keeps /html/body chapter-root targets on page one without secondary CFI navigation', async () => {
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      '//body/DocFragment[2]/body',
      0.85,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('chapter-two.xhtml');
    expect(testState.activeSectionIndex).toBe(1);
    expect(testState.displayedPage).toBe(1);

    mockRendition.display.mockClear();
    await expect(session.displayServerLocation('//body/DocFragment[2]/body/')).resolves.toBe(true);
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('chapter-two.xhtml');
    expect(testState.displayedPage).toBe(1);

    session.destroy();
  });

  it('returns false for missing XPath nodes and falls back to serverPercentage during open', async () => {
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      '//body/DocFragment[1]/body/section[1]/p[99]',
      0.85,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    expect(mockRendition.display).toHaveBeenLastCalledWith('chapter-four.xhtml');
    expect(testState.activeSectionIndex).toBe(3);

    mockRendition.display.mockClear();
    await expect(
      session.displayServerLocation('//body/DocFragment[1]/body/section[1]/p[99]'),
    ).resolves.toBe(false);
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('chapter-one.xhtml');

    session.destroy();
  });

  it('returns false when contents.range(cfi) resolves to null and falls back to serverPercentage', async () => {
    const chapterOneContents = testState.sections[0]!.contents;
    const rangeSpy = vi
      .spyOn(chapterOneContents, 'range')
      .mockReturnValue(null as unknown as Range);

    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      '//body/DocFragment[1]/body/section[1]/p[2]',
      0.85,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    expect(rangeSpy).toHaveBeenCalledOnce();
    expect(mockRendition.display.mock.calls).toEqual([
      ['chapter-one.xhtml'],
      ['chapter-four.xhtml'],
    ]);
    expect(testState.activeSectionIndex).toBe(3);

    mockRendition.display.mockClear();
    await expect(
      session.displayServerLocation('//body/DocFragment[1]/body/section[1]/p[2]'),
    ).resolves.toBe(false);
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('chapter-one.xhtml');

    session.destroy();
  });
});

describe('ReaderSession publisher formatting cascade', () => {
  it('preserves .scene-break and .epigraph styles when publisherStyles is true and overrides cleanly on toggle', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const originalThemes = mockRendition.themes;
    try {
      const chapterDoc = frame.contentDocument!;
      chapterDoc.open();
      chapterDoc.write(`<!doctype html><html><head><style>
        .scene-break { text-align: center; margin: 1.5em 0; }
        .epigraph { text-align: right; margin: 1.5em 2em; }
        .epigraph p { margin-bottom: 0.25em; }
      </style></head><body>
        <p id="body-copy">Ordinary paragraph</p>
        <p id="scene-break" class="scene-break">* * *</p>
        <blockquote class="epigraph"><p id="epigraph-line">Epigraph quote</p></blockquote>
      </body></html>`);
      chapterDoc.close();

      const contents = Object.assign(Object.create(Contents.prototype) as Contents, {
        document: chapterDoc,
        content: chapterDoc.body,
        locationOf: vi.fn(async () => ({ left: 0, top: 0 })),
      });
      testState.activeSectionIndex = 0;
      testState.sections = [{ href: 'chapter-one.xhtml', index: 0, contents }];

      const realThemes = new Rendition(new Book(), {})
        .themes as unknown as typeof mockRendition.themes & {
        rendition: unknown;
      };
      realThemes.rendition = mockRendition;
      mockRendition.themes = realThemes;
      mockRendition.location = { start: { cfi: 'epubcfi(/6/2!/4/2:0)' } };
      mockRendition.display.mockClear();

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
      mockRendition.display.mockClear();

      const styleOf = (id: string) =>
        frame.contentWindow!.getComputedStyle(chapterDoc.getElementById(id)!);

      expect(styleOf('body-copy').textAlign).toBe('start');
      expect(styleOf('body-copy').marginBottom).toBe('10.8px');
      expect(styleOf('scene-break').textAlign).toBe('center');
      expect(styleOf('scene-break').marginBottom).toBe('27px');
      expect(styleOf('epigraph-line').textAlign).toBe('right');
      expect(styleOf('epigraph-line').marginBottom).toBe('4.5px');

      session.applyAppearance({
        ...defaultAppearance,
        alignment: 'justify',
        publisherStyles: false,
      });

      expect(styleOf('body-copy').textAlign).toBe('justify');
      expect(styleOf('scene-break').textAlign).toBe('justify');
      expect(styleOf('scene-break').marginBottom).toBe('10.8px');
      expect(styleOf('epigraph-line').textAlign).toBe('justify');
      expect(styleOf('epigraph-line').marginBottom).toBe('10.8px');
      expect(mockRendition.display).toHaveBeenCalledWith('epubcfi(/6/2!/4/2:0)');

      mockRendition.display.mockClear();
      session.applyAppearance({
        ...defaultAppearance,
        alignment: 'justify',
        publisherStyles: true,
      });

      expect(chapterDoc.querySelectorAll('#epubjs-inserted-css-turnleaf')).toHaveLength(1);
      expect(styleOf('body-copy').textAlign).toBe('justify');
      expect(styleOf('scene-break').textAlign).toBe('center');
      expect(styleOf('scene-break').marginBottom).toBe('27px');
      expect(styleOf('epigraph-line').textAlign).toBe('right');
      expect(styleOf('epigraph-line').marginBottom).toBe('4.5px');
      expect(mockRendition.display).toHaveBeenCalledWith('epubcfi(/6/2!/4/2:0)');

      session.destroy();
    } finally {
      mockRendition.themes = originalThemes;
      mockRendition.location = undefined;
      testState.sections = [];
      frame.remove();
    }
  });
});
