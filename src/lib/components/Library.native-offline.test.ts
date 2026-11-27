// @vitest-environment jsdom

import type * as NodeSqlite from 'node:sqlite';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import type { capTask } from '@capacitor-community/sqlite';
import type { HttpOptions, HttpResponse } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import type * as ThemesModule from '../themes/themes';
import {
  getBooks,
  getPendingSync,
  reconcileBooks,
  saveLocalProgress,
  saveServer,
  type BookRecord,
  type ServerConfig,
} from '../database/database';

const sqliteModule = process.getBuiltinModule('node:sqlite') as typeof NodeSqlite;
const { DatabaseSync } = sqliteModule;

const networkListeners = new Set<
  (status: { connected: boolean; connectionType: string }) => void
>();
const appStateListeners = new Set<(state: { isActive: boolean }) => void>();
let networkConnected = true;

let sqliteDb: DatabaseSyncType | null = null;

function ensureDb(): DatabaseSyncType {
  if (!sqliteDb) {
    sqliteDb = new DatabaseSync(':memory:');
  }
  return sqliteDb;
}

const requestMock = vi.fn<(options: HttpOptions) => Promise<HttpResponse>>();

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    convertFileSrc: (uri: string) => uri,
  },
  CapacitorHttp: {
    request: (options: HttpOptions) => requestMock(options),
  },
  registerPlugin: () => ({
    setEnabled: vi.fn(async () => ({})),
    addListener: vi.fn(async () => ({ remove: async () => {} })),
  }),
}));

