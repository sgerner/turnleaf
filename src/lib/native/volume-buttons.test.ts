// @vitest-environment jsdom

import { mount, tick, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';

if (typeof Element !== 'undefined' && !Element.prototype.animate) {
  Element.prototype.animate = () => {
    const animation = {
      onfinish: null as (() => void) | null,
      cancel() {},
      finish() {
        animation.onfinish?.();
      },
      finished: Promise.resolve(),
    };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
}

const nextPage = vi.fn(async () => undefined);
const previousPage = vi.fn(async () => undefined);

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
  registerPlugin: () => ({
    setEnabled: vi.fn(async () => undefined),
  }),
}));

vi.mock('@capacitor/status-bar', () => ({
  Animation: { None: 'NONE' },
  StatusBar: {
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
  },
}));

vi.mock('../database/database', () => ({
  getPreferences: vi.fn(async () => new Map()),
  setPreferences: vi.fn(async () => undefined),
}));

vi.mock('../reader/session', () => ({
  ReaderSession: class {
    async open() {}
    tableOfContents() {
      return [];
    }
    updateHighlights() {}
    applyAppearance() {}
    async next() {
      await nextPage();
    }
    async previous() {
      await previousPage();
    }
    destroy() {}
  },
}));

import Reader from '../components/Reader.svelte';
import { createBackButtonStack } from './back-button';
import { parseVolumeButtonDirection } from './volume-buttons';

function createCapacitorWindowEvent(eventName: string, eventData?: Record<string, unknown>): Event {
  const event = document.createEvent('Events');
  event.initEvent(eventName, false, false);
  if (eventData) {
    Object.assign(event, eventData);
  }
  return event;
}

describe('parseVolumeButtonDirection', () => {
  it('reads top-level direction properties created by Capacitor triggerWindowJSEvent', () => {
    expect(
      parseVolumeButtonDirection(
        createCapacitorWindowEvent('turnleafVolumeButton', { direction: 'next' }),
      ),
    ).toBe('next');
    expect(
      parseVolumeButtonDirection(
        createCapacitorWindowEvent('turnleafVolumeButton', { direction: 'previous' }),
      ),
    ).toBe('previous');
  });

  it('supports CustomEvent detail payloads and rejects unknown directions', () => {
    expect(
      parseVolumeButtonDirection(
        new CustomEvent('turnleafVolumeButton', { detail: { direction: 'next' } }),
      ),
    ).toBe('next');
    expect(
      parseVolumeButtonDirection(
        createCapacitorWindowEvent('turnleafVolumeButton', { direction: 'up' }),
      ),
    ).toBeNull();
    expect(parseVolumeButtonDirection(new Event('turnleafVolumeButton'))).toBeNull();
  });

  it('turns pages in Reader.svelte when Capacitor dispatches turnleafVolumeButton after closing appearance', async () => {
    nextPage.mockClear();
    previousPage.mockClear();
    const host = document.createElement('div');
    document.body.append(host);
    const stack = createBackButtonStack();
    const mounted = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:test-epub',
        bookId: 'book-volume-1',
        title: 'Volume Test Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        registerBackHandler: stack.register,
      },
    });

    try {
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tick();

      host.querySelector<HTMLButtonElement>('.reader-top-reveal')!.click();
      await tick();
      host.querySelector<HTMLButtonElement>('[aria-label="Text, reading appearance"]')!.click();
      await tick();

      const volumeToggle = Array.from(host.querySelectorAll('#reader-appearance label'))
        .find((label) => label.textContent?.includes('Turn pages with volume buttons'))
        ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(volumeToggle).not.toBeUndefined();
      volumeToggle!.click();
      await tick();

      // While the appearance dialog is open, volume events do not turn pages.
      window.dispatchEvent(
        createCapacitorWindowEvent('turnleafVolumeButton', { direction: 'next' }),
      );
      expect(nextPage).not.toHaveBeenCalled();

      // Dismiss #reader-appearance with Android Back, then dispatch Capacitor window events.
      expect(stack.dispatch()).toBe(true);
      await tick();

      window.dispatchEvent(
        createCapacitorWindowEvent('turnleafVolumeButton', { direction: 'next' }),
      );
      window.dispatchEvent(
        createCapacitorWindowEvent('turnleafVolumeButton', { direction: 'previous' }),
      );

      expect(nextPage).toHaveBeenCalledOnce();
      expect(previousPage).toHaveBeenCalledOnce();
    } finally {
      await unmount(mounted);
      host.remove();
    }
  });
});
