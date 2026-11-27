// @vitest-environment jsdom

import { flushSync, mount, onDestroy, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CapacitorHttp } from '@capacitor/core';
import { clearDiagnostics, getDiagnosticCount } from '../diagnostics/log';
import type { BookRecord, PendingSyncItem, StoredReadingState } from '../database/database';
import { cacheCover, downloadEpub } from '../downloads/native-download';
import type { ReaderLocation } from '../reader/session';
import Library from './Library.svelte';

const runtime = vi.hoisted(() => ({
  native: true,
  connected: true,
  networkListeners: new Set<(status: { connected: boolean; connectionType: string }) => void>(),
  appStateListeners: new Set<(state: { isActive: boolean }) => void>(),
  savedBooks: [] as BookRecord[],
  readingState: null as StoredReadingState | null,
  syncQueue: new Map<string, PendingSyncItem & { serverId: string; lastError: string | null }>(),
  reconcileCalls: 0,
  openedReaderProps: null as Record<string, unknown> | null,
  overlayStates: [] as boolean[],
  readerOpenStates: [] as boolean[],
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => runtime.native,
    convertFileSrc: (value: string) => value,
  },
  CapacitorHttp: {
    request: vi.fn(),
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
  getReadingState: vi.fn(async () => (runtime.readingState ? { ...runtime.readingState } : null)),
  getPreferences: vi.fn(async () => new Map<string, string>()),
  getPendingSync: vi.fn(async (serverId: string) =>
    [...runtime.syncQueue.values()]
      .filter((item) => item.serverId === serverId)
      .map(({ bookId, payload, revision, updatedAt }) => ({
        bookId,
        payload,
        revision,
        updatedAt,
      })),
  ),
  confirmSync: vi.fn(
    async (bookId: string, syncedAt: string, revision: number, updatedAt: string) => {
      const current = runtime.syncQueue.get(bookId);
      if (current && current.revision === revision && current.updatedAt === updatedAt) {
        runtime.syncQueue.delete(bookId);
        if (runtime.readingState) {
          runtime.readingState = {
            ...runtime.readingState,
            pendingSync: false,
            syncedLocalUpdatedAt: updatedAt,
            serverUpdatedAt: syncedAt,
          };
        }
      }
    },
  ),
  markSyncFailure: vi.fn(
    async (bookId: string, error: string, revision: number, updatedAt: string) => {
      const current = runtime.syncQueue.get(bookId);
      if (current && current.revision === revision && current.updatedAt === updatedAt) {
        current.lastError = error;
      }
    },
  ),
  getSyncStatus: vi.fn(async () => {
    const items = [...runtime.syncQueue.values()];
    const failed = items.filter((item) => item.lastError !== null);
    return {
      pendingCount: items.length,
      failedCount: failed.length,
      lastError: failed.at(-1)?.lastError ?? null,
      lastUpdatedAt: items.at(-1)?.updatedAt ?? null,
    };
  }),
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
  saveLocalProgress: vi.fn(
    async (book: BookRecord, cfi: string, xpath: string | null, percentage: number) => {
      const now = new Date().toISOString();
      const nextRevision = (runtime.readingState?.syncRevision ?? 0) + 1;
      const pageNum = Math.round(percentage * book.pages);
      runtime.readingState = {
        cfi,
        xpath,
        percentage,
        localUpdatedAt: now,
        syncedLocalUpdatedAt: runtime.readingState?.syncedLocalUpdatedAt ?? null,
        serverUpdatedAt: runtime.readingState?.serverUpdatedAt ?? null,
        pendingSync: true,
        syncRevision: nextRevision,
      };
      runtime.syncQueue.set(book.id, {
        bookId: book.id,
        serverId: book.serverId,
        payload: JSON.stringify({
          libraryId: book.libraryId,
          seriesId: book.seriesId,
          volumeId: book.volumeId,
          chapterId: book.chapterId,
          pageNum,
          bookScrollId: xpath,
        }),
        revision: nextRevision,
        updatedAt: now,
        lastError: null,
      });
    },
  ),
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
  downloadEpub: vi.fn(async () => ({
    relativePath: 'books/primary-1-20.epub',
    nativeUri: 'file:///books/primary-1-20.epub',
    webViewUrl: 'file:///books/primary-1-20.epub',
    size: 2048,
  })),
  verifyDownloadedEpub: vi.fn(async (relativePath: string) => ({
    relativePath,
    nativeUri: `file:///${relativePath}`,
    webViewUrl: `file:///${relativePath}`,
    size: 1024,
  })),
}));

