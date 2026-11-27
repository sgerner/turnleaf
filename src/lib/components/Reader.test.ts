// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type * as CapacitorCoreModule from '@capacitor/core';
import type * as SessionModule from '../reader/session';

const {
  getPreferencesMock,
  setPreferencesMock,
  openSessionMock,
  destroySessionMock,
  constructedBookUrls,
  isNativePlatformMock,
  nativeEnableMock,
  nativeRestoreMock,
  nativeDisableMock,
} = vi.hoisted(() => ({
  getPreferencesMock: vi.fn(),
  setPreferencesMock: vi.fn(),
  openSessionMock: vi.fn(),
  destroySessionMock: vi.fn(),
  constructedBookUrls: [] as string[],
  isNativePlatformMock: vi.fn(() => false),
  nativeEnableMock: vi.fn(async () => {}),
  nativeRestoreMock: vi.fn(async () => {}),
  nativeDisableMock: vi.fn(async () => {}),
}));

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CapacitorCoreModule>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: isNativePlatformMock,
    },
  };
});

vi.mock('../native/reader-native-features', () => ({
  createReaderNativeFeatures: () => ({
    enable: nativeEnableMock,
    restore: nativeRestoreMock,
    disable: nativeDisableMock,
    setKeepAwake: vi.fn(async () => {}),
    setVolumeButtons: vi.fn(async () => {}),
  }),
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
      constructor(bookUrl: string) {
        constructedBookUrls.push(bookUrl);
      }
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
    constructedBookUrls.length = 0;
    isNativePlatformMock.mockReturnValue(false);
    nativeEnableMock.mockResolvedValue(undefined);
    nativeRestoreMock.mockResolvedValue(undefined);
    nativeDisableMock.mockResolvedValue(undefined);
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

  it('enables native reader chrome before opening the session, restores it on failure, and re-enables with updated bookUrl on retry', async () => {
    isNativePlatformMock.mockReturnValue(true);
    const callOrder: string[] = [];
    nativeEnableMock.mockImplementation(async () => {
      callOrder.push('native:enable');
    });
    nativeRestoreMock.mockImplementation(async () => {
      callOrder.push('native:restore');
    });
    openSessionMock
      .mockImplementationOnce(async () => {
        callOrder.push('session:open:fail');
        throw new Error('corrupt epub');
      })
      .mockImplementationOnce(async () => {
        callOrder.push('session:open:retry');
      });

    let currentBookUrl = 'https://localhost/_capacitor_file_/books/42.epub';
    const props = {
      get bookUrl() {
        return currentBookUrl;
      },
      bookId: 'book-42',
      title: 'Retryable Book',
      androidReader: true,
      onBack: vi.fn(),
      onRelocated: vi.fn(),
      onRetryDownload: async () => {
        callOrder.push('retry:download');
        currentBookUrl = 'https://localhost/_capacitor_file_/books/42.epub?retry=1';
      },
    };

    mounted = mount(Reader, { target, props });
    flushSync();

    await vi.waitFor(() => {
      expect(target.querySelector('[role="alertdialog"]')?.textContent).toContain(
        'This EPUB could not be opened.',
      );
    });
    expect(callOrder).toEqual(['native:enable', 'session:open:fail', 'native:restore']);
    expect(constructedBookUrls).toEqual(['https://localhost/_capacitor_file_/books/42.epub']);

    const retryButton = [...target.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Retry download'),
    );
    expect(retryButton).toBeDefined();
    retryButton!.click();

    await vi.waitFor(() => {
      expect(openSessionMock).toHaveBeenCalledTimes(2);
    });
    expect(callOrder).toEqual([
      'native:enable',
      'session:open:fail',
      'native:restore',
      'retry:download',
      'native:enable',
      'session:open:retry',
    ]);
    expect(constructedBookUrls).toEqual([
      'https://localhost/_capacitor_file_/books/42.epub',
      'https://localhost/_capacitor_file_/books/42.epub?retry=1',
    ]);
  });
});
