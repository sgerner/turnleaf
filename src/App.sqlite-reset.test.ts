// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const dataFiles = new Map<string, string>([
    ['books/primary-1-10.epub', 'PK\x03\x04offline-epub'],
    ['turnleafSQLite.db', 'corrupt-sqlite-bytes'],
  ]);
  let corrupt = true;

  const db = {
    close: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ changes: { changes: 0 } })),
    executeTransaction: vi.fn(async () => ({ changes: { changes: 0 } })),
    getVersion: vi.fn(async () => ({ version: 7 })),
    open: vi.fn(async () => {
      if (corrupt) {
        throw new Error('SQLiteDatabaseCorruptException: database disk image is malformed');
      }
    }),
    query: vi.fn(
      async (_sql = '', _values?: unknown[]): Promise<{ values: Record<string, unknown>[] }> => ({
        values: [],
      }),
    ),
    run: vi.fn(async (_sql = '', _values?: unknown[]) => ({ changes: { changes: 1 } })),
  };

  const sqlite = {
    checkConnectionsConsistency: vi.fn(async () => ({ result: true })),
    createConnection: vi.fn(async () => db),
    isConnection: vi.fn(async () => ({ result: false })),
    retrieveConnection: vi.fn(async () => db),
  };

  const closeConnection = vi.fn(async () => undefined);
  const legacyDeleteDatabase = vi.fn(async () => {
    throw new Error('CapacitorSQLite.deleteDatabase must not be called');
  });
  const nativeUnlinkDatabase = vi.fn(async () => {
    dataFiles.delete('turnleafSQLite.db');
    corrupt = false;
    return { deletedCount: 1 };
  });

  return {
    closeConnection,
    dataFiles,
    db,
    legacyDeleteDatabase,
    nativeUnlinkDatabase,
    reset() {
      corrupt = true;
      dataFiles.clear();
      dataFiles.set('books/primary-1-10.epub', 'PK\x03\x04offline-epub');
      dataFiles.set('turnleafSQLite.db', 'corrupt-sqlite-bytes');
      vi.clearAllMocks();
      db.query.mockImplementation(async () => ({ values: [] }));
      db.run.mockImplementation(async () => ({ changes: { changes: 1 } }));
    },
    setCorrupt(value: boolean) {
      corrupt = value;
    },
    sqlite,
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
    isNativePlatform: () => true,
  },
  registerPlugin: () => ({
    deleteDatabase: mocks.nativeUnlinkDatabase,
  }),
}));

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {
    closeConnection: mocks.closeConnection,
    deleteDatabase: mocks.legacyDeleteDatabase,
  },
  SQLiteConnection: class {
    constructor() {
      return mocks.sqlite;
    }
  },
}));

vi.mock('./lib/github/releases', () => ({
  fetchLatestGithubRelease: vi.fn(async () => null),
}));

vi.mock('./lib/themes/themes', () => ({
  loadTheme: vi.fn(async () => true),
  skeletonThemes: ['fennec', 'vintage'],
}));

import App from './App.svelte';

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

