// @vitest-environment jsdom

import { flushSync, mount, onDestroy, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CapacitorHttp } from '@capacitor/core';
import { clearDiagnostics, exportDiagnostics } from '../diagnostics/log';
import {
  markSyncFailure,
  type BookRecord,
  type PendingSyncItem,
  type StoredReadingState,
} from '../database/database';
import { cacheCover, downloadEpub } from '../downloads/native-download';
import type { ReaderLocation } from '../reader/session';
import type * as ThemesModule from '../themes/themes';
import Library from './Library.svelte';

const runtime = vi.hoisted(() => ({
  native: true,
  connected: true,
  networkListeners: new Set<(status: { connected: boolean; connectionType: string }) => void>(),
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
  CapacitorHttp: { request: vi.fn() },
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
        return { remove: async () => void runtime.networkListeners.delete(listener) };
      },
    ),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => {} })),
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
        if (runtime.readingState && bookId === savedBook.id) {
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
          pageNum: Math.round(percentage * book.pages),
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

vi.mock('../themes/themes', async (importOriginal) => ({
  ...(await importOriginal<typeof ThemesModule>()),
  loadTheme: vi.fn(async () => true),
  skeletonThemes: ['vintage'],
}));

vi.mock('./Reader.svelte', () => ({
  default: (_anchor: unknown, props: Record<string, unknown>) => {
    runtime.openedReaderProps = props;
    const onMountChange = props.onMountChange as ((open: boolean) => void) | undefined;
    onMountChange?.(true);
    onDestroy(() => onMountChange?.(false));
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

function emitNetwork(connected: boolean): void {
  for (const listener of runtime.networkListeners) {
    listener({ connected, connectionType: connected ? 'wifi' : 'none' });
  }
}

function mountLibrary(): void {
  mounted = mount(Library, {
    target: container,
    props: {
      server: {
        id: 'primary',
        displayName: 'Primary',
        baseUrl: 'https://books.example.com/kavita',
        credentialRef: 'cred-1',
        kavitaVersion: '0.8.4',
        lastConnectedAt: '2026-01-01T00:00:00Z',
      },
      apiKey: 'secret',
      theme: 'vintage',
      mode: 'light',
      onThemeChange: () => {},
      onModeChange: () => {},
      onApiKeyChange: () => {},
      onServerDeleted: () => {},
      onChangeServerAddress: () => {},
      onOverlayActiveChange: (active: boolean) => void runtime.overlayStates.push(active),
      onReaderOpenChange: (open: boolean) => void runtime.readerOpenStates.push(open),
    },
  });
}

beforeEach(() => {
  clearDiagnostics();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Element.prototype.animate ??= () =>
    ({
      cancel: () => {},
      finish: () => {},
      onfinish: null,
      finished: Promise.resolve(),
    }) as unknown as Animation;
  runtime.native = true;
  runtime.connected = true;
  runtime.networkListeners.clear();
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
  vi.mocked(markSyncFailure).mockClear();
  container = document.createElement('div');
  container.className = 'app-stage';
  Object.defineProperty(container, 'clientWidth', { value: 900, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 800, configurable: true });
  document.body.appendChild(container);
});

afterEach(() => {
  vi.useRealTimers();
  if (mounted) {
    unmount(mounted);
    mounted = null;
  }
  container.remove();
});

it('settles stalled native refresh on disconnect, ignores stale reconnect events, and preserves origin checks', async () => {
  let rejectOrphanedDetail!: (reason?: unknown) => void;
  let refreshPhase: 'stalled' | 'recovered' = 'stalled';
  vi.mocked(CapacitorHttp.request).mockImplementation((options) => {
    if (options.url.includes('/api/Series/v2')) {
      return Promise.resolve({
        status: 200,
        headers: {},
        data: JSON.stringify([
          { id: 1, libraryId: 1, format: 3, name: 'Saved Series', pages: 100 },
        ]),
        url: '',
      });
    }
    if (refreshPhase === 'stalled') {
      return new Promise((_, reject) => {
        rejectOrphanedDetail = reject;
      });
    }
    return Promise.resolve({
      status: 200,
      headers: {},
      data: JSON.stringify({
        chapters: [
          {
            id: 20,
            volumeId: 1,
            format: 3,
            pages: 120,
            pagesRead: 0,
            titleName: 'Remote Ready Book',
            files: [{ id: 1, format: 3, pages: 120 }],
          },
        ],
        specials: [],
        volumes: [],
        storylineChapters: [],
      }),
      url: '',
    });
  });

  mountLibrary();
  await vi.waitFor(() => expect(CapacitorHttp.request).toHaveBeenCalledTimes(2));

  const refreshBtn = container.querySelector<HTMLButtonElement>('[aria-label="Refresh library"]');
  expect(refreshBtn?.disabled).toBe(true);

  runtime.connected = false;
  emitNetwork(false);
  await vi.waitFor(() => expect(refreshBtn?.disabled).toBe(false));
  expect(runtime.reconcileCalls).toBe(0);
  expect(container.textContent).toContain('Saved Offline Book');

  const callsWhileOffline = vi.mocked(CapacitorHttp.request).mock.calls.length;
  emitNetwork(true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(CapacitorHttp.request).toHaveBeenCalledTimes(callsWhileOffline);
  expect(container.textContent).toContain('No network connection.');

  rejectOrphanedDetail(new Error('SocketTimeoutException'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(exportDiagnostics({ appVersion: 'test', platform: 'android' })).not.toContain(
    'network-error',
  );

  refreshPhase = 'recovered';
  runtime.connected = true;
  emitNetwork(true);
  await vi.waitFor(() => expect(runtime.reconcileCalls).toBe(1));
  flushSync();

  expect(cacheCover).toHaveBeenCalledWith(
    'https://books.example.com/kavita/api/Image/series-cover?seriesId=1',
    'secret',
    1,
    expect.any(AbortSignal),
    'primary',
    true,
    'https://books.example.com',
  );

  container.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')?.click();
  flushSync();
  expect(runtime.overlayStates.at(-1)).toBe(true);
  container.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click();
  flushSync();

  await new Promise((resolve) => setTimeout(resolve, 20));
  flushSync();
  container.querySelector<HTMLButtonElement>('[data-book-open]')?.click();
  await vi.waitFor(() =>
    expect(downloadEpub).toHaveBeenCalledWith(
      'https://books.example.com/kavita/api/Download/chapter?chapterId=20',
      'secret',
      'primary-1-20',
      expect.any(Function),
      'https://books.example.com',
    ),
  );
});

it('stops native progress flush between requests on disconnect and waits for held saveProgress before retrying on reconnect', async () => {
  runtime.connected = false;
  for (const [bookId, chapterId, pageNum, updatedAt] of [
    [savedBook.id, 10, 25, '2026-01-01T00:00:00Z'],
    ['primary:1:11', 11, 40, '2026-01-01T00:00:01Z'],
  ] as const) {
    runtime.syncQueue.set(bookId, {
      bookId,
      serverId: 'primary',
      payload: JSON.stringify({ libraryId: 1, seriesId: 1, volumeId: 1, chapterId, pageNum }),
      revision: 1,
      updatedAt,
      lastError: null,
    });
  }

  let releaseHeldSave!: () => void;
  const savedChapterIds: number[] = [];
  vi.mocked(CapacitorHttp.request).mockImplementation((options) => {
    if (options.url.includes('/api/Reader/progress')) {
      const data = options.data as { chapterId: number };
      savedChapterIds.push(data.chapterId);
      if (savedChapterIds.length === 1) {
        return new Promise((resolve) => {
          releaseHeldSave = () => resolve({ status: 204, headers: {}, data: '', url: '' });
        });
      }
      return Promise.resolve({ status: 204, headers: {}, data: '', url: '' });
    }
    return Promise.resolve({ status: 200, headers: {}, data: '[]', url: '' });
  });

  mountLibrary();
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(CapacitorHttp.request).not.toHaveBeenCalled();

  runtime.connected = true;
  emitNetwork(true);
  await vi.waitFor(() => expect(savedChapterIds).toEqual([10]));

  runtime.connected = false;
  emitNetwork(false);
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(savedChapterIds).toEqual([10]);
  expect(markSyncFailure).not.toHaveBeenCalled();

  runtime.connected = true;
  emitNetwork(true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(savedChapterIds).toEqual([10]);

  releaseHeldSave();
  await vi.waitFor(() => expect(savedChapterIds).toEqual([10, 11]));
  expect(runtime.syncQueue.size).toBe(0);
  expect(markSyncFailure).not.toHaveBeenCalled();
});

it('settles checkOpenProgress on 1,500ms timeout without aborting held saveProgress', async () => {
  runtime.readingState = { ...runtime.readingState!, pendingSync: true };
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
    updatedAt: '2026-01-01T00:00:00Z',
    lastError: null,
  });

  const events: string[] = [];
  let releaseFirstSave!: () => void;
  vi.mocked(CapacitorHttp.request).mockImplementation((options) => {
    if (options.url.includes('/api/Series/v2')) {
      return Promise.resolve({
        status: 200,
        headers: {},
        data: JSON.stringify([
          {
            id: 1,
            libraryId: 1,
            format: 3,
            name: 'Saved Series',
            pages: 100,
            pagesRead: 25,
            latestReadDate: '2026-01-01T00:00:00Z',
          },
        ]),
        url: '',
      });
    }
    if (options.url.includes('/api/Series/series-detail')) {
      return Promise.resolve({
        status: 200,
        headers: {},
        data: JSON.stringify({
          chapters: [
            {
              id: 10,
              volumeId: 1,
              format: 3,
              pages: 100,
              pagesRead: 25,
              titleName: 'Saved Offline Book',
              files: [{ id: 1, format: 3, pages: 100 }],
            },
          ],
          specials: [],
          volumes: [],
          storylineChapters: [],
        }),
        url: '',
      });
    }
    if (options.url.includes('/api/Reader/progress')) {
      const data = options.data as { pageNum: number };
      events.push(`save:${data.pageNum}:start`);
      if (events.length === 1) {
        return new Promise((resolve) => {
          releaseFirstSave = () => {
            events.push(`save:${data.pageNum}:settled`);
            resolve({ status: 204, headers: {}, data: '', url: '' });
          };
        });
      }
      events.push(`save:${data.pageNum}:settled`);
      return Promise.resolve({ status: 204, headers: {}, data: '', url: '' });
    }
    return new Promise(() => {});
  });

  mountLibrary();
  await vi.waitFor(() => expect(events).toEqual(['save:25:start']));
  flushSync();

  vi.useFakeTimers();
  const continueButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((btn) =>
    btn.textContent?.includes('Continue reading'),
  );
  expect(continueButton).toBeDefined();
  continueButton?.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(
    [...container.querySelectorAll('button')].some(
      (btn) => btn.textContent?.trim() === 'Open offline',
    ),
  ).toBe(true);
  await vi.advanceTimersByTimeAsync(1_500);
  await vi.waitFor(() => expect(runtime.openedReaderProps).not.toBeNull());
  expect(runtime.readerOpenStates).toContain(true);

  const onRelocated = runtime.openedReaderProps?.onRelocated as (loc: ReaderLocation) => void;
  onRelocated({
    cfi: 'epubcfi(/6/4!/4/8:0)',
    xpath: '/body/p[8]',
    percentage: 0.6,
    href: 'chapter.xhtml',
    spineIndex: 0,
    pageIndex: 5,
    pageCount: 10,
  });
  await vi.advanceTimersByTimeAsync(2_600);
  expect(events).toEqual(['save:25:start']);

  releaseFirstSave();
  await vi.waitFor(() =>
    expect(events).toEqual([
      'save:25:start',
      'save:25:settled',
      'save:60:start',
      'save:60:settled',
    ]),
  );
});
