// @vitest-environment jsdom

import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import type { capTask } from '@capacitor-community/sqlite';
import type { ConnectionStatus } from '@capacitor/network';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookRecord, ServerConfig } from '../database/database';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};
const { Blob: NodeBlob } = createRequire(import.meta.url)('node:buffer') as {
  Blob: typeof Blob;
};
if (typeof globalThis.Blob.prototype.stream !== 'function') {
  globalThis.Blob = NodeBlob;
}

const epubBytes = readFileSync('dev/kavita/data/Books/lorem-ipsum.epub');
const coverBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const harness = vi.hoisted(() => {
  type NetworkListener = (status: ConnectionStatus) => void;
  type AppStateListener = (state: { isActive: boolean }) => void;

  const files = new Map<string, Uint8Array>();
  const secrets = new Map<string, string>();
  const networkListeners = new Set<NetworkListener>();
  const appStateListeners = new Set<AppStateListener>();

  return {
    files,
    secrets,
    networkListeners,
    appStateListeners,
    networkStatus: { connected: false, connectionType: 'wifi' } as ConnectionStatus,
    databaseDir: '',
    databasePath: '',
    database: null as DatabaseSyncType | null,
    isOpen: false,
    createAdapter: null as (() => unknown) | null,
    readerProps: null as {
      bookId: string;
      title: string;
      onBack: () => void;
      onRelocated: (location: {
        cfi: string;
        xpath: string | null;
        percentage: number;
        spineIndex: number;
      }) => void;
      onSyncLatest?: ((manual: boolean) => Promise<unknown>) | undefined;
    } | null,
    emitNetworkChange(status: ConnectionStatus) {
      this.networkStatus = status;
      for (const listener of networkListeners) listener(status);
    },
    emitAppState(isActive: boolean) {
      for (const listener of appStateListeners) listener({ isActive });
    },
  };
});

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function stripFileUri(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    convertFileSrc: (uri: string) => `web://${uri}`,
  },
  CapacitorHttp: {
    request: vi.fn(
      async (options: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        data?: unknown;
      }) => {
        const init: RequestInit = {
          method: options.method ?? 'GET',
          redirect: 'manual',
        };
        if (options.headers) init.headers = options.headers;
        if (options.data !== undefined) init.body = JSON.stringify(options.data);
        const response = await fetch(options.url, init);
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const text = await response.text();
        return {
          status: response.status,
          headers,
          url: options.url,
          data: text,
        };
      },
    ),
    get: vi.fn(async (options: { url: string; headers?: Record<string, string> }) => {
      const init: RequestInit = { redirect: 'manual' };
      if (options.headers) init.headers = options.headers;
      const response = await fetch(options.url, init);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        status: response.status,
        headers,
        url: options.url,
        data: toBase64(bytes),
      };
    }),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ ...harness.networkStatus })),
    addListener: vi.fn(async (eventName: string, listener: (status: ConnectionStatus) => void) => {
      if (eventName === 'networkStatusChange') harness.networkListeners.add(listener);
      return {
        remove: async () => {
          harness.networkListeners.delete(listener);
        },
      };
    }),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (eventName: string, listener: (payload: never) => void) => {
      if (eventName === 'appStateChange') {
        harness.appStateListeners.add(
          listener as unknown as (state: { isActive: boolean }) => void,
        );
      }
      return {
        remove: async () => {
          harness.appStateListeners.delete(
            listener as unknown as (state: { isActive: boolean }) => void,
          );
        },
      };
    }),
    exitApp: vi.fn(async () => undefined),
  },
}));

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    setKeyPrefix: vi.fn(async () => undefined),
    setSynchronize: vi.fn(async () => undefined),
    set: vi.fn(async (key: string, value: string) => {
      harness.secrets.set(key, value);
    }),
    get: vi.fn(async (key: string) => harness.secrets.get(key) ?? null),
    remove: vi.fn(async (key: string) => {
      harness.secrets.delete(key);
    }),
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Filesystem: {
    stat: vi.fn(async ({ path }: { path: string }) => {
      const content = harness.files.get(path);
      if (content) {
        return {
          type: 'file',
          size: content.byteLength,
          name: path.split('/').pop() ?? path,
          mtime: 0,
          uri: `file://${path}`,
        };
      }
      const prefix = `${path.replace(/\/+$/, '')}/`;
      if ([...harness.files.keys()].some((existing) => existing.startsWith(prefix))) {
        return {
          type: 'directory',
          size: 0,
          name: path,
          mtime: 0,
          uri: `file://${path}`,
        };
      }
      throw { code: 'OS-PLUG-FILE-0008' };
    }),
    mkdir: vi.fn(async () => undefined),
    readdir: vi.fn(async ({ path }: { path: string }) => {
      const prefix = `${path.replace(/\/+$/, '')}/`;
      const entries = [...harness.files.keys()]
        .filter((filePath) => filePath.startsWith(prefix))
        .map((filePath) => ({
          name: filePath.slice(prefix.length),
          type: 'file' as const,
          size: harness.files.get(filePath)?.byteLength ?? 0,
          mtime: 0,
          uri: `file://${filePath}`,
        }));
      return { files: entries };
    }),
    getUri: vi.fn(async ({ path }: { path: string }) => ({ uri: `file://${path}` })),
    readFile: vi.fn(
      async ({
        path,
        offset = 0,
        length = -1,
      }: {
        path: string;
        offset?: number;
        length?: number;
      }) => {
        const content = harness.files.get(path);
        if (!content) throw { code: 'OS-PLUG-FILE-0008' };
        const slice = content.slice(offset, length > 0 ? offset + length : undefined);
        return { data: toBase64(slice) };
      },
    ),
    writeFile: vi.fn(async ({ path, data }: { path: string; data: string }) => {
      harness.files.set(path, fromBase64(data));
      return { uri: `file://${path}` };
    }),
    rename: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      const existing = harness.files.get(from);
      if (!existing) throw { code: 'OS-PLUG-FILE-0008' };
      harness.files.set(to, existing);
      harness.files.delete(from);
    }),
    deleteFile: vi.fn(async ({ path }: { path: string }) => {
      if (!harness.files.delete(path)) throw { code: 'OS-PLUG-FILE-0008' };
    }),
    rmdir: vi.fn(async ({ path }: { path: string }) => {
      const prefix = `${path.replace(/\/+$/, '')}/`;
      for (const existing of [...harness.files.keys()]) {
        if (existing.startsWith(prefix)) harness.files.delete(existing);
      }
    }),
  },
}));

