// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BookRecord, ServerConfig } from '../database/database';
import type { ReaderLocation } from '../reader/session';

const STORAGE_KEY = 'turnleaf_browser_database_v1';

const mocks = vi.hoisted(() => {
  let connected = true;
  const networkListeners = new Set<(status: { connected: boolean }) => void>();
  const readerState: {
    onBack: (() => void) | null;
    onRelocated: ((location: ReaderLocation) => void) | null;
  } = {
    onBack: null,
    onRelocated: null,
  };

  return {
    get connected() {
      return connected;
    },
    setConnected(next: boolean, notify = false) {
      connected = next;
      if (notify) {
        for (const listener of networkListeners) listener({ connected: next });
      }
    },
    networkListeners,
    readerState,
    verifyDownloadedEpub: vi.fn(async (path: string) => ({
      relativePath: path,
      webViewUrl: `blob:${path}`,
    })),
    reset() {
      connected = true;
      networkListeners.clear();
      readerState.onBack = null;
      readerState.onRelocated = null;
      this.verifyDownloadedEpub.mockReset();
      this.verifyDownloadedEpub.mockImplementation(async (path: string) => ({
        relativePath: path,
        webViewUrl: `blob:${path}`,
      }));
    },
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => 'web',
    convertFileSrc: (value: string) => value,
  },
  CapacitorHttp: {
    get: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: mocks.connected, connectionType: 'wifi' })),
    addListener: vi.fn(
      async (_event: string, callback: (status: { connected: boolean }) => void) => {
        mocks.networkListeners.add(callback);
        return {
          remove: async () => {
            mocks.networkListeners.delete(callback);
          },
        };
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

vi.mock('../downloads/native-download', () => ({
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class extends Error {
    constructor(
      message: string,
      readonly status?: number,
      readonly connectionFailed = false,
    ) {
      super(message);
    }
  },
  cacheCover: vi.fn(),
  clearCoverCache: vi.fn(async () => {}),
  cleanupInterruptedEpubDownloads: vi.fn(async () => {}),
  deleteDownloadedEpub: vi.fn(async () => {}),
  downloadEpub: vi.fn(),
  verifyDownloadedEpub: (path: string) => mocks.verifyDownloadedEpub(path),
}));

vi.mock('./Reader.svelte', () => ({
  default: (
    _anchor: unknown,
    props: { onBack: () => void; onRelocated: (l: ReaderLocation) => void },
  ) => {
    mocks.readerState.onBack = props.onBack;
    mocks.readerState.onRelocated = props.onRelocated;
    return {};
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
  id: 'primary',
  displayName: 'Books',
  baseUrl: 'https://kavita.example',
  credentialRef: 'server_primary_api_key',
  kavitaVersion: '0.8.0',
  lastConnectedAt: '2026-09-07T00:00:00.000Z',
};

const bookOne: BookRecord = {
  id: 'primary:1:10',
  serverId: 'primary',
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 10,
  title: 'First Book',
  author: 'Author One',
  series: null,
  descriptionHtml: null,
  format: 'epub',
  pages: 100,
  pagesRead: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: null,
  downloadPath: 'books/primary-1-10.epub',
  downloadStatus: 'available',
  fileSize: 1024,
};

const bookTwo: BookRecord = {
  ...bookOne,
  id: 'primary:2:20',
  seriesId: 2,
  volumeId: 2,
  chapterId: 20,
  title: 'Second Book',
  author: 'Author Two',
  downloadPath: 'books/primary-2-20.epub',
};

type MockResponse = {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  json?: () => Promise<unknown>;
  blob?: () => Promise<Blob>;
};

let container: HTMLDivElement;
let instance: Record<string, unknown> | null = null;

async function settle(cycles = 100): Promise<void> {
  const total = Math.max(100, cycles);
  for (let index = 0; index < total; index += 1) {
    flushSync();
    await Promise.resolve();
  }
  flushSync();
}

function seedLocalState(overrides: Record<string, unknown> = {}): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      serverConfig: server,
      books: [bookOne, bookTwo],
      readingState: {},
      syncQueue: {},
      preferences: { syncFurthest: 'false' },
      ...overrides,
    }),
  );
}

beforeEach(async () => {
  await import('./Reader.svelte');
  await import('./Library.svelte');
  mocks.reset();
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: vi.fn(() => {
      const animation = {
        cancel: vi.fn(),
        finish: vi.fn(),
        onfinish: null as (() => void) | null,
      };
      queueMicrotask(() => animation.onfinish?.());
      return animation;
    }),
  });
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:cover'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: 900,
  });
  Object.defineProperty(window, 'scrollBy', {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  if (instance) {
    unmount(instance);
    instance = null;
  }
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function mountLibrary() {
  const { default: Library } = await import('./Library.svelte');
  instance = mount(Library, {
    target: container,
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
  await settle(10);
}

it('updates syncStatus.pendingCount on save and displays the retry banner while queued', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  mocks.setConnected(false);
  seedLocalState();
  vi.stubGlobal('fetch', vi.fn() as unknown as typeof fetch);

  await mountLibrary();

  const openButtons = container.querySelectorAll<HTMLButtonElement>('[data-book-open]');
  expect(openButtons.length).toBeGreaterThanOrEqual(2);
  openButtons[0]!.click();
  await settle(10);

  expect(mocks.readerState.onRelocated).toBeTypeOf('function');
  mocks.readerState.onRelocated!({
    cfi: 'epubcfi(/6/2!/4/2)',
    xpath: '//body/p[2]',
    href: 'chapter1.xhtml',
    percentage: 0.25,
    spineIndex: 2,
    pageIndex: 0,
    pageCount: 4,
  });
  await settle(10);

  mocks.readerState.onBack!();
  await settle(10);

  expect(container.textContent).toContain('1 reading progress update waiting to sync.');
  expect(container.textContent).toContain('Retry sync');
});

it('replays a deferred syncTimer flush after resolvingOpenProgress finishes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  mocks.setConnected(true);
  seedLocalState();

  let resolveSecondProbe!: (response: unknown) => void;
  const uploadedChapters: number[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/Series/v2')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [
          {
            id: 1,
            name: 'First Book',
            libraryId: 1,
            format: 3,
            pages: 100,
            pagesRead: 10,
            created: '2026-01-01T00:00:00.000Z',
            latestReadDate: '0001-01-01T00:00:00',
          },
          {
            id: 2,
            name: 'Second Book',
            libraryId: 1,
            format: 3,
            pages: 100,
            pagesRead: 0,
            created: '2026-01-01T00:00:00.000Z',
            latestReadDate: '0001-01-01T00:00:00',
          },
        ],
      };
    }
    if (url.includes('/api/Series/series-detail?seriesId=1')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          chapters: [
            {
              id: 10,
              title: 'First Book',
              titleName: 'First Book',
              volumeId: 1,
              pages: 100,
              pagesRead: 10,
              summary: '',
              format: 3,
              files: [{ id: 10, bytes: 1024, extension: '.epub', format: 3 }],
              writers: [{ name: 'Author One' }],
            },
          ],
          specials: [],
          volumes: [],
          storylineChapters: [],
        }),
      };
    }
    if (url.includes('/api/Series/series-detail?seriesId=2')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          chapters: [
            {
              id: 20,
              title: 'Second Book',
              titleName: 'Second Book',
              volumeId: 2,
              pages: 100,
              pagesRead: 0,
              summary: '',
              format: 3,
              files: [{ id: 20, bytes: 1024, extension: '.epub', format: 3 }],
              writers: [{ name: 'Author Two' }],
            },
          ],
          specials: [],
          volumes: [],
          storylineChapters: [],
        }),
      };
    }
    if (url.includes('/api/Image/series-cover')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        blob: async () => new Blob(),
      };
    }
    if (url.includes('/api/Reader/get-progress?chapterId=10')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          libraryId: 1,
          seriesId: 1,
          volumeId: 1,
          chapterId: 10,
          pageNum: 10,
          bookScrollId: null,
        }),
      };
    }
    if (url.includes('/api/Reader/get-progress?chapterId=20')) {
      return new Promise((resolve) => {
        resolveSecondProbe = resolve;
      });
    }
    if (url.includes('/api/Reader/progress')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { chapterId: number };
      uploadedChapters.push(body.chapterId);
      return {
        ok: true,
        status: 200,
        headers: { get: () => '0' },
        json: async () => undefined,
      };
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  await mountLibrary();

  // Open First Book, relocate, and return to Library before the 2.5s debounce expires.
  const openButtons = container.querySelectorAll<HTMLButtonElement>('[data-book-open]');
  openButtons[0]!.click();
  await settle(10);

  mocks.readerState.onRelocated!({
    cfi: 'epubcfi(/6/2!/4/4)',
    xpath: '//body/p[4]',
    href: 'chapter1.xhtml',
    percentage: 0.4,
    spineIndex: 4,
    pageIndex: 1,
    pageCount: 4,
  });
  await settle(10);

  mocks.readerState.onBack!();
  await settle(10);
  expect(container.textContent).toContain('1 reading progress update waiting to sync.');

  // Advance 1,800 ms first so only 700 ms remain on syncTimer (< 1,500 ms openProgressProbe timeout).
  await vi.advanceTimersByTimeAsync(1_800);

  // Open Second Book so resolvingOpenProgress is active when the 2,500 ms timer fires.
  const updatedButtons = container.querySelectorAll<HTMLButtonElement>('[data-book-open]');
  const secondButton = [...updatedButtons].find((btn) =>
    btn.getAttribute('aria-label')?.includes('Second Book'),
  );
  secondButton!.click();
  await settle(6);

  expect(container.textContent).toContain('Opening downloaded book');
  await vi.advanceTimersByTimeAsync(700);
  await settle(6);
  expect(uploadedChapters).toEqual([]);

  // Finish the probe for Second Book; deferred flush should immediately replay First Book's progress.
  resolveSecondProbe({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      libraryId: 1,
      seriesId: 2,
      volumeId: 2,
      chapterId: 20,
      pageNum: 0,
      bookScrollId: null,
    }),
  });
  await settle(15);

  expect(uploadedChapters).toEqual([10]);
});

