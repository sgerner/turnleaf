// @vitest-environment jsdom

import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import type { capTask } from '@capacitor-community/sqlite';
import type { HttpOptions, HttpResponse } from '@capacitor/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reconcileBooks,
  resetLocalDatabase,
  saveLocalProgress,
  saveServer,
  type BookRecord,
  type ServerConfig,
} from '../database/database';
import type { ReaderLocation } from '../reader/session';

const nativeEnv = vi.hoisted(() => {
  let connected = true;
  let connectionType = 'wifi';
  let bridgeLatencyMs = 0;
  const networkListeners = new Set<
    (status: { connected: boolean; connectionType: string }) => void
  >();
  const readerState: {
    onBack: (() => void) | null;
    onRelocated: ((location: ReaderLocation) => void) | null;
  } = {
    onBack: null,
    onRelocated: null,
  };

  return {
    rootDir: '',
    databasePath: '',
    dataDir: '',
    database: null as DatabaseSyncType | null,
    isOpen: false,
    createAdapter: null as (() => unknown) | null,
    get connected() {
      return connected;
    },
    get connectionType() {
      return connectionType;
    },
    get bridgeLatencyMs() {
      return bridgeLatencyMs;
    },
    setBridgeLatency(ms: number) {
      bridgeLatencyMs = ms;
    },
    setNetwork(nextConnected: boolean, nextType: string, notify = true) {
      connected = nextConnected;
      connectionType = nextType;
      if (notify) {
        for (const listener of networkListeners) {
          listener({ connected: nextConnected, connectionType: nextType });
        }
      }
    },
    networkListeners,
    readerState,
    cacheCoverCalls: 0,
    reset() {
      connected = true;
      connectionType = 'wifi';
      bridgeLatencyMs = 0;
      networkListeners.clear();
      readerState.onBack = null;
      readerState.onRelocated = null;
      this.cacheCoverCalls = 0;
    },
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    convertFileSrc: (value: string) => value,
  },
  CapacitorHttp: {
    get: vi.fn(),
    request: vi.fn(async (options: HttpOptions): Promise<HttpResponse> => {
      // Simulate CapacitorHttp's non-cancellable Java ExecutorService thread:
      // once CapacitorHttp.request() is invoked, AbortSignal cannot cancel it.
      if (nativeEnv.bridgeLatencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, nativeEnv.bridgeLatencyMs));
      }
      const init: RequestInit = {
        method: options.method ?? 'GET',
        redirect: 'manual',
      };
      if (options.headers) init.headers = options.headers;
      if (options.data !== undefined) init.body = JSON.stringify(options.data);
      const response = await fetch(options.url, init);
      const text = await response.text();
      let data: unknown = text;
      if (text.trim()) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        status: response.status,
        headers,
        url: options.url,
        data,
      };
    }),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({
      connected: nativeEnv.connected,
      connectionType: nativeEnv.connectionType,
    })),
    addListener: vi.fn(
      async (
        _event: string,
        callback: (status: { connected: boolean; connectionType: string }) => void,
      ) => {
        nativeEnv.networkListeners.add(callback);
        return {
          remove: async () => {
            nativeEnv.networkListeners.delete(callback);
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

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    Data: 'DATA',
  },
  Encoding: {
    UTF8: 'utf8',
  },
  Filesystem: {
    mkdir: vi.fn(async ({ path, recursive }: { path: string; recursive?: boolean }) => {
      mkdirSync(join(nativeEnv.dataDir, path), { recursive: Boolean(recursive) });
    }),
    readFile: vi.fn(async ({ path }: { path: string }) => {
      const target = join(nativeEnv.dataDir, path);
      if (!existsSync(target)) throw new Error('File does not exist');
      return { data: readFileSync(target, 'utf8') };
    }),
    writeFile: vi.fn(async ({ path, data }: { path: string; data: string }) => {
      const target = join(nativeEnv.dataDir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data, 'utf8');
      return { uri: target };
    }),
    deleteFile: vi.fn(async ({ path }: { path: string }) => {
      const target = join(nativeEnv.dataDir, path);
      if (!existsSync(target)) throw new Error('File does not exist');
      rmSync(target, { force: true });
    }),
  },
}));

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {
    deleteDatabase: async () => {
      if (nativeEnv.database) nativeEnv.database.close();
      nativeEnv.database = null;
      nativeEnv.isOpen = false;
      rmSync(nativeEnv.databasePath, { force: true });
    },
  },
  SQLiteConnection: class {
    async checkConnectionsConsistency(): Promise<{ result: boolean }> {
      return { result: true };
    }
    async isConnection(): Promise<{ result: boolean }> {
      return { result: nativeEnv.isOpen };
    }
    async retrieveConnection(): Promise<unknown> {
      return nativeEnv.createAdapter?.();
    }
    async createConnection(): Promise<unknown> {
      return nativeEnv.createAdapter?.();
    }
  },
}));

