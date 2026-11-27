// @vitest-environment node

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOKS_SERVER_FILE_INDEX_NAME, migrations } from './schema';

describe('native library indexes', () => {
  let db: DatabaseSync;

  afterEach(() => db.close());

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

  it('defines non-overlapping v8, v9, and v10 book migrations and indexes server file lookups', () => {
    expect(migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);

    const columnsByVersion = new Map(
      migrations.map((migration) => [
        migration.version,
        Array.from(
          migration.statements.matchAll(/ALTER TABLE books ADD COLUMN (\w+)/g),
          (match) => match[1]!,
        ),
      ]),
    );
    expect(columnsByVersion.get(8)).toEqual([
      'remote_file_size',
      'downloaded_bytes',
      'downloaded_pages',
      'chapter_key',
    ]);
    expect(columnsByVersion.get(9)).toEqual([
      'file_id',
      'file_name',
      'chapter_epub_index',
      'multi_file_chapter',
      'sync_progress',
    ]);
    expect(columnsByVersion.get(10)).toEqual(['sort_order', 'min_number', 'volume_number']);

    const addedBookColumns = [...columnsByVersion.values()].flat();
    expect(new Set(addedBookColumns).size).toBe(addedBookColumns.length);
    expect(addedBookColumns.filter((column) => column === 'remote_file_size')).toHaveLength(1);

    db = new DatabaseSync(':memory:');
    for (const migration of migrations) {
      db.exec(migration.statements);
    }

    const indexes = db.prepare("PRAGMA index_list('books')").all() as Array<{
      name: string;
    }>;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(['books_server_title_idx', BOOKS_SERVER_FILE_INDEX_NAME]),
    );

    const titlePlan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM books WHERE server_id=? ORDER BY title')
      .all('server') as Array<{ detail: string }>;
    expect(titlePlan.some((row) => row.detail.includes('books_server_title_idx'))).toBe(true);

    const filePlan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM books WHERE server_id=? AND file_id=?')
      .all('server', 42) as Array<{ detail: string }>;
    expect(filePlan.some((row) => row.detail.includes(BOOKS_SERVER_FILE_INDEX_NAME))).toBe(true);
  });
});