describe('App.svelte repairLocalData on corrupt native SQLite', () => {
  let mounted: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    mocks.reset();
    document.body.innerHTML = '';
    Element.prototype.animate ??= (() => {
      const anim = {
        cancel() {},
        finish() {},
        onfinish: null as (() => void) | null,
      };
      queueMicrotask(() => anim.onfinish?.());
      return anim as unknown as Animation;
    }) as typeof Element.prototype.animate;
  });

  afterEach(() => {
    if (mounted) unmount(mounted);
    mounted = null;
  });

  it('resets corrupt SQLite files via SqliteReset without opening the corrupt DB and preserves downloaded EPUBs', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mounted = mount(App, { target: document.body });
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Turnleaf could not open its local data');

    const resetButton = [...document.querySelectorAll('button')].find((btn) =>
      btn.textContent?.includes('Reset local data'),
    );
    expect(resetButton).toBeTruthy();

    mocks.db.open.mockClear();
    resetButton!.click();
    await settle();

    expect(mocks.legacyDeleteDatabase).not.toHaveBeenCalled();
    expect(mocks.nativeUnlinkDatabase).toHaveBeenCalledExactlyOnceWith({ database: 'turnleaf' });
    expect(mocks.dataFiles.has('turnleafSQLite.db')).toBe(false);
    expect(mocks.dataFiles.get('books/primary-1-10.epub')).toBe('PK\x03\x04offline-epub');
    expect(document.body.textContent).not.toContain('Turnleaf could not open its local data');
    expect(document.querySelector('#connection-error')).toBeTruthy();
  });

  it('preserves salvaged notes in memory with export, copy, and retry when post-reset setPreferences rejects', async () => {
    const { openDatabase, resetLocalDatabase } = await import('./lib/database/database');
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    // Simulate an already-open native handle whose server_config table fails while
    // reading-note preferences remain readable for salvage.
    await resetLocalDatabase();
    mocks.nativeUnlinkDatabase.mockClear();
    mocks.setCorrupt(false);
    mocks.dataFiles.set('turnleafSQLite.db', 'partially-corrupt-sqlite');

    await openDatabase();

    let failPreferencesWrite = true;
    mocks.db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM server_config')) {
        throw new Error('SQLiteCorruptException: malformed server_config page');
      }
      if (sql.includes('FROM preferences')) {
        return {
          values: [
            {
              key: 'readerBookmarks:primary:1:10',
              value: JSON.stringify([
                {
                  id: 'epubcfi(/6/2!/4/2)|ch1.xhtml',
                  cfi: 'epubcfi(/6/2!/4/2)',
                  href: 'ch1.xhtml',
                  percentage: 0.42,
                  label: 'Salvaged chapter bookmark',
                  savedAt: '2026-03-10T00:00:00.000Z',
                },
              ]),
            },
            {
              key: 'readerNoteMeta:primary:1:10',
              value: JSON.stringify({
                title: 'Left Hand of Darkness',
                author: 'Ursula K. Le Guin',
              }),
            },
          ],
        };
      }
      if (sql.includes('FROM books')) {
        return {
          values: [
            {
              id: 'primary:1:10',
              title: 'Left Hand of Darkness',
              author: 'Ursula K. Le Guin',
              series: null,
            },
          ],
        };
      }
      return { values: [] };
    });
    mocks.db.run.mockImplementation(async (sql: string) => {
      if (failPreferencesWrite && sql.includes('INSERT INTO preferences')) {
        throw new Error('SQLiteFullException: disk full while restoring preferences');
      }
      return { changes: { changes: 1 } };
    });

    mounted = mount(App, { target: document.body });
    await settle();

    const resetButton = [...document.querySelectorAll('button')].find((btn) =>
      btn.textContent?.includes('Reset local data'),
    );
    expect(resetButton).toBeTruthy();

    resetButton!.click();
    await settle();

    // Reset ran once, setPreferences failed, explicit warning is shown, and notes remain exportable.
    expect(mocks.nativeUnlinkDatabase).toHaveBeenCalledTimes(1);
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'Local data was reset, but Turnleaf could not restore your saved bookmarks and notes.',
    );

    const copyJsonButton = [...document.querySelectorAll('button')].find((btn) =>
      btn.textContent?.includes('Copy JSON'),
    );
    expect(copyJsonButton).toBeTruthy();
    copyJsonButton!.click();
    await settle();

    expect(writeText).toHaveBeenCalledTimes(1);
    const exportedJson = String(writeText.mock.calls[0]?.[0] ?? '');
    expect(exportedJson).toContain('Salvaged chapter bookmark');
    expect(exportedJson).toContain('Left Hand of Darkness');

    // Once storage write succeeds, Retry persists the salvaged notes without re-deleting the DB.
    failPreferencesWrite = false;
    mocks.db.query.mockImplementation(async () => ({ values: [] }));
    const retryButton = [...document.querySelectorAll('button')].find(
      (btn) => btn.textContent?.trim() === 'Retry',
    );
    expect(retryButton).toBeTruthy();
    retryButton!.click();
    await settle();

    expect(mocks.nativeUnlinkDatabase).toHaveBeenCalledTimes(1);
    expect(mocks.db.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO preferences'),
      expect.arrayContaining(['readerBookmarks:primary:1:10']),
    );
    expect(document.querySelector('#connection-error')).toBeTruthy();
  });
});
