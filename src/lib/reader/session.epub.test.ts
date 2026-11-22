// @vitest-environment jsdom

import type { Contents, Location } from 'epubjs';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Reader from '../components/Reader.svelte';
import {
  getPendingSync,
  getPreferences,
  getReadingState,
  reconcileBooks,
  saveLocalProgress,
  setPreference,
  type BookRecord,
} from '../database/database';
import { addAnnotation } from './annotations';
import { defaultAppearance } from './appearance';
import {
  parseLocationHistory,
  parseReturnStack,
  returnStackPreferenceKey,
  toggleBookmark,
} from './bookmarks';

type TestTocItem = { label: string; href: string; subitems?: TestTocItem[] };
type TestSpineSection = {
  href: string;
  index: number;
  load?: () => Promise<void>;
  unload?: () => void;
  search?: (query: string) => Array<{ cfi: string; excerpt: string }>;
};

const { defaultSpineSections, integrationState, mockBook, mockRendition } = vi.hoisted(() => {
  const defaultSpineSections: TestSpineSection[] = [
    { href: 'first.xhtml', index: 0 },
    { href: 'second.xhtml', index: 1 },
  ];
  const integrationSections: TestSpineSection[] = [
    {
      href: 'chapter-1.xhtml',
      index: 0,
      load: vi.fn(async () => {}),
      unload: vi.fn(),
      search: vi.fn(() => []),
    },
    {
      href: 'chapter-2.xhtml',
      index: 1,
      load: vi.fn(async () => {}),
      unload: vi.fn(),
      search: vi.fn(() => [
        {
          cfi: 'epubcfi(/6/4!/4/8)',
          excerpt: 'Search match inside chapter two',
        },
      ]),
    },
    {
      href: 'endnotes.xhtml',
      index: 2,
      load: vi.fn(async () => {}),
      unload: vi.fn(),
      search: vi.fn(() => []),
    },
  ];
  const integrationToc: TestTocItem[] = [
    { label: 'Chapter 1', href: 'chapter-1.xhtml' },
    { label: 'Chapter 2', href: 'chapter-2.xhtml' },
    { label: 'Endnotes', href: 'endnotes.xhtml' },
  ];
  const integrationState = {
    autoRelocate: false,
    currentSectionIndex: 0,
    currentPage: 1,
    currentCfi: 'epubcfi(/6/2!/4/2)',
    currentHref: 'chapter-1.xhtml',
    sections: integrationSections,
    toc: integrationToc,
  };

  function makeAutoLocation(
    cfi: string,
    href: string,
    index: number,
    page = 1,
    total = 4,
  ): Location {
    return {
      start: {
        cfi,
        href,
        index,
        percentage: (index + (page - 1) / total) / Math.max(1, integrationState.sections.length),
        displayed: { page, total },
      },
    } as Location;
  }

  function emitRelocated(loc: Location): void {
    const relocated = [...rendition.on.mock.calls]
      .reverse()
      .find(([name]) => name === 'relocated')?.[1];
    if (typeof relocated === 'function') {
      relocated(loc);
    }
  }

  const rendition = {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async (target?: string) => {
      if (!integrationState.autoRelocate) return;
      if (!target) {
        integrationState.currentSectionIndex = 0;
        integrationState.currentHref = 'chapter-1.xhtml';
        integrationState.currentPage = 1;
        integrationState.currentCfi = 'epubcfi(/6/2!/4/2)';
      } else if (target.startsWith('epubcfi(')) {
        integrationState.currentCfi = target;
        if (target.includes('/6/6!')) {
          integrationState.currentSectionIndex = 2;
          integrationState.currentHref = 'endnotes.xhtml';
        } else if (target.includes('/6/4!')) {
          integrationState.currentSectionIndex = 1;
          integrationState.currentHref = 'chapter-2.xhtml';
        } else {
          integrationState.currentSectionIndex = 0;
          integrationState.currentHref = 'chapter-1.xhtml';
        }
        integrationState.currentPage = target.endsWith('/6)') ? 2 : 1;
      } else {
        const cleanHref = target.split('#')[0] ?? target;
        const found = integrationState.sections.find((section) => section.href === cleanHref);
        integrationState.currentSectionIndex = found?.index ?? 0;
        integrationState.currentHref = found?.href ?? cleanHref;
        integrationState.currentPage = 1;
        integrationState.currentCfi = `epubcfi(/6/${(integrationState.currentSectionIndex + 1) * 2}!/4/2)`;
      }
      emitRelocated(
        makeAutoLocation(
          integrationState.currentCfi,
          integrationState.currentHref,
          integrationState.currentSectionIndex,
          integrationState.currentPage,
        ),
      );
    }),
    next: vi.fn(async () => {
      if (!integrationState.autoRelocate) return;
      integrationState.currentPage += 1;
      integrationState.currentCfi = `epubcfi(/6/${(integrationState.currentSectionIndex + 1) * 2}!/4/${integrationState.currentPage * 2 + 2})`;
      emitRelocated(
        makeAutoLocation(
          integrationState.currentCfi,
          integrationState.currentHref,
          integrationState.currentSectionIndex,
          integrationState.currentPage,
        ),
      );
    }),
    prev: vi.fn(async () => {
      if (!integrationState.autoRelocate) return;
      integrationState.currentPage = Math.max(1, integrationState.currentPage - 1);
      integrationState.currentCfi = `epubcfi(/6/${(integrationState.currentSectionIndex + 1) * 2}!/4/${integrationState.currentPage * 2})`;
      emitRelocated(
        makeAutoLocation(
          integrationState.currentCfi,
          integrationState.currentHref,
          integrationState.currentSectionIndex,
          integrationState.currentPage,
        ),
      );
    }),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const spine = {
    sections: [...defaultSpineSections],
    each: vi.fn((visit: (section: TestSpineSection) => void) => {
      for (const section of spine.sections) {
        visit(section);
      }
    }),
  };
  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    load: vi.fn(async () => document.implementation.createHTMLDocument('section')),
    spine,
    navigation: { toc: [] as TestTocItem[] },
  };
  return { defaultSpineSections, integrationState, mockBook: book, mockRendition: rendition };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => mockBook) }));

