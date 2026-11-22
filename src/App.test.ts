// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

vi.mock('./lib/github/releases', () => ({
  fetchLatestGithubRelease: vi.fn(async () => ({
    version: '0.4.0',
    title: 'Accessibility Update',
    releaseUrl: 'https://github.com/sgerner/turnleaf/releases/tag/v0.4.0',
    downloadUrl: 'https://github.com/sgerner/turnleaf/releases/download/v0.4.0/turnleaf.apk',
  })),
}));

vi.mock('./lib/database/database', () => ({
  getServer: vi.fn(async () => null),
  getPreferences: vi.fn(async () => new Map()),
  resetLocalDatabase: vi.fn(async () => {}),
  saveServer: vi.fn(async () => {}),
}));

vi.mock('./lib/native/credentials', () => ({
  getApiKey: vi.fn(async () => null),
  saveApiKey: vi.fn(async () => {}),
  removeApiKey: vi.fn(async () => {}),
}));

vi.mock('./lib/themes/themes', () => ({
  loadTheme: vi.fn(async () => true),
}));

import App from './App.svelte';

describe('App shell releaseBanner layout', () => {
  let host: HTMLDivElement;
  let instance: Record<string, unknown> | null = null;

  beforeEach(() => {
    Element.prototype.animate ??= () => {
      let canceled = false;
      const animation = {
        currentTime: 0,
        playState: 'finished',
        effect: null,
        onfinish: null as ((event: AnimationPlaybackEvent) => void) | null,
        cancel: () => {
          canceled = true;
        },
      };
      queueMicrotask(() => {
        if (!canceled) animation.onfinish?.(new Event('finish') as AnimationPlaybackEvent);
      });
      return animation as unknown as Animation;
    };
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(() => {
    if (instance) {
      void unmount(instance);
      instance = null;
    }
    host.remove();
  });

  it('renders releaseBanner as a non-sticky sibling above .app-stage and allows dismissal', async () => {
    instance = mount(App, { target: host });
    await vi.waitFor(() => {
      expect(host.querySelector('.release-banner')).not.toBeNull();
    });
    await tick();

    const shell = host.querySelector<HTMLElement>('.app-shell')!;
    const banner = host.querySelector<HTMLElement>('.release-banner')!;
    const stage = host.querySelector<HTMLElement>('.app-stage')!;

    expect(banner.parentElement).toBe(shell);
    expect(stage.parentElement).toBe(shell);
    expect(stage.contains(banner)).toBe(false);
    expect(banner.classList.contains('sticky')).toBe(false);
    expect(stage.querySelector('.sticky')).toBeNull();
    expect(Boolean(banner.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );

    const dismissButton = Array.from(banner.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Dismiss',
    )!;
    flushSync(() => {
      dismissButton.click();
    });

    await vi.waitFor(() => {
      expect(host.querySelector('.release-banner')).toBeNull();
    });
  });
});
