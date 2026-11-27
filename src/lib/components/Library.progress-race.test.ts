// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '../database/database';
import type { BookRecord, ServerConfig } from '../database/database';
import type * as KavitaClientModule from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';
import type * as ReaderSessionModule from '../reader/session';
import type {
  ReaderLocation,
  ReaderLocationOrigin,
  ReaderLinkReturnTarget,
} from '../reader/session';
import type * as LocalProgressBufferModule from '../sync/local-progress-buffer';
import type { LocalProgressBuffer } from '../sync/local-progress-buffer';

const {
  networkState,
  writeGateState,
  kavitaMocks,
  sessionHooks,
  verifyDownloadedEpubMock,
  deleteDownloadedEpubMock,
  removeApiKeyMock,
  bufferHolder,
} = vi.hoisted(() => ({
  networkState: {
    connected: false,
    listener: null as ((status: { connected: boolean; connectionType: string }) => void) | null,
  },
  writeGateState: {
    enabled: false,
    notifyStarted: null as (() => void) | null,
    gate: Promise.resolve(),
  },
  kavitaMocks: {
    getBookSeries: vi.fn(async () => [
      {
        id: 1,
        name: 'Race Condition Chronicle',
        libraryId: 1,
        format: 3,
        pages: 100,
        pagesRead: 10,
        created: '2026-01-01T00:00:00.000Z',
        latestReadDate: '2026-03-01T00:00:00.000Z',
        coverImage: '',
      },
    ]),
    getSeriesDetail: vi.fn(async () => ({
      chapters: [],
      specials: [
        {
          id: 10,
          title: 'Race Condition Chronicle',
          titleName: 'Race Condition Chronicle',
          volumeId: 1,
          pages: 100,
          pagesRead: 10,
          summary: '',
          format: 3,
          files: [{ id: 10, bytes: 4096, extension: '.epub', format: 3 }],
          writers: [{ name: 'Ada Lovelace' }],
          lastReadingProgressUtc: '2026-03-01T00:00:00.000Z',
        },
      ],
      volumes: [],
      storylineChapters: [],
    })),
    getProgress: vi.fn<(chapterId: number, signal?: AbortSignal) => Promise<KavitaProgress>>(),
    saveProgress: vi.fn(async () => undefined),
  },
  sessionHooks: {
    onLocation: null as
      | ((
          location: ReaderLocation,
          origin: ReaderLocationOrigin,
          returnTarget?: ReaderLinkReturnTarget | null,
        ) => void)
      | null,
    displayServerLocation: vi.fn(async () => true),
    displayServerPercentage: vi.fn(async () => undefined),
  },
  verifyDownloadedEpubMock: vi.fn(async () => ({
    path: 'books/book-1.epub',
    webViewUrl: 'blob:book-1',
  })),
  deleteDownloadedEpubMock: vi.fn(async () => undefined),
  removeApiKeyMock: vi.fn(async () => undefined),
  bufferHolder: {
    current: null as LocalProgressBuffer | null,
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({
      connected: networkState.connected,
      connectionType: networkState.connected ? 'wifi' : 'none',
    })),
    addListener: vi.fn(async (_event: string, cb: typeof networkState.listener) => {
      networkState.listener = cb;
      return {
        remove: async () => {
          if (networkState.listener === cb) networkState.listener = null;
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

vi.mock('../native/credentials', () => ({
  getApiKey: vi.fn(async () => 'api-key'),
  removeApiKey: removeApiKeyMock,
  saveApiKey: vi.fn(async () => undefined),
}));

vi.mock('../downloads/native-download', () => ({
  cacheCover: vi.fn(),
  clearCoverCache: vi.fn(async () => undefined),
  cleanupInterruptedEpubDownloads: vi.fn(async () => undefined),
  deleteDownloadedEpub: deleteDownloadedEpubMock,
  downloadEpub: vi.fn(),
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class EpubTransferError extends Error {
    status?: number;
    connectionFailed?: boolean;
  },
  verifyDownloadedEpub: verifyDownloadedEpubMock,
}));

vi.mock('../kavita/client', async (importOriginal) => {
  const actual = await importOriginal<typeof KavitaClientModule>();
  return {
    ...actual,
    KavitaClient: class MockKavitaClient {
      getBookSeries = kavitaMocks.getBookSeries;
      getSeriesDetail = kavitaMocks.getSeriesDetail;
      getProgress = kavitaMocks.getProgress;
      saveProgress = kavitaMocks.saveProgress;
      downloadUrl(chapterId: number): string {
        return `https://kavita.example.com/api/Download/chapter?chapterId=${chapterId}`;
      }
      coverUrl(seriesId: number): string {
        return `https://kavita.example.com/api/Image/series-cover?seriesId=${seriesId}`;
      }
    },
  };
});

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<typeof ReaderSessionModule>();
  return {
    ...actual,
    ReaderSession: class MockReaderSession {
      async open(
        _target: HTMLElement,
        _cfi: string | null,
        _xpath: string | null,
        _percentage: number | null,
        _appearance: unknown,
        onLocation: (
          location: ReaderLocation,
          origin: ReaderLocationOrigin,
          returnTarget?: ReaderLinkReturnTarget | null,
        ) => void,
      ): Promise<void> {
        sessionHooks.onLocation = onLocation;
      }

      tableOfContents() {
        return [];
      }

      updateHighlights(): void {}

      getVisiblePassages() {
        return [];
      }

      clearTextSelection(): void {}

      displayServerLocation = sessionHooks.displayServerLocation;
      displayServerPercentage = sessionHooks.displayServerPercentage;

      destroy(): void {}
    },
  };
});

vi.mock('../sync/local-progress-buffer', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalProgressBufferModule>();
  return {
    ...actual,
    createLocalProgressBuffer: (...args: Parameters<typeof actual.createLocalProgressBuffer>) => {
      const instance = actual.createLocalProgressBuffer(...args);
      bufferHolder.current = instance;
      return instance;
    },
  };
});

vi.mock('../database/database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return {
    ...actual,
    saveLocalProgress: vi.fn(async (...args: Parameters<typeof actual.saveLocalProgress>) => {
      if (writeGateState.enabled) {
        writeGateState.notifyStarted?.();
        await writeGateState.gate;
      }
      return actual.saveLocalProgress(...args);
    }),
  };
});

import {
  getBooks,
  getPendingSync,
  getReadingState,
  getServer,
  reconcileBooks,
  saveLocalProgress,
  saveServer,
  setPreference,
} from '../database/database';
import Library from './Library.svelte';

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
  displayName: 'Home Kavita',
  baseUrl: 'https://kavita.example.com',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.4',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const book: BookRecord = {
  id: 'server-1:1:10',
  serverId: 'server-1',
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 10,
  title: 'Race Condition Chronicle',
  author: 'Ada Lovelace',
  series: 'Systems',
  descriptionHtml: null,
  format: 'epub',
  pages: 100,
  pagesRead: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-03-01T00:00:00.000Z',
  downloadPath: 'books/book-1.epub',
  downloadStatus: 'available',
  fileSize: 4096,
  remoteAvailable: true,
};

function makeLocation(page: number): ReaderLocation {
  return {
    cfi: `epubcfi(/6/2!/4/2/${page}:0)`,
    xpath: `//body/DocFragment[1]/body/p[${page}]`,
    href: 'chapter-1.xhtml',
    percentage: page / 100,
    spineIndex: 0,
    pageIndex: page - 1,
    pageCount: 100,
  };
}

function armLocalWriteGate(): { started: Promise<void>; release: () => void } {
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeGateState.enabled = true;
  writeGateState.notifyStarted = notifyStarted;
  writeGateState.gate = gate;
  return {
    started,
    release: () => {
      writeGateState.enabled = false;
      release();
    },
  };
}

describe('Library local-progress persistence ordering', () => {
  let target: HTMLDivElement;
  let instance: Record<string, unknown> | null = null;
  let onServerDeleted: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    networkState.connected = false;
    writeGateState.enabled = false;
    writeGateState.notifyStarted = null;
    writeGateState.gate = Promise.resolve();
    sessionHooks.onLocation = null;

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

    onServerDeleted = vi.fn<() => void>();
    target = document.createElement('div');
    document.body.appendChild(target);
    await saveServer(server);
    await reconcileBooks(server.id, [book]);
    await setPreference('libraryHideCompleted', 'false');
  });

  afterEach(async () => {
    writeGateState.enabled = false;
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
        apiKey: 'api-key',
        theme: 'fennec',
        mode: 'light',
        onChangeServerAddress: () => undefined,
        onServerDeleted,
        onApiKeyChange: () => undefined,
        onThemeChange: () => undefined,
        onModeChange: () => undefined,
      },
    });
    await vi.waitFor(() => {
      expect(target.textContent).toContain(book.title);
    });
  }

  async function openReaderFromContinueCard(): Promise<void> {
    const continueButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find((btn) =>
      btn.textContent?.includes('Continue reading'),
    );
    expect(continueButton).toBeDefined();
    continueButton!.click();
    await vi.waitFor(() => {
      expect(target.querySelector('.reader-shell')).not.toBeNull();
      expect(sessionHooks.onLocation).not.toBeNull();
    });
  }

  it('keeps accepted Reader remote progress authoritative when an older local write releases afterwards', async () => {
    await mountLibrary();
    await openReaderFromContinueCard();

    // Go online for manual reader sync and return a newer remote Kavita position at page 76.
    networkState.connected = true;
    networkState.listener?.({ connected: true, connectionType: 'wifi' });
    kavitaMocks.getProgress.mockResolvedValue({
      libraryId: book.libraryId,
      seriesId: book.seriesId,
      volumeId: book.volumeId,
      chapterId: book.chapterId,
      pageNum: 76,
      bookScrollId: '//body/DocFragment[1]/body/p[76]',
      lastModifiedUtc: '2026-04-03T10:00:00.000Z',
    });

    target.querySelector<HTMLButtonElement>('button[aria-label="Show reading controls"]')?.click();
    flushSync();
    target
      .querySelector<HTMLButtonElement>('button[aria-label="Sync latest reading position"]')
      ?.click();

    const confirmButton = await vi.waitFor(() => {
      const btn = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent?.trim() === 'Go to latest position',
      );
      expect(btn).toBeDefined();
      return btn!;
    });

    // Start an older local relocation write and gate it in flight before accepting remote progress.
    const gated = armLocalWriteGate();
    sessionHooks.onLocation!(makeLocation(14), 'navigation');
    await gated.started;

    confirmButton.click();
    gated.release();

    await vi.waitFor(() => {
      expect(sessionHooks.displayServerLocation).toHaveBeenCalledWith(
        '//body/DocFragment[1]/body/p[76]',
      );
    });

    expect(await getReadingState(book.id)).toMatchObject({
      cfi: '',
      xpath: '//body/DocFragment[1]/body/p[76]',
      percentage: 0.76,
      pendingSync: false,
    });
    expect(await getPendingSync(server.id)).toEqual([]);
    expect((await getBooks(server.id))[0]?.pagesRead).toBe(76);
  });

  it('keeps markDone completion authoritative when an in-flight local write releases afterwards', async () => {
    await mountLibrary();
    await openReaderFromContinueCard();

    const gated = armLocalWriteGate();
    sessionHooks.onLocation!(makeLocation(18), 'navigation');
    await gated.started;

    target.querySelector<HTMLButtonElement>('button[aria-label="Show reading controls"]')?.click();
    flushSync();
    target.querySelector<HTMLButtonElement>('button[aria-label="Back to library"]')?.click();

    const actionsButton = await vi.waitFor(() => {
      const btn = target.querySelector<HTMLButtonElement>('[data-book-actions]');
      expect(btn).not.toBeNull();
      return btn!;
    });
    actionsButton.click();
    flushSync();

    const markReadButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find((btn) =>
      btn.textContent?.includes('Mark as read'),
    );
    expect(markReadButton).toBeDefined();
    markReadButton!.click();

    gated.release();

    await vi.waitFor(async () => {
      expect(target.textContent).toContain(`${book.title} marked as read.`);
      expect(await getReadingState(book.id)).toMatchObject({
        cfi: '',
        percentage: 1,
        pendingSync: true,
      });
    });

    expect((await getBooks(server.id))[0]?.pagesRead).toBe(100);
    const pending = await getPendingSync(server.id);
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0]!.payload)).toMatchObject({
      chapterId: book.chapterId,
      pageNum: 100,
    });
  });

  it('keeps Continue from Kavita conflict resolution authoritative when an older local write releases afterwards', async () => {
    await setPreference('syncFurthest', 'false');
    await saveLocalProgress(
      book,
      'epubcfi(/6/2!/4/2/35:0)',
      '//body/DocFragment[1]/body/p[35]',
      0.35,
    );
    kavitaMocks.saveProgress.mockRejectedValueOnce(new Error('temporary upload failure'));
    networkState.connected = true;
    kavitaMocks.getProgress.mockResolvedValue({
      libraryId: book.libraryId,
      seriesId: book.seriesId,
      volumeId: book.volumeId,
      chapterId: book.chapterId,
      pageNum: 82,
      bookScrollId: '//body/DocFragment[1]/body/p[82]',
      lastModifiedUtc: '2026-04-03T12:00:00.000Z',
    });

    await mountLibrary();
    await vi.waitFor(() => {
      expect(kavitaMocks.saveProgress).toHaveBeenCalledOnce();
    });

    const openCard = [...target.querySelectorAll<HTMLButtonElement>('button')].find((btn) =>
      btn.textContent?.includes('Continue reading'),
    )!;
    openCard.click();

    const continueFromKavitaButton = await vi.waitFor(() => {
      const btn = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent?.trim() === 'Continue from Kavita',
      );
      expect(btn).toBeDefined();
      return btn!;
    });

    const gated = armLocalWriteGate();
    const staleWrite = bufferHolder.current!.queue(book, makeLocation(12));
    await gated.started;

    continueFromKavitaButton.click();
    gated.release();
    await staleWrite;

    await vi.waitFor(() => {
      expect(target.querySelector('.reader-shell')).not.toBeNull();
    });

    expect(await getReadingState(book.id)).toMatchObject({
      cfi: '',
      xpath: '//body/DocFragment[1]/body/p[82]',
      percentage: 0.82,
      pendingSync: false,
    });
    expect(await getPendingSync(server.id)).toEqual([]);
    expect((await getBooks(server.id))[0]?.pagesRead).toBe(82);
  });

  it('keeps open() remote progress adoption authoritative when an older local write starts before saveRemoteProgress and releases afterwards', async () => {
    networkState.connected = true;
    let resolveRemoteProbe!: (progress: KavitaProgress) => void;
    const remoteProbeGate = new Promise<KavitaProgress>((resolve) => {
      resolveRemoteProbe = resolve;
    });
    let notifyProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      notifyProbeStarted = resolve;
    });

    await mountLibrary();
    kavitaMocks.getProgress.mockImplementationOnce(async () => {
      notifyProbeStarted();
      return remoteProbeGate;
    });

    const openCard = [...target.querySelectorAll<HTMLButtonElement>('button')].find((btn) =>
      btn.textContent?.includes('Continue reading'),
    )!;
    openCard.click();
    await probeStarted;

    // Start an older local write while checkOpenProgress is awaiting the Kavita progress probe.
    const gated = armLocalWriteGate();
    const staleWrite = bufferHolder.current!.queue(book, makeLocation(16));
    await gated.started;

    resolveRemoteProbe({
      libraryId: book.libraryId,
      seriesId: book.seriesId,
      volumeId: book.volumeId,
      chapterId: book.chapterId,
      pageNum: 68,
      bookScrollId: '//body/DocFragment[1]/body/p[68]',
      lastModifiedUtc: '2026-04-03T14:00:00.000Z',
    });

    // Wait until open() enters runAuthoritative and invalidates the older write, then release the gate.
    await vi.waitFor(() => {
      expect(bufferHolder.current!.hasPending(book.id)).toBe(false);
    });
    gated.release();
    await staleWrite;

    await vi.waitFor(() => {
      expect(target.querySelector('.reader-shell')).not.toBeNull();
    });

    expect(await getReadingState(book.id)).toMatchObject({
      cfi: '',
      xpath: '//body/DocFragment[1]/body/p[68]',
      percentage: 0.68,
      pendingSync: false,
    });
    expect(await getPendingSync(server.id)).toEqual([]);
    expect((await getBooks(server.id))[0]?.pagesRead).toBe(68);
  });

  it('does not recreate deleted reading state when an in-flight local write releases during server removal', async () => {
    await mountLibrary();
    await openReaderFromContinueCard();

    const gated = armLocalWriteGate();
    sessionHooks.onLocation!(makeLocation(24), 'navigation');
    await gated.started;

    target.querySelector<HTMLButtonElement>('button[aria-label="Show reading controls"]')?.click();
    flushSync();
    target.querySelector<HTMLButtonElement>('button[aria-label="Back to library"]')?.click();

    const settingsButton = await vi.waitFor(() => {
      const btn = target.querySelector<HTMLButtonElement>('button[aria-label="Open settings"]');
      expect(btn).not.toBeNull();
      return btn!;
    });
    settingsButton.click();
    flushSync();

    const deleteServerButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Delete server',
    );
    expect(deleteServerButton).toBeDefined();
    deleteServerButton!.click();
    flushSync();

    const confirmDeleteButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Delete now',
    );
    expect(confirmDeleteButton).toBeDefined();
    confirmDeleteButton!.click();

    gated.release();

    await vi.waitFor(() => {
      expect(onServerDeleted).toHaveBeenCalledOnce();
    });

    expect(await getServer()).toBeNull();
    expect(await getBooks(server.id)).toEqual([]);
    expect(await getReadingState(book.id)).toBeNull();
    expect(await getPendingSync(server.id)).toEqual([]);
  });
});
