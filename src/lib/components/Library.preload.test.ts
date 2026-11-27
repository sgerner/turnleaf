// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookRecord, ServerConfig } from '../database/database';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const hooks = vi.hoisted(() => ({
  nativeDownloadLoads: 0,
  readerLoads: 0,
  readerGate: null as Promise<void> | null,
  verifyGate: null as Promise<{ webViewUrl: string; size: number }> | null,
  progressGate: null as Promise<null> | null,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => 'web',
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: true, connectionType: 'wifi' })),
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
    exitApp: vi.fn(async () => undefined),
  },
}));

const server: ServerConfig = {
  id: 'server-1',
  displayName: 'Local Kavita',
  baseUrl: 'https://kavita.example.com',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.0',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const downloadedBook: BookRecord = {
  id: 'server-1:1:10',
  serverId: server.id,
  libraryId: 1,
  seriesId: 1,
  volumeId: 10,
  chapterId: 10,
  title: 'The Left Hand of Darkness',
  author: 'Ursula K. Le Guin',
  series: 'Hainish Cycle',
  descriptionHtml: null,
  format: 'epub',
  pages: 300,
  pagesRead: 30,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-01-02T00:00:00.000Z',
  downloadPath: 'books/server-1/10.epub',
  downloadStatus: 'downloaded',
  fileSize: 2048,
};

