// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPreferences,
  reconcileBooks,
  saveServer,
  setPreference,
  type BookRecord,
  type ServerConfig,
} from '../database/database';
import Library from './Library.svelte';

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: false, connectionType: 'none' })),
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
    exitApp: vi.fn(async () => undefined),
  },
}));

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const server: ServerConfig = {
  id: 'server',
  displayName: 'Kavita',
  baseUrl: 'https://kavita.example.com',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.0',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const downloadedInProgress: BookRecord = {
  id: 'server:1:1',
  serverId: 'server',
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 1,
  title: 'Alpha Downloaded Reading',
  author: 'Ada Lovelace',
  series: 'Computing',
  descriptionHtml: null,
  format: 'epub',
  pages: 100,
  pagesRead: 40,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-03-01T00:00:00.000Z',
  downloadPath: 'books/server-1-1.epub',
  downloadStatus: 'available',
  fileSize: 2048,
};

const remoteUnread: BookRecord = {
  id: 'server:1:2',
  serverId: 'server',
  libraryId: 1,
  seriesId: 2,
  volumeId: 2,
  chapterId: 2,
  title: 'Beta Remote Unread',
  author: 'Grace Hopper',
  series: 'Compilers',
  descriptionHtml: null,
  format: 'epub',
  pages: 120,
  pagesRead: 0,
  createdAt: '2026-01-02T00:00:00.000Z',
  lastReadAt: null,
  downloadPath: null,
  downloadStatus: 'none',
  fileSize: null,
};

const downloadedCompleted: BookRecord = {
  id: 'server:1:3',
  serverId: 'server',
  libraryId: 1,
  seriesId: 3,
  volumeId: 3,
  chapterId: 3,
  title: 'Gamma Downloaded Finished',
  author: 'Margaret Hamilton',
  series: 'Guidance',
  descriptionHtml: null,
  format: 'epub',
  pages: 90,
  pagesRead: 90,
  createdAt: '2026-01-03T00:00:00.000Z',
  lastReadAt: '2026-02-01T00:00:00.000Z',
  downloadPath: 'books/server-1-3.epub',
  downloadStatus: 'available',
  fileSize: 4096,
};

