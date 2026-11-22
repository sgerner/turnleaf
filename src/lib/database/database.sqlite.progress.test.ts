// @vitest-environment node

import { writeFileSync } from 'node:fs';
import { SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import type * as CapacitorSQLiteModule from '@capacitor-community/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrations } from './schema';
import type { SQLiteTestBridge } from './sqlite-test-bridge';

const hoisted = vi.hoisted(() => ({
  bridge: null as SQLiteTestBridge | null,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
  registerPlugin: () => ({}),
}));

vi.mock('@capacitor-community/sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof CapacitorSQLiteModule>();
  const { createSQLiteTestBridge } = await import('./sqlite-test-bridge');
  hoisted.bridge ??= createSQLiteTestBridge('turnleaf-r2-');
  return {
    ...actual,
    CapacitorSQLite: hoisted.bridge.plugin as unknown as typeof actual.CapacitorSQLite,
  };
});

import * as database from './database';

function getBridge(): SQLiteTestBridge {
  if (!hoisted.bridge) {
    throw new Error('SQLite test bridge was not initialized');
  }
  return hoisted.bridge;
}

const server = {
  id: 'server',
  displayName: 'Test server',
  baseUrl: 'https://books.example.com',
  credentialRef: 'credential',
  kavitaVersion: null,
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const book = {
  id: 'server:1:10',
  serverId: server.id,
  libraryId: 1,
  seriesId: 1,
  volumeId: 10,
  chapterId: 10,
  title: 'Book',
  author: null,
  series: null,
  descriptionHtml: null,
  format: 'epub',
  pages: 100,
  pagesRead: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: null,
  downloadPath: null,
  downloadStatus: 'none',
  fileSize: null,
};

async function reopenDatabase() {
  const conn = await database.openDatabase();
  expect(conn).toBeInstanceOf(SQLiteDBConnection);
  await conn.close();
  return database;
}

async function seedDatabase() {
  await database.saveServer(server);
  await database.reconcileBooks(server.id, [book]);
  await database.saveLocalProgress(book, 'old-cfi', '/old', 0.25);
}

describe('native progress transactions against SQLite', () => {
  beforeEach(() => {
    getBridge().useNewDirectory('turnleaf-r2-');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    getBridge().clearFaults();
    await database.resetLocalDatabase().catch(() => undefined);
    getBridge().cleanup();
  });

  it('reuses a single SQLiteConnection, retrieves closed connections on reopen, and cleans up on reset', async () => {
    const bridge = getBridge();
    const consistencySpy = vi.spyOn(SQLiteConnection.prototype, 'checkConnectionsConsistency');
    const createSpy = vi.spyOn(SQLiteConnection.prototype, 'createConnection');
    const retrieveSpy = vi.spyOn(SQLiteConnection.prototype, 'retrieveConnection');
    const closeConnectionSpy = vi.spyOn(SQLiteConnection.prototype, 'closeConnection');

    const first = await database.openDatabase();
    expect(first).toBeInstanceOf(SQLiteDBConnection);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(retrieveSpy).toHaveBeenCalledTimes(0);
    expect(bridge.isNativeHandleOpen('turnleaf')).toBe(true);

    await first.close();
    expect(bridge.hasNativeConnection('turnleaf')).toBe(true);
    expect(bridge.isNativeHandleOpen('turnleaf')).toBe(false);

    const second = await database.openDatabase();
    expect(second).toBe(first);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(retrieveSpy).toHaveBeenCalledTimes(1);
    expect(bridge.isNativeHandleOpen('turnleaf')).toBe(true);

    await database.resetLocalDatabase();
    expect(closeConnectionSpy).toHaveBeenCalledWith('turnleaf', false);
    expect(bridge.hasNativeConnection('turnleaf')).toBe(false);

    const third = await database.openDatabase();
    expect(third).toBeInstanceOf(SQLiteDBConnection);
    expect(third).not.toBe(first);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(new Set(consistencySpy.mock.instances).size).toBe(1);

    await database.resetLocalDatabase();
    writeFileSync(bridge.databasePath('turnleaf'), 'seed');
    await database.resetLocalDatabase();
    expect(bridge.hasNativeConnection('turnleaf')).toBe(false);
  });

  it('persists a remote-only position across reopen without scheduling an upload', async () => {
    await database.saveServer(server);
    await database.reconcileBooks(server.id, [book]);
    const remote = { ...book, pageNum: 41, bookScrollId: '/remote' };

    expect(await database.saveRemoteProgress(book, remote, null)).toBe(true);
    const reopened = await reopenDatabase();
    const saved = await reopened.getReadingState(book.id);
    expect(saved).toMatchObject({ xpath: '/remote', percentage: 0.41, pendingSync: false });
    expect((await reopened.getBooks(server.id))[0]?.pagesRead).toBe(41);
    expect(await reopened.getPendingSync(server.id)).toEqual([]);

    expect(await reopened.saveRemoteProgress(book, { ...remote, pageNum: 52 }, saved)).toBe(true);
    await reopened.saveLocalProgress(book, 'local-cfi', '/local', 0.63);
    expect(await reopened.saveRemoteProgress(book, remote, saved)).toBe(false);
    expect(await reopened.getReadingState(book.id)).toMatchObject({
      cfi: 'local-cfi',
      pendingSync: true,
    });
  });

  it.each([0, 1, 2])(
    'rolls back every progress write when task %i fails and preserves the prior retryable state after reopen',
    async (failAt) => {
      await seedDatabase();
      const baselineReading = await database.getReadingState(book.id);
      const baselineQueue = await database.getPendingSync(server.id);
      const baselineBook = (await database.getBooks(server.id))[0];

      getBridge().failTransactionAt(failAt);
      await expect(database.saveLocalProgress(book, 'new-cfi', '/new', 0.8)).rejects.toBe(
        `injected transaction failure at ${failAt}`,
      );

      const reopened = await reopenDatabase();
      expect(await reopened.getReadingState(book.id)).toEqual(baselineReading);
      expect(await reopened.getPendingSync(server.id)).toEqual(baselineQueue);
      expect((await reopened.getBooks(server.id))[0]).toEqual(baselineBook);
    },
  );

  it('rolls back a failed completion transaction without losing its retryable queue row', async () => {
    await seedDatabase();
    const baselineReading = await database.getReadingState(book.id);
    const baselineQueue = await database.getPendingSync(server.id);
    const baselineBook = (await database.getBooks(server.id))[0];

    getBridge().failTransactionAt(2);
    await expect(database.markBookCompleted(book, baselineReading)).rejects.toBe(
      'injected transaction failure at 2',
    );

    const reopened = await reopenDatabase();
    expect(await reopened.getReadingState(book.id)).toEqual(baselineReading);
    expect(await reopened.getPendingSync(server.id)).toEqual(baselineQueue);
    expect((await reopened.getBooks(server.id))[0]).toEqual(baselineBook);
  });

  it('rolls back a failed acknowledgement so the queue can be retried after reopen', async () => {
    await seedDatabase();
    const pending = (await database.getPendingSync(server.id))[0];
    const before = await database.getReadingState(book.id);
    expect(pending).toBeDefined();

    getBridge().failTransactionAt(1);
    await expect(
      database.confirmSync(
        book.id,
        '2026-01-02T00:00:00.000Z',
        pending!.revision,
        pending!.updatedAt,
      ),
    ).rejects.toBe('injected transaction failure at 1');

    const reopened = await reopenDatabase();
    expect(await reopened.getReadingState(book.id)).toEqual(before);
    expect(await reopened.getPendingSync(server.id)).toEqual([pending]);

    await reopened.confirmSync(
      book.id,
      '2026-01-02T00:00:00.000Z',
      pending!.revision,
      pending!.updatedAt,
    );
    const afterRetry = await reopenDatabase();
    expect(await afterRetry.getPendingSync(server.id)).toEqual([]);
    expect(await afterRetry.getReadingState(book.id)).toMatchObject({
      pendingSync: false,
      syncedLocalUpdatedAt: pending!.updatedAt,
      serverUpdatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('keeps pending SQLite progress ahead of a known remote snapshot', async () => {
    await seedDatabase();
    await database.saveLocalProgress(book, 'local-cfi', '/local', 0.4);
    const localProgress = (await database.getBooks(server.id))[0];
    expect(localProgress).toBeDefined();

    await database.reconcileBooks(server.id, [
      {
        ...book,
        title: 'Updated metadata',
        pagesRead: 0,
        lastReadAt: null,
        remoteProgressKnown: true,
      },
    ]);

    expect((await database.getBooks(server.id))[0]).toMatchObject({
      title: 'Updated metadata',
      pagesRead: localProgress!.pagesRead,
      lastReadAt: localProgress!.lastReadAt,
    });
    expect(await database.getPendingSync(server.id)).toHaveLength(1);
  });

  it('keeps progress acknowledged while an older catalog snapshot was in flight', async () => {
    await seedDatabase();
    await database.saveLocalProgress(book, 'local-cfi', '/local', 0.4);
    const pending = (await database.getPendingSync(server.id))[0]!;
    const startedAt = new Date(Date.parse(pending.updatedAt) + 1000).toISOString();
    const acknowledgedAt = new Date(Date.parse(startedAt) + 1000).toISOString();
    await database.confirmSync(book.id, acknowledgedAt, pending.revision, pending.updatedAt);
    expect(await database.getPendingSync(server.id)).toEqual([]);

    await database.reconcileBooks(server.id, [{ ...book, pagesRead: 0 }], {
      snapshotStartedAt: startedAt,
    });
    expect((await database.getBooks(server.id))[0]?.pagesRead).toBe(40);

    await database.reconcileBooks(server.id, [{ ...book, pagesRead: 60 }], {
      snapshotStartedAt: new Date(Date.parse(acknowledgedAt) + 1000).toISOString(),
    });
    expect((await database.getBooks(server.id))[0]?.pagesRead).toBe(60);
  });

  it('filters SQLite sync work by its owning server', async () => {
    const otherServer = { ...server, id: 'other', baseUrl: 'https://other.example.com' };
    const otherBook = { ...book, id: 'other:1:10', serverId: otherServer.id };
    await database.saveServer(server);
    await database.saveServer(otherServer);
    await database.reconcileBooks(server.id, [book]);
    await database.reconcileBooks(otherServer.id, [otherBook]);
    await database.saveLocalProgress(book, 'main-cfi', '/main', 0.2);
    await database.saveLocalProgress(otherBook, 'other-cfi', '/other', 0.8);

    expect(await database.getPendingSync(server.id)).toHaveLength(1);
    expect(await database.getPendingSync(otherServer.id)).toHaveLength(1);
    expect(await database.getSyncStatus(server.id)).toMatchObject({
      pendingCount: 1,
      failedCount: 0,
    });
  });

  it('routes queued SQLite progress through refreshed book IDs', async () => {
    await database.saveServer(server);
    await database.reconcileBooks(server.id, [book]);
    await database.saveLocalProgress(book, 'local-cfi', '/local', 0.4);

    await database.reconcileBooks(server.id, [{ ...book, libraryId: 2, volumeId: 22 }]);

    const pending = (await database.getPendingSync(server.id))[0];
    expect(pending).toBeDefined();
    expect(JSON.parse(pending!.payload)).toMatchObject({
      libraryId: 2,
      seriesId: book.seriesId,
      volumeId: 22,
      chapterId: book.chapterId,
      pageNum: 40,
      bookScrollId: '/local',
    });
    expect((await database.getBooks(server.id))[0]).toMatchObject({
      libraryId: 2,
      volumeId: 22,
    });
  });

  it('clears native retry errors when a new local revision replaces the failed payload', async () => {
    await seedDatabase();
    const failed = (await database.getPendingSync(server.id))[0];
    expect(failed).toBeDefined();
    await database.markSyncFailure(book.id, 'expired key', failed!.revision, failed!.updatedAt);
    expect(await database.getSyncStatus(server.id)).toMatchObject({
      pendingCount: 1,
      failedCount: 1,
      lastError: 'expired key',
    });

    await database.saveLocalProgress(book, 'new-cfi', '/new', 0.75);

    expect(await database.getPendingSync(server.id)).toMatchObject([
      { revision: failed!.revision + 1 },
    ]);
    expect(await database.getSyncStatus(server.id)).toMatchObject({
      pendingCount: 1,
      failedCount: 0,
      lastError: null,
    });
  });

  it('adopts a selected server location and clears only the displayed SQLite revision', async () => {
    await seedDatabase();
    const initial = await database.getReadingState(book.id);
    expect(initial?.syncRevision).toBe(1);
    const remote = {
      libraryId: 1,
      seriesId: 1,
      volumeId: 10,
      chapterId: 10,
      pageNum: 80,
      bookScrollId: '/remote',
      lastModifiedUtc: '2026-01-02T00:00:00.000Z',
    };

    expect(
      await database.acceptRemoteProgress(
        book,
        remote,
        initial!.syncRevision!,
        initial!.localUpdatedAt,
      ),
    ).toBe(true);
    expect(await database.getPendingSync(server.id)).toEqual([]);
    expect(await database.getReadingState(book.id)).toMatchObject({
      cfi: '',
      xpath: '/remote',
      percentage: 0.8,
      pendingSync: false,
    });
    expect((await database.getBooks(server.id))[0]).toMatchObject({
      pagesRead: 80,
      lastReadAt: remote.lastModifiedUtc,
    });

    await database.saveLocalProgress(book, 'newer-cfi', '/newer', 0.9);
    expect(
      await database.acceptRemoteProgress(
        book,
        remote,
        initial!.syncRevision!,
        initial!.localUpdatedAt,
      ),
    ).toBe(false);
    expect(await database.getPendingSync(server.id)).toHaveLength(1);
    expect(await database.getReadingState(book.id)).toMatchObject({
      cfi: 'newer-cfi',
      pendingSync: true,
    });
  });

  it('keeps progress for removed books locally and resumes uploads when they return', async () => {
    await seedDatabase();
    await database.reconcileBooks(server.id, []);
    await database.saveLocalProgress(book, 'offline-cfi', '/offline', 0.5);

    expect(await database.getPendingSync(server.id)).toEqual([]);
    expect(await database.getSyncStatus(server.id)).toMatchObject({ pendingCount: 0 });
    expect(await database.getReadingState(book.id)).toMatchObject({ cfi: 'offline-cfi' });

    await database.reconcileBooks(server.id, [book]);
    expect(await database.getPendingSync(server.id)).toMatchObject([{ bookId: book.id }]);
  });

  it('upgrades a populated version-1 database sequentially through version 7, preserving getBooks, syncRevision, and cascades', async () => {
    const updatedAt = '2026-01-01T00:00:00.000Z';
    const syncedBookId = 'server:1:11';
    const otherServerId = 'legacy-other';
    const otherBookId = 'legacy-other:2:20';

    const raw = getBridge().openDirect('turnleaf');
    try {
      const v1 = migrations.find((entry) => entry.version === 1)!;
      raw.exec(v1.statements);
      raw.exec('PRAGMA user_version = 1;');

      raw
        .prepare(
          `INSERT INTO server_config
            (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          server.id,
          server.displayName,
          server.baseUrl,
          server.credentialRef,
          '0.8.0',
          updatedAt,
        );
      raw
        .prepare(
          `INSERT INTO server_config
            (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          otherServerId,
          'Other server',
          'https://other.example.com',
          'other-cred',
          null,
          updatedAt,
        );

      const insertV1Book = raw.prepare(
        `INSERT INTO books
          (id, server_id, library_id, series_id, volume_id, chapter_id, title, author, series,
           description_html, cover_path, format, metadata_refreshed_at, download_path,
           download_status, file_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertV1Book.run(
        book.id,
        server.id,
        1,
        1,
        10,
        10,
        'Alpha Book',
        'Jane Roe',
        'Series A',
        '<p>Alpha summary</p>',
        null,
        'epub',
        updatedAt,
        'books/alpha.epub',
        'available',
        4096,
      );
      insertV1Book.run(
        syncedBookId,
        server.id,
        1,
        2,
        11,
        11,
        'Beta Book',
        null,
        null,
        null,
        null,
        'epub',
        updatedAt,
        null,
        'none',
        null,
      );
      insertV1Book.run(
        otherBookId,
        otherServerId,
        2,
        3,
        20,
        20,
        'Other Server Book',
        null,
        null,
        null,
        null,
        'epub',
        updatedAt,
        null,
        'none',
        null,
      );

      const insertV1Reading = raw.prepare(
        `INSERT INTO reading_state
          (book_id, cfi, kavita_xpath, percentage, local_updated_at, synced_local_updated_at,
           server_updated_at, pending_sync)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertV1Reading.run(book.id, 'legacy-cfi', '/legacy', 0.25, updatedAt, null, null, 1);
      insertV1Reading.run(
        syncedBookId,
        'synced-cfi',
        '/synced',
        0.5,
        updatedAt,
        updatedAt,
        updatedAt,
        0,
      );
      insertV1Reading.run(otherBookId, 'other-cfi', '/other', 0.1, updatedAt, null, null, 1);

      const insertV1Queue = raw.prepare(
        `INSERT INTO sync_queue (book_id, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      );
      insertV1Queue.run(book.id, '{"pageNum":25}', updatedAt, updatedAt);
      insertV1Queue.run(otherBookId, '{"pageNum":10}', updatedAt, updatedAt);

      for (const migration of migrations) {
        if (migration.version <= 1 || migration.version >= 7) continue;
        raw.exec(migration.statements);
        raw.exec(`PRAGMA user_version = ${migration.version};`);
        if (migration.version === 2) {
          raw
            .prepare(
              'UPDATE books SET pages = 100, pages_read = 25, created_at = ?, last_read_at = ? WHERE id = ?',
            )
            .run(updatedAt, updatedAt, book.id);
        }
        if (migration.version === 3) {
          raw
            .prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)')
            .run('uiTheme', 'paper', updatedAt);
        }
        if (migration.version === 6) {
          raw.prepare('UPDATE sync_queue SET revision = 7 WHERE book_id = ?').run(book.id);
          raw.prepare('UPDATE sync_queue SET revision = 3 WHERE book_id = ?').run(otherBookId);
        }
      }
    } finally {
      raw.close();
    }

    const conn = await database.openDatabase();
    expect((await conn.getVersion()).version).toBe(7);

    const migratedBooks = await database.getBooks(server.id);
    expect(migratedBooks).toEqual([
      {
        id: book.id,
        serverId: server.id,
        libraryId: 1,
        seriesId: 1,
        volumeId: 10,
        chapterId: 10,
        title: 'Alpha Book',
        author: 'Jane Roe',
        series: 'Series A',
        descriptionHtml: '<p>Alpha summary</p>',
        format: 'epub',
        pages: 100,
        pagesRead: 25,
        createdAt: updatedAt,
        lastReadAt: updatedAt,
        downloadPath: 'books/alpha.epub',
        downloadStatus: 'available',
        fileSize: 4096,
        remoteAvailable: true,
      },
      {
        id: syncedBookId,
        serverId: server.id,
        libraryId: 1,
        seriesId: 2,
        volumeId: 11,
        chapterId: 11,
        title: 'Beta Book',
        author: null,
        series: null,
        descriptionHtml: null,
        format: 'epub',
        pages: 0,
        pagesRead: 0,
        createdAt: '',
        lastReadAt: null,
        downloadPath: null,
        downloadStatus: 'none',
        fileSize: null,
        remoteAvailable: true,
      },
    ]);

    expect((await database.getReadingState(book.id))?.syncRevision).toBe(7);
    expect((await database.getReadingState(syncedBookId))?.syncRevision).toBe(0);
    expect((await database.getPreferences(['uiTheme'])).get('uiTheme')).toBe('paper');

    await database.saveLocalProgress(
      { ...book, title: 'Alpha Book', pages: 100 },
      'next-cfi',
      '/next',
      0.5,
    );
    expect(await database.getPendingSync(server.id)).toMatchObject([
      { bookId: book.id, revision: 8 },
    ]);
    expect(await database.getReadingState(book.id)).toMatchObject({
      cfi: 'next-cfi',
      syncRevision: 8,
      pendingSync: true,
    });

    // Updating server_config in place (e.g. API key rotation) must not cascade-delete child rows.
    await database.saveServer({ ...server, kavitaVersion: '0.8.4' });
    expect((await database.getServer())?.kavitaVersion).toBe('0.8.4');
    expect(await database.getBooks(server.id)).toHaveLength(2);
    expect(await database.getPendingSync(server.id)).toHaveLength(1);

    // Verify ON DELETE CASCADE from server_config -> books -> reading_state / sync_queue.
    await database.removeServer(otherServerId);
    expect(await database.getBooks(otherServerId)).toEqual([]);
    expect(await database.getReadingState(otherBookId)).toBeNull();
    expect(await database.getPendingSync(otherServerId)).toEqual([]);

    // Verify ON DELETE CASCADE directly from books -> reading_state / sync_queue.
    await conn.run('DELETE FROM books WHERE id = ?', [book.id]);
    expect(await database.getReadingState(book.id)).toBeNull();
    expect(await database.getPendingSync(server.id)).toEqual([]);
  });

  it('migrates a populated version-1 database directly through openDatabase()', async () => {
    const updatedAt = '2026-01-01T00:00:00.000Z';
    const raw = getBridge().openDirect('turnleaf');
    try {
      raw.exec(migrations[0]!.statements);
      raw.exec('PRAGMA user_version = 1;');
      raw
        .prepare(
          `INSERT INTO server_config
            (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(server.id, server.displayName, server.baseUrl, server.credentialRef, null, updatedAt);
      raw
        .prepare(
          `INSERT INTO books
            (id, server_id, library_id, series_id, volume_id, chapter_id, title, format, metadata_refreshed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(book.id, server.id, 1, 1, 10, 10, 'Legacy V1 Book', 'epub', updatedAt);
      raw
        .prepare(
          `INSERT INTO reading_state
            (book_id, cfi, kavita_xpath, percentage, local_updated_at, pending_sync)
           VALUES (?, ?, ?, ?, ?, 1)`,
        )
        .run(book.id, 'v1-cfi', '/v1', 0.3, updatedAt);
      raw
        .prepare(
          `INSERT INTO sync_queue (book_id, payload_json, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(book.id, '{"pageNum":30}', updatedAt, updatedAt);
    } finally {
      raw.close();
    }

    const conn = await database.openDatabase();
    expect((await conn.getVersion()).version).toBe(7);
    expect(await database.getBooks(server.id)).toMatchObject([
      {
        id: book.id,
        title: 'Legacy V1 Book',
        pages: 0,
        pagesRead: 0,
        remoteAvailable: true,
      },
    ]);
    expect(await database.getReadingState(book.id)).toMatchObject({
      cfi: 'v1-cfi',
      syncRevision: 0,
      pendingSync: true,
    });

    await database.saveLocalProgress(book, 'v7-cfi', '/v7', 0.6);
    expect(await database.getPendingSync(server.id)).toMatchObject([
      { bookId: book.id, revision: 1 },
    ]);
  });

  it('retries an interrupted migration after reopening the same database file', async () => {
    const retrieveSpy = vi.spyOn(SQLiteConnection.prototype, 'retrieveConnection');
    getBridge().failTransactionAt(1);
    await expect(database.openDatabase()).rejects.toBe('injected transaction failure at 1');
    expect(getBridge().isNativeHandleOpen('turnleaf')).toBe(false);

    const conn = await database.openDatabase();
    expect(conn).toBeInstanceOf(SQLiteDBConnection);
    expect(retrieveSpy).toHaveBeenCalledWith('turnleaf', false);
    await expect(database.saveServer(server)).resolves.toBeUndefined();
  });
});