it('defers syncTimer during a conflict dialog and replays after cancelling the dialog', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  mocks.setConnected(true);
  seedLocalState({
    readingState: {
      [bookTwo.id]: {
        cfi: 'epubcfi(/6/2!/4/2)',
        xpath: '//body/p[2]',
        percentage: 0.2,
        localUpdatedAt: '2026-09-07T00:00:00.000Z',
        syncedLocalUpdatedAt: null,
        serverUpdatedAt: null,
        pendingSync: true,
        syncRevision: 1,
      },
    },
    syncQueue: {
      [bookTwo.id]: {
        bookId: bookTwo.id,
        serverId: 'primary',
        payloadJson: JSON.stringify({
          libraryId: 1,
          seriesId: 2,
          volumeId: 2,
          chapterId: 20,
          pageNum: 20,
          bookScrollId: '//body/p[2]',
        }),
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
        createdAt: '2026-09-07T00:00:00.000Z',
        updatedAt: '2026-09-07T00:00:00.000Z',
        revision: 1,
      },
    },
  });

  let rejectInitialMountUpload = true;
  const uploadedChapters: number[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<MockResponse> => {
      const url = String(input);
      if (url.includes('/api/Series/v2')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => [
            {
              id: 1,
              name: 'First Book',
              libraryId: 1,
              format: 3,
              pages: 100,
              pagesRead: 10,
              created: '2026-01-01T00:00:00.000Z',
              latestReadDate: '0001-01-01T00:00:00',
            },
            {
              id: 2,
              name: 'Second Book',
              libraryId: 1,
              format: 3,
              pages: 100,
              pagesRead: 20,
              created: '2026-01-01T00:00:00.000Z',
              latestReadDate: '0001-01-01T00:00:00',
            },
          ],
        };
      }
      if (url.includes('/api/Series/series-detail?seriesId=1')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            chapters: [
              {
                id: 10,
                title: 'First Book',
                titleName: 'First Book',
                volumeId: 1,
                pages: 100,
                pagesRead: 10,
                summary: '',
                format: 3,
                files: [{ id: 10, bytes: 1024, extension: '.epub', format: 3 }],
                writers: [{ name: 'Author One' }],
              },
            ],
            specials: [],
            volumes: [],
            storylineChapters: [],
          }),
        };
      }
      if (url.includes('/api/Series/series-detail?seriesId=2')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            chapters: [
              {
                id: 20,
                title: 'Second Book',
                titleName: 'Second Book',
                volumeId: 2,
                pages: 100,
                pagesRead: 20,
                summary: '',
                format: 3,
                files: [{ id: 20, bytes: 1024, extension: '.epub', format: 3 }],
                writers: [{ name: 'Author Two' }],
              },
            ],
            specials: [],
            volumes: [],
            storylineChapters: [],
          }),
        };
      }
      if (url.includes('/api/Image/series-cover')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          blob: async () => new Blob(),
        };
      }
      if (url.includes('/api/Reader/get-progress?chapterId=10')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            libraryId: 1,
            seriesId: 1,
            volumeId: 1,
            chapterId: 10,
            pageNum: 0,
            bookScrollId: null,
          }),
        };
      }
      if (url.includes('/api/Reader/get-progress?chapterId=20')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            libraryId: 1,
            seriesId: 2,
            volumeId: 2,
            chapterId: 20,
            pageNum: 65,
            bookScrollId: '//body/p[65]',
          }),
        };
      }
      if (url.includes('/api/Reader/progress')) {
        if (rejectInitialMountUpload) {
          rejectInitialMountUpload = false;
          return {
            ok: false,
            status: 503,
            headers: { get: () => null },
            json: async () => undefined,
          };
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { chapterId: number };
        uploadedChapters.push(body.chapterId);
        return {
          ok: true,
          status: 200,
          headers: { get: () => '0' },
          json: async () => undefined,
        };
      }
      throw new Error(`Unhandled fetch: ${url}`);
    },
  );
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  await mountLibrary();

  // Open First Book, relocate to start the 2.5s syncTimer, then close reader.
  const openButtons = container.querySelectorAll<HTMLButtonElement>('[data-book-open]');
  openButtons[0]!.click();
  await settle(10);
  mocks.readerState.onRelocated!({
    cfi: 'epubcfi(/6/2!/4/6)',
    xpath: '//body/p[6]',
    href: 'chapter1.xhtml',
    percentage: 0.3,
    spineIndex: 3,
    pageIndex: 1,
    pageCount: 4,
  });
  await settle(10);
  mocks.readerState.onBack!();
  await settle(10);

  // Open Second Book so the conflict modal opens before the 2.5s timer expires.
  const secondButton = [...container.querySelectorAll<HTMLButtonElement>('[data-book-open]')].find(
    (btn) => btn.getAttribute('aria-label')?.includes('Second Book'),
  );
  secondButton!.click();
  await settle(12);

  expect(container.textContent).toContain('Choose where to continue');
  expect(uploadedChapters).toEqual([]);

  // Fire the 2.5s syncTimer while conflict modal is open: upload must remain deferred.
  await vi.advanceTimersByTimeAsync(2_500);
  await settle(8);
  expect(uploadedChapters).toEqual([]);

  // Cancel the conflict dialog: deferred flush replays!
  const cancelBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (btn) => btn.textContent?.trim() === 'Cancel',
  );
  expect(cancelBtn).toBeDefined();
  cancelBtn!.click();
  await settle(15);

  expect(uploadedChapters).toContain(10);
  expect(uploadedChapters).toContain(20);
});

