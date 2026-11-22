// @vitest-environment jsdom

import type { Contents, Location } from 'epubjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

const { mockBook, mockRendition, resetManager } = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  const createContainer = () => {
    const el = {
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 900,
      clientWidth: 300,
    };
    return el;
  };

  const manager = {
    _onScroll: () => {},
    container: createContainer() as unknown as HTMLElement,
    ignore: false,
    isPaginated: true,
    scrollLeft: 0,
    layout: { delta: 300, pageWidth: 300, width: 300 },
    scrollTo: vi.fn((x: number, _y: number, silent?: boolean) => {
      if (silent) manager.ignore = true;
      manager.container.scrollLeft = x;
      manager.scrollLeft = x;
    }),
    on: vi.fn((event: string, cb: () => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, cb: () => void) => {
      listeners.get(event)?.delete(cb);
    }),
    emitScroll: () => {
      for (const cb of listeners.get('scroll') ?? []) cb();
    },
  };

  const rendition = {
    manager,
    location: undefined as Location | undefined,
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    reportLocation: vi.fn(async () => {}),
    getContents: vi.fn(() => []),
    resize: vi.fn(),
    destroy: vi.fn(),
  };

  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine: {
      each: vi.fn((visit: (section: { href: string; index: number }) => void) => {
        visit({ href: 'chapter-1.xhtml', index: 0 });
        visit({ href: 'chapter-2.xhtml', index: 1 });
      }),
    },
    navigation: { toc: [] },
  };

  const resetManager = () => {
    listeners.clear();
    manager._onScroll = () => {};
    manager.container = createContainer() as unknown as HTMLElement;
    manager.ignore = false;
    manager.isPaginated = true;
    manager.scrollLeft = 0;
    manager.layout = { delta: 300, pageWidth: 300, width: 300 };
    rendition.location = undefined;
  };

  return { mockBook: book, mockRendition: rendition, resetManager };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => mockBook) }));

import { ReaderSession } from './session';

function makeLocation(cfi: string, page = 1, href = 'chapter-1.xhtml', index = 0): Location {
  return {
    start: {
      cfi,
      href,
      index,
      percentage: (page - 1) / 3,
      displayed: { page, total: 3 },
    },
  } as Location;
}

