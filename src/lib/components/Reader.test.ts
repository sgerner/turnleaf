// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type * as SessionModule from '../reader/session';

const {
  getPreferencesMock,
  setPreferencesMock,
  openSessionMock,
  nextSessionMock,
  destroySessionMock,
} = vi.hoisted(() => ({
  getPreferencesMock: vi.fn(),
  setPreferencesMock: vi.fn(),
  openSessionMock: vi.fn(),
  nextSessionMock: vi.fn(),
  destroySessionMock: vi.fn(),
}));

vi.mock('../database/database', () => ({
  getPreferences: getPreferencesMock,
  setPreferences: setPreferencesMock,
}));

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    ReaderSession: class MockReaderSession {
      open = openSessionMock;
      next = nextSessionMock;
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
    nextSessionMock.mockResolvedValue(true);
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
      expect(target.querySelector('[role="alertdialog"]')?.textContent).toContain(
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

  it('opens, focuses, and restores focus for the end-of-book continuation dialog', async () => {
    nextSessionMock.mockResolvedValueOnce(false);
    const onBookCompleted = vi.fn();
    const onOpenNextBook = vi.fn().mockResolvedValue(undefined);

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:vol-1',
        bookId: 'vol-1',
        title: 'Leviathan Wakes',
        nextBook: {
          title: "Caliban's War",
          seriesLabel: 'The Expanse · Vol. 2',
          downloaded: true,
          available: true,
        },
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onBookCompleted,
        onOpenNextBook,
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(openSessionMock).toHaveBeenCalledOnce();
    });

    const nextZone = target.querySelector<HTMLButtonElement>('button[aria-label="Next page"]');
    expect(nextZone).not.toBeNull();
    nextZone?.focus();
    nextZone?.click();

    await vi.waitFor(() => {
      expect(onBookCompleted).toHaveBeenCalledOnce();
      expect(target.querySelector('dialog, [role="dialog"]')).not.toBeNull();
    });

    const dialog = target.querySelector<HTMLElement>('dialog, [role="dialog"]');
    await vi.waitFor(() => {
      expect(dialog?.contains(document.activeElement)).toBe(true);
    });

    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();

    await vi.waitFor(() => {
      expect(target.querySelector('dialog, [role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(nextZone);
    });
  });
});