it('aborts a stalled upload on disconnect or teardown and retries pending books on reconnect', async () => {
  mocks.setConnected(true);
  seedLocalState({
    readingState: {
      [bookOne.id]: {
        cfi: 'epubcfi(/6/2!/4/2)',
        xpath: '//body/p[2]',
        percentage: 0.2,
        localUpdatedAt: '2026-09-07T05:00:00.000Z',
        syncedLocalUpdatedAt: null,
        serverUpdatedAt: null,
        pendingSync: true,
        syncRevision: 1,
      },
    },
    syncQueue: {
      [bookOne.id]: {
        bookId: bookOne.id,
        serverId: 'primary',
        payloadJson: JSON.stringify({
          libraryId: 1,
          seriesId: 1,
          volumeId: 1,
          chapterId: 10,
          pageNum: 20,
          bookScrollId: '//body/p[2]',
        }),
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
        createdAt: '2026-09-07T05:00:00.000Z',
        updatedAt: '2026-09-07T05:00:00.000Z',
        revision: 1,
      },
    },
  });

  const uploadSignals: AbortSignal[] = [];
  let stalledAttempt = true;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/Series/v2')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [
          {
            id: 1,
            name: 'First Book',
            libraryId: 1,
            format: 3,
            pages: 100,
            pagesRead: 10,
            created: '2026-01-01T00:00:00.000Z',
            latestReadDate: '0001-01-01T00:00:00',
          },
        ],
      };
    }
    if (url.includes('/api/Series/series-detail?seriesId=1')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          chapters: [
            {
              id: 10,
              title: 'First Book',
              titleName: 'First Book',
              volumeId: 1,
              pages: 100,
              pagesRead: 10,
              summary: '',
              format: 3,
              files: [{ id: 10, bytes: 1024, extension: '.epub', format: 3 }],
              writers: [{ name: 'Author One' }],
            },
          ],
          specials: [],
          volumes: [],
          storylineChapters: [],
        }),
      };
    }
    if (url.includes('/api/Image/series-cover')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        blob: async () => new Blob(),
      };
    }
    if (url.includes('/api/Reader/progress')) {
      if (init?.signal) uploadSignals.push(init.signal);
      if (stalledAttempt) {
        stalledAttempt = false;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => '0' },
        json: async () => undefined,
      };
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  await mountLibrary();
  expect(uploadSignals).toHaveLength(1);
  expect(uploadSignals[0]?.aborted).toBe(false);

  // Disconnect aborts the stalled upload without incrementing attemptCount.
  mocks.setConnected(false, true);
  await settle(10);
  expect(uploadSignals[0]?.aborted).toBe(true);

  const midState = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
    syncQueue: Record<string, { attemptCount: number; lastError: string | null }>;
  };
  expect(midState.syncQueue[bookOne.id]).toMatchObject({
    attemptCount: 0,
    lastError: null,
  });

  // Reconnect refreshes and retries all pending books.
  mocks.setConnected(true, true);
  await settle(15);

  expect(uploadSignals).toHaveLength(2);
  const finalState = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
    syncQueue: Record<string, unknown>;
    readingState: Record<string, { pendingSync: boolean }>;
  };
  expect(finalState.syncQueue[bookOne.id]).toBeUndefined();
  expect(finalState.readingState[bookOne.id]?.pendingSync).toBe(false);
});