describe('ReaderSession accessibility and paginated scroll relocations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetManager();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets the book title on the EPUB iframe and guards mocked Contents without frameElement', async () => {
    const session = new ReaderSession('book.epub', 'The Left Hand of Darkness');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    const contentHook = mockRendition.hooks.content.register.mock.calls[0]?.[0] as (
      contents: Contents,
    ) => Promise<void>;
    const frame = document.createElement('iframe');
    const doc = new DOMParser().parseFromString(
      '<html><body><p>One</p></body></html>',
      'text/html',
    );

    await contentHook({
      document: doc,
      window: { frameElement: frame },
    } as unknown as Contents);
    expect(frame.getAttribute('title')).toBe('The Left Hand of Darkness');

    await expect(
      contentHook({
        document: doc,
        window: { frameElement: null },
      } as unknown as Contents),
    ).resolves.toBeUndefined();

    await expect(
      contentHook({
        document: doc,
      } as unknown as Contents),
    ).resolves.toBeUndefined();

    session.destroy();

    const fallbackSession = new ReaderSession('book.epub', '   ');
    await fallbackSession.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );
    const fallbackHook = mockRendition.hooks.content.register.mock.calls.at(-1)?.[0] as (
      contents: Contents,
    ) => Promise<void>;
    const unnamedFrame = document.createElement('iframe');
    await fallbackHook({
      document: doc,
      window: { frameElement: unnamedFrame },
    } as unknown as Contents);
    expect(unnamedFrame.getAttribute('title')).toBe('Book content');
    fallbackSession.destroy();
  });

  it('aligns columns and reports navigation for un-ignored TalkBack container scrolls', async () => {
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub', 'Sample Book');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );

    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as (
      loc: Location,
    ) => void;

    // Simulate EPUB.js leaving manager.ignore = true after a no-op scrollTo(0, 0, true) on open.
    mockRendition.manager.ignore = true;
    relocated(makeLocation('cfi-page-1', 1));
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'cfi-page-1', pageIndex: 0 }),
      'restore',
    );
    expect(mockRendition.manager.ignore).toBe(false);

    // Forward TalkBack partial scroll into column 2 (e.g. minimal scrollIntoView to 120px).
    mockRendition.manager.container.scrollLeft = 120;
    mockRendition.manager.emitScroll();

    expect(mockRendition.manager.scrollTo).toHaveBeenLastCalledWith(300, 0, true);
    expect(mockRendition.manager.container.scrollLeft).toBe(300);

    relocated(makeLocation('cfi-page-2', 2));
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'cfi-page-2', pageIndex: 1 }),
      'navigation',
    );

    // Forward scroll to column 3, then backward TalkBack partial scroll into column 2 (e.g. 540px).
    mockRendition.manager.container.scrollLeft = 600;
    mockRendition.manager.emitScroll();
    relocated(makeLocation('cfi-page-3', 3));
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'cfi-page-3', pageIndex: 2 }),
      'navigation',
    );

    mockRendition.manager.container.scrollLeft = 540;
    mockRendition.manager.emitScroll();
    expect(mockRendition.manager.container.scrollLeft).toBe(300);
    relocated(makeLocation('cfi-page-2', 2));
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'cfi-page-2', pageIndex: 1 }),
      'navigation',
    );

    session.destroy();
    expect(mockRendition.manager.off).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('aligns columns and reports navigation when focusin moves across paginated columns', async () => {
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub', 'Sample Book');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );

    const contentHook = mockRendition.hooks.content.register.mock.calls[0]?.[0] as (
      contents: Contents,
    ) => Promise<void>;
    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as (
      loc: Location,
    ) => void;
    const click = mockRendition.on.mock.calls.find(([name]) => name === 'click')?.[1] as (
      event: unknown,
      contents: unknown,
    ) => void;

    const doc = new DOMParser().parseFromString(
      '<html><body><p>First</p><a id="col3-link" href="#note">Note</a></body></html>',
      'text/html',
    );
    await contentHook({
      document: doc,
      window: { frameElement: document.createElement('iframe') },
    } as unknown as Contents);

    relocated(makeLocation('cfi-col-1', 1));

    const link = doc.querySelector<HTMLAnchorElement>('#col3-link')!;
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(new DOMRect(624, 20, 80, 20));
    link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(mockRendition.manager.container.scrollLeft).toBe(600);
    expect(mockRendition.reportLocation).toHaveBeenCalledOnce();

    relocated(makeLocation('cfi-col-3', 3));
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'cfi-col-3', pageIndex: 2 }),
      'navigation',
    );

    // Focusing body must not snap scrollLeft back to column 0.
    doc.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(mockRendition.manager.container.scrollLeft).toBe(600);

    // Clicking an internal link still reports 'link' with returnTarget rather than 'navigation'.
    click(
      { target: link, clientX: 640 },
      { window: { getSelection: () => ({ isCollapsed: true }) } },
    );
    relocated(makeLocation('cfi-footnote', 1, 'chapter-2.xhtml', 1));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('link');
    expect(onLocation.mock.calls.at(-1)?.[2]).toEqual({
      cfi: 'cfi-col-3',
      href: 'chapter-1.xhtml',
    });

    session.destroy();
  });

  it('keeps restore origin for server syncs, viewport resizes, and appearance reflows', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub', 'Sample Book');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );

    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as (
      loc: Location,
    ) => void;
    relocated(makeLocation('cfi-initial', 1));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    await session.displayServerPercentage(0.6);
    relocated(makeLocation('cfi-server', 1, 'chapter-2.xhtml', 1));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    await session.displayServerLocation('//body/DocFragment[1]/body/p[1]');
    relocated(makeLocation('cfi-server-xpath', 1, 'chapter-1.xhtml', 0));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    resizeCallbacks[0]?.(
      [{ contentRect: { width: 360, height: 640 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    relocated(makeLocation('cfi-resized', 2, 'chapter-2.xhtml', 1));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    session.applyAppearance({ ...defaultAppearance, fontSize: defaultAppearance.fontSize + 4 });
    relocated(makeLocation('cfi-reflowed', 3, 'chapter-2.xhtml', 1));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    session.destroy();
  });

  it('tracks capture-phase container scroll events when a rendition has no manager emitter', async () => {
    (mockRendition.manager as { _onScroll?: (() => void) | undefined })._onScroll = undefined;
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    const container = document.createElement('div');
    Object.defineProperty(container, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(container, 'clientWidth', { value: 300, configurable: true });
    viewport.append(container);
    mockRendition.manager.container = container;

    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub', 'Sample Book');
    await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());
    const relocated = mockRendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1] as (
      loc: Location,
    ) => void;

    relocated(makeLocation('cfi-1', 1));

    // Ignored scroll must stay 'restore'.
    mockRendition.manager.ignore = true;
    container.scrollLeft = 300;
    container.dispatchEvent(new Event('scroll'));
    relocated(makeLocation('cfi-ignored', 2));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');

    // Un-ignored scroll snaps to next column and reports 'navigation'.
    container.scrollLeft = 420;
    container.dispatchEvent(new Event('scroll'));
    expect(container.scrollLeft).toBe(600);
    relocated(makeLocation('cfi-3', 3));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('navigation');

    session.destroy();
  });
});