vi.mock('@capacitor/file-transfer', () => ({
  FileTransfer: {
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
    downloadFile: vi.fn(
      async ({
        url,
        path,
        headers,
      }: {
        url: string;
        path: string;
        headers?: Record<string, string>;
      }) => {
        let response: Response;
        try {
          const init: RequestInit = {};
          if (headers) init.headers = headers;
          response = await fetch(url, init);
        } catch {
          throw { code: 'OS-PLUG-FLTR-0008' };
        }
        if (!response.ok) {
          throw {
            code: 'OS-PLUG-FLTR-0010',
            data: { httpStatus: response.status },
          };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        harness.files.set(stripFileUri(path), bytes);
        return { path };
      },
    ),
  },
}));

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {
    deleteDatabase: async () => {
      if (harness.database) harness.database.close();
      harness.database = null;
      harness.isOpen = false;
      if (harness.databasePath) rmSync(harness.databasePath, { force: true });
    },
  },
  SQLiteConnection: class {
    async checkConnectionsConsistency(): Promise<{ result: boolean }> {
      return { result: true };
    }

    async isConnection(): Promise<{ result: boolean }> {
      return { result: harness.isOpen };
    }

    async retrieveConnection(): Promise<unknown> {
      return harness.createAdapter?.();
    }

    async createConnection(): Promise<unknown> {
      return harness.createAdapter?.();
    }
  },
}));

vi.mock('../themes/themes', () => ({
  skeletonThemes: ['vintage', 'fennec'],
  loadTheme: vi.fn(async () => true),
}));