it('aborts an active stalled upload when Library unmounts for a server address change', async () => {
  mocks.setConnected(true);
  seedLocalState({
    readingState: {
      [bookOne.id]: {
        cfi: 'epubcfi(/6/2!/4/2)',
        xpath: '//body/p[2]',
        percentage: 0.2,
        localUpdatedAt: '2026-09-07T06:00:00.000Z',
        syncedLocalUpdatedAt: null,
        serverUpdatedAt: null,
        pendingSync: true,
        syncRevision: 1,
      },
    },
    syncQueue: {
      [bookOne.id]: {
        bookId: bookOne.id,
        serverId: 'primary',
        payloadJson: JSON.stringify({
          libraryId: 1,
          seriesId: 1,
          volumeId: 1,
          chapterId: 10,
          pageNum: 20,
          bookScrollId: '//body/p[2]',
        }),
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
        createdAt: '2026-09-07T06:00:00.000Z',
        updatedAt: '2026-09-07T06:00:00.000Z',
        revision: 1,
      },
    },
  });

  let uploadSignal: AbortSignal | undefined;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/Series/v2')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [
          {
            id: 1,
            name: 'First Book',
            libraryId: 1,
            format: 3,
            pages: 100,
            pagesRead: 10,
            created: '2026-01-01T00:00:00.000Z',
            latestReadDate: '0001-01-01T00:00:00',
          },
        ],
      };
    }
    if (url.includes('/api/Series/series-detail?seriesId=1')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          chapters: [
            {
              id: 10,
              title: 'First Book',
              titleName: 'First Book',
              volumeId: 1,
              pages: 100,
              pagesRead: 10,
              summary: '',
              format: 3,
              files: [{ id: 10, bytes: 1024, extension: '.epub', format: 3 }],
              writers: [{ name: 'Author One' }],
            },
          ],
          specials: [],
          volumes: [],
          storylineChapters: [],
        }),
      };
    }
    if (url.includes('/api/Image/series-cover')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        blob: async () => new Blob(),
      };
    }
    if (url.includes('/api/Reader/progress')) {
      uploadSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  await mountLibrary();
  expect(uploadSignal?.aborted).toBe(false);

  unmount(instance!);
  instance = null;
  await settle(6);

  expect(uploadSignal?.aborted).toBe(true);
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
    syncQueue: Record<string, { attemptCount: number; lastError: string | null }>;
  };
  expect(saved.syncQueue[bookOne.id]).toMatchObject({
    attemptCount: 0,
    lastError: null,
  });
});
