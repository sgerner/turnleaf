// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { flushSync, mount, unmount } from 'svelte';
import {
  getBooks,
  getPendingSync,
  reconcileBooks,
  saveLocalProgress,
  saveServer,
  type BookRecord,
  type ServerConfig,
} from '../database/database';

const networkListeners = new Set<
  (status: { connected: boolean; connectionType: string }) => void
>();
const appStateListeners = new Set<(state: { isActive: boolean }) => void>();
let networkConnected = true;

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({
      connected: networkConnected,
      connectionType: networkConnected ? 'wifi' : 'none',
    })),
    addListener: vi.fn(
      async (
        event: string,
        listener: (status: { connected: boolean; connectionType: string }) => void,
      ) => {
        if (event === 'networkStatusChange') networkListeners.add(listener);
        return {
          remove: async () => {
            networkListeners.delete(listener);
          },
        };
      },
    ),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (event: string, listener: (state: { isActive: boolean }) => void) => {
      if (event === 'appStateChange') appStateListeners.add(listener);
      return {
        remove: async () => {
          appStateListeners.delete(listener);
        },
      };
    }),
    exitApp: vi.fn(async () => {}),
  },
}));

const verifyDownloadedEpubMock = vi.fn(async (path: string) => ({
  relativePath: path,
  webViewUrl: `blob:${path}`,
}));

vi.mock('../downloads/native-download', () => ({
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class EpubTransferError extends Error {},
  cacheCover: vi.fn(async () => 'cover'),
  clearCoverCache: vi.fn(async () => {}),
  cleanupInterruptedEpubDownloads: vi.fn(async () => {}),
  deleteDownloadedEpub: vi.fn(async () => {}),
  downloadEpub: vi.fn(async () => ({ relativePath: 'books/book-1.epub', size: 1024 })),
  verifyDownloadedEpub: (path: string) => verifyDownloadedEpubMock(path),
}));

vi.mock('../native/credentials', () => ({
  saveApiKey: vi.fn(async () => {}),
  removeApiKey: vi.fn(async () => {}),
}));

