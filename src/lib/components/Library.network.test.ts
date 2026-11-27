// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '@capacitor/network';
import type { BookRecord, ServerConfig } from '../database/database';

const runtime = vi.hoisted(() => ({
  native: true,
  status: { connected: false, connectionType: 'none' } as ConnectionStatus,
  networkListener: null as ((status: ConnectionStatus) => void) | null,
}));

const { flushProgressMock, getBookSeriesMock, getBooksMock } = vi.hoisted(() => ({
  flushProgressMock: vi.fn(async () => undefined),
  getBookSeriesMock: vi.fn(async () => []),
  getBooksMock: vi.fn(async (): Promise<BookRecord[]> => []),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => runtime.native,
    getPlatform: () => (runtime.native ? 'android' : 'web'),
    convertFileSrc: (value: string) => value,
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => runtime.status),
    addListener: vi.fn(async (_event: string, listener: (status: ConnectionStatus) => void) => {
      runtime.networkListener = listener;
      return {
        remove: async () => {
          if (runtime.networkListener === listener) runtime.networkListener = null;
        },
      };
    }),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
    exitApp: vi.fn(async () => undefined),
  },
}));

vi.mock('../database/database', () => ({
  getBooks: getBooksMock,
  getReadingState: vi.fn(async () => null),
  getPreferences: vi.fn(async () => new Map()),
  getSyncStatus: vi.fn(async () => ({
    pendingCount: 1,
    failedCount: 0,
    lastError: null,
    lastUpdatedAt: null,
  })),
  acceptRemoteProgress: vi.fn(),
  markDownloaded: vi.fn(),
  markBookCompleted: vi.fn(),
  removeDownload: vi.fn(),
  removeServer: vi.fn(),
  reconcileBooks: vi.fn(async () => undefined),
  saveLocalProgress: vi.fn(),
  saveRemoteProgress: vi.fn(),
  saveServer: vi.fn(),
  setPreference: vi.fn(async () => undefined),
}));

vi.mock('../downloads/native-download', () => ({
  cacheCover: vi.fn(),
  clearCoverCache: vi.fn(),
  cleanupInterruptedEpubDownloads: vi.fn(async () => undefined),
  deleteDownloadedEpub: vi.fn(),
  downloadEpub: vi.fn(),
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class EpubTransferError extends Error {},
  verifyDownloadedEpub: vi.fn(),
}));

vi.mock('../kavita/client', () => ({
  KavitaError: class KavitaError extends Error {
    constructor(
      message: string,
      readonly kind: string,
      readonly status?: number,
    ) {
      super(message);
    }
  },
  KavitaClient: class MockKavitaClient {
    getBookSeries = getBookSeriesMock;
    getSeriesDetail = vi.fn(async () => ({ volumes: [], incomplete: false }));
    coverUrl = (seriesId: number) => `http://127.0.0.1/cover/${seriesId}`;
  },
}));

vi.mock('../sync/sync', () => ({
  flushProgress: flushProgressMock,
}));

import Library from './Library.svelte';

const server: ServerConfig = {
  id: 'server-1',
  displayName: 'Local Kavita',
  baseUrl: 'http://127.0.0.1:5000',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.4',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const savedBook: BookRecord = {
  id: 'server-1:1:1',
  serverId: 'server-1',
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 1,
  title: 'Turnleaf CI EPUB',
  author: 'Ada Lovelace',
  series: null,
  descriptionHtml: null,
  format: 'epub',
  pages: 2,
  pagesRead: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-01-02T00:00:00.000Z',
  downloadPath: 'books/server-1-1-1.epub',
  downloadStatus: 'available',
  fileSize: 2048,
};

describe('Library native network status and reconnect progress sync', () => {
  let target: HTMLDivElement;
  let instance: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
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
    runtime.native = true;
    runtime.status = { connected: false, connectionType: 'none' };
    runtime.networkListener = null;
    getBooksMock.mockResolvedValue([savedBook]);
    getBookSeriesMock.mockResolvedValue([]);
    flushProgressMock.mockResolvedValue(undefined);
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

  async function mountLibrary(): Promise<void> {
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
      expect(runtime.networkListener).not.toBeNull();
    });
    flushSync();
  }

  it('flushes queued progress when native Wi-Fi reconnects before captive-portal validation and ignores false onLost events', async () => {
    let abortedDuringRefresh = false;
    let resolveSeries!: (value: never[]) => void;
    getBookSeriesMock.mockImplementation(
      (signal?: AbortSignal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => {
            abortedDuringRefresh = true;
          });
          resolveSeries = resolve;
        }),
    );

    await mountLibrary();
    expect(target.textContent).toContain('No network connection. Showing your saved library.');
    expect(flushProgressMock).not.toHaveBeenCalled();

    // Wi-Fi transport comes up before Google captive-portal NET_CAPABILITY_VALIDATED completes.
    runtime.status = { connected: false, connectionType: 'wifi' };
    runtime.networkListener?.({ connected: false, connectionType: 'wifi' });

    await vi.waitFor(() => {
      expect(flushProgressMock).toHaveBeenCalled();
      expect(getBookSeriesMock).toHaveBeenCalledOnce();
    });

    // Cellular lingers and fires NetworkPlugin wasLostEvent ({ connected: false, connectionType: 'none' })
    // while Wi-Fi is already the active network.
    runtime.status = { connected: true, connectionType: 'wifi' };
    runtime.networkListener?.({ connected: false, connectionType: 'none' });
    await Promise.resolve();
    await Promise.resolve();

    expect(abortedDuringRefresh).toBe(false);
    await vi.waitFor(() => {
      expect(target.textContent).not.toContain('No network connection.');
    });

    resolveSeries([]);
    await Promise.resolve();
  });
});