vi.mock('../themes/themes', () => ({
  loadTheme: vi.fn(async () => {}),
  skeletonThemes: ['vintage'],
}));

vi.mock('./Reader.svelte', () => ({
  default: (_anchor: unknown, props: Record<string, unknown>) => {
    runtime.openedReaderProps = props;
    const onMountChange = props.onMountChange as ((open: boolean) => void) | undefined;
    onMountChange?.(true);
    onDestroy(() => {
      onMountChange?.(false);
    });
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
  runtime.savedBooks = [{ ...savedBook }];
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
  runtime.syncQueue.clear();
  runtime.reconcileCalls = 0;
  runtime.openedReaderProps = null;
  runtime.overlayStates = [];
  runtime.readerOpenStates = [];
  vi.mocked(CapacitorHttp.request).mockReset();
  vi.mocked(cacheCover).mockClear();
  vi.mocked(downloadEpub).mockClear();
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
        baseUrl: 'https://books.example.com/kavita',
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
      onReaderOpenChange: (open) => {
        runtime.readerOpenStates.push(open);
      },
      onOverlayActiveChange: (active) => {
        runtime.overlayStates.push(active);
      },
    },
  });
  flushSync();
}

it('re-enables Refresh immediately on disconnect abort, preserves saved books and transfer origin, and refreshes on reconnect', async () => {
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
          {
            id: 2,
            name: 'Remote Series',
            libraryId: 1,
            format: 3,
            pages: 80,
            pagesRead: 0,
            created: '2026-01-02T00:00:00Z',
            latestReadDate: null,
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
    if (url.includes('seriesId=2')) {
      return {
        status: 200,
        headers: {},
        url,
        data: JSON.stringify({
          chapters: [
            {
              id: 20,
              title: 'Remote Downloadable Book',
              titleName: 'Remote Downloadable Book',
              volumeId: 2,
              pages: 80,
              pagesRead: 0,
              summary: '',
              format: 3,
              files: [{ id: 200, bytes: 2048, extension: '.epub', format: 3 }],
              writers: [{ name: 'Grace Hopper' }],
            },
          ],
          specials: [],
          volumes: [],
          storylineChapters: [],
        }),
      };
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
  await vi.waitFor(() => expect(orphanRejects).toHaveLength(2));

  const refreshButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Refresh library"]',
  );
  expect(refreshButton?.disabled).toBe(true);
  expect(runtime.overlayStates.at(-1)).toBe(false);

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
  flushSync();
  expect(container.textContent).toContain('Refreshed Book');
  expect(container.textContent).toContain('Remote Downloadable Book');

  await vi.waitFor(() => expect(cacheCover).toHaveBeenCalled());
  expect(vi.mocked(cacheCover).mock.calls[0]?.[6]).toBe('https://books.example.com');

  const downloadOpenButton = [
    ...container.querySelectorAll<HTMLButtonElement>('[data-book-open]'),
  ].find((button) => button.textContent?.includes('Remote Downloadable Book'));
  expect(downloadOpenButton).toBeDefined();
  downloadOpenButton?.click();
  await vi.waitFor(() => expect(downloadEpub).toHaveBeenCalledOnce());
  expect(vi.mocked(downloadEpub).mock.calls[0]?.[4]).toBe('https://books.example.com');

  orphanRejects.forEach((reject) => reject(new Error('SocketTimeoutException')));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(getDiagnosticCount()).toBe(0);
});

it('aborts the open progress probe while serializing replacement progress uploads behind in-flight saveProgress and preserving overlay state', async () => {
  vi.useFakeTimers();
  try {
    runtime.readingState = {
      cfi: 'epubcfi(/6/4!/4/2:0)',
      xpath: '/body/p[2]',
      percentage: 0.25,
      localUpdatedAt: '2026-01-01T00:00:05Z',
      syncedLocalUpdatedAt: '2026-01-01T00:00:00Z',
      serverUpdatedAt: '2026-01-01T00:00:00Z',
      pendingSync: true,
      syncRevision: 1,
    };
    runtime.syncQueue.set(savedBook.id, {
      bookId: savedBook.id,
      serverId: 'primary',
      payload: JSON.stringify({
        libraryId: 1,
        seriesId: 1,
        volumeId: 1,
        chapterId: 10,
        pageNum: 25,
        bookScrollId: '/body/p[2]',
      }),
      revision: 1,
      updatedAt: '2026-01-01T00:00:05Z',
      lastError: null,
    });

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

    const uploadedPages: number[] = [];
    let resolveInitialUpload!: () => void;
    let rejectProgressOrphan!: (reason?: unknown) => void;
    let progressCalls = 0;

    vi.mocked(CapacitorHttp.request).mockImplementation(async (options) => {
      if (options.url.includes('/api/Series/v2')) {
        return { status: 200, headers: {}, url: options.url, data: seriesPayload };
      }
      if (options.url.includes('/api/Series/series-detail')) {
        return { status: 200, headers: {}, url: options.url, data: detailPayload };
      }
      if (options.url.includes('/api/Reader/progress')) {
        const pageNum = (options.data as { pageNum: number }).pageNum;
        uploadedPages.push(pageNum);
        if (uploadedPages.length === 1) {
          return new Promise((resolve) => {
            resolveInitialUpload = () =>
              resolve({ status: 200, headers: {}, url: options.url, data: '' });
          });
        }
        return { status: 200, headers: {}, url: options.url, data: '' };
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

    // Initial mount started real flushProgress -> CapacitorHttp.request POST /api/Reader/progress (page 25)
    expect(uploadedPages).toEqual([25]);
    expect(runtime.overlayStates.at(-1)).toBe(false);

    const continueButton = [...container.querySelectorAll('button')].find(
      (button) =>
        button.textContent?.includes('Continue reading') &&
        button.textContent.includes('Saved Offline Book'),
    );
    expect(continueButton).toBeDefined();
    continueButton?.click();
    flushSync();

    // While resolvingOpenProgress banner is visible, overlayActive stays false
    expect(container.textContent).toContain('Opening downloaded book…');
    expect(runtime.overlayStates.at(-1)).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    flushSync();

    // Book opened from local state; overlayActive transitioned to true; syncWork is still in flight
    expect(runtime.openedReaderProps).toMatchObject({ initialCfi: 'epubcfi(/6/4!/4/2:0)' });
    expect(runtime.overlayStates.at(-1)).toBe(true);
    expect(runtime.readerOpenStates.at(-1)).toBe(true);
    expect(progressCalls).toBe(0);
    expect(uploadedPages).toEqual([25]);

    // Reader saves a newer relocation (page 40) and triggers debounce timer while upload 1 is still pending
    const onRelocated = runtime.openedReaderProps?.onRelocated as
      ((location: ReaderLocation) => void) | undefined;
    expect(onRelocated).toBeTypeOf('function');
    onRelocated?.({
      cfi: 'epubcfi(/6/4!/4/8:0)',
      xpath: '/body/p[8]',
      href: 'chapter-1.xhtml',
      percentage: 0.4,
      spineIndex: 1,
      pageIndex: 4,
      pageCount: 10,
    });
    await vi.advanceTimersByTimeAsync(2_600);

    // Replacement mutation MUST NOT start until the original saveProgress request actually settles
    expect(uploadedPages).toEqual([25]);

    resolveInitialUpload();
    await vi.advanceTimersByTimeAsync(50);

    expect(uploadedPages).toEqual([25, 40]);
    expect(runtime.syncQueue.size).toBe(0);

    // Close reader and verify overlayActive returns to false, then test "Open offline" during getProgress
    const onBack = runtime.openedReaderProps?.onBack as (() => void) | undefined;
    expect(onBack).toBeTypeOf('function');
    onBack?.();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(runtime.overlayStates.at(-1)).toBe(false);
    expect(runtime.readerOpenStates.at(-1)).toBe(false);
    runtime.openedReaderProps = null;

    const secondContinueButton = [...container.querySelectorAll('button')].find(
      (button) =>
        button.textContent?.includes('Continue reading') &&
        button.textContent.includes('Saved Offline Book'),
    );
    expect(secondContinueButton).toBeDefined();
    secondContinueButton?.click();
    flushSync();

    await vi.advanceTimersByTimeAsync(50);
    flushSync();
    expect(progressCalls).toBe(1);

    const openOfflineButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Open offline'),
    );
    expect(openOfflineButton).toBeDefined();
    openOfflineButton?.click();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();

    expect(progressCalls).toBe(1);
    expect(runtime.openedReaderProps).toMatchObject({ initialCfi: 'epubcfi(/6/4!/4/8:0)' });
    expect(runtime.overlayStates.at(-1)).toBe(true);

    rejectProgressOrphan(new Error('SocketTimeoutException'));
    await vi.advanceTimersByTimeAsync(0);
    expect(getDiagnosticCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
