// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookRecord, ServerConfig } from '../database/database';

const {
  mockIsNativePlatform,
  mockGetStatus,
  mockNetworkAddListener,
  mockFlushProgress,
  mockGetSyncStatus,
  mockGetBooks,
} = vi.hoisted(() => ({
  mockIsNativePlatform: vi.fn(() => true),
  mockGetStatus: vi.fn(async () => ({ connected: false, connectionType: 'none' })),
  mockNetworkAddListener: vi.fn(),
  mockFlushProgress: vi.fn(async () => undefined),
  mockGetSyncStatus: vi.fn(async () => ({
    pendingCount: 1,
    failedCount: 0,
    lastError: null,
    lastUpdatedAt: '2026-03-01T00:00:00.000Z',
  })),
  mockGetBooks: vi.fn<() => Promise<BookRecord[]>>(async () => []),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: mockIsNativePlatform,
    getPlatform: () => (mockIsNativePlatform() ? 'android' : 'web'),
    convertFileSrc: (path: string) => path,
  },
  CapacitorHttp: {
    request: vi.fn(async () => ({ status: 200, headers: {}, data: [], url: '' })),
  },
  registerPlugin: () => ({}),
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: mockGetStatus,
    addListener: mockNetworkAddListener,
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
    exitApp: vi.fn(async () => undefined),
  },
}));

vi.mock('../database/database', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../database/database');
  return {
    ...actual,
    getBooks: mockGetBooks,
    getPreferences: vi.fn(async () => new Map()),
    getSyncStatus: mockGetSyncStatus,
    reconcileBooks: vi.fn(async () => []),
  };
});

vi.mock('../downloads/native-download', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../downloads/native-download');
  return {
    ...actual,
    cacheCover: vi.fn(async () => null),
    cleanupInterruptedEpubDownloads: vi.fn(async () => []),
  };
});

vi.mock('../sync/sync', () => ({
  flushProgress: mockFlushProgress,
}));

import Library from './Library.svelte';

const server: ServerConfig = {
  id: 'server',
  displayName: 'Kavita',
  baseUrl: 'http://127.0.0.1:41234',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.8',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const downloadedBook: BookRecord = {
  id: 'server:1:1',
  serverId: 'server',
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 1,
  title: 'Turnleaf CI EPUB',
  author: 'Turnleaf',
  series: 'Turnleaf CI EPUB',
  descriptionHtml: null,
  format: 'epub',
  pages: 2,
  pagesRead: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-03-01T00:00:00.000Z',
  downloadPath: 'books/server-1-1.epub',
  downloadStatus: 'available',
  fileSize: 2048,
};

describe('Library native network reconnect sync', () => {
  let target: HTMLDivElement;
  let instance: Record<string, unknown> | null = null;
  let networkListeners: Array<(status: { connected: boolean; connectionType: string }) => void> =
    [];

  beforeEach(() => {
    vi.clearAllMocks();
    networkListeners = [];
    mockIsNativePlatform.mockReturnValue(true);
    mockGetBooks.mockResolvedValue([downloadedBook]);
    mockGetStatus.mockResolvedValue({ connected: false, connectionType: 'none' });
    mockNetworkAddListener.mockImplementation(
      async (
        _event: string,
        listener: (status: { connected: boolean; connectionType: string }) => void,
      ) => {
        networkListeners.push(listener);
        return { remove: async () => undefined };
      },
    );
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
  });

  afterEach(async () => {
    if (instance) {
      await unmount(instance);
      instance = null;
    }
    target.remove();
  });

  it('flushes queued reading progress when Android switches to unvalidated Wi-Fi transport on reconnect', async () => {
    instance = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'turnleaf-ci-only',
        theme: 'vintage',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });

    await vi.waitFor(() => {
      expect(networkListeners.length).toBeGreaterThan(0);
    });
    expect(mockFlushProgress).not.toHaveBeenCalled();

    // Simulate Android 16 re-enabling cellular + Wi-Fi where active Wi-Fi transport is not yet
    // internet-validated (connected: false, connectionType: 'wifi'), while local/LAN Kavita is reachable.
    mockGetStatus.mockResolvedValue({ connected: false, connectionType: 'wifi' });
    for (const listener of networkListeners) {
      listener({ connected: false, connectionType: 'wifi' });
    }

    await vi.waitFor(() => {
      flushSync();
      expect(mockFlushProgress).toHaveBeenCalled();
      expect(target.textContent).not.toContain('No network connection.');
    });
  });
});