vi.mock('../downloads/native-download', () => ({
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class extends Error {
    constructor(
      readonly status: number | undefined,
      readonly connectionFailed: boolean,
    ) {
      super('The EPUB transfer failed.');
    }
  },
  cacheCover: vi.fn(
    async (
      _url: string,
      _apiKey: string,
      seriesId: number,
      _signal: AbortSignal,
      _serverId: string,
      allowDownload: boolean | (() => boolean | Promise<boolean>),
    ) => {
      const allowed = typeof allowDownload === 'function' ? await allowDownload() : allowDownload;
      if (allowed) nativeEnv.cacheCoverCalls += 1;
      return `file:///covers/${seriesId}.png`;
    },
  ),
  clearCoverCache: vi.fn(async () => {}),
  cleanupInterruptedEpubDownloads: vi.fn(async () => {}),
  deleteDownloadedEpub: vi.fn(async () => {}),
  downloadEpub: vi.fn(async () => ({ relativePath: 'books/primary-1-1.epub', size: 1024 })),
  verifyDownloadedEpub: vi.fn(async (path: string) => ({
    relativePath: path,
    webViewUrl: `blob:${path}`,
  })),
}));

vi.mock('../native/credentials', () => ({
  saveApiKey: vi.fn(async () => {}),
  removeApiKey: vi.fn(async () => {}),
}));

vi.mock('./Reader.svelte', () => ({
  default: (
    _anchor: unknown,
    props: { onBack: () => void; onRelocated: (l: ReaderLocation) => void },
  ) => {
    nativeEnv.readerState.onBack = props.onBack;
    nativeEnv.readerState.onRelocated = props.onRelocated;
    return {};
  },
}));

