// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const { getPreferencesMock, setPreferencesMock, openSessionMock, destroySessionMock } = vi.hoisted(
  () => ({
    getPreferencesMock: vi.fn(),
    setPreferencesMock: vi.fn(),
    openSessionMock: vi.fn(),
    destroySessionMock: vi.fn(),
  }),
);

vi.mock('../database/database', () => ({
  getPreferences: getPreferencesMock,
  setPreferences: setPreferencesMock,
}));

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ReaderSession: class MockReaderSession {
      open = openSessionMock;
      tableOfContents = () => [];
      getVisiblePassages = () => [];
      clearTextSelection = vi.fn();
      updateHighlights = vi.fn();
      destroy = destroySessionMock;
    },
  };
});

import Reader from './Reader.svelte';

describe('Reader mount lifecycle', () => {
  let target: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    if (typeof Element.prototype.animate !== 'function') {
      Element.prototype.animate = (() => {
        const anim = {
          currentTime: 0,
          playState: 'running',
          effect: null,
          onfinish: null as ((event: AnimationPlaybackEvent) => void) | null,
          cancel() {
            anim.playState = 'idle';
          },
          finish() {
            anim.playState = 'finished';
          },
        };
        queueMicrotask(() => {
          if (anim.playState !== 'idle') {
            anim.playState = 'finished';
            anim.onfinish?.(new Event('finish') as AnimationPlaybackEvent);
          }
        });
        return anim as unknown as Animation;
      }) as typeof Element.prototype.animate;
    }
    getPreferencesMock.mockResolvedValue(new Map());
    setPreferencesMock.mockResolvedValue(undefined);
    openSessionMock.mockResolvedValue(undefined);
    target = document.createElement('div');
    document.body.append(target);
  });

  afterEach(async () => {
    if (mounted) {
      await unmount(mounted);
      mounted = null;
    }
    target.remove();
  });

  it('reports true on mount and false on destroy through onMountChange', async () => {
    const onMountChange = vi.fn<(isMounted: boolean) => void>();

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-1',
        title: 'Test Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onMountChange,
      },
    });
    flushSync();

    expect(target.querySelector('.reader-shell')).not.toBeNull();
    expect(onMountChange).toHaveBeenCalledTimes(1);
    expect(onMountChange).toHaveBeenNthCalledWith(1, true);

    await vi.waitFor(() => {
      expect(openSessionMock).toHaveBeenCalledOnce();
    });

    await unmount(mounted);
    mounted = null;

    expect(onMountChange).toHaveBeenCalledTimes(2);
    expect(onMountChange).toHaveBeenNthCalledWith(2, false);
  });

  it('still reports mount and destroy transitions when opening the EPUB fails', async () => {
    openSessionMock.mockRejectedValueOnce(new Error('corrupt epub'));
    const onMountChange = vi.fn<(isMounted: boolean) => void>();

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:broken-book',
        bookId: 'book-2',
        title: 'Broken Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onMountChange,
      },
    });
    flushSync();

    expect(onMountChange).toHaveBeenCalledWith(true);

    await vi.waitFor(() => {
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        'This EPUB could not be opened.',
      );
    });
    expect(onMountChange).toHaveBeenCalledTimes(1);

    await unmount(mounted);
    mounted = null;

    expect(onMountChange).toHaveBeenCalledTimes(2);
    expect(onMountChange).toHaveBeenLastCalledWith(false);
  });

  it('mounts and unmounts cleanly when onMountChange is omitted', async () => {
    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:optional-book',
        bookId: 'book-3',
        title: 'Optional Callback Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(openSessionMock).toHaveBeenCalledOnce();
    });

    await unmount(mounted);
    mounted = null;
    expect(destroySessionMock).toHaveBeenCalledOnce();
  });

  it('flushes final teardown relocations on unmount while preserving selection note drafts across relocations', async () => {
    let onLocationCallback:
      | ((
          location: {
            cfi: string;
            xpath: string | null;
            href: string;
            percentage: number;
            spineIndex: number;
            pageIndex: number;
            pageCount: number;
          },
          origin: 'restore' | 'navigation' | 'link',
        ) => void)
      | null = null;
    let onSelectionCallback: ((selection: { cfi: string; text: string } | null) => void) | null =
      null;

    openSessionMock.mockImplementationOnce(
      async (
        _viewport: HTMLElement,
        _cfi: string | null,
        _xpath: string | null,
        _percentage: number | null,
        _appearance: unknown,
        onLocation: typeof onLocationCallback,
        _onTapZone: unknown,
        onSelection: typeof onSelectionCallback,
      ) => {
        onLocationCallback = onLocation;
        onSelectionCallback = onSelection;
      },
    );
    destroySessionMock.mockImplementationOnce(() => {
      onLocationCallback?.(
        {
          cfi: 'epubcfi(/6/2!/4/2/99:0)',
          xpath: '//body/p[99]',
          href: 'chapter-1.xhtml',
          percentage: 0.99,
          spineIndex: 0,
          pageIndex: 98,
          pageCount: 100,
        },
        'navigation',
      );
    });

    const onRelocated = vi.fn();
    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:teardown-book',
        bookId: 'book-teardown',
        title: 'Teardown Book',
        onBack: vi.fn(),
        onRelocated,
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(onLocationCallback).not.toBeNull();
      expect(onSelectionCallback).not.toBeNull();
    });

    onLocationCallback!(
      {
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        xpath: '//body/p[1]',
        href: 'chapter-1.xhtml',
        percentage: 0.01,
        spineIndex: 0,
        pageIndex: 0,
        pageCount: 100,
      },
      'restore',
    );
    onSelectionCallback!({
      cfi: 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:12)',
      text: 'Important passage',
    });
    flushSync();

    // Open annotations dialog and type an unsaved selection note draft, then close dialog.
    target.querySelector<HTMLButtonElement>('button[aria-label="Show reading controls"]')?.click();
    flushSync();
    target.querySelector<HTMLButtonElement>('button[aria-controls="reader-annotations"]')?.click();
    flushSync();

    const noteTextarea = target.querySelector<HTMLTextAreaElement>('form textarea');
    expect(noteTextarea).not.toBeNull();
    noteTextarea!.value = 'Draft note in progress';
    noteTextarea!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    // Turning a page should preserve selectedText when a non-empty selection draft exists.
    onLocationCallback!(
      {
        cfi: 'epubcfi(/6/2!/4/2/2:0)',
        xpath: '//body/p[2]',
        href: 'chapter-1.xhtml',
        percentage: 0.02,
        spineIndex: 0,
        pageIndex: 1,
        pageCount: 100,
      },
      'navigation',
    );
    flushSync();
    expect(target.textContent).toContain('Important passage');
    expect(onRelocated).toHaveBeenCalledTimes(1);

    await unmount(mounted);
    mounted = null;

    expect(onRelocated).toHaveBeenCalledTimes(2);
    expect(onRelocated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cfi: 'epubcfi(/6/2!/4/2/99:0)',
        percentage: 0.99,
      }),
    );
  });
});
