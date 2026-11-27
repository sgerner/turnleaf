// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { BookRecord, ServerConfig } from '../database/database';
import type * as ThemesModule from '../themes/themes';

type NetworkListener = (status: { connected: boolean; connectionType: string }) => void;

const {
  networkGetStatusMock,
  networkAddListenerMock,
  getBookSeriesMock,
  getSeriesDetailMock,
  flushProgressMock,
  getPreferencesMock,
  getBooksMock,
  getSyncStatusMock,
  reconcileBooksMock,
} = vi.hoisted(() => ({
  networkGetStatusMock: vi.fn(),
  networkAddListenerMock: vi.fn(),
  getBookSeriesMock: vi.fn(),
  getSeriesDetailMock: vi.fn(),
  flushProgressMock: vi.fn(),
  getPreferencesMock: vi.fn(),
  getBooksMock: vi.fn(),
  getSyncStatusMock: vi.fn(),
  reconcileBooksMock: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    convertFileSrc: (uri: string) => uri,
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: networkGetStatusMock,
    addListener: networkAddListenerMock,
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn().mockResolvedValue({ remove: async () => {} }),
    exitApp: vi.fn(),
  },
}));

vi.mock('../kavita/client', () => ({
  KavitaError: class MockKavitaError extends Error {
    kind = 'network';
    status?: number;
  },
  KavitaClient: class MockKavitaClient {
    getBookSeries = getBookSeriesMock;
    getSeriesDetail = getSeriesDetailMock;
    getProgress = vi.fn().mockResolvedValue(null);
  },
  mapSeriesToBooks: vi.fn(() => []),
}));

vi.mock('../sync/sync', () => ({
  flushProgress: flushProgressMock,
}));

vi.mock('../themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    loadTheme: vi.fn().mockResolvedValue(true),
    skeletonThemes: ['fennec', 'eink', 'catppuccin'],
  };
});

vi.mock('../native/credentials', () => ({
  saveApiKey: vi.fn().mockResolvedValue(undefined),
  removeApiKey: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../downloads/native-download', () => ({
  cacheCover: vi.fn().mockResolvedValue(null),
  clearCoverCache: vi.fn().mockResolvedValue(undefined),
  cleanupInterruptedEpubDownloads: vi.fn().mockResolvedValue(undefined),
  deleteDownloadedEpub: vi.fn().mockResolvedValue(undefined),
  downloadEpub: vi.fn(),
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class MockEpubTransferError extends Error {},
  verifyDownloadedEpub: vi.fn(),
}));

vi.mock('../database/database', () => ({
  getPreferences: getPreferencesMock,
  setPreference: vi.fn().mockResolvedValue(undefined),
  setPreferences: vi.fn().mockResolvedValue(undefined),
  getBooks: getBooksMock,
  getReadingState: vi.fn().mockResolvedValue(null),
  getSyncStatus: getSyncStatusMock,
  removeServer: vi.fn().mockResolvedValue(undefined),
  acceptRemoteProgress: vi.fn(),
  markDownloaded: vi.fn(),
  markBookCompleted: vi.fn(),
  removeDownload: vi.fn(),
  reconcileBooks: reconcileBooksMock,
  saveLocalProgress: vi.fn(),
  saveRemoteProgress: vi.fn(),
}));

import Library from './Library.svelte';

const server: ServerConfig = {
  id: 'server-1',
  baseUrl: 'http://127.0.0.1:5000',
  displayName: 'Local Kavita',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.4',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const savedBook: BookRecord = {
  id: 'book-1',
  serverId: 'server-1',
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 1,
  title: 'Turnleaf CI EPUB',
  author: 'Ada Lovelace',
  series: null,
  descriptionHtml: null,
  format: 'EPUB',
  pages: 2,
  pagesRead: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-01-02T00:00:00.000Z',
  downloadPath: 'epub/book-1.epub',
  downloadStatus: 'available',
  fileSize: 4096,
  remoteAvailable: true,
};