vi.mock('./Reader.svelte', async () => {
  interface MockReaderProps {
    bookId: string;
    title: string;
    onBack: () => void;
    onRelocated: (location: {
      cfi: string;
      xpath: string | null;
      percentage: number;
      spineIndex: number;
    }) => void;
    onSyncLatest?: ((manual: boolean) => Promise<unknown>) | undefined;
  }
  const { createRawSnippet } = await import('svelte');
  const snippet = createRawSnippet((props: () => MockReaderProps) => ({
    render: () => `<section data-testid="mock-reader"><h1>${props().title}</h1></section>`,
    setup: (element) => {
      harness.readerProps = props();
      const backButton = document.createElement('button');
      backButton.type = 'button';
      backButton.setAttribute('aria-label', 'Back to library');
      backButton.addEventListener('click', () => props().onBack());

      const syncButton = document.createElement('button');
      syncButton.type = 'button';
      syncButton.setAttribute('aria-label', 'Sync latest reading position');
      syncButton.disabled = !props().onSyncLatest;
      syncButton.addEventListener('click', () => {
        void props().onSyncLatest?.(true);
      });

      element.append(backButton, syncButton);
      return () => {
        if (harness.readerProps === props()) harness.readerProps = null;
      };
    },
  }));
  const renderSnippet = snippet as unknown as (
    anchor: Comment,
    getProps: () => MockReaderProps,
  ) => void;
  return {
    default: function MockReader(anchor: Comment, props: MockReaderProps) {
      return renderSnippet(anchor, () => props);
    },
  };
});