import { ReaderSession } from './session';

function getRenditionListener(
  event: 'click' | 'keydown' | 'relocated',
): (...args: unknown[]) => void {
  const listener = mockRendition.on.mock.calls.find(([name]) => name === event)?.[1];
  if (typeof listener !== 'function') {
    throw new Error(`Expected rendition listener for "${event}"`);
  }
  return listener;
}

function location(cfi: string, href = 'chapter.xhtml', index = 0, page = 2): Location {
  return {
    start: {
      cfi,
      href,
      index,
      percentage: 0.2,
      displayed: { page, total: 10 },
    },
  } as Location;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const testBook: BookRecord = {
  id: 'server:1:10',
  serverId: 'server',
  libraryId: 1,
  seriesId: 1,
  volumeId: 10,
  chapterId: 10,
  title: 'Excursion Test Book',
  author: 'Turnleaf Author',
  series: null,
  descriptionHtml: null,
  format: 'epub',
  pages: 120,
  pagesRead: 40,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-01-02T00:00:00.000Z',
  downloadPath: 'books/server-1-10.epub',
  downloadStatus: 'available',
  fileSize: 2048,
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

if (typeof Element !== 'undefined' && !Element.prototype.animate) {
  Element.prototype.animate = () => {
    const animation = {
      onfinish: null as (() => void) | null,
      cancel: () => {},
      finish: () => {
        animation.onfinish?.();
      },
    };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
}

describe('ReaderSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    integrationState.autoRelocate = false;
    mockBook.navigation.toc = [];
    mockBook.spine.sections = [...defaultSpineSections];
  });

  afterEach(() => vi.unstubAllGlobals());

  it('forwards EPUB iframe key events to the reader and removes the listener on destroy', async () => {
    const onKeyboardNavigation = vi.fn();
    const session = new ReaderSession('book.epub');

    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
      undefined,
      onKeyboardNavigation,
    );

    expect(mockRendition.on).toHaveBeenCalledWith('keydown', onKeyboardNavigation);
    session.destroy();
    expect(mockRendition.off).toHaveBeenCalledWith('keydown', onKeyboardNavigation);
    expect(mockBook.destroy).toHaveBeenCalledOnce();
  });

  it('turns pages on ordinary content clicks while leaving links and text selection available', async () => {
    const onTap = vi.fn();
    const session = new ReaderSession('book.epub');
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), onTap);
    const click = getRenditionListener('click');
    const frame = document.createElement('iframe');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    const contents = {
      window: {
        frameElement: frame,
        innerWidth: 300,
        getSelection: () => ({ isCollapsed: true }),
      },
    };
    click({ target: document.createElement('a'), clientX: 250 }, contents);
    click(
      { target: document.createElement('p'), clientX: 250 },
      {
        window: {
          frameElement: frame,
          innerWidth: 300,
          getSelection: () => ({ isCollapsed: false }),
        },
      },
    );
    expect(onTap).not.toHaveBeenCalled();

    click({ target: document.createElement('p'), clientX: 250 }, contents);
    expect(onTap).toHaveBeenCalledExactlyOnceWith('next');
    session.destroy();
  });

  it('reports selection collapse to clear the reader selection actions', async () => {
    const session = new ReaderSession('book.epub');
    const onSelection = vi.fn();
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
      onSelection,
    );

    const registerSelection = mockRendition.hooks.content.register.mock.calls[1]?.[0];
    const text = document.createTextNode('Chapter One');
    document.body.append(text);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.addRange(range);
    registerSelection({ window, document, cfiFromRange: () => 'selected-cfi' });

    document.dispatchEvent(new Event('selectionchange'));
    expect(onSelection).toHaveBeenLastCalledWith({ cfi: 'selected-cfi', text: 'Chapter One' });
    selection.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(onSelection).toHaveBeenLastCalledWith(null);

    session.destroy();
    text.remove();
  });

  it('indexes the spine once across repeated relocation events', async () => {
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
    const relocated = getRenditionListener('relocated');
    const start = { href: 'second.xhtml', index: 1, cfi: '', displayed: { page: 1, total: 4 } };
    relocated({ start });
    relocated({ start: { ...start, displayed: { page: 2, total: 4 } } });

    expect(mockBook.spine.each).toHaveBeenCalledOnce();
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ percentage: 0.625 }),
      'restore',
    );
    session.destroy();
  });

  it('keeps nested EPUB navigation entries in the table of contents', () => {
    mockBook.navigation.toc = [
      {
        label: 'Part One',
        href: 'part-one.xhtml',
        subitems: [{ label: 'Chapter One', href: 'chapter-one.xhtml' }],
      },
    ];

    expect(new ReaderSession('book.epub').tableOfContents()).toEqual([
      {
        label: 'Part One',
        href: 'part-one.xhtml',
        children: [{ label: 'Chapter One', href: 'chapter-one.xhtml', children: [] }],
      },
    ]);
  });

  it('adds and removes persistent CFI highlights in the EPUB rendition', async () => {
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

    session.updateHighlights([{ cfi: 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:8)' }]);
    expect(mockRendition.annotations.highlight).toHaveBeenCalledWith(
      'epubcfi(/6/2!/4/2/1:0,/1:0,/1:8)',
      {},
      undefined,
      'turnleaf-highlight',
      { fill: '#facc15', 'fill-opacity': '0.38' },
    );

    session.updateHighlights([]);
    expect(mockRendition.annotations.remove).toHaveBeenCalledWith(
      'epubcfi(/6/2!/4/2/1:0,/1:0,/1:8)',
      'highlight',
    );
    session.destroy();
  });

  it('reflows the rendition when the reader viewport changes size', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

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
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 480, height: 640 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    expect(mockRendition.resize).toHaveBeenCalledWith(480, 640);
    session.destroy();
  });

  it('reports link jumps with a one-tap return location and does not retain stale origins', async () => {
    mockBook.spine.sections = [{ href: 'chapter.xhtml', index: 0 }];
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
    const relocated = getRenditionListener('relocated');
    const click = getRenditionListener('click');
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

  it('keeps the tap zones in the same places as the EPUB iframe scrolls', async () => {
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 0, 300, 400));
    const frame = document.createElement('iframe');
    const frameRect = vi.spyOn(frame, 'getBoundingClientRect');
    const contents = {
      window: { frameElement: frame, innerWidth: 1200, getSelection: () => null },
    } as unknown as Contents;
    const onTap = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), onTap);
    const click = getRenditionListener('click');

    for (const offset of [0, 300, 600, 900]) {
      frameRect.mockReturnValue(new DOMRect(20 - offset, 0, 1200, 400));
      for (const x of [20, 150, 280]) {
        click(new MouseEvent('click', { clientX: offset + x }), contents);
      }
    }

    expect(onTap.mock.calls).toEqual(
      Array.from({ length: 4 }, () => [['previous'], ['center'], ['next']]).flat(),
    );
    session.destroy();
  });

  it('classifies restore, sequential page turn, explicit jump, internal link, and return origins', async () => {
    mockBook.spine.sections = [
      { href: 'chapter.xhtml', index: 0 },
      { href: 'endnotes.xhtml', index: 2 },
    ];
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    const restored = await session.open(
      document.createElement('div'),
      'epubcfi(/6/2!/4/4)',
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );
    expect(restored).toBe(true);

    const relocated = getRenditionListener('relocated');
    relocated(location('epubcfi(/6/2!/4/4)'));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    await session.next();
    relocated(location('epubcfi(/6/2!/4/6)'));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('page');
    expect(onLocation.mock.calls.at(-1)).toHaveLength(2);

    await session.display('endnotes.xhtml');
    relocated(location('epubcfi(/6/6!/4/2)', 'endnotes.xhtml', 2, 1));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('jump');
    expect(onLocation.mock.calls.at(-1)?.[2]).toEqual({
      cfi: 'epubcfi(/6/2!/4/6)',
      href: 'chapter.xhtml',
    });

    await session.displayCfi('epubcfi(/6/2!/4/6)', 'return');
    relocated(location('epubcfi(/6/2!/4/6)'));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('return');
    expect(onLocation.mock.calls.at(-1)).toHaveLength(2);
    session.destroy();
  });
});

