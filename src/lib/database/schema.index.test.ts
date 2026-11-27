// @vitest-environment node

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  migrations,
  STUDY_STORAGE_MIGRATION_VERSION,
  V8_BOOK_COLUMNS,
  V8_MIGRATION_VERSION,
  V9_BOOK_COLUMNS,
  V9_MIGRATION_VERSION,
  V10_BOOK_COLUMNS,
  V10_MIGRATION_VERSION,
} from './schema';

describe('native library indexes', () => {
  let db: DatabaseSync;

  afterEach(() => db?.close());

  it('defines sequential v1-v11 migrations without duplicate ALTER TABLE ADD COLUMN definitions', () => {
    expect(STUDY_STORAGE_MIGRATION_VERSION).toBe(11);
    expect(migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);

    const addedColumnsByTable = new Map<string, string[]>();
    for (const migration of migrations) {
      const matches = migration.statements.matchAll(
        /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)\b/gi,
      );
      for (const match of matches) {
        const table = match[1]!;
        const column = match[2]!;
        const list = addedColumnsByTable.get(table) ?? [];
        expect(list, `duplicate column ${table}.${column} in v${migration.version}`).not.toContain(
          column,
        );
        list.push(column);
        addedColumnsByTable.set(table, list);
      }
    }

    const v8 = migrations.find((migration) => migration.version === V8_MIGRATION_VERSION)!;
    const v9 = migrations.find((migration) => migration.version === V9_MIGRATION_VERSION)!;
    const v10 = migrations.find((migration) => migration.version === V10_MIGRATION_VERSION)!;
    for (const col of V8_BOOK_COLUMNS) {
      expect(v8.statements).toContain(`ADD COLUMN ${col.name}`);
    }
    expect(v9.statements).not.toContain('remote_file_size');
    for (const col of V9_BOOK_COLUMNS) {
      expect(v9.statements).toContain(`ADD COLUMN ${col.name}`);
    }
    expect(v9.statements).toContain('books_server_file_idx');
    for (const col of V10_BOOK_COLUMNS) {
      expect(v10.statements).toContain(`ADD COLUMN ${col.name}`);
    }
  });

  it('adds a server-scoped title index for ordered library reads', () => {
    db = new DatabaseSync(':memory:');
    db.exec(
      migrations
        .slice(0, 4)
        .map((migration) => migration.statements)
        .join('\n'),
    );
    db.exec(migrations[4]!.statements);

    const indexes = db.prepare("PRAGMA index_list('books')").all() as Array<{
      name: string;
    }>;
    expect(indexes.map((index) => index.name)).toContain('books_server_title_idx');

    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM books WHERE server_id=? ORDER BY title')
      .all('server') as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('books_server_title_idx'))).toBe(true);
  });

  it('adds study table indexes and cascades server deletion to annotations, bookmarks, and history', () => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    for (const migration of migrations) db.exec(migration.statements);

    const bookIndexes = db.prepare("PRAGMA index_list('books')").all() as Array<{
      name: string;
    }>;
    const annotationIndexes = db.prepare("PRAGMA index_list('annotations')").all() as Array<{
      name: string;
    }>;
    const bookmarkIndexes = db.prepare("PRAGMA index_list('bookmarks')").all() as Array<{
      name: string;
    }>;
    const historyIndexes = db.prepare("PRAGMA index_list('reading_history')").all() as Array<{
      name: string;
    }>;
    expect(bookIndexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(['books_server_title_idx', 'books_server_file_idx']),
    );
    expect(annotationIndexes.map((index) => index.name)).toContain('annotations_book_created_idx');
    expect(bookmarkIndexes.map((index) => index.name)).toContain('bookmarks_book_saved_idx');
    expect(historyIndexes.map((index) => index.name)).toContain('reading_history_book_saved_idx');

    db.prepare(
      `INSERT INTO server_config (id, display_name, base_url, credential_ref, kavita_version, last_connected_at)
       VALUES ('srv_a', 'Server A', 'https://a.example', 'server_srv_a_api_key', '0.8.8', '2026-01-01T00:00:00.000Z'),
              ('srv_b', 'Server B', 'https://b.example', 'server_srv_b_api_key', '0.8.8', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO books (id, server_id, library_id, series_id, volume_id, chapter_id, title, format, metadata_refreshed_at, download_status, created_at)
       VALUES ('srv_a:1:10', 'srv_a', 1, 1, 10, 10, 'Book A', 'epub', '2026-01-01T00:00:00.000Z', 'none', '2026-01-01T00:00:00.000Z'),
              ('srv_b:1:10', 'srv_b', 1, 1, 10, 10, 'Book B', 'epub', '2026-01-01T00:00:00.000Z', 'none', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO annotations (id, book_id, cfi, xpath, excerpt, note, created_at, updated_at)
       VALUES ('ann_a', 'srv_a:1:10', 'epubcfi(/6/2!/4/2)', '//body/DocFragment[1]/body/p[1]', 'Quote A', 'Note A', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
              ('ann_b', 'srv_b:1:10', 'epubcfi(/6/2!/4/2)', '//body/DocFragment[1]/body/p[1]', 'Quote B', 'Note B', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO bookmarks (id, book_id, cfi, href, percentage, label, saved_at, updated_at)
       VALUES ('bm_a', 'srv_a:1:10', 'epubcfi(/6/2!/4/2)', 'ch1.xhtml', 0.2, 'Mark A', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
              ('bm_b', 'srv_b:1:10', 'epubcfi(/6/2!/4/2)', 'ch1.xhtml', 0.2, 'Mark B', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO reading_history (book_id, id, cfi, href, percentage, label, saved_at)
       VALUES ('srv_a:1:10', 'h_a', 'epubcfi(/6/2!/4/2)', 'ch1.xhtml', 0.2, '20%', '2026-01-01T00:00:00.000Z'),
              ('srv_b:1:10', 'h_b', 'epubcfi(/6/2!/4/2)', 'ch1.xhtml', 0.2, '20%', '2026-01-01T00:00:00.000Z')`,
    ).run();

    db.prepare('DELETE FROM server_config WHERE id=?').run('srv_a');

    expect(db.prepare("SELECT COUNT(*) AS total FROM books WHERE server_id='srv_a'").get()).toEqual(
      { total: 0 },
    );
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM annotations WHERE book_id='srv_a:1:10'").get(),
    ).toEqual({ total: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM bookmarks WHERE book_id='srv_a:1:10'").get(),
    ).toEqual({ total: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM reading_history WHERE book_id='srv_a:1:10'").get(),
    ).toEqual({ total: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM annotations WHERE book_id='srv_b:1:10'").get(),
    ).toEqual({ total: 1 });
  });
});