harness.createAdapter = () => ({
  async open(): Promise<void> {
    if (!harness.database) harness.database = new DatabaseSync(harness.databasePath);
    harness.isOpen = true;
  },
  async close(): Promise<void> {
    if (harness.database) harness.database.close();
    harness.database = null;
    harness.isOpen = false;
  },
  async getVersion(): Promise<{ version: number }> {
    const row = harness.database?.prepare('PRAGMA user_version').get() as
      { user_version?: number } | undefined;
    return { version: Number(row?.user_version ?? 0) };
  },
  async execute(statement: string): Promise<{ changes: { changes: number } }> {
    harness.database?.exec(statement);
    return { changes: { changes: 0 } };
  },
  async run(statement: string, values: unknown[] = []): Promise<{ changes: { changes: number } }> {
    const result = harness.database?.prepare(statement).run(...(values as SQLInputValue[]));
    return { changes: { changes: Number(result?.changes ?? 0) } };
  },
  async query(
    statement: string,
    values: unknown[] = [],
  ): Promise<{ values: Record<string, unknown>[] }> {
    const rows = harness.database?.prepare(statement).all(...(values as SQLInputValue[])) as
      Record<string, unknown>[] | undefined;
    return { values: rows ?? [] };
  },
  async executeTransaction(tasks: capTask[]): Promise<{ changes: { changes: number } }> {
    const database = harness.database;
    if (!database) throw new Error('database is not open');
    database.exec('BEGIN');
    try {
      for (const task of tasks) {
        if (task.values && task.values.length > 0) {
          database.prepare(task.statement).run(...(task.values as SQLInputValue[]));
        } else {
          database.exec(task.statement);
        }
      }
      database.exec('COMMIT');
      return { changes: { changes: tasks.length } };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  },
});

interface RecordedRequest {
  method: string;
  path: string;
  apiKey: string | undefined;
}

interface KavitaFixture {
  baseUrl: string;
  requests: RecordedRequest[];
  uploads: Array<{ chapterId: number; pageNum: number; bookScrollId?: string }>;
  setAllowedKey(nextKey: string): void;
  setDropConnections(drop: boolean): void;
  setStallGetProgressMs(ms: number): void;
  close(): Promise<void>;
}

async function startKavitaFixture(initialKey = 'lan-key-1'): Promise<KavitaFixture> {
  let allowedKey = initialKey;
  let dropConnections = false;
  let stallGetProgressMs = 0;
  const requests: RecordedRequest[] = [];
  const uploads: Array<{ chapterId: number; pageNum: number; bookScrollId?: string }> = [];

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const apiKeyHeader = request.headers['x-api-key'];
    const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    requests.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      apiKey,
    });

    if (dropConnections) {
      request.socket.destroy();
      return;
    }

    if (apiKey !== allowedKey) {
      response.writeHead(401, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }

    const pagesRead = uploads.at(-1)?.pageNum ?? 0;

    switch (url.pathname) {
      case '/api/Health':
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ version: '0.8.4' }));
        return;
      case '/api/Library/libraries':
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify([{ id: 1, name: 'Home LAN Books', type: 2 }]));
        return;
      case '/api/Series/v2':
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify([
            {
              id: 1,
              libraryId: 1,
              name: 'LAN Odyssey',
              format: 3,
              pages: 10,
              pagesRead,
            },
            {
              id: 2,
              libraryId: 1,
              name: 'Second Shelf',
              format: 3,
              pages: 12,
              pagesRead: 0,
            },
          ]),
        );
        return;
      case '/api/Series/series-detail': {
        const seriesId = Number(url.searchParams.get('seriesId') ?? '1');
        const chapterId = seriesId === 1 ? 101 : 202;
        const bookTitle = seriesId === 1 ? 'LAN Odyssey' : 'Second Shelf';
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            volumes: [
              {
                id: seriesId * 10,
                chapters: [
                  {
                    id: chapterId,
                    volumeId: seriesId * 10,
                    title: bookTitle,
                    titleName: bookTitle,
                    pages: seriesId === 1 ? 10 : 12,
                    pagesRead: seriesId === 1 ? pagesRead : 0,
                    format: 3,
                    files: [
                      {
                        id: chapterId,
                        format: 3,
                        extension: '.epub',
                        bytes: epubBytes.byteLength,
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
      case '/api/Image/series-cover':
        response
          .writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': coverBytes.byteLength,
          })
          .end(coverBytes);
        return;
      case '/api/Download/chapter':
        response
          .writeHead(200, {
            'Content-Type': 'application/epub+zip',
            'Content-Length': epubBytes.byteLength,
          })
          .end(epubBytes);
        return;
      case '/api/Reader/get-progress':
        if (stallGetProgressMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, stallGetProgressMs));
        }
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify(
            uploads.at(-1) ?? {
              libraryId: 1,
              seriesId: 1,
              volumeId: 10,
              chapterId: 101,
              pageNum: 0,
            },
          ),
        );
        return;
      case '/api/Reader/progress': {
        let body = '';
        for await (const chunk of request) body += chunk;
        uploads.push(
          JSON.parse(body) as { chapterId: number; pageNum: number; bookScrollId?: string },
        );
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        return;
      }
      default:
        response.writeHead(404).end();
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    uploads,
    setAllowedKey(nextKey: string) {
      allowedKey = nextKey;
    },
    setDropConnections(drop: boolean) {
      dropConnections = drop;
    },
    setStallGetProgressMs(ms: number) {
      stallGetProgressMs = ms;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const queueDump = harness.database
    ? JSON.stringify(harness.database.prepare('SELECT * FROM sync_queue').all())
    : 'closed';
  throw new Error(
    `Timed out waiting for condition: ${check.toString()} | queue=${queueDump} | DOM=${container?.textContent?.slice(0, 200)} | requests=${JSON.stringify(fixture?.requests)}`,
  );
}

function setInputValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

let fixture: KavitaFixture | null = null;
let mountedComponent: Record<string, unknown> | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  harness.files.clear();
  harness.secrets.clear();
  harness.networkListeners.clear();
  harness.appStateListeners.clear();
  harness.readerProps = null;
  harness.networkStatus = { connected: false, connectionType: 'wifi' };
  harness.databaseDir = mkdtempSync(join(tmpdir(), 'turnleaf-lan-test-'));
  harness.databasePath = join(harness.databaseDir, 'turnleaf.sqlite');
  harness.database = null;
  harness.isOpen = false;
  const { resetLocalDatabase } = await import('../database/database');
  await resetLocalDatabase();
  if (!Element.prototype.animate) {
    Element.prototype.animate = () =>
      ({
        cancel: () => undefined,
        finish: () => undefined,
        onfinish: null,
      }) as unknown as Animation;
  }
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  if (mountedComponent) {
    await unmount(mountedComponent);
    mountedComponent = null;
  }
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
  if (harness.database) {
    harness.database.close();
    harness.database = null;
  }
  harness.isOpen = false;
  if (harness.databaseDir) {
    rmSync(harness.databaseDir, { recursive: true, force: true });
  }
});

