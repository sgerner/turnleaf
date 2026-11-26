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

vi.mock('../reader/session', () => ({
  ReaderSession: class MockReaderSession {
    open = openSessionMock;
    tableOfContents = () => [];
    updateHighlights = vi.fn();
    destroy = destroySessionMock;
  },
}));

import Reader from './Reader.svelte';

describe('Reader mount lifecycle', () => {
  let target: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
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
});
