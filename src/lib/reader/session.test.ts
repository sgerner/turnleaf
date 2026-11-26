// @vitest-environment jsdom

import type { Contents as EpubContents, Location } from 'epubjs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { defaultAppearance, parseAppearance } from './appearance';
import { parseKavitaXPath, resolveContentXPath, toKavitaXPath } from './kavita-xpath';

const PAGE_WIDTH = 300;

const { testState, mockBook, mockRendition, createBookMock } = vi.hoisted(() => {
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
  const createBookMock = vi.fn<(...args: unknown[]) => unknown>(() => book);
  return { testState: state, mockBook: book, mockRendition: rendition, createBookMock };
});

vi.mock('epubjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    default: (...args: unknown[]) => createBookMock(...args),
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface SimulatedSection {
  href: string;
  index: number;
  html: string;
  cfiTargets: Record<string, { unthemedPage: number; pageAt18: number; pageAt34: number }>;
  pagesAt16: number;
  pagesAt18: number;
  pagesAt34: number;
}

interface SimulatedContents {
  document: Document;
  window: Window;
  sectionIndex: number;
  cfiFromRange: () => string;
  resizeCheck: Mock<() => void>;
}

function createSimulatedEpubHarness(sections: SimulatedSection[]) {
  const pageWidth = PAGE_WIDTH;
  const contentHooks: Array<(contents: EpubContents) => unknown> = [];
  const renderHooks: Array<(view: unknown) => unknown> = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const currentThemeRules: Record<string, Record<string, Record<string, string>>> = {};
  let selectedTheme = 'default';
  let scrollLeft = 0;
  let scrollWidth = pageWidth;

  // Non-iterable Views collection matching epub.js Views helper (only exposes forEach, not Symbol.iterator).
  const activeViews: Array<{
    section: SimulatedSection;
    displayed: boolean;
    width: () => number;
    destroy: () => void;
    expand: Mock<() => void>;
    contents?: SimulatedContents;
    pane?: { render: Mock<() => void> };
    locationOf: (target: string) => { left: number; top: number };
  }> = [];

  const viewsCollection = {
    forEach(callback: (view: (typeof activeViews)[number]) => void) {
      activeViews.forEach(callback);
    },
  };

  const injectTheme = (contents: Pick<SimulatedContents, 'document'>) => {
    const rules = currentThemeRules[selectedTheme];
    if (!rules) return;
    let style = contents.document.getElementById(
      `epubjs-inserted-css-${selectedTheme}`,
    ) as HTMLStyleElement | null;
    if (!style) {
      style = contents.document.createElement('style');
      style.id = `epubjs-inserted-css-${selectedTheme}`;
      contents.document.head.appendChild(style);
    }
    const fontSize = rules.body?.['font-size'] ?? '16px';
    style.dataset.fontSize = fontSize;
    contents.document.body.classList.add(selectedTheme);
  };

  // Match epub.js Rendition constructor: Themes.inject registers on hooks.content before ReaderSession.open.
  contentHooks.push(injectTheme);

  const measurePages = (doc: Document, section: SimulatedSection): number => {
    const themeStyle = doc.getElementById('epubjs-inserted-css-turnleaf');
    const fontSizeAttr = themeStyle?.dataset.fontSize ?? '';
    const hasLinkPending = doc.querySelector('link[rel="stylesheet"]') !== null;
    const sanitizedStyles = [...doc.querySelectorAll('style:not([id])')].some((node) =>
      (node.textContent ?? '').includes('--chapter-ready'),
    );
    const expectsExternalCss = section.html.includes('rel="stylesheet"');
    if (hasLinkPending || (expectsExternalCss && !sanitizedStyles)) {
      return section.pagesAt16;
    }
    if (fontSizeAttr.startsWith('34px')) return section.pagesAt34;
    if (fontSizeAttr.startsWith('18px')) return section.pagesAt18;
    return section.pagesAt16;
  };

  const emit = (event: string, ...args: unknown[]) => {
    for (const handler of listeners.get(event) ?? []) {
      handler(...args);
    }
  };

  const clearViews = () => {
    scrollLeft = 0;
    scrollWidth = pageWidth;
    for (const view of [...activeViews]) {
      if (view.displayed) view.destroy();
    }
    activeViews.length = 0;
  };

  const createView = vi.fn((section: SimulatedSection) => {
    let viewWidth = 0;
    let cachedSize = { width: 0, height: 0 };
    const pane = { render: vi.fn<() => void>() };
    const view: (typeof activeViews)[number] & {
      display: () => Promise<unknown>;
    } = {
      section,
      displayed: false,
      pane,
      width: () => viewWidth,
      locationOf: (target: string) => {
        const entry = section.cfiTargets[target];
        if (!entry || !view.contents) return { left: 0, top: 0 };
        const pages = measurePages(view.contents.document, section);
        const page =
          pages === section.pagesAt34
            ? entry.pageAt34
            : pages === section.pagesAt18
              ? entry.pageAt18
              : entry.unthemedPage;
        return { left: (page - 1) * pageWidth, top: 0 };
      },
      expand: vi.fn<() => void>(() => {
        if (!view.contents || !view.displayed) {
          if (view.contents) {
            viewWidth = measurePages(view.contents.document, section) * pageWidth;
            scrollWidth = viewWidth;
          }
          return;
        }
        const nextWidth = measurePages(view.contents.document, section) * pageWidth;
        if (nextWidth !== viewWidth) {
          viewWidth = nextWidth;
          scrollWidth = nextWidth;
          view.pane?.render();
        }
      }),
      destroy: vi.fn<() => void>(() => {
        if (!view.displayed) return;
        view.displayed = false;
        delete view.contents;
        delete view.pane;
      }),
      display: async () => {
        if (!view.displayed) {
          const doc = new DOMParser().parseFromString(section.html, 'application/xhtml+xml');
          const resizeCheck = vi.fn<() => void>(() => {
            if (!view.contents) return;
            const width = measurePages(view.contents.document, section) * pageWidth;
            if (width !== cachedSize.width) {
              cachedSize = { width, height: 400 };
              if (view.displayed) view.expand();
            }
          });
          view.contents = {
            document: doc,
            window: window as unknown as Window,
            sectionIndex: section.index,
            cfiFromRange: () => '',
            resizeCheck,
          };

          // Initial unthemed render expands at 16px before afterDisplayed hooks run.
          view.expand();
          view.displayed = true;

          // Match epub.js Rendition.afterDisplayed: detached hooks.render -> hooks.content chain.
          void Promise.all(renderHooks.map((hook) => hook(view))).then(() => {
            if (view.contents) {
              return Promise.all(
                contentHooks.map((hook) => hook(view.contents as unknown as EpubContents)),
              );
            }
            return undefined;
          });
        }
        return view;
      },
    };
    return view;
  });

  const moveTo = (offset: { left: number; top: number }) => {
    let distX = Math.floor(offset.left / pageWidth) * pageWidth;
    if (distX + pageWidth > scrollWidth) {
      distX = scrollWidth - pageWidth;
    }
    scrollLeft = Math.max(0, distX);
  };

  const manager = {
    createView,
    clear: clearViews,
  };

  const reportRelocated = (section: SimulatedSection, requestedTarget?: string) => {
    const total = Math.max(1, Math.round(scrollWidth / pageWidth));
    const page = Math.floor(scrollLeft / pageWidth) + 1;
    let resolvedCfi = `epubcfi(/6/${(section.index + 1) * 2}!/4/2/2:0)`;
    if (requestedTarget && section.cfiTargets[requestedTarget]) {
      const targetOffset =
        activeViews
          .find((item) => item.section.index === section.index)
          ?.locationOf(requestedTarget).left ?? 0;
      if (targetOffset === scrollLeft) {
        resolvedCfi = requestedTarget;
      } else {
        resolvedCfi = `clamped-page-${page}`;
      }
    }
    const location = {
      start: {
        cfi: resolvedCfi,
        href: section.href,
        index: section.index,
        percentage: (page - 1) / total,
        displayed: { page, total },
      },
    } as Location;
    rendition.location = location;
    emit('relocated', location);
  };

  const rendition = {
    manager,
    location: undefined as Location | undefined,
    hooks: {
      content: {
        register: vi.fn((fn: (contents: EpubContents) => unknown) => {
          contentHooks.push(fn);
        }),
      },
      render: {
        register: vi.fn((fn: (view: unknown) => unknown) => {
          renderHooks.push(fn);
        }),
      },
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    started: Promise.resolve(),
    themes: {
      register: vi.fn((name: string, rules: Record<string, Record<string, string>>) => {
        currentThemeRules[name] = rules;
      }),
      select: vi.fn((name: string) => {
        selectedTheme = name;
        for (const view of activeViews) {
          if (view.displayed && view.contents) injectTheme(view.contents);
        }
      }),
    },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    views: vi.fn(() => viewsCollection),
    display: vi.fn(async (target?: string) => {
      const section =
        (target
          ? sections.find(
              (candidate) => candidate.href === target || target in candidate.cfiTargets,
            )
          : sections[0]) ?? null;
      if (!section) throw new Error('No Section Found');
      const isSectionHref = target === undefined || target === section.href;
      const existing = activeViews.find(
        (candidate) => candidate.displayed && candidate.section.index === section.index,
      );
      if (existing) {
        scrollLeft = 0;
        if (!isSectionHref && target) {
          moveTo(existing.locationOf(target));
        }
        reportRelocated(section, isSectionHref ? undefined : target);
        return;
      }
      clearViews();
      const view = manager.createView(section);
      activeViews.push(view);
      await view.display();
      if (!isSectionHref && target) {
        moveTo(view.locationOf(target));
      }
      reportRelocated(section, isSectionHref ? undefined : target);
    }),
    resize: vi.fn(),
    destroy: vi.fn(() => {
      clearViews();
    }),
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

  createBookMock.mockReturnValue(book);

  return {
    book,
    rendition,
    manager,
    activeViews,
    getScrollLeft: () => scrollLeft,
    getScrollWidth: () => scrollWidth,
  };
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
    createBookMock.mockImplementation(() => mockBook);
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

describe('ReaderSession styled iframe expansion before CFI positioning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    createBookMock.mockImplementation(() => mockBook);
  });

  it.each([
    { fontSize: 18, expectedPageIndex: 6, expectedPageCount: 8, expectedScrollLeft: 1800 },
    { fontSize: 34, expectedPageIndex: 15, expectedPageCount: 18, expectedScrollLeft: 4500 },
  ])(
    'expands unloaded chapters after theme injection and async stylesheet sanitization on open at $fontSize px',
    async ({ fontSize, expectedPageIndex, expectedPageCount, expectedScrollLeft }) => {
      const targetCfi = 'epubcfi(/6/2!/4/2/18:0)';
      const cssDeferred = createDeferred<Response>();
      vi.stubGlobal(
        'fetch',
        vi.fn(() => cssDeferred.promise),
      );

      const harness = createSimulatedEpubHarness([
        {
          href: 'chapter-1.xhtml',
          index: 0,
          html: '<html xmlns="http://www.w3.org/1999/xhtml"><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/chapter.css" /></head><body><p>Deep chapter text</p></body></html>',
          pagesAt16: 4,
          pagesAt18: 8,
          pagesAt34: 18,
          cfiTargets: {
            [targetCfi]: { unthemedPage: 4, pageAt18: 7, pageAt34: 16 },
          },
        },
      ]);

      const appearance = parseAppearance(JSON.stringify({ ...defaultAppearance, fontSize }));
      const onLocation = vi.fn();
      const session = new ReaderSession('book.epub');

      const openPromise = session.open(
        document.createElement('div'),
        targetCfi,
        null,
        null,
        appearance,
        onLocation,
        vi.fn(),
      );

      await Promise.resolve();
      expect(onLocation).not.toHaveBeenCalled();

      cssDeferred.resolve(
        new Response(':root { --chapter-ready: 1; }', {
          status: 200,
          headers: { 'content-type': 'text/css' },
        }),
      );
      await openPromise;

      const renderedView = harness.activeViews[0];
      expect(renderedView?.contents?.resizeCheck).toHaveBeenCalled();
      expect(renderedView?.pane?.render).toHaveBeenCalled();
      expect(harness.getScrollWidth()).toBe(expectedPageCount * 300);
      expect(harness.getScrollLeft()).toBe(expectedScrollLeft);
      expect(onLocation).toHaveBeenCalledOnce();
      expect(onLocation).toHaveBeenCalledWith(
        expect.objectContaining({
          cfi: targetCfi,
          pageIndex: expectedPageIndex,
          pageCount: expectedPageCount,
        }),
        'restore',
      );

      session.destroy();
    },
  );

  it.each([
    { fontSize: 18, expectedPageIndex: 7, expectedPageCount: 9, expectedScrollLeft: 2100 },
    { fontSize: 34, expectedPageIndex: 16, expectedPageCount: 20, expectedScrollLeft: 4800 },
  ])(
    'expands unloaded target chapters on displayCfi jumps at $fontSize px and emits one navigation relocation',
    async ({ fontSize, expectedPageIndex, expectedPageCount, expectedScrollLeft }) => {
      const jumpCfi = 'epubcfi(/6/4!/4/2/24:0)';
      const stylesheetGate = createDeferred<Response>();
      vi.stubGlobal(
        'fetch',
        vi.fn(() => stylesheetGate.promise),
      );

      const harness = createSimulatedEpubHarness([
        {
          href: 'chapter-1.xhtml',
          index: 0,
          html: '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body><p>Chapter one</p></body></html>',
          pagesAt16: 1,
          pagesAt18: 2,
          pagesAt34: 4,
          cfiTargets: {},
        },
        {
          href: 'chapter-2.xhtml',
          index: 1,
          html: '<html xmlns="http://www.w3.org/1999/xhtml"><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/chapter-2.css" /></head><body><p>Chapter two</p></body></html>',
          pagesAt16: 3,
          pagesAt18: 9,
          pagesAt34: 20,
          cfiTargets: {
            [jumpCfi]: { unthemedPage: 3, pageAt18: 8, pageAt34: 17 },
          },
        },
      ]);

      const appearance = parseAppearance(JSON.stringify({ ...defaultAppearance, fontSize }));
      const onLocation = vi.fn();
      const session = new ReaderSession('book.epub');

      await session.open(
        document.createElement('div'),
        null,
        null,
        null,
        appearance,
        onLocation,
        vi.fn(),
      );
      onLocation.mockClear();

      const jumpPromise = session.displayCfi(jumpCfi);
      await Promise.resolve();
      expect(onLocation).not.toHaveBeenCalled();

      stylesheetGate.resolve(
        new Response(':root { --chapter-ready: 1; }', {
          status: 200,
          headers: { 'content-type': 'text/css' },
        }),
      );
      await expect(jumpPromise).resolves.toBe(true);

      expect(harness.getScrollWidth()).toBe(expectedPageCount * 300);
      expect(harness.getScrollLeft()).toBe(expectedScrollLeft);
      expect(onLocation).toHaveBeenCalledOnce();
      expect(onLocation).toHaveBeenCalledWith(
        expect.objectContaining({
          cfi: jumpCfi,
          href: 'chapter-2.xhtml',
          spineIndex: 1,
          pageIndex: expectedPageIndex,
          pageCount: expectedPageCount,
        }),
        'navigation',
      );

      session.destroy();
    },
  );

  it('expands only active rendered views via non-iterable Views.forEach before preserveCfi reflows on appearance changes', async () => {
    const targetCfi = 'epubcfi(/6/2!/4/2/12:0)';
    const harness = createSimulatedEpubHarness([
      {
        href: 'chapter-1.xhtml',
        index: 0,
        html: '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body><p>Reflowable chapter</p></body></html>',
        pagesAt16: 3,
        pagesAt18: 6,
        pagesAt34: 14,
        cfiTargets: {
          [targetCfi]: { unthemedPage: 3, pageAt18: 5, pageAt34: 12 },
        },
      },
    ]);

    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      targetCfi,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );

    const unrenderedExpand = vi.fn<() => void>();
    const unrenderedResizeCheck = vi.fn<() => void>();
    harness.activeViews.push({
      section: harness.activeViews[0]!.section,
      displayed: false,
      width: () => 0,
      destroy: vi.fn(),
      expand: unrenderedExpand,
      contents: {
        document: document.implementation.createHTMLDocument('unrendered'),
        window: window as unknown as Window,
        sectionIndex: 1,
        cfiFromRange: () => '',
        resizeCheck: unrenderedResizeCheck,
      },
      pane: { render: vi.fn<() => void>() },
      locationOf: () => ({ left: 0, top: 0 }),
    });

    const activeView = harness.activeViews[0]!;
    activeView.contents!.resizeCheck.mockClear();
    activeView.expand.mockClear();
    activeView.pane!.render.mockClear();
    onLocation.mockClear();

    session.applyAppearance({ ...defaultAppearance, fontSize: 34 });
    await vi.waitFor(() => expect(onLocation).toHaveBeenCalledOnce());

    expect(harness.rendition.views).toHaveBeenCalled();
    expect(activeView.contents!.resizeCheck).toHaveBeenCalled();
    expect(activeView.expand).toHaveBeenCalled();
    expect(activeView.pane!.render).toHaveBeenCalled();
    expect(unrenderedResizeCheck).not.toHaveBeenCalled();
    expect(unrenderedExpand).not.toHaveBeenCalled();
    expect(harness.getScrollWidth()).toBe(14 * 300);
    expect(harness.getScrollLeft()).toBe(11 * 300);
    expect(onLocation).toHaveBeenCalledWith(
      expect.objectContaining({
        cfi: targetCfi,
        pageIndex: 11,
        pageCount: 14,
      }),
      'restore',
    );

    onLocation.mockClear();
    session.applyAppearance({ ...defaultAppearance, fontSize: 18 });
    await vi.waitFor(() => expect(onLocation).toHaveBeenCalledOnce());

    expect(harness.getScrollWidth()).toBe(6 * 300);
    expect(harness.getScrollLeft()).toBe(4 * 300);
    expect(onLocation).toHaveBeenCalledWith(
      expect.objectContaining({
        cfi: targetCfi,
        pageIndex: 4,
        pageCount: 6,
      }),
      'restore',
    );

    session.destroy();
  });

  it('cancels stale restore operations when superseded by user navigation before open finishes', async () => {
    const staleRestoreCfi = 'epubcfi(/6/2!/4/2/18:0)';
    const freshNavCfi = 'epubcfi(/6/4!/4/2/24:0)';
    const chapter1Css = createDeferred<Response>();
    const chapter2Css = createDeferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const href = String(input);
        return href.includes('chapter-1.css') ? chapter1Css.promise : chapter2Css.promise;
      }),
    );

    const harness = createSimulatedEpubHarness([
      {
        href: 'chapter-1.xhtml',
        index: 0,
        html: '<html xmlns="http://www.w3.org/1999/xhtml"><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/chapter-1.css" /></head><body><p>Stale chapter</p></body></html>',
        pagesAt16: 2,
        pagesAt18: 6,
        pagesAt34: 12,
        cfiTargets: {
          [staleRestoreCfi]: { unthemedPage: 2, pageAt18: 5, pageAt34: 10 },
        },
      },
      {
        href: 'chapter-2.xhtml',
        index: 1,
        html: '<html xmlns="http://www.w3.org/1999/xhtml"><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/chapter-2.css" /></head><body><p>Fresh chapter</p></body></html>',
        pagesAt16: 3,
        pagesAt18: 8,
        pagesAt34: 16,
        cfiTargets: {
          [freshNavCfi]: { unthemedPage: 3, pageAt18: 7, pageAt34: 14 },
        },
      },
    ]);

    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    const openPromise = session.open(
      document.createElement('div'),
      'epubcfi(/6/99!/4/2:0)',
      '//body/DocFragment[2]/body/p[1]',
      0.5,
      { ...defaultAppearance, fontSize: 34 },
      onLocation,
      vi.fn(),
    );

    // Let open() fail the missing CFI and begin fallback while we supersede with displayCfi().
    await Promise.resolve();
    const navPromise = session.displayCfi(freshNavCfi);
    await vi.waitFor(() => expect(harness.activeViews).toHaveLength(1));

    chapter2Css.resolve(new Response(':root { --chapter-ready: 1; }', { status: 200 }));
    chapter1Css.resolve(new Response(':root { --chapter-ready: 1; }', { status: 200 }));

    await expect(navPromise).resolves.toBe(true);
    await expect(openPromise).resolves.toBeUndefined();

    expect(harness.getScrollLeft()).toBe(13 * 300);
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cfi: freshNavCfi,
        href: 'chapter-2.xhtml',
        pageIndex: 13,
        pageCount: 16,
      }),
      'navigation',
    );

    session.destroy();
  });

  it('releases pending view readiness waits when DefaultViewManager.clear destroys an in-flight view', async () => {
    const neverSettledFetch = new Promise<Response>(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() => neverSettledFetch),
    );

    const harness = createSimulatedEpubHarness([
      {
        href: 'chapter-1.xhtml',
        index: 0,
        html: '<html xmlns="http://www.w3.org/1999/xhtml"><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/slow.css" /></head><body><p>Slow chapter</p></body></html>',
        pagesAt16: 2,
        pagesAt18: 5,
        pagesAt34: 10,
        cfiTargets: {},
      },
    ]);

    const session = new ReaderSession('book.epub');
    const openPromise = session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    await vi.waitFor(() => expect(harness.activeViews).toHaveLength(1));
    const pendingView = harness.activeViews[0]!;
    pendingView.expand.mockClear();

    // Directly invoke manager.clear() -> view.destroy() without destroying the session yet.
    harness.manager.clear();
    await expect(openPromise).resolves.toBeUndefined();
    expect(pendingView.expand).not.toHaveBeenCalled();

    session.destroy();
  });

  it('releases pending view readiness waits when a view or session is destroyed mid-sanitization', async () => {
    const neverSettledFetch = new Promise<Response>(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() => neverSettledFetch),
    );

    const harness = createSimulatedEpubHarness([
      {
        href: 'chapter-1.xhtml',
        index: 0,
        html: '<html xmlns="http://www.w3.org/1999/xhtml"><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/slow.css" /></head><body><p>Slow chapter</p></body></html>',
        pagesAt16: 2,
        pagesAt18: 5,
        pagesAt34: 10,
        cfiTargets: {},
      },
    ]);

    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    const openPromise = session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );

    await vi.waitFor(() => expect(harness.activeViews).toHaveLength(1));
    const pendingView = harness.activeViews[0]!;
    pendingView.expand.mockClear();

    // Simulate DefaultViewManager.clear() or ReaderSession.destroy() tearing down the in-flight view.
    session.destroy();
    await expect(openPromise).resolves.toBeUndefined();

    expect(pendingView.expand).not.toHaveBeenCalled();
    expect(onLocation).not.toHaveBeenCalled();
  });

  it('clears the document, installs CSP, and settles readiness if sanitization throws', async () => {
    const harness = createSimulatedEpubHarness([
      {
        href: 'broken.xhtml',
        index: 0,
        html: '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body onload="evil()"><script>evil()</script><p>Unsafe fallback content</p></body></html>',
        pagesAt16: 1,
        pagesAt18: 2,
        pagesAt34: 4,
        cfiTargets: {},
      },
    ]);

    const originalQuerySelectorAll = Document.prototype.querySelectorAll;
    let failedOnce = false;
    vi.spyOn(Document.prototype, 'querySelectorAll').mockImplementation(function (
      this: Document,
      selectors: string,
    ) {
      if (!failedOnce && selectors.includes('script')) {
        failedOnce = true;
        throw new Error('Synthetic DOM sanitization failure');
      }
      return originalQuerySelectorAll.call(this, selectors);
    });

    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    await expect(
      session.open(
        document.createElement('div'),
        null,
        null,
        null,
        defaultAppearance,
        onLocation,
        vi.fn(),
      ),
    ).resolves.toBeUndefined();

    const doc = harness.activeViews[0]?.contents?.document;
    expect(doc?.querySelector('script')).toBeNull();
    expect(doc?.body.textContent).toBe('');
    expect(doc?.body.getAttribute('onload')).toBeNull();
    expect(
      doc?.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
    ).toContain("default-src 'none'");
    expect(onLocation).toHaveBeenCalledOnce();

    session.destroy();
  });

  it('defers ResizeObserver and Stage manager.resize calls during async open and flushes the latest size afterward', async () => {
    const cssDeferred = createDeferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => cssDeferred.promise),
    );

    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const targetCfi = 'epubcfi(/6/2!/4/2/16:0)';
    const harness = createSimulatedEpubHarness([
      {
        href: 'chapter-1.xhtml',
        index: 0,
        html: '<html xmlns="http://www.w3.org/1999/xhtml"><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/chapter.css" /></head><body><p>Styled chapter</p></body></html>',
        pagesAt16: 2,
        pagesAt18: 6,
        pagesAt34: 12,
        cfiTargets: {
          [targetCfi]: { unthemedPage: 2, pageAt18: 5, pageAt34: 10 },
        },
      },
    ]);
    const rawManagerResize = vi.fn<(_width?: number, _height?: number) => void>(() => {
      harness.manager.clear();
      if (harness.rendition.location?.start?.cfi) {
        void harness.rendition.display(harness.rendition.location.start.cfi);
      }
    });
    Object.assign(harness.manager, { resize: rawManagerResize });
    harness.rendition.resize.mockImplementation((width?: number, height?: number) => {
      (harness.manager as typeof harness.manager & { resize: typeof rawManagerResize }).resize(
        width,
        height,
      );
    });

    const viewport = document.createElement('div');
    let currentRect = new DOMRect(0, 0, 411, 842);
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => currentRect);

    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    const openPromise = session.open(
      viewport,
      targetCfi,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );

    await vi.waitFor(() => expect(harness.activeViews).toHaveLength(1));

    // Simulate Android ReaderChrome hiding system bars while open() is still awaiting stylesheet sanitization.
    currentRect = new DOMRect(0, 0, 411, 880);
    (harness.manager as typeof harness.manager & { resize: () => void }).resize();
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 411, height: 880 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    currentRect = new DOMRect(0, 0, 411, 914);
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 411, height: 914 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    expect(rawManagerResize).not.toHaveBeenCalled();
    expect(harness.rendition.resize).not.toHaveBeenCalled();
    expect(harness.activeViews).toHaveLength(1);

    cssDeferred.resolve(new Response('body { --chapter-ready: 1; }', { status: 200 }));
    await openPromise;

    expect(harness.rendition.resize).toHaveBeenCalledTimes(1);
    expect(harness.rendition.resize).toHaveBeenCalledWith(411, 914);
    await vi.waitFor(() => expect(harness.getScrollLeft()).toBe(1200));
    expect(harness.activeViews).toHaveLength(1);

    session.destroy();
  });

  it('keeps userNavigationPending intact if open() emits its queued relocated event after next() starts', async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const emit = (event: string, ...args: unknown[]) => {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args);
      }
    };
    const nextDeferred = createDeferred<void>();
    const queuedRendition = {
      q: {
        running: false,
        length: () => 0,
        enqueue: vi.fn((task: () => Promise<void>) => task()),
      },
      location: undefined as Location | undefined,
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
      display: vi.fn(async () => {}),
      next: vi.fn(() => nextDeferred.promise),
      resize: vi.fn(),
      destroy: vi.fn(),
    };
    createBookMock.mockReturnValue({
      renderTo: vi.fn(() => queuedRendition),
      destroy: vi.fn(),
      spine: {
        each: vi.fn((visit: (section: { href: string; index: number }) => void) => {
          visit({ href: 'chapter1.xhtml', index: 0 });
          visit({ href: 'chapter2.xhtml', index: 1 });
        }),
      },
      navigation: { toc: [] },
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

    // Start next() before open()'s requestAnimationFrame relocated callback has fired.
    const nextPromise = session.next();

    const chapter1Location = {
      start: {
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        href: 'chapter1.xhtml',
        index: 0,
        percentage: 0,
        displayed: { page: 1, total: 1 },
      },
    } as Location;
    queuedRendition.location = chapter1Location;
    emit('relocated', chapter1Location);

    nextDeferred.resolve();
    await nextPromise;

    const chapter2Location = {
      start: {
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        href: 'chapter2.xhtml',
        index: 1,
        percentage: 0.5,
        displayed: { page: 1, total: 1 },
      },
    } as Location;
    queuedRendition.location = chapter2Location;
    emit('relocated', chapter2Location);

    expect(onLocation).toHaveBeenCalledTimes(2);
    expect(onLocation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cfi: 'epubcfi(/6/2!/4/2/1:0)', spineIndex: 0 }),
      'restore',
    );
    expect(onLocation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cfi: 'epubcfi(/6/4!/4/2/1:0)', spineIndex: 1 }),
      'navigation',
    );

    session.destroy();
  });

  it('expands active views and defers concurrent viewport resizes during publisherStyles appearance reflow', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const targetCfi = 'epubcfi(/6/2!/4/2/14:0)';
    const harness = createSimulatedEpubHarness([
      {
        href: 'chapter-1.xhtml',
        index: 0,
        html: '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body><p>Publisher formatted chapter</p></body></html>',
        pagesAt16: 3,
        pagesAt18: 7,
        pagesAt34: 15,
        cfiTargets: {
          [targetCfi]: { unthemedPage: 3, pageAt18: 6, pageAt34: 13 },
        },
      },
    ]);

    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 0, 411, 842),
    );

    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(viewport, targetCfi, null, null, defaultAppearance, onLocation, vi.fn());

    const activeView = harness.activeViews[0]!;
    activeView.contents!.resizeCheck.mockClear();
    activeView.expand.mockClear();
    harness.rendition.resize.mockClear();
    onLocation.mockClear();

    const reflowGate = createDeferred<void>();
    const baseDisplay = harness.rendition.display.getMockImplementation()!;
    harness.rendition.display.mockImplementationOnce(async (target?: string) => {
      await reflowGate.promise;
      return baseDisplay(target);
    });

    session.applyAppearance({ ...defaultAppearance, publisherStyles: false });

    expect(activeView.contents!.resizeCheck).toHaveBeenCalledOnce();
    expect(activeView.expand).toHaveBeenCalledOnce();
    expect(harness.rendition.display).toHaveBeenCalledWith(targetCfi);

    resizeCallbacks[0]?.(
      [{ contentRect: { width: 411, height: 900 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    expect(harness.rendition.resize).not.toHaveBeenCalled();

    reflowGate.resolve();
    await vi.waitFor(() => expect(onLocation).toHaveBeenCalledOnce());
    expect(onLocation).toHaveBeenCalledWith(
      expect.objectContaining({ cfi: targetCfi, pageIndex: 5, pageCount: 7 }),
      'restore',
    );
    expect(harness.rendition.resize).toHaveBeenCalledExactlyOnceWith(411, 900);

    session.destroy();
  });
});