function createSqliteAdapter() {
  return {
    async open(): Promise<void> {
      if (!nativeEnv.database) {
        const sqliteModuleName = 'node:sqlite';
        const { DatabaseSync } = (await import(/* @vite-ignore */ sqliteModuleName)) as {
          DatabaseSync: new (path: string) => DatabaseSyncType;
        };
        nativeEnv.database = new DatabaseSync(nativeEnv.databasePath);
      }
      nativeEnv.isOpen = true;
    },
    async close(): Promise<void> {
      if (nativeEnv.database) nativeEnv.database.close();
      nativeEnv.database = null;
      nativeEnv.isOpen = false;
    },
    async getVersion(): Promise<{ version: number }> {
      const row = nativeEnv.database?.prepare('PRAGMA user_version').get() as
        { user_version?: number } | undefined;
      return { version: Number(row?.user_version ?? 0) };
    },
    async execute(statement: string): Promise<{ changes: { changes: number } }> {
      nativeEnv.database?.exec(statement);
      return { changes: { changes: 0 } };
    },
    async run(
      statement: string,
      values: unknown[] = [],
    ): Promise<{ changes: { changes: number } }> {
      const result = nativeEnv.database?.prepare(statement).run(...(values as SQLInputValue[]));
      return { changes: { changes: Number(result?.changes ?? 0) } };
    },
    async query(
      statement: string,
      values: unknown[] = [],
    ): Promise<{ values: Record<string, unknown>[] }> {
      const rows = nativeEnv.database?.prepare(statement).all(...(values as SQLInputValue[])) as
        Record<string, unknown>[] | undefined;
      return { values: rows ?? [] };
    },
    async executeTransaction(tasks: capTask[]): Promise<{ changes: { changes: number } }> {
      const db = nativeEnv.database!;
      db.exec('BEGIN IMMEDIATE');
      try {
        let total = 0;
        for (const task of tasks) {
          if (task.values && task.values.length > 0) {
            const res = db.prepare(task.statement).run(...(task.values as SQLInputValue[]));
            total += Number(res.changes ?? 0);
          } else {
            db.exec(task.statement);
          }
        }
        db.exec('COMMIT');
        return { changes: { changes: total } };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

type JourneyFixture = {
  port: number;
  seriesRequests: number;
  uploads: Array<{ chapterId: number; bookScrollId?: string; pageNum?: number }>;
  offlineRequests: string[];
  setOffline: (value: boolean) => void;
  close: () => void;
};

async function startJourneyFixture(): Promise<JourneyFixture> {
  const key = 'turnleaf-ci-only';
  const title = 'Turnleaf CI EPUB';
  const uploads: Array<{ chapterId: number; bookScrollId?: string; pageNum?: number }> = [];
  const offlineRequests: string[] = [];
  let seriesRequests = 0;
  let offline = false;

  const server = createServer(async (request, response) => {
    if (request.headers['x-api-key'] !== key) {
      response.writeHead(401).end();
      return;
    }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (offline) {
      offlineRequests.push(path);
      response.writeHead(503).end();
      return;
    }
    const pagesRead = uploads.at(-1)?.pageNum ?? 0;
    let body: unknown;
    switch (path) {
      case '/api/Health':
        body = { version: '0.0.0-ci' };
        break;
      case '/api/Library/libraries':
        body = [{ id: 1, name: 'Books', type: 2 }];
        break;
      case '/api/Series/v2':
        seriesRequests += 1;
        body = [{ id: 1, libraryId: 1, name: title, format: 3, pages: 2, pagesRead }];
        break;
      case '/api/Series/series-detail':
        body = {
          volumes: [
            {
              id: 1,
              chapters: [
                {
                  id: 1,
                  volumeId: 1,
                  title,
                  titleName: title,
                  pages: 2,
                  pagesRead,
                  format: 3,
                  files: [{ id: 1, format: 3, extension: '.epub', bytes: 1024 }],
                },
              ],
            },
          ],
        };
        break;
      case '/api/Reader/get-progress':
        body = uploads.at(-1) ?? {
          libraryId: 1,
          seriesId: 1,
          volumeId: 1,
          chapterId: 1,
          pageNum: 0,
        };
        break;
      case '/api/Reader/progress': {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        uploads.push(
          JSON.parse(raw) as { chapterId: number; bookScrollId?: string; pageNum?: number },
        );
        body = {};
        break;
      }
      default:
        response.writeHead(404).end();
        return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    get seriesRequests() {
      return seriesRequests;
    },
    uploads,
    offlineRequests,
    setOffline(value: boolean) {
      offline = value;
    },
    close() {
      server.close();
    },
  };
}

let fixture: JourneyFixture | null = null;
let container: HTMLDivElement | null = null;
let instance: Record<string, unknown> | null = null;

async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    flushSync();
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await check()).toBe(true);
}

beforeEach(async () => {
  nativeEnv.reset();
  nativeEnv.rootDir = mkdtempSync(join(tmpdir(), 'turnleaf-native-library-'));
  nativeEnv.databasePath = join(nativeEnv.rootDir, 'turnleaf.sqlite');
  nativeEnv.dataDir = join(nativeEnv.rootDir, 'data');
  mkdirSync(nativeEnv.dataDir, { recursive: true });
  nativeEnv.createAdapter = createSqliteAdapter;

  if (!Element.prototype.animate) {
    Element.prototype.animate = () =>
      ({
        cancel: () => {},
        finish: () => {},
        onfinish: null,
        finished: Promise.resolve(),
      }) as unknown as Animation;
  }

  fixture = await startJourneyFixture();
  container = document.createElement('div');
  container.className = 'app-stage';
  document.body.appendChild(container);
});

afterEach(async () => {
  if (instance) {
    await unmount(instance);
    instance = null;
  }
  container?.remove();
  container = null;
  fixture?.close();
  fixture = null;
  await resetLocalDatabase().catch(() => {});
  if (nativeEnv.database) {
    nativeEnv.database.close();
    nativeEnv.database = null;
  }
  nativeEnv.isOpen = false;
  if (nativeEnv.rootDir) {
    rmSync(nativeEnv.rootDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('Library native offline transitions (Android reading journey parity)', () => {
  it('sends zero offline requests when Wi-Fi disables onto cellular before mobile data disables while reading', async () => {
    const server: ServerConfig = {
      id: 'primary',
      displayName: 'Kavita CI',
      baseUrl: `http://127.0.0.1:${fixture!.port}`,
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.0.0-ci',
      lastConnectedAt: '2026-09-07T00:00:00.000Z',
    };
    const book: BookRecord = {
      id: 'primary:1:1',
      serverId: 'primary',
      libraryId: 1,
      seriesId: 1,
      volumeId: 1,
      chapterId: 1,
      title: 'Turnleaf CI EPUB',
      author: null,
      series: null,
      descriptionHtml: null,
      format: 'epub',
      pages: 2,
      pagesRead: 0,
      createdAt: '2026-09-07T00:00:00.000Z',
      lastReadAt: null,
      downloadPath: 'books/primary-1-1.epub',
      downloadStatus: 'available',
      fileSize: 1024,
    };
    await saveServer(server);
    await reconcileBooks(server.id, [book]);

    const Library = (await import('./Library.svelte')).default;
    instance = mount(Library, {
      target: container!,
      props: {
        server,
        apiKey: 'turnleaf-ci-only',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });

    await waitForCondition(() => Boolean(container!.querySelector('[data-book-open]')));
    // Wait for initial online catalog refresh to settle completely
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Open the downloaded book into Reader (Chapter 1)
    container!.querySelector<HTMLButtonElement>('[data-book-open]')!.click();
    await waitForCondition(() => typeof nativeEnv.readerState.onRelocated === 'function');

    // Simulate `adb shell svc wifi disable` followed by `adb shell svc data disable`:
    // 1. Wi-Fi drops (`onLost`), then Android briefly promotes cellular (`onCapabilitiesChanged`)
    //    while CapacitorHttp background executor takes ~35ms to open its loopback socket.
    nativeEnv.setBridgeLatency(35);
    nativeEnv.setNetwork(false, 'none', true);
    nativeEnv.setNetwork(true, 'cellular', true);
    await new Promise((resolve) => setTimeout(resolve, 15));

    // 2. `adb shell svc data disable` completes and journey sets fixture offline.
    nativeEnv.setNetwork(false, 'none', true);
    fixture!.setOffline(true);

    // Wait past bridge latency to observe any un-cancellable CapacitorHttp requests
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(fixture!.offlineRequests).toEqual([]);

    // Turn page to Chapter 2 while offline
    nativeEnv.readerState.onRelocated!({
      cfi: 'epubcfi(/6/4!/4/2)',
      xpath: '//body/div/DocFragment[2]/body/p[1]',
      href: 'chapter2.xhtml',
      percentage: 0.5,
      spineIndex: 1,
      pageIndex: 0,
      pageCount: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fixture!.offlineRequests).toEqual([]);

    // Reconnect while still inside Reader: queued progress uploads after native settle,
    // while catalog refresh stays deferred until returning to the library.
    const seriesBeforeReconnect = fixture!.seriesRequests;
    fixture!.setOffline(false);
    nativeEnv.setBridgeLatency(0);
    nativeEnv.setNetwork(true, 'wifi', true);

    await waitForCondition(
      () =>
        fixture!.uploads.some(
          (progress) =>
            progress.chapterId === 1 && progress.bookScrollId?.includes('DocFragment[2]'),
        ),
      3_000,
    );
    expect(fixture!.seriesRequests).toBe(seriesBeforeReconnect);

    // Return to library: deferred catalog refresh replays cleanly
    nativeEnv.readerState.onBack!();
    await waitForCondition(() => fixture!.seriesRequests > seriesBeforeReconnect);
    await waitForCondition(() =>
      Boolean(
        container!.querySelector(
          '[aria-label="Open Turnleaf CI EPUB, downloaded for offline reading, 50% complete"]',
        ),
      ),
    );
    expect(fixture!.offlineRequests).toEqual([]);
  });

  it('sends zero offline requests on Library view with queued progress during Wi-Fi -> cellular -> offline teardown, then syncs on real reconnect', async () => {
    const server: ServerConfig = {
      id: 'primary',
      displayName: 'Kavita CI',
      baseUrl: `http://127.0.0.1:${fixture!.port}`,
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.0.0-ci',
      lastConnectedAt: '2026-09-07T00:00:00.000Z',
    };
    const book: BookRecord = {
      id: 'primary:1:1',
      serverId: 'primary',
      libraryId: 1,
      seriesId: 1,
      volumeId: 1,
      chapterId: 1,
      title: 'Turnleaf CI EPUB',
      author: null,
      series: null,
      descriptionHtml: null,
      format: 'epub',
      pages: 2,
      pagesRead: 0,
      createdAt: '2026-09-07T00:00:00.000Z',
      lastReadAt: null,
      downloadPath: 'books/primary-1-1.epub',
      downloadStatus: 'available',
      fileSize: 1024,
    };
    await saveServer(server);
    await reconcileBooks(server.id, [book]);

    // Start offline with queued reading progress
    nativeEnv.setNetwork(false, 'none', false);
    await saveLocalProgress(
      book,
      'epubcfi(/6/4!/4/2)',
      '//body/div/DocFragment[2]/body/p[1]',
      0.5,
      1,
    );

    const Library = (await import('./Library.svelte')).default;
    instance = mount(Library, {
      target: container!,
      props: {
        server,
        apiKey: 'turnleaf-ci-only',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });

    await waitForCondition(() => Boolean(container!.querySelector('[data-book-open]')));

    // Transient cellular blip (`svc wifi disable` -> cellular failover -> `svc data disable` 80ms later)
    nativeEnv.setBridgeLatency(35);
    nativeEnv.setNetwork(true, 'cellular', true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    nativeEnv.setNetwork(false, 'none', true);
    fixture!.setOffline(true);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture!.offlineRequests).toEqual([]);
    expect(fixture!.uploads).toHaveLength(0);

    // Real reconnect (`svc wifi enable` + `svc data enable`) stays connected and uploads queued passage
    fixture!.setOffline(false);
    nativeEnv.setBridgeLatency(0);
    nativeEnv.setNetwork(true, 'wifi', true);

    await waitForCondition(
      () =>
        fixture!.uploads.some(
          (progress: { chapterId: number; bookScrollId?: string }) =>
            progress.chapterId === 1 && progress.bookScrollId?.includes('DocFragment[2]'),
        ),
      3_000,
    );
    expect(fixture!.offlineRequests).toEqual([]);
  });
});
