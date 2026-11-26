// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CapacitorHttp } from '@capacitor/core';
import { clearDiagnostics, getDiagnosticCount } from '../diagnostics/log';
import type { BookRecord, StoredReadingState } from '../database/database';
import Library from './Library.svelte';

const runtime = vi.hoisted(() => ({
  native: true,
  connected: true,
  networkListeners: new Set<(status: { connected: boolean; connectionType: string }) => void>(),
  appStateListeners: new Set<(state: { isActive: boolean }) => void>(),
  savedBooks: [] as BookRecord[],
  readingState: null as StoredReadingState | null,
  reconcileCalls: 0,
  flushProgressImpl: vi.fn<() => Promise<void>>(async () => {}),
  openedReaderProps: null as Record<string, unknown> | null,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => runtime.native,
    convertFileSrc: (value: string) => value,
  },
  CapacitorHttp: {
    request: vi.fn(),
    get: vi.fn(),
  },
  registerPlugin: () => ({}),
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({
      connected: runtime.connected,
      connectionType: runtime.connected ? 'wifi' : 'none',
    })),
    addListener: vi.fn(
      async (
        _event: string,
        listener: (status: { connected: boolean; connectionType: string }) => void,
      ) => {
        runtime.networkListeners.add(listener);
        return {
          remove: async () => {
            runtime.networkListeners.delete(listener);
          },
        };
      },
    ),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (event: string, listener: (state: { isActive: boolean }) => void) => {
      if (event === 'appStateChange') runtime.appStateListeners.add(listener);
      return {
        remove: async () => {
          runtime.appStateListeners.delete(listener);
        },
      };
    }),
    exitApp: vi.fn(async () => {}),
  },
}));

vi.mock('../database/database', () => ({
  getBooks: vi.fn(async () => [...runtime.savedBooks]),
  getReadingState: vi.fn(async () => runtime.readingState),
  getPreferences: vi.fn(async () => new Map<string, string>()),
  getSyncStatus: vi.fn(async () => ({
    pendingCount: 0,
    failedCount: 0,
    lastError: null,
    lastUpdatedAt: null,
  })),
  acceptRemoteProgress: vi.fn(async () => true),
  markDownloaded: vi.fn(async () => {}),
  markBookCompleted: vi.fn(async () => {}),
  removeDownload: vi.fn(async () => {}),
  removeServer: vi.fn(async () => {}),
  reconcileBooks: vi.fn(async (_serverId: string, mapped: BookRecord[]) => {
    runtime.reconcileCalls += 1;
    const byId = new Map(runtime.savedBooks.map((item) => [item.id, item]));
    runtime.savedBooks = mapped.map((item) => {
      const existing = byId.get(item.id);
      return existing
        ? {
            ...item,
            downloadPath: existing.downloadPath,
            downloadStatus: existing.downloadStatus,
            fileSize: existing.fileSize,
            lastReadAt: item.lastReadAt ?? existing.lastReadAt,
          }
        : item;
    });
  }),
  saveLocalProgress: vi.fn(async () => {}),
  saveRemoteProgress: vi.fn(async () => true),
  saveServer: vi.fn(async () => {}),
  setPreference: vi.fn(async () => {}),
}));

vi.mock('../downloads/native-download', () => ({
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class EpubTransferError extends Error {},
  cacheCover: vi.fn(async () => 'file:///cover.img'),
  clearCoverCache: vi.fn(async () => {}),
  cleanupInterruptedEpubDownloads: vi.fn(async () => {}),
  deleteDownloadedEpub: vi.fn(async () => {}),
  downloadEpub: vi.fn(),
  verifyDownloadedEpub: vi.fn(async (relativePath: string) => ({
    relativePath,
    nativeUri: `file:///${relativePath}`,
    webViewUrl: `file:///${relativePath}`,
    size: 1024,
  })),
}));

vi.mock('../sync/sync', () => ({
  flushProgress: () => runtime.flushProgressImpl(),
}));

vi.mock('../themes/themes', () => ({
  loadTheme: vi.fn(async () => {}),
  skeletonThemes: ['vintage'],
}));

vi.mock('./Reader.svelte', () => ({
  default: (_anchor: unknown, props: Record<string, unknown>) => {
    runtime.openedReaderProps = props;
    return {};
  },
}));