vi.mock('@capacitor-community/sqlite', () => {
  class MockConnection {
    async open(): Promise<void> {
      ensureDb();
    }

    async close(): Promise<void> {}

    async getVersion(): Promise<{ version: number }> {
      const row = ensureDb().prepare('PRAGMA user_version').get() as
        { user_version?: number } | undefined;
      return { version: Number(row?.user_version ?? 0) };
    }

    async execute(statement: string): Promise<{ changes: { changes: number } }> {
      ensureDb().exec(statement);
      return { changes: { changes: 0 } };
    }

    async run(
      statement: string,
      values: unknown[] = [],
    ): Promise<{ changes: { changes: number; lastId: number } }> {
      const info = ensureDb()
        .prepare(statement)
        .run(...(values as SQLInputValue[]));
      return {
        changes: {
          changes: Number(info.changes ?? 0),
          lastId: Number(info.lastInsertRowid ?? 0),
        },
      };
    }

    async query(
      statement: string,
      values: unknown[] = [],
    ): Promise<{ values: Record<string, unknown>[] }> {
      const rows = ensureDb()
        .prepare(statement)
        .all(...(values as SQLInputValue[])) as Record<string, unknown>[];
      return { values: rows };
    }

    async executeTransaction(tasks: capTask[]): Promise<{ changes: { changes: number } }> {
      const db = ensureDb();
      db.exec('BEGIN');
      try {
        for (const task of tasks) {
          if (task.values && task.values.length > 0) {
            db.prepare(task.statement).run(...(task.values as SQLInputValue[]));
          } else {
            db.exec(task.statement);
          }
        }
        db.exec('COMMIT');
        return { changes: { changes: tasks.length } };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  return {
    CapacitorSQLite: {
      deleteDatabase: vi.fn(async () => {
        sqliteDb?.close();
        sqliteDb = null;
      }),
    },
    SQLiteConnection: class {
      async checkConnectionsConsistency() {
        return { result: false };
      }

      async isConnection() {
        return { result: false };
      }

      async retrieveConnection() {
        return new MockConnection();
      }

      async createConnection() {
        return new MockConnection();
      }
    },
  };
});

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

vi.mock('../downloads/native-download', () => ({
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class EpubTransferError extends Error {},
  cacheCover: vi.fn(async () => 'file:///cover.png'),
  clearCoverCache: vi.fn(async () => {}),
  cleanupInterruptedEpubDownloads: vi.fn(async () => {}),
  deleteDownloadedEpub: vi.fn(async () => {}),
  downloadEpub: vi.fn(async () => ({ relativePath: 'books/book-1.epub', size: 1024 })),
  verifyDownloadedEpub: vi.fn(async (path: string) => ({
    relativePath: path,
    webViewUrl: `blob:${path}`,
  })),
}));

vi.mock('../native/credentials', () => ({
  saveApiKey: vi.fn(async () => {}),
  removeApiKey: vi.fn(async () => {}),
}));

vi.mock('../themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    skeletonThemes: ['fennec', 'vintage'],
    loadTheme: vi.fn(async () => true),
  };
});

const server: ServerConfig = {
  id: 'server-1',
  displayName: 'Kavita',
  baseUrl: 'http://127.0.0.1:41999',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.0',
  lastConnectedAt: '2026-09-01T00:00:00.000Z',
};

const firstBook: BookRecord = {
  id: 'server-1:1:10',
  serverId: server.id,
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 10,
  title: 'Book One',
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

const secondBook: BookRecord = {
  ...firstBook,
  id: 'server-1:2:20',
  seriesId: 2,
  volumeId: 2,
  chapterId: 20,
  title: 'Book Two',
};

const mountedInstances: Array<Record<string, unknown>> = [];
const containers: HTMLElement[] = [];

async function mountLibrary() {
  const Library = (await import('./Library.svelte')).default;
  const target = document.createElement('div');
  target.className = 'app-stage';
  document.body.appendChild(target);
  containers.push(target);
  const instance = mount(Library, {
    target,
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
  mountedInstances.push(instance);
  return { target, instance };
}

beforeEach(async () => {
  if (sqliteDb) {
    sqliteDb.exec(
      'DELETE FROM sync_queue; DELETE FROM reading_state; DELETE FROM books; DELETE FROM server_config; DELETE FROM preferences;',
    );
  }
  networkConnected = true;
  networkListeners.clear();
  appStateListeners.clear();
  requestMock.mockReset();
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
  await reconcileBooks(server.id, [firstBook, secondBook]);
});

afterEach(async () => {
  for (const instance of mountedInstances.splice(0)) {
    await unmount(instance);
  }
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

describe('Library native offline guards before networkStatusChange callback delivery', () => {
  it('stops catalog refresh before getSeriesDetail when Network.getStatus turns offline mid-refresh', async () => {
    const offlineRequests: string[] = [];

    requestMock.mockImplementation(async (options) => {
      const url = new URL(options.url);
      if (!networkConnected) offlineRequests.push(url.pathname);
      if (url.pathname === '/api/Series/v2') {
        // Simulate Android radio dropping after /api/Series/v2 finishes but before
        // DefaultNetworkCallback.onLost asynchronously delivers networkStatusChange.
        networkConnected = false;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          url: options.url,
          data: [
            { id: 1, libraryId: 1, name: firstBook.title, format: 3, pages: 100, pagesRead: 0 },
          ],
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        url: options.url,
        data: {},
      };
    });

    await mountLibrary();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(offlineRequests).toEqual([]);
    expect(
      requestMock.mock.calls.some((call) => call[0].url.includes('/api/Series/series-detail')),
    ).toBe(false);
    // Aborted refresh leaves existing saved books untouched.
    const saved = await getBooks(server.id);
    expect(saved).toHaveLength(2);
  });

  it('halts queued progress uploads mid-batch when Network.getStatus turns offline before networkStatusChange', async () => {
    await saveLocalProgress(firstBook, 'epubcfi(/6/2!/4/2)', '//body/p[1]', 0.2, 0);
    await saveLocalProgress(secondBook, 'epubcfi(/6/4!/4/2)', '//body/p[2]', 0.5, 1);

    const offlineRequests: string[] = [];
    let resolveFirstProgress!: () => void;
    const firstProgressUploaded = new Promise<void>((resolve) => {
      resolveFirstProgress = resolve;
    });

    requestMock.mockImplementation(async (options) => {
      const url = new URL(options.url);
      if (!networkConnected) offlineRequests.push(url.pathname);
      if (url.pathname === '/api/Reader/progress') {
        networkConnected = false;
        resolveFirstProgress();
        return {
          status: 204,
          headers: {},
          url: options.url,
          data: '',
        };
      }
      if (url.pathname === '/api/Series/v2') {
        await firstProgressUploaded;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          url: options.url,
          data: [
            { id: 1, libraryId: 1, name: firstBook.title, format: 3, pages: 100, pagesRead: 0 },
            { id: 2, libraryId: 1, name: secondBook.title, format: 3, pages: 100, pagesRead: 0 },
          ],
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        url: options.url,
        data: {},
      };
    });

    await mountLibrary();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(offlineRequests).toEqual([]);
    const progressCalls = requestMock.mock.calls.filter((call) =>
      call[0].url.includes('/api/Reader/progress'),
    );
    expect(progressCalls).toHaveLength(1);
    const remainingPending = await getPendingSync(server.id);
    expect(remainingPending).toHaveLength(1);
    expect(remainingPending[0]?.bookId).toBe(secondBook.id);
  });
});
