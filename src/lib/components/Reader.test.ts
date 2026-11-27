// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type * as DatabaseModule from '../database/database';
import type * as SessionModule from '../reader/session';

const {
  getBookAnnotationsMock,
  getBookBookmarksMock,
  getBookHistoryMock,
  getPreferencesMock,
  setPreferencesMock,
  openSessionMock,
  resolveAnnotationLocationsMock,
  resolveBookmarkLocationsMock,
  destroySessionMock,
} = vi.hoisted(() => ({
  getBookAnnotationsMock: vi.fn(),
  getBookBookmarksMock: vi.fn(),
  getBookHistoryMock: vi.fn(),
  getPreferencesMock: vi.fn(),
  setPreferencesMock: vi.fn(),
  openSessionMock: vi.fn(),
  resolveAnnotationLocationsMock: vi.fn(async (items: unknown[]) => items),
  resolveBookmarkLocationsMock: vi.fn(async (items: unknown[]) => items),
  destroySessionMock: vi.fn(),
}));

vi.mock('../database/database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return {
    ...actual,
    deleteBookAnnotation: vi.fn(),
    deleteBookBookmark: vi.fn(),
    getBookAnnotations: getBookAnnotationsMock,
    getBookBookmarks: getBookBookmarksMock,
    getBookHistory: getBookHistoryMock,
    getPreferences: getPreferencesMock,
    recordBookHistory: vi.fn().mockResolvedValue([]),
    renameBookBookmark: vi.fn(),
    saveBookAnnotation: vi.fn(),
    saveBookBookmark: vi.fn(),
    saveResolvedBookAnnotations: vi.fn(),
    saveResolvedBookBookmarks: vi.fn(),
    setPreferences: setPreferencesMock,
    updateBookAnnotationNote: vi.fn(),
  };
});

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    ReaderSession: class MockReaderSession {
      open = openSessionMock;
      tableOfContents = () => [];
      getVisiblePassages = () => [];
      clearTextSelection = vi.fn();
      updateHighlights = vi.fn();
      resolveAnnotationLocations = resolveAnnotationLocationsMock;
      resolveBookmarkLocations = resolveBookmarkLocationsMock;
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
    getBookAnnotationsMock.mockResolvedValue([]);
    getBookBookmarksMock.mockResolvedValue([]);
    getBookHistoryMock.mockResolvedValue([]);
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

  it('loads server-scoped study data by bookId without querying legacy study preference keys', async () => {
    const serverScopedBookId = 'server_alpha:2:44';
    getBookAnnotationsMock.mockResolvedValueOnce([
      {
        id: `${serverScopedBookId}:ann-1`,
        cfi: '',
        xpath: '//body/DocFragment[1]/body/p[2]',
        excerpt: 'Server-scoped highlight',
        note: 'Server-scoped note',
        createdAt: '2026-01-01T00:00:00.000Z',
        syncState: 'synced',
      },
    ]);
    getBookBookmarksMock.mockResolvedValueOnce([
      {
        id: `${serverScopedBookId}:bm-1`,
        cfi: '',
        xpath: '//body/DocFragment[1]/body/p[2]',
        href: 'ch1.xhtml',
        percentage: 0.2,
        pageNumber: 0,
        label: 'Chapter 1',
        savedAt: '2026-01-01T00:00:00.000Z',
        syncState: 'synced',
      },
    ]);

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:server-book',
        bookId: serverScopedBookId,
        title: 'Server Scoped Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(openSessionMock).toHaveBeenCalledOnce();
      expect(getBookAnnotationsMock).toHaveBeenCalledWith(serverScopedBookId);
      expect(getBookBookmarksMock).toHaveBeenCalledWith(serverScopedBookId);
      expect(getBookHistoryMock).toHaveBeenCalledWith(serverScopedBookId);
      expect(resolveAnnotationLocationsMock).toHaveBeenCalledOnce();
      expect(resolveBookmarkLocationsMock).toHaveBeenCalledOnce();
    });

    const requestedPrefKeys = getPreferencesMock.mock.calls.flatMap(
      ([keys]) => (keys as string[]) ?? [],
    );
    expect(requestedPrefKeys.some((key) => key.startsWith('readerAnnotations:'))).toBe(false);
    expect(requestedPrefKeys.some((key) => key.startsWith('readerBookmarks:'))).toBe(false);
    expect(requestedPrefKeys.some((key) => key.startsWith('readerHistory:'))).toBe(false);
  });
});