const savedBook: BookRecord = {
  id: 'primary:1:10',
  serverId: 'primary',
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 10,
  title: 'Saved Offline Book',
  author: 'Ada Lovelace',
  series: 'Saved Series',
  descriptionHtml: null,
  format: 'epub',
  pages: 100,
  pagesRead: 25,
  createdAt: '2026-01-01T00:00:00Z',
  lastReadAt: '2026-01-01T00:00:00Z',
  downloadPath: 'books/primary-10.epub',
  downloadStatus: 'available',
  fileSize: 1024,
  remoteAvailable: true,
};

let mounted: Record<string, unknown> | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  clearDiagnostics();
  runtime.native = true;
  runtime.connected = true;
  runtime.networkListeners.clear();
  runtime.appStateListeners.clear();
  runtime.savedBooks = [savedBook];
  runtime.readingState = {
    cfi: 'epubcfi(/6/4!/4/2:0)',
    xpath: '/body/p[2]',
    percentage: 0.25,
    localUpdatedAt: '2026-01-01T00:00:00Z',
    syncedLocalUpdatedAt: '2026-01-01T00:00:00Z',
    serverUpdatedAt: '2026-01-01T00:00:00Z',
    pendingSync: false,
    syncRevision: 1,
  };
  runtime.reconcileCalls = 0;
  runtime.flushProgressImpl = vi.fn(async () => {});
  runtime.openedReaderProps = null;
  vi.mocked(CapacitorHttp.request).mockReset();
  vi.mocked(CapacitorHttp.get).mockReset();
  (Element.prototype as { animate?: unknown }).animate ??= () => ({
    cancel() {},
    finish() {},
    onfinish: null,
    finished: Promise.resolve(),
  });
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  if (mounted) {
    unmount(mounted);
    mounted = null;
  }
  container.remove();
});

function mountLibrary(): void {
  mounted = mount(Library, {
    target: container,
    props: {
      server: {
        id: 'primary',
        displayName: 'Books',
        baseUrl: 'https://books.example.com',
        credentialRef: 'server_primary_api_key',
        kavitaVersion: '0.8.0',
        lastConnectedAt: '2026-01-01T00:00:00Z',
      },
      apiKey: 'secret-key',
      theme: 'vintage',
      mode: 'dark',
      onThemeChange: () => {},
      onModeChange: () => {},
      onApiKeyChange: () => {},
      onServerDeleted: () => {},
      onChangeServerAddress: () => {},
    },
  });
  flushSync();
}

it('re-enables Refresh immediately on disconnect abort, preserves saved books, and refreshes without stalling on reconnect', async () => {
  const orphanRejects: Array<(reason?: unknown) => void> = [];
  let healthy = false;

  vi.mocked(CapacitorHttp.request).mockImplementation(async (options) => {
    const url = options.url;
    if (url.includes('/api/Series/v2')) {
      return {
        status: 200,
        headers: {},
        url,
        data: JSON.stringify([
          {
            id: 1,
            name: 'Saved Series',
            libraryId: 1,
            format: 3,
            pages: 100,
            pagesRead: 25,
            created: '2026-01-01T00:00:00Z',
            latestReadDate: '2026-01-01T00:00:00Z',
            coverImage: '',
          },
        ]),
      };
    }
    if (!healthy) {
      return new Promise((_, reject) => {
        orphanRejects.push(reject);
      });
    }
    return {
      status: 200,
      headers: {},
      url,
      data: JSON.stringify({
        chapters: [
          {
            id: 10,
            title: 'Refreshed Book',
            titleName: 'Refreshed Book',
            volumeId: 1,
            pages: 100,
            pagesRead: 30,
            summary: '',
            format: 3,
            files: [{ id: 100, bytes: 1024, extension: '.epub', format: 3 }],
            writers: [{ name: 'Ada Lovelace' }],
          },
        ],
        specials: [],
        volumes: [],
        storylineChapters: [],
      }),
    };
  });

  mountLibrary();
  await vi.waitFor(() => expect(orphanRejects).toHaveLength(1));

  const refreshButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Refresh library"]',
  );
  expect(refreshButton?.disabled).toBe(true);

  runtime.connected = false;
  for (const listener of runtime.networkListeners) {
    listener({ connected: false, connectionType: 'none' });
  }
  flushSync();

  expect(refreshButton?.disabled).toBe(false);
  expect(runtime.reconcileCalls).toBe(0);
  expect(container.textContent).toContain('Saved Offline Book');

  healthy = true;
  runtime.connected = true;
  for (const listener of runtime.networkListeners) {
    listener({ connected: true, connectionType: 'wifi' });
  }

  await vi.waitFor(() => expect(runtime.reconcileCalls).toBe(1));
  expect(container.textContent).toContain('Refreshed Book');

  orphanRejects.forEach((reject) => reject(new Error('SocketTimeoutException')));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(getDiagnosticCount()).toBe(0);
});