describe('Library native network handover handling', () => {
  let target: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;
  let networkListeners: NetworkListener[];

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
    networkListeners = [];

    networkAddListenerMock.mockImplementation(
      async (eventName: string, callback: NetworkListener) => {
        if (eventName === 'networkStatusChange') networkListeners.push(callback);
        return { remove: async () => {} };
      },
    );
    getPreferencesMock.mockResolvedValue(new Map());
    getBooksMock.mockResolvedValue([savedBook]);
    getSyncStatusMock.mockResolvedValue({ pendingCount: 1, failedCount: 0 });
    getBookSeriesMock.mockResolvedValue([]);
    getSeriesDetailMock.mockResolvedValue({ volumes: [], incomplete: false });
    reconcileBooksMock.mockResolvedValue(undefined);
    flushProgressMock.mockResolvedValue(undefined);

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

  it('does not trigger a redundant refresh on online Wi-Fi to Cellular handovers before going offline', async () => {
    networkGetStatusMock.mockResolvedValue({ connected: true, connectionType: 'wifi' });

    mounted = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'secret-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onChangeServerAddress: vi.fn(),
        onServerDeleted: vi.fn(),
      },
    });

    await vi.waitFor(() => {
      expect(networkListeners).toHaveLength(1);
      expect(getBookSeriesMock).toHaveBeenCalledTimes(1);
      expect(flushProgressMock).toHaveBeenCalledTimes(1);
    });

    getBookSeriesMock.mockClear();
    flushProgressMock.mockClear();

    // Wi-Fi drops while Cellular is still active -> connected: true handover event.
    networkGetStatusMock.mockResolvedValue({ connected: true, connectionType: 'cellular' });
    networkListeners[0]?.({ connected: true, connectionType: 'cellular' });
    flushSync();

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(getBookSeriesMock).not.toHaveBeenCalled();
    expect(flushProgressMock).not.toHaveBeenCalled();

    // Cellular then drops -> Network.getStatus() confirms offline.
    networkGetStatusMock.mockResolvedValue({ connected: false, connectionType: 'none' });
    networkListeners[0]?.({ connected: false, connectionType: 'none' });

    await vi.waitFor(() => {
      expect(target.textContent).toContain('No network connection. Showing your saved library.');
    });
    expect(getBookSeriesMock).not.toHaveBeenCalled();
  });

  it('ignores superseded Cellular onLost disconnect events when Network.getStatus() confirms Wi-Fi is still connected', async () => {
    networkGetStatusMock.mockResolvedValue({ connected: false, connectionType: 'none' });

    mounted = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'secret-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onChangeServerAddress: vi.fn(),
        onServerDeleted: vi.fn(),
      },
    });

    await vi.waitFor(() => {
      expect(networkListeners).toHaveLength(1);
      expect(target.textContent).toContain('No network connection. Showing your saved library.');
    });
    expect(getBookSeriesMock).not.toHaveBeenCalled();
    expect(flushProgressMock).not.toHaveBeenCalled();

    let resolveRefreshSeries!: (value: unknown[]) => void;
    getBookSeriesMock.mockImplementation(
      (_signal?: AbortSignal) =>
        new Promise((resolve) => {
          resolveRefreshSeries = resolve;
        }),
    );

    // Reconnect: Cellular connects first, then Wi-Fi supersedes Cellular and fires a lost event,
    // while Network.getStatus() remains connected on Wi-Fi.
    networkGetStatusMock.mockResolvedValue({ connected: true, connectionType: 'wifi' });
    networkListeners[0]?.({ connected: true, connectionType: 'cellular' });
    networkListeners[0]?.({ connected: false, connectionType: 'none' });

    await vi.waitFor(() => {
      expect(getBookSeriesMock).toHaveBeenCalledTimes(1);
    });
    const refreshSignal = getBookSeriesMock.mock.calls[0]?.[0] as AbortSignal | undefined;
    expect(refreshSignal?.aborted).toBe(false);

    resolveRefreshSeries([]);

    await vi.waitFor(() => {
      expect(flushProgressMock).toHaveBeenCalledTimes(1);
    });
    expect(target.textContent).not.toContain('No network connection. Showing your saved library.');
  });

  it('does not send authenticated refresh or sync requests during a transient Cellular blip between Wi-Fi disable and mobile data disable', async () => {
    networkGetStatusMock.mockResolvedValue({ connected: true, connectionType: 'wifi' });

    mounted = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'secret-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onChangeServerAddress: vi.fn(),
        onServerDeleted: vi.fn(),
      },
    });

    await vi.waitFor(() => {
      expect(networkListeners).toHaveLength(1);
      expect(getBookSeriesMock).toHaveBeenCalledTimes(1);
      expect(flushProgressMock).toHaveBeenCalledTimes(1);
    });

    getBookSeriesMock.mockClear();
    flushProgressMock.mockClear();

    // 1. svc wifi disable drops Wi-Fi before Cellular validates -> briefly offline
    networkGetStatusMock.mockResolvedValue({ connected: false, connectionType: 'none' });
    networkListeners[0]?.({ connected: false, connectionType: 'none' });
    await vi.waitFor(() => {
      expect(target.textContent).toContain('No network connection. Showing your saved library.');
    });

    // 2. Cellular briefly validates 50ms later, then svc data disable drops Cellular 60ms after that
    networkGetStatusMock.mockResolvedValue({ connected: true, connectionType: 'cellular' });
    networkListeners[0]?.({ connected: true, connectionType: 'cellular' });
    await new Promise((resolve) => setTimeout(resolve, 60));

    networkGetStatusMock.mockResolvedValue({ connected: false, connectionType: 'none' });
    networkListeners[0]?.({ connected: false, connectionType: 'none' });

    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(getBookSeriesMock).not.toHaveBeenCalled();
    expect(flushProgressMock).not.toHaveBeenCalled();
    expect(target.textContent).toContain('No network connection. Showing your saved library.');

    // 3. Even a late stale queued connected: true callback arriving while native getStatus() is false sends nothing
    networkListeners[0]?.({ connected: true, connectionType: 'cellular' });
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(getBookSeriesMock).not.toHaveBeenCalled();
    expect(flushProgressMock).not.toHaveBeenCalled();
  });
});
