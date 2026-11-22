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

describe('ReaderSession appearance reflows and theme CSS', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps #epubjs-inserted-css-turnleaf at 7 rules, caches getComputedStyle, bounds display, and preserves initial CFI across a 30-step slider burst', async () => {
    const chapterDoc = createChapterDocument();
    mockRendition.setContents([{ document: chapterDoc }]);
    const onLocation = vi.fn();
    const computedStyleSpy = vi.spyOn(window, 'getComputedStyle');

    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      'epubcfi(/6/2!/4/2/10:0)',
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

    const initialCfi = 'epubcfi(/6/2!/4/2/10:0)';
    mockRendition.emit('relocated', makeLocation(initialCfi));
    mockRendition.display.mockClear();

    let resolveFirstReflow!: () => void;
    mockRendition.display
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstReflow = resolve;
          }),
      )
      .mockImplementation(async (target?: string) => {
        if (target) mockRendition.emit('relocated', makeLocation(target));
      });

    // First 15 slider steps in frame 1
    for (let step = 1; step <= 15; step += 1) {
      session.applyAppearance({
        ...defaultAppearance,
        fontSize: 18 + (step % 15),
        lineHeight: Number((1.4 + (step % 5) * 0.1).toFixed(1)),
        margin: 16 + step,
      });
    }

    // Flush animation frame 1 -> starts first coalesced rendition.display
    await vi.advanceTimersByTimeAsync(16);
    expect(mockRendition.display).toHaveBeenCalledTimes(1);
    expect(mockRendition.display).toHaveBeenLastCalledWith(initialCfi);

    // Remaining 15 slider steps arrive while first display is still in flight,
    // alongside an intermediate drifted relocated event from the stale layout pass.
    for (let step = 16; step <= 30; step += 1) {
      session.applyAppearance({
        ...defaultAppearance,
        fontSize: 14 + (step % 20),
        bottomMargin: (step % 8) * 4,
        paragraphSpacing: Number(((step % 10) * 0.1).toFixed(1)),
      });
    }
    mockRendition.emit('relocated', makeLocation('epubcfi(/6/2!/4/2/46:0)', 9, 12));

    // Finish first display and advance one frame for the trailing coalesced pass
    resolveFirstReflow();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(16);

    const styleEl = chapterDoc.getElementById(
      'epubjs-inserted-css-turnleaf',
    ) as HTMLStyleElement | null;
    expect(styleEl).not.toBeNull();
    expect(styleEl?.sheet?.cssRules).toHaveLength(7);
    expect(styleEl?.textContent).toContain('font-size: 24px !important;');
    expect(styleEl?.textContent).toContain('#faf8f5 !important');
    expect(mockRendition.themes.register).not.toHaveBeenCalled();
    expect(mockRendition.themes.select).not.toHaveBeenCalled();

    // Root palette tokens resolved with a single getComputedStyle call across open + 30 updates
    expect(computedStyleSpy).toHaveBeenCalledTimes(1);

    // Bounded to 2 serialized display calls (1 initial frame + 1 trailing pass), both anchored to initialCfi
    expect(mockRendition.display).toHaveBeenCalledTimes(2);
    expect(mockRendition.display.mock.calls).toEqual([[initialCfi], [initialCfi]]);

    // Intermediate drifted CFI was ignored; final reported CFI remains initialCfi
    expect(onLocation.mock.calls.some(([loc]) => loc.cfi === 'epubcfi(/6/2!/4/2/46:0)')).toBe(
      false,
    );
    expect(onLocation.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ cfi: initialCfi }));

    session.destroy();
  });

  it('refreshes cached palette colors when root theme dataset or reading mode changes and injects rules on harden', async () => {
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

    // Updating root dataset.theme invalidates the cache and refreshes reader colors
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

  it('cancels stale CFI preservation on explicit page navigation or destroy and tolerates minimal rendition mocks', async () => {
    const chapterDoc = createChapterDocument();
    mockRendition.setContents([{ document: chapterDoc }]);

    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      'epubcfi(/6/2!/4/2/4:0)',
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );
    mockRendition.emit('relocated', makeLocation('epubcfi(/6/2!/4/2/4:0)', 1, 10));
    mockRendition.display.mockClear();

    // Queue a slider reflow, then explicitly turn the page before the animation frame fires
    session.applyAppearance({ ...defaultAppearance, fontSize: 26 });
    await session.next();
    mockRendition.emit('relocated', makeLocation('epubcfi(/6/2!/4/2/20:0)', 2, 10));

    await vi.advanceTimersByTimeAsync(32);

    // Latest CSS was flushed for pagination, and stale anchor CFI display was cancelled
    expect(mockRendition.next).toHaveBeenCalledOnce();
    expect(mockRendition.display).not.toHaveBeenCalled();
    expect(chapterDoc.getElementById('epubjs-inserted-css-turnleaf')?.textContent).toContain(
      'font-size: 26px !important;',
    );

    // Also verify navigation during an in-flight reflow display cancels queued follow-up preservation
    let resolveInFlightDisplay!: () => void;
    mockRendition.display.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveInFlightDisplay = resolve;
        }),
    );

    session.applyAppearance({ ...defaultAppearance, fontSize: 28 });
    await vi.advanceTimersByTimeAsync(16);
    expect(mockRendition.display).toHaveBeenCalledTimes(1);
    expect(mockRendition.display).toHaveBeenLastCalledWith('epubcfi(/6/2!/4/2/20:0)');

    // Queue another slider step while display is in flight, then navigate explicitly
    session.applyAppearance({ ...defaultAppearance, fontSize: 30 });
    await session.next();
    resolveInFlightDisplay();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(32);

    // No second display('epubcfi(/6/2!/4/2/20:0)') was scheduled after navigation
    expect(mockRendition.display).toHaveBeenCalledTimes(1);
    expect(chapterDoc.getElementById('epubjs-inserted-css-turnleaf')?.textContent).toContain(
      'font-size: 30px !important;',
    );

    // Tolerates minimal rendition mocks without getContents and cancels frames on destroy
    const originalGetContents = mockRendition.getContents;
    (mockRendition as { getContents?: unknown }).getContents = undefined;
    try {
      session.applyAppearance({ ...defaultAppearance, fontSize: 32 });
      session.destroy();
      await vi.advanceTimersByTimeAsync(32);
      expect(mockRendition.display).toHaveBeenCalledTimes(1);
    } finally {
      mockRendition.getContents = originalGetContents;
    }
  });
});