it('aborts the 1,500 ms open progress probe across syncWork and getProgress without aborting syncWork or retrying', async () => {
  vi.useFakeTimers();
  try {
    let resolveSyncWork!: () => void;
    let syncFinished = false;
    runtime.flushProgressImpl = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSyncWork = () => {
            syncFinished = true;
            resolve();
          };
        }),
    );

    const seriesPayload = JSON.stringify([
      {
        id: 1,
        name: 'Saved Series',
        libraryId: 1,
        format: 3,
        pages: 100,
        pagesRead: 25,
        created: '2026-01-01T00:00:00Z',
        latestReadDate: '2026-01-01T00:00:00Z',
        coverImage: '',
      },
    ]);
    const detailPayload = JSON.stringify({
      chapters: [
        {
          id: 10,
          title: 'Saved Offline Book',
          titleName: 'Saved Offline Book',
          volumeId: 1,
          pages: 100,
          pagesRead: 25,
          summary: '',
          format: 3,
          files: [{ id: 100, bytes: 1024, extension: '.epub', format: 3 }],
          writers: [{ name: 'Ada Lovelace' }],
        },
      ],
      specials: [],
      volumes: [],
      storylineChapters: [],
    });

    let rejectProgressOrphan!: (reason?: unknown) => void;
    let progressCalls = 0;
    vi.mocked(CapacitorHttp.request).mockImplementation(async (options) => {
      if (options.url.includes('/api/Series/v2')) {
        return { status: 200, headers: {}, url: options.url, data: seriesPayload };
      }
      if (options.url.includes('/api/Series/series-detail')) {
        return { status: 200, headers: {}, url: options.url, data: detailPayload };
      }
      if (options.url.includes('/api/Reader/get-progress')) {
        progressCalls += 1;
        return new Promise((_, reject) => {
          rejectProgressOrphan = reject;
        });
      }
      return { status: 200, headers: {}, url: options.url, data: '[]' };
    });

    mountLibrary();
    await vi.advanceTimersByTimeAsync(50);
    flushSync();

    // Case 1: syncWork itself exceeds 1,500 ms -> probe aborts wait without aborting syncWork
    for (const listener of runtime.appStateListeners) {
      listener({ isActive: false });
    }
    expect(runtime.flushProgressImpl).toHaveBeenCalledOnce();

    const continueButton = [...container.querySelectorAll('button')].find(
      (button) =>
        button.textContent?.includes('Continue reading') &&
        button.textContent.includes('Saved Offline Book'),
    );
    expect(continueButton).not.toBeNull();
    continueButton?.click();
    flushSync();

    await vi.advanceTimersByTimeAsync(1_500);
    flushSync();

    // Book opened from local state while syncWork is still running un-aborted
    expect(runtime.openedReaderProps).toMatchObject({ initialCfi: 'epubcfi(/6/4!/4/2:0)' });
    expect(progressCalls).toBe(0);
    expect(syncFinished).toBe(false);

    // Finish syncWork cleanly in background
    resolveSyncWork();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncFinished).toBe(true);

    // Remount to verify Case 2: syncWork settles quickly, then getProgress exceeds 1,500 ms
    if (mounted) {
      unmount(mounted);
      mounted = null;
    }
    runtime.openedReaderProps = null;
    runtime.flushProgressImpl = vi.fn(async () => {});

    mountLibrary();
    await vi.advanceTimersByTimeAsync(50);
    flushSync();

    const secondContinueButton = [...container.querySelectorAll('button')].find(
      (button) =>
        button.textContent?.includes('Continue reading') &&
        button.textContent.includes('Saved Offline Book'),
    );
    expect(secondContinueButton).not.toBeNull();
    secondContinueButton?.click();
    flushSync();

    await vi.advanceTimersByTimeAsync(50);
    expect(progressCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_500);
    flushSync();

    expect(progressCalls).toBe(1);
    expect(runtime.openedReaderProps).toMatchObject({ initialCfi: 'epubcfi(/6/4!/4/2:0)' });

    rejectProgressOrphan(new Error('SocketTimeoutException'));
    await vi.advanceTimersByTimeAsync(0);
    expect(getDiagnosticCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
