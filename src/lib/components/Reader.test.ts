// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { defaultAppearance } from '../reader/appearance';
import type * as SessionModule from '../reader/session';

const {
  getPreferencesMock,
  setPreferencesMock,
  openSessionMock,
  applyAppearanceMock,
  destroySessionMock,
} = vi.hoisted(() => ({
  getPreferencesMock: vi.fn(),
  setPreferencesMock: vi.fn(),
  openSessionMock: vi.fn(),
  applyAppearanceMock: vi.fn(),
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
      applyAppearance = applyAppearanceMock;
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

  it('batches slider input via requestAnimationFrame and flushes combined state when toggling publisher formatting', async () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    let nextRafId = 1;
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        const id = nextRafId++;
        rafCallbacks.push(callback);
        return id;
      });
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      rafCallbacks.length = 0;
    });

    try {
      mounted = mount(Reader, {
        target,
        props: {
          bookUrl: 'blob:appearance-book',
          bookId: 'book-4',
          title: 'Appearance Book',
          initialCfi: 'epubcfi(/6/2!/4/2/10:0)',
          onBack: vi.fn(),
          onRelocated: vi.fn(),
        },
      });
      flushSync();

      await vi.waitFor(() => {
        expect(openSessionMock).toHaveBeenCalledOnce();
      });

      const showControlsBtn = target.querySelector<HTMLButtonElement>(
        'button[aria-label="Show reading controls"]',
      );
      expect(showControlsBtn).not.toBeNull();
      showControlsBtn!.click();
      flushSync();

      const openAppearanceBtn = target.querySelector<HTMLButtonElement>(
        'button[aria-label="Text, reading appearance"]',
      );
      expect(openAppearanceBtn).not.toBeNull();
      openAppearanceBtn!.click();
      flushSync();

      applyAppearanceMock.mockClear();
      rafCallbacks.length = 0;

      const fontSizeInput = target.querySelector<HTMLInputElement>(
        '#reader-appearance input[aria-label="Text size"]',
      );
      const paragraphSpacingInput = target.querySelector<HTMLInputElement>(
        '#reader-appearance input[aria-label="Paragraph spacing"]',
      );
      expect(fontSizeInput).not.toBeNull();
      expect(paragraphSpacingInput).not.toBeNull();

      for (const size of ['20', '22', '24']) {
        fontSizeInput!.value = size;
        fontSizeInput!.dispatchEvent(new Event('input', { bubbles: true }));
      }
      paragraphSpacingInput!.value = '1';
      paragraphSpacingInput!.dispatchEvent(new Event('input', { bubbles: true }));
      flushSync();

      // Labels and aria-valuetext update immediately while session.applyAppearance is deferred to one rAF
      expect(fontSizeInput!.getAttribute('aria-valuetext')).toBe('24 pixels');
      expect(paragraphSpacingInput!.getAttribute('aria-valuetext')).toBe('1.0 em');
      expect(applyAppearanceMock).not.toHaveBeenCalled();
      expect(rafCallbacks).toHaveLength(1);

      // Toggling "Respect publisher formatting" cancels the pending slider rAF and applies both immediately
      const publisherCheckbox = Array.from(
        target.querySelectorAll<HTMLLabelElement>('#reader-appearance label'),
      )
        .find((label) => label.textContent?.includes('Respect publisher formatting'))
        ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(publisherCheckbox).not.toBeNull();
      expect(publisherCheckbox!.checked).toBe(true);

      publisherCheckbox!.checked = false;
      publisherCheckbox!.dispatchEvent(new Event('change', { bubbles: true }));
      flushSync();

      expect(cancelRafSpy).toHaveBeenCalledOnce();
      expect(applyAppearanceMock).toHaveBeenCalledExactlyOnceWith({
        ...defaultAppearance,
        fontSize: 24,
        paragraphSpacing: 1,
        publisherStyles: false,
      });
    } finally {
      rafSpy.mockRestore();
      cancelRafSpy.mockRestore();
    }
  });
});
