// @vitest-environment jsdom

import type { Contents, Location } from 'epubjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

function makeLocation(cfi: string, page = 3, total = 12): Location {
  return {
    start: {
      cfi,
      href: 'chapter-1.xhtml',
      index: 0,
      percentage: page / total,
      displayed: { page, total },
    },
  } as Location;
}

const { mockBook, mockRendition, resetMocks } = vi.hoisted(() => {
  let contentHooks: Array<(contents: Contents) => Promise<void> | void> = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let loadedContents: Array<{ document: Document }> = [];

  const rendition = {
    hooks: {
      content: {
        register: vi.fn((hook: (contents: Contents) => Promise<void> | void) => {
          contentHooks.push(hook);
        }),
      },
    },
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const group = listeners.get(event) ?? [];
      group.push(callback);
      listeners.set(event, group);
    }),
    off: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const group = listeners.get(event) ?? [];
      listeners.set(
        event,
        group.filter((entry) => entry !== callback),
      );
    }),
    emit(event: string, ...args: unknown[]) {
      for (const callback of listeners.get(event) ?? []) {
        callback(...args);
      }
    },
    async runContentHooks(contents: Contents) {
      for (const hook of contentHooks) {
        await hook(contents);
      }
    },
    setContents(next: Array<{ document: Document }>) {
      loadedContents = next;
    },
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    getContents: vi.fn(() => loadedContents),
    display: vi.fn(async (_target?: string) => {}),
    next: vi.fn(async () => {}),
    prev: vi.fn(async () => {}),
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

  return {
    mockBook: book,
    mockRendition: rendition,
    resetMocks() {
      contentHooks = [];
      listeners.clear();
      loadedContents = [];
      rendition.display.mockReset();
      rendition.display.mockImplementation(async () => {});
      rendition.resize.mockReset();
    },
  };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => mockBook) }));

import { ReaderSession } from './session';

const mountedFrames: HTMLIFrameElement[] = [];