describe('Library parallel reader preload', () => {
  let target: HTMLDivElement;
  let cleanupMount: (() => Promise<void>) | null = null;
  let originalAnimate: typeof Element.prototype.animate | undefined;

  beforeEach(async () => {
    vi.resetModules();
    hooks.nativeDownloadLoads = 0;
    hooks.readerLoads = 0;
    hooks.readerGate = null;
    hooks.verifyGate = null;
    hooks.progressGate = null;
    window.localStorage.clear();

    originalAnimate = Element.prototype.animate;
    Element.prototype.animate = (() => {
      const animation = {
        onfinish: null as (() => void) | null,
        cancel() {},
        finish() {
          animation.onfinish?.();
        },
      };
      queueMicrotask(() => animation.onfinish?.());
      return animation as unknown as Animation;
    }) as typeof Element.prototype.animate;

    vi.doMock('../kavita/client', () => ({
      KavitaError: class KavitaError extends Error {
        kind = 'network';
        status?: number;
      },
      KavitaClient: class MockKavitaClient {
        coverUrl = (seriesId: number) => `https://kavita.example.com/cover/${seriesId}`;
        getCover = async () => new Blob(['cover']);
        getBookLibraries = async () => [{ id: 1, name: 'Books', type: 2 }];
        getAllSeriesForLibrary = async () => [
          {
            id: 1,
            libraryId: 1,
            name: downloadedBook.title,
            format: 3,
            pages: downloadedBook.pages,
            pagesRead: downloadedBook.pagesRead,
            created: downloadedBook.createdAt,
            latestReadDate: downloadedBook.lastReadAt,
          },
        ];
        getSeriesDetail = async () => ({
          volumes: [
            {
              id: 10,
              number: 1,
              name: '1',
              pages: downloadedBook.pages,
              pagesRead: downloadedBook.pagesRead,
              chapters: [
                {
                  id: 10,
                  range: '1',
                  titleName: downloadedBook.title,
                  pages: downloadedBook.pages,
                  pagesRead: downloadedBook.pagesRead,
                  files: [{ id: 100, format: 3, bytes: 2048 }],
                },
              ],
            },
          ],
          storylineChapters: [],
          chapters: [],
        });
        getSeriesMetadata = async () => ({
          summary: '',
          writers: [{ name: downloadedBook.author }],
        });
        getProgress = async () =>
          hooks.progressGate ?? {
            libraryId: 1,
            seriesId: 1,
            volumeId: 10,
            chapterId: 10,
            pageNum: 30,
            bookScrollId: null,
          };
      },
    }));

    vi.doMock('../downloads/native-download', () => {
      hooks.nativeDownloadLoads += 1;
      return {
        EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
        EpubValidationError: class EpubValidationError extends Error {},
        verifyDownloadedEpub: vi.fn(
          async () => hooks.verifyGate ?? { webViewUrl: 'blob:test-book', size: 1024 },
        ),
        cleanupInterruptedEpubDownloads: vi.fn(async () => undefined),
        clearCoverCache: vi.fn(async () => undefined),
        cacheCover: vi.fn(async () => 'blob:test-cover'),
        downloadEpubToDevice: vi.fn(async () => ({ path: 'books/10.epub', size: 1024 })),
        removeDownloadedEpub: vi.fn(async () => undefined),
      };
    });

    vi.doMock('./Reader.svelte', async () => {
      hooks.readerLoads += 1;
      await hooks.readerGate;
      return {
        default: function MockReader(anchor: Comment) {
          const marker = document.createElement('div');
          marker.setAttribute('data-testid', 'mock-reader');
          marker.textContent = 'Mock Reader Ready';
          anchor.before(marker);
          return {};
        },
      };
    });

    vi.stubGlobal('scrollBy', () => {});
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    const database = await import('../database/database');
    await database.saveServer(server);
    await database.reconcileBooks(server.id, [downloadedBook]);
    await database.markDownloaded(
      downloadedBook.id,
      downloadedBook.downloadPath!,
      downloadedBook.fileSize!,
    );

    target = document.createElement('div');
    document.body.append(target);
  });

  afterEach(async () => {
    if (cleanupMount) {
      await cleanupMount();
      cleanupMount = null;
    }
    if (originalAnimate) {
      Element.prototype.animate = originalAnimate;
    } else {
      Reflect.deleteProperty(Element.prototype, 'animate');
    }
    target.remove();
    vi.unstubAllGlobals();
  });

  async function mountLibrary() {
    const svelte = await import('svelte');
    const { default: Library } = await import('./Library.svelte');
    const instance = svelte.mount(Library, {
      target,
      props: {
        server,
        apiKey: 'test-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: () => {},
        onModeChange: () => {},
        onApiKeyChange: () => {},
        onServerDeleted: () => {},
        onChangeServerAddress: () => {},
      },
    });
    cleanupMount = () => svelte.unmount(instance);
    return async function flushAsync(turns = 10): Promise<void> {
      for (let i = 0; i < turns; i += 1) {
        await Promise.resolve();
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (let i = 0; i < turns; i += 1) {
        await Promise.resolve();
      }
      svelte.flushSync();
    };
  }

  it('starts Reader.svelte import before file verification and progress checks finish, without re-importing on render', async () => {
    const verifyDeferred = deferred<{ webViewUrl: string; size: number }>();
    const progressDeferred = deferred<null>();
    hooks.verifyGate = verifyDeferred.promise;
    hooks.progressGate = progressDeferred.promise;

    const flushAsync = await mountLibrary();
    await flushAsync(12);

    expect(hooks.nativeDownloadLoads).toBe(0);
    expect(hooks.readerLoads).toBe(0);

    const openButton = target.querySelector<HTMLButtonElement>('[data-book-open]');
    expect(openButton).not.toBeNull();
    openButton!.click();
    await flushAsync(6);

    // Reader chunk import must already be in flight while verifyDownloadedEpub and getProgress are still blocked.
    expect(hooks.readerLoads).toBe(1);
    expect(hooks.nativeDownloadLoads).toBe(1);
    expect(target.querySelector('[data-testid="mock-reader"]')).toBeNull();

    verifyDeferred.resolve({ webViewUrl: 'blob:verified-epub', size: 2048 });
    progressDeferred.resolve(null);
    await flushAsync(14);

    expect(hooks.readerLoads).toBe(1);
    expect(target.querySelector('[data-testid="mock-reader"]')).not.toBeNull();
  });

  it('resets the cached Reader.svelte promise on import failure so reopening retries the import', async () => {
    const readerDeferred = deferred<void>();
    hooks.readerGate = readerDeferred.promise;

    const flushAsync = await mountLibrary();
    await flushAsync(12);

    const openButton = target.querySelector<HTMLButtonElement>('[data-book-open]');
    expect(openButton).not.toBeNull();
    openButton!.click();
    await flushAsync(12);

    expect(hooks.readerLoads).toBe(1);
    expect(target.textContent).toContain('Opening reader…');

    readerDeferred.reject(new Error('simulated reader chunk load failure'));
    hooks.readerGate = null;
    await flushAsync(12);

    expect(hooks.readerLoads).toBe(1);
    expect(target.textContent).toContain('Turnleaf could not load the reader.');

    const backButton = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Back to library'),
    );
    expect(backButton).toBeDefined();
    backButton!.click();
    await flushAsync(12);

    const retryOpenButton = target.querySelector<HTMLButtonElement>('[data-book-open]');
    expect(retryOpenButton).not.toBeNull();
    retryOpenButton!.click();
    await flushAsync(16);

    expect(hooks.readerLoads).toBe(2);
    expect(target.querySelector('[data-testid="mock-reader"]')).not.toBeNull();
  });
});