describe('Reader return stack and excursion gating integration', () => {
  let storage: MemoryStorage;
  let host: HTMLDivElement;

  beforeEach(async () => {
    vi.clearAllMocks();
    integrationState.autoRelocate = true;
    mockBook.navigation.toc = [...integrationState.toc];
    mockBook.spine.sections = [...integrationState.sections];
    storage = new MemoryStorage();
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
    host = document.createElement('div');
    document.body.innerHTML = '';
    document.body.append(host);
    await reconcileBooks('server', [testBook]);
  });

  function mountReader(
    options: {
      initialCfi?: string | null;
      initialPercentage?: number | null;
      onBack?: () => void;
      onSyncLatest?: (manual: boolean) => Promise<{
        xpath: string | null;
        percentage: number | null;
        accept?: () => Promise<void>;
      } | null>;
      registerBackHandler?: (handler: () => boolean) => () => void;
    } = {},
  ) {
    return mount(Reader, {
      target: host,
      props: {
        bookUrl: 'book.epub',
        bookId: testBook.id,
        title: testBook.title,
        initialCfi: options.initialCfi ?? null,
        initialPercentage: options.initialPercentage ?? null,
        onBack: options.onBack ?? vi.fn(),
        onRelocated: (loc) => {
          void saveLocalProgress(testBook, loc.cfi, loc.xpath, loc.percentage, loc.spineIndex);
        },
        ...(options.onSyncLatest ? { onSyncLatest: options.onSyncLatest } : {}),
        ...(options.registerBackHandler
          ? { registerBackHandler: options.registerBackHandler }
          : {}),
      },
    });
  }

  function clickInternalLink(href: string): void {
    const click = [...mockRendition.on.mock.calls]
      .reverse()
      .find(([name]) => name === 'click')?.[1] as
      ((event: unknown, contents: unknown) => void) | undefined;
    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);
    click?.(
      { target: anchor, clientX: 100 },
      { window: { getSelection: () => ({ isCollapsed: true }) } },
    );
  }

  it('preserves restored CFI in the return stack and history across Contents, Search, Bookmark, and Highlight jumps', async () => {
    const restoredCfi = 'epubcfi(/6/4!/4/2)';
    await saveLocalProgress(testBook, restoredCfi, '//body/DocFragment[2]/body/p[1]', 0.35, 1);

    const bookmarks = toggleBookmark(
      [],
      { cfi: 'epubcfi(/6/6!/4/2)', href: 'endnotes.xhtml', percentage: 0.7 },
      '2026-01-01T00:00:00.000Z',
    );
    const annotations = addAnnotation(
      [],
      'epubcfi(/6/2!/4/2)',
      'Opening paragraph highlight',
      '',
      '2026-01-01T00:00:00.000Z',
    );
    await setPreference(`readerBookmarks:${testBook.id}`, JSON.stringify(bookmarks));
    await setPreference(`readerAnnotations:${testBook.id}`, JSON.stringify(annotations));

    const reader = mountReader({ initialCfi: restoredCfi, initialPercentage: 0.35 });
    await settle();

    // Requirement 2: restored CFI is seeded into recent history on open.
    let prefs = await getPreferences([
      `readerHistory:${testBook.id}`,
      returnStackPreferenceKey(testBook.id),
    ]);
    expect(parseLocationHistory(prefs.get(`readerHistory:${testBook.id}`) ?? null)[0]?.cfi).toBe(
      restoredCfi,
    );

    // 1. Contents jump
    host.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')?.click();
    await settle();
    host.querySelector<HTMLButtonElement>('[aria-label="Contents"]')?.click();
    await settle();
    const endnotesToc = [
      ...host.querySelectorAll<HTMLButtonElement>('#reader-contents button'),
    ].find((btn) => btn.textContent?.trim() === 'Endnotes');
    endnotesToc?.click();
    await settle();

    expect((await getReadingState(testBook.id))?.cfi).toBe(restoredCfi);
    prefs = await getPreferences([
      `readerHistory:${testBook.id}`,
      returnStackPreferenceKey(testBook.id),
    ]);
    expect(parseReturnStack(prefs.get(returnStackPreferenceKey(testBook.id)) ?? null)).toEqual([
      { cfi: restoredCfi, href: 'chapter-2.xhtml' },
    ]);
    expect(
      parseLocationHistory(prefs.get(`readerHistory:${testBook.id}`) ?? null).map(
        (item) => item.cfi,
      ),
    ).toContain(restoredCfi);

    // Return to restored chapter
    const excursionGroup = host.querySelector('[aria-label="Reading excursion controls"]');
    expect(excursionGroup).not.toBeNull();
    excursionGroup?.querySelectorAll('button')[0]?.click();
    await settle();
    expect(host.querySelector('[aria-label="Reading excursion controls"]')).toBeNull();

    // 2. Search result jump
    host.querySelector<HTMLButtonElement>('[aria-label="Search this book"]')?.click();
    await settle();
    const searchInput = host.querySelector<HTMLInputElement>('#reader-search-query')!;
    searchInput.value = 'match';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    host
      .querySelector<HTMLFormElement>('#reader-search form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    host.querySelector<HTMLButtonElement>('[aria-label="Search results"] button')?.click();
    await settle();

    expect((await getReadingState(testBook.id))?.cfi).toBe(restoredCfi);
    expect(
      parseReturnStack(
        (await getPreferences([returnStackPreferenceKey(testBook.id)])).get(
          returnStackPreferenceKey(testBook.id),
        ) ?? null,
      ),
    ).toEqual([{ cfi: restoredCfi, href: 'chapter-2.xhtml' }]);

    host
      .querySelector('[aria-label="Reading excursion controls"]')
      ?.querySelectorAll('button')[0]
      ?.click();
    await settle();

    // 3. Bookmark jump
    host.querySelector<HTMLButtonElement>('[aria-label="Marks, bookmarks and history"]')?.click();
    await settle();
    host.querySelector<HTMLButtonElement>('[data-reader-focus="bookmark-location"]')?.click();
    await settle();

    expect((await getReadingState(testBook.id))?.cfi).toBe(restoredCfi);
    expect(
      parseReturnStack(
        (await getPreferences([returnStackPreferenceKey(testBook.id)])).get(
          returnStackPreferenceKey(testBook.id),
        ) ?? null,
      ),
    ).toEqual([{ cfi: restoredCfi, href: 'chapter-2.xhtml' }]);

    host
      .querySelector('[aria-label="Reading excursion controls"]')
      ?.querySelectorAll('button')[0]
      ?.click();
    await settle();

    // 4. Highlight jump
    host
      .querySelector<HTMLButtonElement>('[aria-label="Notes: highlights and annotations"]')
      ?.click();
    await settle();
    host.querySelector<HTMLButtonElement>('#reader-annotations article button')?.click();
    await settle();

    expect((await getReadingState(testBook.id))?.cfi).toBe(restoredCfi);
    expect(
      parseReturnStack(
        (await getPreferences([returnStackPreferenceKey(testBook.id)])).get(
          returnStackPreferenceKey(testBook.id),
        ) ?? null,
      ),
    ).toEqual([{ cfi: restoredCfi, href: 'chapter-2.xhtml' }]);

    await unmount(reader);
  });

  it('keeps Return and Stay active across multi-page endnotes, unwinds nested links via Back/Return, and survives restarts', async () => {
    const chapterCfi = 'epubcfi(/6/4!/4/2)';
    await saveLocalProgress(testBook, chapterCfi, '//body/DocFragment[2]/body/p[1]', 0.35, 1);

    const back = { current: null as (() => boolean) | null };
    const reader = mountReader({
      initialCfi: chapterCfi,
      initialPercentage: 0.35,
      registerBackHandler: (handler) => {
        back.current = handler;
        return () => {
          back.current = null;
        };
      },
    });
    await settle();

    // Tap footnote link from chapter -> endnote page 1
    clickInternalLink('endnotes.xhtml#fn1');
    await mockRendition.display('epubcfi(/6/6!/4/2)');
    await settle();

    // Turn page inside multi-page endnote -> endnote page 2
    host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')?.click();
    await settle();

    const endnotePage2Cfi = integrationState.currentCfi;
    // Controls remain visible and progress/sync_queue still hold chapterCfi
    expect(host.querySelector('[aria-label="Reading excursion controls"]')).not.toBeNull();
    expect((await getReadingState(testBook.id))?.cfi).toBe(chapterCfi);
    const pendingBeforeRestart = await getPendingSync('server');
    expect(pendingBeforeRestart).toHaveLength(1);
    expect(JSON.parse(pendingBeforeRestart[0]!.payload).bookScrollId).toBe(
      '//body/DocFragment[2]/body/p[1]',
    );

    // Tap nested link inside endnote page 2 -> chapter 1 reference
    clickInternalLink('chapter-1.xhtml#ref');
    await mockRendition.display('epubcfi(/6/2!/4/2)');
    await settle();

    const persistedStack = parseReturnStack(
      (await getPreferences([returnStackPreferenceKey(testBook.id)])).get(
        returnStackPreferenceKey(testBook.id),
      ) ?? null,
    );
    expect(persistedStack).toEqual([
      { cfi: endnotePage2Cfi, href: 'endnotes.xhtml' },
      { cfi: chapterCfi, href: 'chapter-2.xhtml' },
    ]);

    // Simulate app restart while viewing nested excursion target (persisted stack survives)
    await unmount(reader);
    const reopenedAtExcursion = mountReader({
      initialCfi: 'epubcfi(/6/2!/4/2)',
      registerBackHandler: (handler) => {
        back.current = handler;
        return () => {
          back.current = null;
        };
      },
    });
    await settle();

    // Unwind first nested entry via Back press -> back to endnotePage2Cfi
    expect(host.querySelector('[aria-label="Reading excursion controls"]')).not.toBeNull();
    back.current?.();
    await settle();
    expect(integrationState.currentCfi).toBe(endnotePage2Cfi);
    expect(host.querySelector('[aria-label="Reading excursion controls"]')).not.toBeNull();

    // Unwind second entry via Return control -> back to active chapterCfi
    host
      .querySelector('[aria-label="Reading excursion controls"]')
      ?.querySelectorAll('button')[0]
      ?.click();
    await settle();
    expect(integrationState.currentCfi).toBe(chapterCfi);
    expect(host.querySelector('[aria-label="Reading excursion controls"]')).toBeNull();

    // Start another footnote excursion, then simulate force-stop & reopen from committed reading_state
    clickInternalLink('endnotes.xhtml#fn2');
    await mockRendition.display('epubcfi(/6/6!/4/2)');
    await settle();
    expect(host.querySelector('[aria-label="Reading excursion controls"]')).not.toBeNull();

    await unmount(reopenedAtExcursion);
    const savedState = await getReadingState(testBook.id);
    expect(savedState?.cfi).toBe(chapterCfi);

    const reopenedFromCommitted = mountReader({
      initialCfi: savedState?.cfi ?? null,
      initialPercentage: savedState?.percentage ?? null,
    });
    await settle();

    // Restores committed chapter CFI, sync queue still has chapter XPath (no endnote progress),
    // and reconciled stack is empty so subsequent chapter page turns commit normally.
    expect(integrationState.currentCfi).toBe(chapterCfi);
    expect(host.querySelector('[aria-label="Reading excursion controls"]')).toBeNull();
    const pendingAfterRestart = await getPendingSync('server');
    expect(JSON.parse(pendingAfterRestart[0]!.payload).bookScrollId).toBe(
      '//body/DocFragment[2]/body/p[1]',
    );

    host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')?.click();
    await settle();
    expect((await getReadingState(testBook.id))?.cfi).toBe(integrationState.currentCfi);

    await unmount(reopenedFromCommitted);
  });

  it('commits Stay confirmation in one tap and commits jumps immediately when a book opens unread at 0%', async () => {
    // 1. Unread book at 0%: jump commits immediately without gating
    const unreadReader = mountReader({ initialCfi: null, initialPercentage: null });
    await settle();
    expect(integrationState.currentCfi).toBe('epubcfi(/6/2!/4/2)');

    host.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')?.click();
    await settle();
    host.querySelector<HTMLButtonElement>('[aria-label="Contents"]')?.click();
    await settle();
    const ch2Button = [...host.querySelectorAll<HTMLButtonElement>('#reader-contents button')].find(
      (btn) => btn.textContent?.trim() === 'Chapter 2',
    );
    ch2Button?.click();
    await settle();

    const committedChapter2Cfi = 'epubcfi(/6/4!/4/2)';
    expect(host.querySelector('[aria-label="Reading excursion controls"]')).toBeNull();
    expect((await getReadingState(testBook.id))?.cfi).toBe(committedChapter2Cfi);

    // 2. Subsequent jump from Chapter 2 to Endnotes gates progress until Stay is tapped
    host.querySelector<HTMLButtonElement>('[aria-label="Contents"]')?.click();
    await settle();
    const endnotesButton = [
      ...host.querySelectorAll<HTMLButtonElement>('#reader-contents button'),
    ].find((btn) => btn.textContent?.trim() === 'Endnotes');
    endnotesButton?.click();
    await settle();

    const endnotesCfi = 'epubcfi(/6/6!/4/2)';
    expect((await getReadingState(testBook.id))?.cfi).toBe(committedChapter2Cfi);
    const controls = host.querySelector('[aria-label="Reading excursion controls"]');
    expect(controls).not.toBeNull();

    // Tap Stay -> clears stack and commits endnotesCfi to reading_state and sync_queue
    const stayButton = [...(controls?.querySelectorAll('button') ?? [])].find((btn) =>
      btn.textContent?.includes('Stay'),
    );
    stayButton?.click();
    await settle();

    expect(host.querySelector('[aria-label="Reading excursion controls"]')).toBeNull();
    expect((await getReadingState(testBook.id))?.cfi).toBe(endnotesCfi);
    expect(await getPendingSync('server')).toHaveLength(1);
    expect(
      parseReturnStack(
        (await getPreferences([returnStackPreferenceKey(testBook.id)])).get(
          returnStackPreferenceKey(testBook.id),
        ) ?? null,
      ),
    ).toEqual([]);

    // 3. Remote sync adoption clears stale return stack
    clickInternalLink('chapter-1.xhtml#back');
    await mockRendition.display('epubcfi(/6/2!/4/2)');
    await settle();
    expect(host.querySelector('[aria-label="Reading excursion controls"]')).not.toBeNull();

    await unmount(unreadReader);
    const acceptRemote = vi.fn(async () => {});
    const syncReader = mountReader({
      initialCfi: 'epubcfi(/6/2!/4/2)',
      onSyncLatest: async () => ({
        xpath: null,
        percentage: 0.5,
        accept: acceptRemote,
      }),
    });
    await settle();
    expect(host.querySelector('[aria-label="Reading excursion controls"]')).not.toBeNull();

    host.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')?.click();
    await settle();
    host.querySelector<HTMLButtonElement>('[aria-label="Sync latest reading position"]')?.click();
    await settle();
    const confirmButton = [...host.querySelectorAll('button')].find((btn) =>
      btn.textContent?.includes('Go to latest position'),
    );
    confirmButton?.click();
    await settle();

    expect(acceptRemote).toHaveBeenCalledOnce();
    expect(host.querySelector('[aria-label="Reading excursion controls"]')).toBeNull();
    expect(
      parseReturnStack(
        (await getPreferences([returnStackPreferenceKey(testBook.id)])).get(
          returnStackPreferenceKey(testBook.id),
        ) ?? null,
      ),
    ).toEqual([]);

    await unmount(syncReader);
  });
});