describe('Library filter preference persistence', () => {
  let target: HTMLDivElement;
  let instance: Record<string, unknown> | null = null;

  beforeEach(async () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
    if (!window.matchMedia) {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: vi.fn(() => ({
          matches: false,
          media: '',
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });
    }
    if (!Element.prototype.animate) {
      Element.prototype.animate = vi.fn(() => {
        let cancelled = false;
        const animation = {
          currentTime: 0,
          effect: null,
          playState: 'finished' as AnimationPlayState,
          onfinish: null as ((this: Animation, ev: AnimationPlaybackEvent) => unknown) | null,
          cancel: () => {
            cancelled = true;
            animation.playState = 'idle';
          },
          finish: () => undefined,
        };
        queueMicrotask(() => {
          if (!cancelled) {
            animation.onfinish?.call(
              animation as unknown as Animation,
              new Event('finish') as AnimationPlaybackEvent,
            );
          }
        });
        return animation as unknown as Animation;
      });
    }
    target = document.createElement('div');
    document.body.appendChild(target);
    await saveServer(server);
    await reconcileBooks(server.id, [downloadedInProgress, remoteUnread, downloadedCompleted]);
  });

  afterEach(async () => {
    if (instance) {
      await unmount(instance);
      instance = null;
    }
    target.remove();
  });

  async function mountLibrary(): Promise<void> {
    if (instance) {
      await unmount(instance);
      instance = null;
    }
    target.innerHTML = '';
    instance = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'test-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });
    await vi.waitFor(() => {
      expect(target.textContent).not.toContain('Opening your saved library...');
    });
    flushSync();
  }

  function getFilterButtons(): {
    downloadedButton: HTMLButtonElement;
    hideCompletedButton: HTMLButtonElement;
  } {
    const group = target.querySelector('[role="group"][aria-label="Library filters"]');
    expect(group).not.toBeNull();
    const buttons = [...group!.querySelectorAll('button')];
    const downloadedButton = buttons.find((button) =>
      button.textContent?.includes('Downloaded Only'),
    );
    const hideCompletedButton = buttons.find((button) =>
      button.textContent?.includes('Hide completed'),
    );
    expect(downloadedButton).toBeDefined();
    expect(hideCompletedButton).toBeDefined();
    return {
      downloadedButton: downloadedButton!,
      hideCompletedButton: hideCompletedButton!,
    };
  }

  it('uses false and true defaults when filter preferences are missing or invalid', async () => {
    await mountLibrary();

    let buttons = getFilterButtons();
    expect(buttons.downloadedButton.getAttribute('aria-pressed')).toBe('false');
    expect(buttons.hideCompletedButton.getAttribute('aria-pressed')).toBe('true');
    expect(target.textContent).toContain('2 of 3 books');

    await setPreference('libraryDownloadedOnly', 'invalid');
    await setPreference('libraryHideCompleted', 'unexpected');
    await mountLibrary();

    buttons = getFilterButtons();
    expect(buttons.downloadedButton.getAttribute('aria-pressed')).toBe('false');
    expect(buttons.hideCompletedButton.getAttribute('aria-pressed')).toBe('true');
    expect(target.textContent).toContain('2 of 3 books');
  });

  it('persists button toggles across remounts while keeping continueBook and transient search intact', async () => {
    await mountLibrary();

    const { downloadedButton, hideCompletedButton } = getFilterButtons();
    flushSync(() => {
      downloadedButton.click();
    });
    expect(downloadedButton.getAttribute('aria-pressed')).toBe('true');
    expect(target.textContent).toContain('1 of 3 books');

    flushSync(() => {
      hideCompletedButton.click();
    });
    expect(hideCompletedButton.getAttribute('aria-pressed')).toBe('false');
    expect(target.textContent).toContain('2 of 3 books');

    const searchInput = target.querySelector<HTMLInputElement>('#library-search');
    expect(searchInput).not.toBeNull();
    searchInput!.value = 'Gamma';
    flushSync(() => {
      searchInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(target.textContent).toContain('1 of 3 books');

    const stored = await getPreferences(['libraryDownloadedOnly', 'libraryHideCompleted']);
    expect(stored.get('libraryDownloadedOnly')).toBe('true');
    expect(stored.get('libraryHideCompleted')).toBe('false');

    await mountLibrary();

    const remountedButtons = getFilterButtons();
    expect(remountedButtons.downloadedButton.getAttribute('aria-pressed')).toBe('true');
    expect(remountedButtons.hideCompletedButton.getAttribute('aria-pressed')).toBe('false');
    expect(target.querySelector<HTMLInputElement>('#library-search')?.value).toBe('');
    expect(target.textContent).toContain('2 of 3 books');
    expect(target.textContent).toContain('Continue reading');
    expect(target.textContent).toContain('Alpha Downloaded Reading');
  });

  it('persists clearFilters resets from both toolbar and empty-state buttons across remounts', async () => {
    await setPreference('libraryDownloadedOnly', 'true');
    await setPreference('libraryHideCompleted', 'true');
    await mountLibrary();

    expect(target.textContent).toContain('1 of 3 books');
    const toolbarClear = target.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear library filters"]',
    );
    expect(toolbarClear).not.toBeNull();
    flushSync(() => {
      toolbarClear!.click();
    });

    expect(target.textContent).toContain('3 of 3 books');

    await mountLibrary();

    let buttons = getFilterButtons();
    expect(buttons.downloadedButton.getAttribute('aria-pressed')).toBe('false');
    expect(buttons.hideCompletedButton.getAttribute('aria-pressed')).toBe('false');
    expect(target.textContent).toContain('3 of 3 books');

    await setPreference('libraryDownloadedOnly', 'true');
    await setPreference('libraryHideCompleted', 'true');
    await mountLibrary();

    const searchInput = target.querySelector<HTMLInputElement>('#library-search');
    expect(searchInput).not.toBeNull();
    searchInput!.value = 'Nonexistent';
    flushSync(() => {
      searchInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(target.textContent).toContain('No books match your search.');
    const emptyStateClear = [...target.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Clear search and filters'),
    );
    expect(emptyStateClear).toBeDefined();
    flushSync(() => {
      emptyStateClear!.click();
    });

    expect(target.querySelector<HTMLInputElement>('#library-search')?.value).toBe('');
    expect(target.textContent).toContain('3 of 3 books');

    await mountLibrary();

    buttons = getFilterButtons();
    expect(buttons.downloadedButton.getAttribute('aria-pressed')).toBe('false');
    expect(buttons.hideCompletedButton.getAttribute('aria-pressed')).toBe('false');
    expect(target.textContent).toContain('3 of 3 books');
  });
});