vi.mock('../themes/themes', () => ({
  skeletonThemes: ['fennec', 'vintage'],
  loadTheme: vi.fn(async () => true),
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
  id: 'server-1',
  displayName: 'Kavita',
  baseUrl: 'https://kavita.example',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.0',
  lastConnectedAt: '2026-09-01T00:00:00.000Z',
};

const seededBook: BookRecord = {
  id: 'server-1:1:10',
  serverId: server.id,
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 10,
  title: 'The Left Hand of Darkness',
  author: 'Ursula K. Le Guin',
  series: 'Hainish Cycle',
  descriptionHtml: null,
  format: 'epub',
  pages: 100,
  pagesRead: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  lastReadAt: null,
  downloadPath: 'books/book-1.epub',
  downloadStatus: 'available',
  fileSize: 2048,
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function seriesListItem(pagesRead = 0) {
  return {
    id: 1,
    libraryId: 1,
    name: seededBook.title,
    format: 3,
    pages: 100,
    pagesRead,
  };
}

function seriesDetailPayload(pagesRead = 0) {
  return {
    volumes: [
      {
        id: 1,
        chapters: [
          {
            id: 10,
            volumeId: 1,
            title: seededBook.title,
            titleName: seededBook.title,
            pages: 100,
            pagesRead,
            format: 3,
            files: [{ id: 1, format: 3, extension: '.epub', bytes: 2048 }],
          },
        ],
      },
    ],
  };
}

async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await check()).toBe(true);
}

const mountedInstances: Array<Record<string, unknown>> = [];
const containers: HTMLElement[] = [];

async function mountLibrary(
  options: {
    apiKey?: string;
    onApiKeyChange?: (next: string) => void;
  } = {},
) {
  const Library = (await import('./Library.svelte')).default;
  const target = document.createElement('div');
  target.className = 'app-stage';
  document.body.appendChild(target);
  containers.push(target);
  const instance = mount(Library, {
    target,
    props: {
      server,
      apiKey: options.apiKey ?? 'initial-key',
      theme: 'fennec',
      mode: 'dark',
      onThemeChange: vi.fn(),
      onModeChange: vi.fn(),
      onApiKeyChange: options.onApiKeyChange ?? vi.fn(),
      onServerDeleted: vi.fn(),
      onChangeServerAddress: vi.fn(),
    },
  });
  mountedInstances.push(instance);
  return { target, instance };
}

beforeEach(async () => {
  networkConnected = true;
  networkListeners.clear();
  appStateListeners.clear();
  verifyDownloadedEpubMock.mockClear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  if (!Element.prototype.animate) {
    Element.prototype.animate = () =>
      ({
        cancel: () => {},
        finish: () => {},
        onfinish: null,
        finished: Promise.resolve(),
      }) as unknown as Animation;
  }
  await saveServer(server);
  await reconcileBooks(server.id, [seededBook]);
});

afterEach(async () => {
  for (const instance of mountedInstances.splice(0)) {
    await unmount(instance);
  }
  for (const container of containers.splice(0)) {
    container.remove();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Library concurrent progress uploads and catalog refreshes', () => {
  it('starts saveProgress on online mount without awaiting catalog pagination and retains local progress', async () => {
    await saveLocalProgress(seededBook, 'epubcfi(/6/4!/4/2)', '//body/p[4]', 0.4);

    const requestOrder: string[] = [];
    const releaseDetail = deferred<void>();
    const progressUploaded = deferred<void>();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/Reader/progress' || url.pathname.startsWith('/api/Series/')) {
        requestOrder.push(url.pathname);
      }
      if (url.pathname === '/api/Reader/progress') {
        progressUploaded.resolve();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/api/Series/v2') {
        return jsonResponse([seriesListItem(0)]);
      }
      if (url.pathname === '/api/Series/series-detail') {
        await releaseDetail.promise;
        return jsonResponse(seriesDetailPayload(0));
      }
      if (url.pathname === '/api/Image/series-cover') {
        return new Response(new Blob(['cover']), { status: 200 });
      }
      return jsonResponse({});
    });

    await mountLibrary();
    await waitForCondition(() => requestOrder.includes('/api/Series/series-detail'));
    await progressUploaded.promise;
    await waitForCondition(async () => (await getPendingSync(server.id)).length === 0);

    expect(requestOrder).toContain('/api/Reader/progress');
    expect(await getPendingSync(server.id)).toEqual([]);

    releaseDetail.resolve();
    await waitForCondition(() => requestOrder.includes('/api/Series/series-detail'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const booksAfterReconcile = await getBooks(server.id);
    expect(booksAfterReconcile[0]?.pagesRead).toBe(40);
  });

  it('uploads completed items during a brief reconnect window and cancels in-flight catalog and progress work on disconnect', async () => {
    networkConnected = false;
    await saveLocalProgress(seededBook, 'epubcfi(/6/4!/4/8)', '//body/p[8]', 0.55, 2);

    const secondBook: BookRecord = {
      ...seededBook,
      id: 'server-1:1:11',
      chapterId: 11,
      title: 'The Dispossessed',
    };
    await reconcileBooks(server.id, [seededBook, secondBook]);
    await saveLocalProgress(secondBook, 'epubcfi(/6/6!/4/2)', '//body/p[2]', 0.3, 1);

    const catalogSignals: AbortSignal[] = [];
    const progressSignals: Array<AbortSignal | undefined> = [];
    const secondUploadGate = deferred<void>();
    const secondUploadStarted = deferred<void>();
    let uploadCalls = 0;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/Reader/progress') {
        uploadCalls += 1;
        progressSignals.push(init?.signal ?? undefined);
        if (uploadCalls === 2) {
          secondUploadStarted.resolve();
          await secondUploadGate.promise;
          if (init?.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/api/Series/v2') {
        if (init?.signal) catalogSignals.push(init.signal);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      if (url.pathname === '/api/Image/series-cover') {
        return new Response(new Blob(['cover']), { status: 200 });
      }
      return jsonResponse({});
    });

    const { target } = await mountLibrary();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSpy).not.toHaveBeenCalled();

    // Brief reconnection window begins
    networkConnected = true;
    for (const listener of networkListeners) {
      listener({ connected: true, connectionType: 'cellular' });
    }

    await secondUploadStarted.promise;
    await waitForCondition(() => catalogSignals.length === 1);
    expect(uploadCalls).toBe(2);

    // Network drops mid-refresh and mid-upload: both catalog refresh and in-flight upload abort
    networkConnected = false;
    for (const listener of networkListeners) {
      listener({ connected: false, connectionType: 'none' });
    }

    expect(catalogSignals[0]?.aborted).toBe(true);
    expect(progressSignals[1]?.aborted).toBe(true);

    secondUploadGate.resolve();
    await waitForCondition(() =>
      Boolean(target.textContent?.includes('1 reading progress update waiting to sync.')),
    );
    expect(target.textContent).not.toContain('failed and remain queued');
    const remaining = await getPendingSync(server.id);
    expect(remaining.map((item) => item.bookId)).toEqual([secondBook.id]);

    // Confirmed reconnect uploads the preserved item
    networkConnected = true;
    for (const listener of networkListeners) {
      listener({ connected: true, connectionType: 'wifi' });
    }
    await waitForCondition(async () => (await getPendingSync(server.id)).length === 0);
    expect(uploadCalls).toBe(3);
  });

  it('awaits active syncWork in updateApiKey before switching keys, then runs syncProgress and refresh concurrently while preserving notice', async () => {
    await saveLocalProgress(seededBook, 'epubcfi(/6/4!/4/6)', '//body/p[6]', 0.6, 1);

    const oldUploadStarted = deferred<void>();
    const finishOldUpload = deferred<Response>();
    const stalledNewKeyCatalogDetail = deferred<void>();
    const newKeyUploadCompleted = deferred<void>();
    const observedCalls: Array<{ path: string; apiKey: string | null }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const key = headers.get('x-api-key');
      observedCalls.push({ path: url.pathname, apiKey: key });

      if (url.pathname === '/api/Reader/progress') {
        if (key === 'expired-key') {
          oldUploadStarted.resolve();
          return finishOldUpload.promise;
        }
        if (key === 'valid-replacement-key') {
          newKeyUploadCompleted.resolve();
          return new Response(null, { status: 204 });
        }
      }
      if (url.pathname === '/api/Library/libraries') {
        return jsonResponse([{ id: 1, name: 'Books', type: 2 }]);
      }
      if (url.pathname === '/api/Health') {
        return jsonResponse({ version: '0.8.4' });
      }
      if (url.pathname === '/api/Series/v2') {
        if (key === 'expired-key') {
          return jsonResponse([], 401);
        }
        return jsonResponse([seriesListItem(60)]);
      }
      if (url.pathname === '/api/Series/series-detail') {
        await stalledNewKeyCatalogDetail.promise;
        return jsonResponse(seriesDetailPayload(60));
      }
      if (url.pathname === '/api/Image/series-cover') {
        return new Response(new Blob(['cover']), { status: 200 });
      }
      return jsonResponse({});
    });

    const onApiKeyChange = vi.fn();
    const { target } = await mountLibrary({
      apiKey: 'expired-key',
      onApiKeyChange,
    });

    await oldUploadStarted.promise;

    // Open settings and submit replacement key while old upload is still in flight
    const settingsButton = target.querySelector<HTMLButtonElement>('[aria-label="Open settings"]');
    expect(settingsButton).not.toBeNull();
    settingsButton!.click();
    flushSync();

    const keyInput = target.querySelector<HTMLInputElement>('#replacement-api-key');
    expect(keyInput).not.toBeNull();
    keyInput!.value = 'valid-replacement-key';
    keyInput!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    const form = keyInput!.closest('form');
    expect(form).not.toBeNull();
    form!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

    await waitForCondition(() =>
      observedCalls.some(
        (call) => call.path === '/api/Library/libraries' && call.apiKey === 'valid-replacement-key',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Neither new-key upload nor new-key catalog refresh may start before old syncWork settles
    expect(onApiKeyChange).not.toHaveBeenCalled();
    expect(
      observedCalls.some(
        (call) => call.path === '/api/Reader/progress' && call.apiKey === 'valid-replacement-key',
      ),
    ).toBe(false);

    // Finish old upload with 401 auth rejection
    finishOldUpload.resolve(jsonResponse({}, 401));

    // New key takes effect and uploads progress immediately while catalog detail is still stalled
    await newKeyUploadCompleted.promise;
    await waitForCondition(async () => (await getPendingSync(server.id)).length === 0);

    expect(onApiKeyChange).toHaveBeenCalledWith('valid-replacement-key');
    expect(target.textContent).toContain('API key updated.');

    stalledNewKeyCatalogDetail.resolve();
    await waitForCondition(() =>
      observedCalls.some(
        (call) =>
          call.path === '/api/Series/series-detail' && call.apiKey === 'valid-replacement-key',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Catalog refresh preserved the newer 'API key updated.' status notice
    expect(target.textContent).toContain('API key updated.');
  });

  it('preserves authentication failure notices from runProgressSync when refreshCatalog runs concurrently or after abort', async () => {
    networkConnected = false;
    await saveLocalProgress(seededBook, 'epubcfi(/6/4!/4/2)', '//body/p[2]', 0.25, 1);

    let seriesAttempt = 0;
    const releaseAbortedCleanup = deferred<void>();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/Reader/progress') {
        return jsonResponse({}, 401);
      }
      if (url.pathname === '/api/Series/v2') {
        seriesAttempt += 1;
        if (seriesAttempt === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                void releaseAbortedCleanup.promise.then(() =>
                  reject(new DOMException('Aborted', 'AbortError')),
                );
              },
              { once: true },
            );
          });
        }
        return jsonResponse([seriesListItem(0)]);
      }
      if (url.pathname === '/api/Series/series-detail') {
        return jsonResponse(seriesDetailPayload(0));
      }
      if (url.pathname === '/api/Image/series-cover') {
        return new Response(new Blob(['cover']), { status: 200 });
      }
      return jsonResponse({});
    });

    const { target } = await mountLibrary({ apiKey: 'revoked-key' });
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Connect, then disconnect while first catalog refresh is still unwinding
    networkConnected = true;
    for (const listener of networkListeners) {
      listener({ connected: true, connectionType: 'wifi' });
    }
    await waitForCondition(() => seriesAttempt === 1);

    networkConnected = false;
    for (const listener of networkListeners) {
      listener({ connected: false, connectionType: 'none' });
    }

    // Reconnect immediately: syncProgress fails with 401 before the second refreshCatalog begins
    networkConnected = true;
    for (const listener of networkListeners) {
      listener({ connected: true, connectionType: 'wifi' });
    }
    await waitForCondition(() =>
      Boolean(
        target.textContent?.includes(
          'Kavita rejected the saved auth key. Update it in Settings to sync reading progress.',
        ),
      ),
    );

    // Let the aborted refresh finish unwinding so the queued second refreshCatalog starts and completes
    releaseAbortedCleanup.resolve();
    await waitForCondition(() => seriesAttempt === 2);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(target.textContent).toContain(
      'Kavita rejected the saved auth key. Update it in Settings to sync reading progress.',
    );
  });

  it('pauses automatic progress uploads while opening a book or resolving a reading conflict', async () => {
    let progressSaveCount = 0;
    const verifyGate = deferred<{ relativePath: string; webViewUrl: string }>();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/Reader/progress') {
        progressSaveCount += 1;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/api/Reader/get-progress') {
        return jsonResponse({
          libraryId: 1,
          seriesId: 1,
          volumeId: 1,
          chapterId: 10,
          pageNum: 75,
          bookScrollId: '//body/p[75]',
          lastModifiedUtc: '2026-09-08T00:00:00.000Z',
        });
      }
      if (url.pathname === '/api/Series/v2') {
        return jsonResponse([seriesListItem(0)]);
      }
      if (url.pathname === '/api/Series/series-detail') {
        return jsonResponse(seriesDetailPayload(0));
      }
      if (url.pathname === '/api/Image/series-cover') {
        return new Response(new Blob(['cover']), { status: 200 });
      }
      return jsonResponse({});
    });

    const { target } = await mountLibrary();
    await waitForCondition(() => Boolean(target.querySelector('[data-book-open]')));

    // Queue a new local relocation while online right before opening the book
    await saveLocalProgress(seededBook, 'epubcfi(/6/4!/4/2)', '//body/p[2]', 0.25, 1);
    verifyDownloadedEpubMock.mockImplementationOnce(() => verifyGate.promise);

    // Start opening the book while online (resolvingOpenProgress = true while verifyGate is pending)
    const openButton = target.querySelector<HTMLButtonElement>('[data-book-open]');
    expect(openButton).not.toBeNull();
    openButton!.click();
    flushSync();

    // Trigger background & reconnect events while resolvingOpenProgress is active
    for (const listener of appStateListeners) listener({ isActive: false });
    for (const listener of networkListeners) listener({ connected: true, connectionType: 'wifi' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(progressSaveCount).toBe(0);

    // Complete verification -> conflict modal opens because pending local (//body/p[2]) and remote (//body/p[75]) diverged
    verifyGate.resolve({ relativePath: 'books/book-1.epub', webViewUrl: 'blob:book-1' });
    await waitForCondition(() => Boolean(target.textContent?.includes('Continue from Kavita')));

    // Trigger background & reconnect events while conflict modal is open
    for (const listener of appStateListeners) listener({ isActive: false });
    for (const listener of networkListeners) listener({ connected: true, connectionType: 'wifi' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(progressSaveCount).toBe(0);
  });

  it('invalidates in-flight catalog and progress requests on disconnect and blocks new requests until a confirmed reconnect', async () => {
    await saveLocalProgress(seededBook, 'epubcfi(/6/4!/4/10)', '//body/p[10]', 0.5, 2);

    const catalogStarted = deferred<void>();
    const progressStarted = deferred<void>();
    const releaseCatalog = deferred<Response>();
    const observedPaths: string[] = [];
    let holdCatalog = true;
    let holdProgress = true;
    let catalogSignal: AbortSignal | undefined;
    let progressSignal: AbortSignal | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      observedPaths.push(url.pathname);
      if (url.pathname === '/api/Series/v2') {
        catalogSignal = init?.signal ?? undefined;
        if (holdCatalog) {
          holdCatalog = false;
          catalogStarted.resolve();
          return releaseCatalog.promise;
        }
        return jsonResponse([seriesListItem(50)]);
      }
      if (url.pathname === '/api/Series/series-detail') {
        return jsonResponse(seriesDetailPayload(50));
      }
      if (url.pathname === '/api/Reader/progress') {
        progressSignal = init?.signal ?? undefined;
        if (holdProgress) {
          holdProgress = false;
          progressStarted.resolve();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/api/Image/series-cover') {
        return new Response(new Blob(['cover']), { status: 200 });
      }
      return jsonResponse({});
    });

    const { target } = await mountLibrary();
    await Promise.all([catalogStarted.promise, progressStarted.promise]);

    // Disconnect while both /api/Series/v2 and /api/Reader/progress are in flight
    networkConnected = false;
    for (const listener of networkListeners) {
      listener({ connected: false, connectionType: 'none' });
    }

    expect(catalogSignal?.aborted).toBe(true);
    expect(progressSignal?.aborted).toBe(true);

    // Even if the pre-disconnect /api/Series/v2 response resolves at the boundary,
    // Library must discard it and never request /api/Series/series-detail while offline
    releaseCatalog.resolve(jsonResponse([seriesListItem(50)]));
    await waitForCondition(() =>
      Boolean(target.textContent?.includes('1 reading progress update waiting to sync.')),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    const countAfterDisconnect = observedPaths.length;
    expect(observedPaths).not.toContain('/api/Series/series-detail');
    expect(target.textContent).toContain('No network connection. Showing your saved library.');
    expect(target.textContent).not.toContain('failed and remain queued');
    expect(await getPendingSync(server.id)).toHaveLength(1);

    // App backgrounding and unconfirmed reconnect events must not start any authenticated requests
    for (const listener of appStateListeners) {
      listener({ isActive: false });
    }
    for (const listener of networkListeners) {
      // Spurious online event while Network.getStatus() still reports disconnected
      listener({ connected: true, connectionType: 'cellular' });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(observedPaths).toHaveLength(countAfterDisconnect);
    expect(target.textContent).toContain('No network connection. Showing your saved library.');
    expect(await getPendingSync(server.id)).toHaveLength(1);

    // Confirmed reconnect flushes preserved progress and refreshes catalog
    networkConnected = true;
    for (const listener of networkListeners) {
      listener({ connected: true, connectionType: 'wifi' });
    }
    await waitForCondition(async () => (await getPendingSync(server.id)).length === 0);
    await waitForCondition(() => observedPaths.includes('/api/Series/series-detail'));
    await waitForCondition(
      () =>
        !target.querySelector('p[role="status"]')?.textContent?.includes('No network connection.'),
    );
    expect(target.querySelector('p[role="status"]')?.textContent).not.toContain(
      'No network connection.',
    );
  });

  it('ignores transient native cellular fallback flaps before NATIVE_RECONNECT_SETTLE_MS elapses', async () => {
    networkConnected = false;
    await saveLocalProgress(seededBook, 'epubcfi(/6/4!/4/12)', '//body/p[12]', 0.6, 3);

    const observedPaths: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      observedPaths.push(url.pathname);
      if (url.pathname === '/api/Series/v2') {
        return jsonResponse([seriesListItem(60)]);
      }
      if (url.pathname === '/api/Series/series-detail') {
        return jsonResponse(seriesDetailPayload(60));
      }
      if (url.pathname === '/api/Reader/progress') {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/api/Image/series-cover') {
        return new Response(new Blob(['cover']), { status: 200 });
      }
      return jsonResponse({});
    });

    const { target } = await mountLibrary();
    await waitForCondition(() =>
      Boolean(target.textContent?.includes('1 reading progress update waiting to sync.')),
    );
    expect(observedPaths).toEqual([]);

    const nativeSpy = vi.spyOn(Capacitor, 'isNativePlatform');

    // Transient dying-cellular promotion briefly reports connected: true, then drops within 250ms
    nativeSpy.mockReturnValueOnce(true);
    networkConnected = true;
    for (const listener of networkListeners) {
      listener({ connected: true, connectionType: 'cellular' });
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    networkConnected = false;
    for (const listener of networkListeners) {
      listener({ connected: false, connectionType: 'none' });
    }
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(observedPaths).toEqual([]);
    expect(await getPendingSync(server.id)).toHaveLength(1);
    expect(target.querySelector('p[role="status"]')?.textContent).toContain(
      'No network connection.',
    );

    // Sustained reconnect waits out NATIVE_RECONNECT_SETTLE_MS before starting requests
    nativeSpy.mockReturnValueOnce(true);
    networkConnected = true;
    for (const listener of networkListeners) {
      listener({ connected: true, connectionType: 'wifi' });
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(observedPaths).toEqual([]);

    await waitForCondition(async () => (await getPendingSync(server.id)).length === 0, 3_000);
    await waitForCondition(() => observedPaths.includes('/api/Series/series-detail'), 3_000);
    expect(observedPaths).toContain('/api/Reader/progress');
  });
});