describe('LAN transport and Kavita reachability component journeys', () => {
  it('completes HTTP onboarding and Library catalog load, cover caching, download/open check, key update, and sync on unvalidated Wi-Fi', async () => {
    fixture = await startKavitaFixture('lan-key-1');
    harness.networkStatus = { connected: false, connectionType: 'wifi' };

    const [{ default: Onboarding }, { default: Library }] = await Promise.all([
      import('./Onboarding.svelte'),
      import('./Library.svelte'),
    ]);

    let connectedServer: ServerConfig | null = null;
    let connectedKey = '';

    mountedComponent = mount(Onboarding, {
      target: container!,
      props: {
        onConnected(server, key) {
          connectedServer = server;
          connectedKey = key;
        },
      },
    });
    flushSync();

    const urlInput = container!.querySelector<HTMLInputElement>('input[type="url"]')!;
    const keyInput = container!.querySelector<HTMLInputElement>('#kavita-auth-key')!;
    setInputValue(urlInput, fixture.baseUrl);
    setInputValue(keyInput, 'lan-key-1');
    flushSync();

    // Plain HTTP requires explicit user confirmation.
    const submitButton = container!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submitButton.click();
    await waitForCondition(() =>
      Boolean(container!.textContent?.includes('unencrypted HTTP connection')),
    );

    const allowHttpCheckbox = container!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    allowHttpCheckbox.click();
    flushSync();
    submitButton.click();

    await waitForCondition(() => connectedServer !== null);
    expect(connectedKey).toBe('lan-key-1');
    expect(fixture.requests.map((item) => item.path)).toEqual(
      expect.arrayContaining(['/api/Library/libraries', '/api/Health']),
    );

    await unmount(mountedComponent);
    mountedComponent = null;
    container!.innerHTML = '';

    let latestApiKey = connectedKey;
    mountedComponent = mount(Library, {
      target: container!,
      props: {
        server: connectedServer!,
        apiKey: latestApiKey,
        theme: 'vintage',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: (next) => {
          latestApiKey = next;
        },
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });

    // Catalog loads and covers cache when connected === false on Wi-Fi.
    await waitForCondition(() => Boolean(container!.textContent?.includes('LAN Odyssey')));
    expect(container!.textContent).not.toContain('No network connection');

    await waitForCondition(() => harness.files.has('covers/primary/1.img'));
    await waitForCondition(() =>
      Boolean(container!.querySelector('img[src*="covers/primary/1.img"]')),
    );

    // Download EPUB and open book, verifying remote open-progress check runs on unvalidated Wi-Fi.
    const openBookButton = container!.querySelector<HTMLButtonElement>('[data-book-open]')!;
    openBookButton.click();

    await waitForCondition(() => harness.readerProps !== null);
    expect(harness.files.has('books/primary-1-101.epub')).toBe(true);
    expect(fixture.requests.some((item) => item.path === '/api/Reader/get-progress')).toBe(true);

    // Relocate inside Reader and verify automatic sync uploads over unvalidated Wi-Fi.
    harness.readerProps!.onRelocated({
      cfi: 'epubcfi(/6/4!/4/2:0)',
      xpath: '/body/DocFragment[5]/body/p[1]',
      percentage: 0.5,
      spineIndex: 4,
    });

    await waitForCondition(() => fixture!.uploads.length === 1);
    expect(fixture.uploads[0]).toMatchObject({
      chapterId: 101,
      pageNum: 5,
      bookScrollId: '/body/DocFragment[5]/body/p[1]',
    });

    // Queue another reading relocation and rotate API key on server so background sync waits for key update.
    fixture.setAllowedKey('lan-key-2');
    harness.readerProps!.onRelocated({
      cfi: 'epubcfi(/6/4!/4/4:0)',
      xpath: '/body/DocFragment[8]/body/p[2]',
      percentage: 0.8,
      spineIndex: 7,
    });
    await waitForCondition(() =>
      fixture!.requests.some(
        (item) => item.path === '/api/Reader/progress' && item.apiKey === 'lan-key-1',
      ),
    );

    // Exit Reader, open Settings, replace API key, and verify catalog refresh + progress flush use the new key on LAN Wi-Fi.
    container!.querySelector<HTMLButtonElement>('[aria-label="Back to library"]')!.click();
    await waitForCondition(() => Boolean(container!.querySelector('[aria-label="Open settings"]')));

    container!.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await waitForCondition(() =>
      Boolean(container!.querySelector<HTMLInputElement>('#replacement-api-key')),
    );

    const replacementInput = container!.querySelector<HTMLInputElement>('#replacement-api-key')!;
    setInputValue(replacementInput, 'lan-key-2');
    flushSync();

    const keyForm = replacementInput.closest('form')!;
    keyForm.requestSubmit();

    await waitForCondition(() => fixture!.uploads.some((upload) => upload.pageNum === 8));
    expect(latestApiKey).toBe('lan-key-2');
    expect(
      Boolean(container!.querySelector('[aria-label*="downloaded for offline reading"]')),
    ).toBe(true);
    expect(
      fixture.requests.some(
        (item) => item.path === '/api/Series/v2' && item.apiKey === 'lan-key-2',
      ),
    ).toBe(true);
    expect(
      fixture.requests.some(
        (item) => item.path === '/api/Reader/progress' && item.apiKey === 'lan-key-2',
      ),
    ).toBe(true);
  }, 15_000);

  it('sends zero requests and disables network controls when connectionType is none, then syncs on unvalidated Wi-Fi reconnect', async () => {
    fixture = await startKavitaFixture('lan-key-1');
    const database = await import('../database/database');
    const { saveApiKey } = await import('../native/credentials');
    const { default: Library } = await import('./Library.svelte');

    const server = {
      id: 'primary',
      displayName: 'Books',
      baseUrl: fixture.baseUrl,
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.8.4',
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    };
    await saveApiKey(server.credentialRef, 'lan-key-1');
    await database.saveServer(server);

    const downloadedBook: BookRecord = {
      id: 'primary:1:101',
      serverId: 'primary',
      libraryId: 1,
      seriesId: 1,
      volumeId: 10,
      chapterId: 101,
      title: 'LAN Odyssey',
      author: 'Author One',
      series: 'LAN Odyssey',
      descriptionHtml: null,
      format: 'epub',
      pages: 10,
      pagesRead: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastReadAt: '2026-01-02T00:00:00.000Z',
      downloadPath: 'books/primary-1-101.epub',
      downloadStatus: 'available',
      fileSize: epubBytes.byteLength,
    };
    const remoteOnlyBook: BookRecord = {
      id: 'primary:2:202',
      serverId: 'primary',
      libraryId: 1,
      seriesId: 2,
      volumeId: 20,
      chapterId: 202,
      title: 'Second Shelf',
      author: 'Author Two',
      series: 'Second Shelf',
      descriptionHtml: null,
      format: 'epub',
      pages: 12,
      pagesRead: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastReadAt: null,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
    };

    harness.files.set('books/primary-1-101.epub', epubBytes);
    await database.reconcileBooks('primary', [downloadedBook, remoteOnlyBook], {
      snapshotStartedAt: '2026-01-01T00:00:00.000Z',
    });
    await database.markDownloaded(
      downloadedBook.id,
      'books/primary-1-101.epub',
      epubBytes.byteLength,
    );
    await database.saveLocalProgress(
      downloadedBook,
      'epubcfi(/6/4!/4/2:0)',
      '/body/DocFragment[5]/body/p[1]',
      0.5,
      4,
    );

    harness.networkStatus = { connected: false, connectionType: 'none' };
    fixture.requests.length = 0;

    mountedComponent = mount(Library, {
      target: container!,
      props: {
        server,
        apiKey: 'lan-key-1',
        theme: 'vintage',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });

    await waitForCondition(() => Boolean(container!.textContent?.includes('LAN Odyssey')));
    expect(container!.textContent).toContain('No network connection. Showing your saved library.');

    const headerRefresh = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh library"]',
    )!;
    expect(headerRefresh.disabled).toBe(true);

    await waitForCondition(() =>
      Boolean(
        Array.from(container!.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Retry sync'),
        ),
      ),
    );
    const retrySyncButton = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Retry sync'))!;
    expect(retrySyncButton.disabled).toBe(true);

    // Undownloaded book open control is disabled while disconnected.
    const undownloadedOpen = container!.querySelector<HTMLButtonElement>(
      '[data-book-id="primary:2:202"] [data-book-open]',
    )!;
    expect(undownloadedOpen.disabled).toBe(true);

    // Downloaded book opens offline with zero network calls and Reader sync disabled.
    const downloadedOpen = container!.querySelector<HTMLButtonElement>(
      '[data-book-id="primary:1:101"] [data-book-open]',
    )!;
    expect(downloadedOpen.disabled).toBe(false);
    downloadedOpen.click();

    await waitForCondition(() => harness.readerProps !== null);
    const readerSyncButton = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Sync latest reading position"]',
    )!;
    expect(readerSyncButton.disabled).toBe(true);
    expect(fixture.requests).toHaveLength(0);

    // Return to library, reconnect to unvalidated Wi-Fi, and verify automatic catalog refresh + progress upload.
    container!.querySelector<HTMLButtonElement>('[aria-label="Back to library"]')!.click();
    await waitForCondition(() => harness.readerProps === null);
    expect(fixture.requests).toHaveLength(0);

    harness.emitNetworkChange({ connected: false, connectionType: 'wifi' });

    await waitForCondition(() => fixture!.uploads.length === 1);
    expect(fixture.uploads[0]).toMatchObject({
      chapterId: 101,
      pageNum: 5,
      bookScrollId: '/body/DocFragment[5]/body/p[1]',
    });
    expect(fixture.requests.some((item) => item.path === '/api/Series/v2')).toBe(true);
    await waitForCondition(() => harness.files.has('covers/primary/1.img'));
  });

  it('pauses background cover, open-check, and sync calls while Kavita is unreachable and recovers on manual retry', async () => {
    fixture = await startKavitaFixture('lan-key-1');
    const database = await import('../database/database');
    const { saveApiKey } = await import('../native/credentials');
    const { default: Library } = await import('./Library.svelte');

    const server = {
      id: 'primary',
      displayName: 'Books',
      baseUrl: fixture.baseUrl,
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.8.4',
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    };
    await saveApiKey(server.credentialRef, 'lan-key-1');
    await database.saveServer(server);
    await database.setPreference('syncFurthest', 'true');

    const downloadedBook: BookRecord = {
      id: 'primary:1:101',
      serverId: 'primary',
      libraryId: 1,
      seriesId: 1,
      volumeId: 10,
      chapterId: 101,
      title: 'LAN Odyssey',
      author: 'Author One',
      series: 'LAN Odyssey',
      descriptionHtml: null,
      format: 'epub',
      pages: 10,
      pagesRead: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastReadAt: '2026-01-02T00:00:00.000Z',
      downloadPath: 'books/primary-1-101.epub',
      downloadStatus: 'available',
      fileSize: epubBytes.byteLength,
    };
    harness.files.set('books/primary-1-101.epub', epubBytes);
    await database.reconcileBooks('primary', [downloadedBook], {
      snapshotStartedAt: '2026-01-01T00:00:00.000Z',
    });
    await database.markDownloaded(
      downloadedBook.id,
      'books/primary-1-101.epub',
      epubBytes.byteLength,
    );
    await database.saveLocalProgress(
      downloadedBook,
      'epubcfi(/6/4!/4/2:0)',
      '/body/DocFragment[2]/body/p[1]',
      0.5,
      1,
    );

    // Simulate mobile data away from home LAN server: transport is active, but Kavita is unreachable.
    harness.networkStatus = { connected: true, connectionType: 'cellular' };
    fixture.setDropConnections(true);
    fixture.requests.length = 0;

    mountedComponent = mount(Library, {
      target: container!,
      props: {
        server,
        apiKey: 'lan-key-1',
        theme: 'vintage',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });

    await waitForCondition(
      () =>
        Boolean(container!.textContent?.includes('Kavita could not be reached')) &&
        Boolean(container!.textContent?.includes('failed and remain queued')),
    );

    // Concurrent initial catalog probe (/api/Series/v2) and queued progress upload (/api/Reader/progress)
    // run once on mount (#314), with 0 cover requests while initialRefreshPending / kavitaUnreachable hold.
    expect([...fixture.requests.map((item) => item.path)].sort()).toEqual([
      '/api/Reader/progress',
      '/api/Series/v2',
    ]);
    const startupRequestCount = fixture.requests.length;

    // Duplicate cellular status events and app backgrounding must not trigger background retries.
    harness.emitNetworkChange({ connected: true, connectionType: 'cellular' });
    harness.emitAppState(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fixture.requests).toHaveLength(startupRequestCount);

    // Opening a downloaded book while Kavita is unreachable skips remote progress checks immediately.
    container!
      .querySelector<HTMLButtonElement>('[data-book-id="primary:1:101"] [data-book-open]')!
      .click();
    await waitForCondition(() => harness.readerProps !== null);
    expect(fixture.requests).toHaveLength(startupRequestCount);

    // Background Reader sync is suppressed while Kavita is unreachable, while manual sync stays enabled.
    expect(harness.readerProps!.onSyncLatest).toBeTypeOf('function');
    await expect(harness.readerProps!.onSyncLatest!(false)).resolves.toBeNull();
    expect(fixture.requests).toHaveLength(startupRequestCount);

    container!.querySelector<HTMLButtonElement>('[aria-label="Back to library"]')!.click();
    await waitForCondition(() => harness.readerProps === null);

    // Manual controls stay enabled on active transports and clear unreachable state on success.
    const headerRefresh = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh library"]',
    )!;
    const retrySyncButton = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Retry sync'))!;
    expect(headerRefresh.disabled).toBe(false);
    expect(retrySyncButton.disabled).toBe(false);

    fixture.setDropConnections(false);
    retrySyncButton.click();

    await waitForCondition(() => fixture!.uploads.length === 1);
    await waitForCondition(() => harness.files.has('covers/primary/1.img'));
  });

  it('preserves the Open offline action while a remote open-progress check is in flight', async () => {
    fixture = await startKavitaFixture('lan-key-1');
    harness.networkStatus = { connected: false, connectionType: 'wifi' };

    const database = await import('../database/database');
    const { saveApiKey } = await import('../native/credentials');
    const { default: Library } = await import('./Library.svelte');

    const server = {
      id: 'primary',
      displayName: 'Books',
      baseUrl: fixture.baseUrl,
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.8.4',
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    };
    await saveApiKey(server.credentialRef, 'lan-key-1');
    await database.saveServer(server);
    harness.files.set('books/primary-1-101.epub', epubBytes);

    mountedComponent = mount(Library, {
      target: container!,
      props: {
        server,
        apiKey: 'lan-key-1',
        theme: 'vintage',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });

    await waitForCondition(() => Boolean(container!.textContent?.includes('LAN Odyssey')));
    await database.markDownloaded(
      'primary:1:101',
      'books/primary-1-101.epub',
      epubBytes.byteLength,
    );
    container!.querySelector<HTMLButtonElement>('button[aria-label="Refresh library"]')!.click();
    await waitForCondition(() =>
      Boolean(container!.querySelector('[aria-label*="downloaded for offline reading"]')),
    );

    fixture.setStallGetProgressMs(2_500);
    container!
      .querySelector<HTMLButtonElement>('[data-book-id="primary:1:101"] [data-book-open]')!
      .click();

    await waitForCondition(() =>
      Boolean(
        Array.from(container!.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Open offline'),
        ),
      ),
    );
    const openOfflineButton = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Open offline'))!;
    openOfflineButton.click();

    await waitForCondition(() => harness.readerProps !== null);
  });
});