function createChapterDocument(): Document {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  mountedFrames.push(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write('<!doctype html><html><head></head><body><p>Opening passage</p></body></html>');
  doc.close();
  return doc;
}

describe('ReaderSession theme CSS replacement, palette caching, and resize interruption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-mode');
    document.documentElement.removeAttribute('style');
    document.documentElement.style.setProperty('--color-surface-50', '#faf8f5');
    document.documentElement.style.setProperty('--color-surface-950', '#18181b');
    document.documentElement.style.setProperty('--color-primary-700', '#1d4ed8');
    document.documentElement.style.setProperty('--color-primary-200', '#bfdbfe');
    document.documentElement.style.setProperty('--color-primary-300', '#93c5fd');
    document.documentElement.style.setProperty('--color-primary-800', '#1e40af');
  });

  afterEach(() => {
    for (const frame of mountedFrames.splice(0)) {
      frame.remove();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps #epubjs-inserted-css-turnleaf at 7 rules in place and caches getComputedStyle across 30 appearance updates', async () => {
    const chapterDoc = createChapterDocument();
    mockRendition.setContents([{ document: chapterDoc }]);
    const onLocation = vi.fn();
    const computedStyleSpy = vi.spyOn(window, 'getComputedStyle');

    const initialCfi = 'epubcfi(/6/2!/4/2/10:0)';
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      initialCfi,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );
    await mockRendition.runContentHooks({
      document: chapterDoc,
      window,
    } as unknown as Contents);

    mockRendition.emit('relocated', makeLocation(initialCfi));
    mockRendition.display.mockClear();

    for (let step = 1; step <= 30; step += 1) {
      session.applyAppearance({
        ...defaultAppearance,
        fontSize: 14 + (step % 20),
        lineHeight: Number((1.4 + (step % 5) * 0.1).toFixed(1)),
        margin: 16 + step,
        bottomMargin: (step % 8) * 4,
        paragraphSpacing: Number(((step % 10) * 0.1).toFixed(1)),
      });
    }

    const styles = chapterDoc.querySelectorAll<HTMLStyleElement>('#epubjs-inserted-css-turnleaf');
    expect(styles).toHaveLength(1);
    const styleEl = styles[0]!;
    expect(styleEl.sheet?.cssRules).toHaveLength(7);
    expect(styleEl.textContent).toContain('font-size: 24px !important;');
    expect(styleEl.textContent).toContain('#faf8f5 !important');
    expect(mockRendition.themes.register).not.toHaveBeenCalled();
    expect(mockRendition.themes.select).not.toHaveBeenCalled();

    // Root palette tokens resolved with a single getComputedStyle call across open + 30 updates
    expect(computedStyleSpy).toHaveBeenCalledTimes(1);
    expect(mockRendition.display).toHaveBeenLastCalledWith(initialCfi);

    session.destroy();
  });

  it('refreshes cached palette colors when root theme dataset, mode, or inline style changes and injects rules on harden', async () => {
    const firstChapter = createChapterDocument();
    mockRendition.setContents([{ document: firstChapter }]);
    const computedStyleSpy = vi.spyOn(window, 'getComputedStyle');

    document.documentElement.dataset.theme = 'fennec';
    document.documentElement.dataset.mode = 'light';

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
    await mockRendition.runContentHooks({
      document: firstChapter,
      window,
    } as unknown as Contents);
    mockRendition.display.mockClear();

    expect(computedStyleSpy).toHaveBeenCalledTimes(1);

    // Switching to dark mode resolves dark tokens once without triggering a layout display
    session.applyAppearance({ ...defaultAppearance, mode: 'dark' });
    expect(computedStyleSpy).toHaveBeenCalledTimes(2);
    expect(mockRendition.display).not.toHaveBeenCalled();
    expect(firstChapter.getElementById('epubjs-inserted-css-turnleaf')?.textContent).toContain(
      'background: #18181b !important;',
    );

    // Switching back to light mode reuses the cached light palette
    session.applyAppearance({ ...defaultAppearance, mode: 'light' });
    expect(computedStyleSpy).toHaveBeenCalledTimes(2);

    // Updating root dataset.theme or inline style invalidates the cache and refreshes reader colors
    document.documentElement.dataset.theme = 'catppuccin';
    document.documentElement.style.setProperty('--color-surface-50', '#eff1f5');
    session.applyAppearance({ ...defaultAppearance, mode: 'light' });
    expect(computedStyleSpy).toHaveBeenCalledTimes(3);
    expect(firstChapter.getElementById('epubjs-inserted-css-turnleaf')?.textContent).toContain(
      'background: #eff1f5 !important;',
    );

    // Newly opened chapters receive the current 7 rules in harden
    const secondChapter = createChapterDocument();
    await mockRendition.runContentHooks({
      document: secondChapter,
      window,
    } as unknown as Contents);
    const secondStyle = secondChapter.getElementById(
      'epubjs-inserted-css-turnleaf',
    ) as HTMLStyleElement | null;
    expect(secondStyle?.sheet?.cssRules).toHaveLength(7);
    expect(secondStyle?.textContent).toContain('background: #eff1f5 !important;');

    session.destroy();
  });

  it('preserves publisher-specific styles across typography updates and publisherStyles toggles and tolerates minimal rendition mocks', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    mountedFrames.push(frame);
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

    mockRendition.setContents([{ document: chapterDoc }]);
    const savedCfi = 'epubcfi(/6/2!/4/2/10:0)';

    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      savedCfi,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );
    await mockRendition.runContentHooks({
      document: chapterDoc,
      window: frame.contentWindow!,
    } as unknown as Contents);
    mockRendition.emit('relocated', makeLocation(savedCfi));
    mockRendition.display.mockClear();

    const styleOf = (id: string) =>
      frame.contentWindow!.getComputedStyle(chapterDoc.getElementById(id)!);

    // 1. Apply custom typography with publisherStyles enabled
    session.applyAppearance({
      ...defaultAppearance,
      fontSize: 24,
      paragraphSpacing: 1.0,
      alignment: 'justify',
      publisherStyles: true,
    });

    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith(savedCfi);
    expect(chapterDoc.querySelectorAll('#epubjs-inserted-css-turnleaf')).toHaveLength(1);
    const styleEl = chapterDoc.getElementById(
      'epubjs-inserted-css-turnleaf',
    ) as HTMLStyleElement | null;
    expect(styleEl?.sheet?.cssRules).toHaveLength(7);
    expect(styleOf('body-copy').fontSize).toBe('24px');
    expect(styleOf('body-copy').textAlign).toBe('justify');
    expect(styleOf('body-copy').marginBottom).toBe('24px');
    expect(styleOf('scene-break').textAlign).toBe('center');
    expect(styleOf('scene-break').marginBottom).toBe('36px');
    expect(styleOf('epigraph-line').textAlign).toBe('right');
    expect(styleOf('epigraph-line').marginBottom).toBe('6px');

    // 2. Toggle publisherStyles off: reflows to savedCfi and overrides publisher classes with !important
    mockRendition.display.mockClear();
    session.applyAppearance({
      ...defaultAppearance,
      fontSize: 24,
      paragraphSpacing: 1.0,
      alignment: 'justify',
      publisherStyles: false,
    });

    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith(savedCfi);
    expect(styleEl?.sheet?.cssRules).toHaveLength(7);
    expect(styleOf('body-copy').textAlign).toBe('justify');
    expect(styleOf('body-copy').marginBottom).toBe('24px');
    expect(styleOf('scene-break').textAlign).toBe('justify');
    expect(styleOf('scene-break').marginBottom).toBe('24px');
    expect(styleOf('epigraph-line').textAlign).toBe('justify');
    expect(styleOf('epigraph-line').marginBottom).toBe('24px');

    // 3. Toggle publisherStyles back on alongside updated typography
    mockRendition.display.mockClear();
    session.applyAppearance({
      ...defaultAppearance,
      fontSize: 20,
      paragraphSpacing: 0.5,
      alignment: 'justify',
      publisherStyles: true,
    });

    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith(savedCfi);
    expect(styleEl?.sheet?.cssRules).toHaveLength(7);
    expect(styleOf('body-copy').fontSize).toBe('20px');
    expect(styleOf('body-copy').textAlign).toBe('justify');
    expect(styleOf('body-copy').marginBottom).toBe('10px');
    expect(styleOf('scene-break').textAlign).toBe('center');
    expect(styleOf('scene-break').marginBottom).toBe('30px');
    expect(styleOf('epigraph-line').textAlign).toBe('right');
    expect(styleOf('epigraph-line').marginBottom).toBe('5px');

    // 4. Tolerates minimal rendition mocks without getContents
    const originalGetContents = mockRendition.getContents;
    (mockRendition as { getContents?: unknown }).getContents = undefined;
    try {
      mockRendition.display.mockClear();
      session.applyAppearance({ ...defaultAppearance, fontSize: 22 });
      expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith(savedCfi);
    } finally {
      mockRendition.getContents = originalGetContents;
    }

    session.destroy();
  });

  it('aborts a display that is in flight during a resize and checks the final CFI', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const chapterDoc = createChapterDocument();
    mockRendition.setContents([{ document: chapterDoc }]);
    const onLocation = vi.fn();
    const initialCfi = 'epubcfi(/6/2!/4/2/4:0)';

    const session = new ReaderSession('book.epub');
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 640));

    await session.open(viewport, initialCfi, null, null, defaultAppearance, onLocation, vi.fn());
    mockRendition.emit('relocated', makeLocation(initialCfi, 1, 10));
    onLocation.mockClear();
    mockRendition.display.mockClear();

    // 1. Start an in-flight navigation displayCfi, then trigger a viewport resize that aborts it
    let abortNavigationDisplay: ((reason?: unknown) => void) | null = null;
    mockRendition.display.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          abortNavigationDisplay = reject;
        }),
    );

    const resizedAfterNavAbortCfi = 'epubcfi(/6/2!/4/2/6:0)';
    mockRendition.resize.mockImplementationOnce(() => {
      abortNavigationDisplay?.(new DOMException('Display aborted by resize', 'AbortError'));
      setTimeout(() => {
        mockRendition.emit('relocated', makeLocation(resizedAfterNavAbortCfi, 2, 8));
      }, 0);
    });

    const navigationResultPromise = session.displayCfi('epubcfi(/6/4!/4/2/12:0)');
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith('epubcfi(/6/4!/4/2/12:0)');

    resizeCallbacks[0]?.(
      [{ contentRect: { width: 480, height: 720 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    await expect(navigationResultPromise).resolves.toBe(false);
    await vi.waitFor(() => {
      expect(onLocation).toHaveBeenCalledTimes(1);
    });
    expect(mockRendition.resize).toHaveBeenCalledExactlyOnceWith(480, 720);
    expect(onLocation.mock.calls.at(-1)).toEqual([
      expect.objectContaining({
        cfi: resizedAfterNavAbortCfi,
        pageIndex: 1,
        pageCount: 8,
      }),
      'restore',
    ]);

    // 2. Start an in-flight appearance reflow display, then trigger a viewport resize that aborts it
    onLocation.mockClear();
    mockRendition.display.mockClear();
    mockRendition.resize.mockClear();

    let abortReflowDisplay: ((reason?: unknown) => void) | null = null;
    mockRendition.display.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          abortReflowDisplay = reject;
        }),
    );

    const finalResizedCfi = 'epubcfi(/6/2!/4/2/8:0)';
    mockRendition.resize.mockImplementationOnce(() => {
      abortReflowDisplay?.(new DOMException('Reflow display aborted by resize', 'AbortError'));
      setTimeout(() => {
        mockRendition.emit('relocated', makeLocation(finalResizedCfi, 3, 7));
      }, 0);
    });

    session.applyAppearance({ ...defaultAppearance, fontSize: 24 });
    expect(mockRendition.display).toHaveBeenCalledExactlyOnceWith(resizedAfterNavAbortCfi);

    resizeCallbacks[0]?.(
      [{ contentRect: { width: 520, height: 760 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    await vi.waitFor(() => {
      expect(onLocation).toHaveBeenCalledTimes(1);
    });
    expect(mockRendition.resize).toHaveBeenCalledExactlyOnceWith(520, 760);
    expect(onLocation.mock.calls.at(-1)).toEqual([
      expect.objectContaining({
        cfi: finalResizedCfi,
        pageIndex: 2,
        pageCount: 7,
      }),
      'restore',
    ]);

    session.destroy();
  });
});
