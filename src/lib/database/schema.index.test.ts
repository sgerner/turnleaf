// @vitest-environment node

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOKS_SERVER_FILE_INDEX_NAME, COORDINATED_BOOK_COLUMNS, migrations } from './schema';

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

  it('defines coordinated v8 and v9 book columns without duplicates and indexes server file lookups', () => {
    const addedBookColumns = migrations.flatMap((migration) =>
      Array.from(
        migration.statements.matchAll(/ALTER TABLE books ADD COLUMN (\w+)/g),
        (match) => match[1]!,
      ),
    );
    expect(new Set(addedBookColumns).size).toBe(addedBookColumns.length);
    expect(addedBookColumns.filter((column) => column === 'remote_file_size')).toHaveLength(1);
    expect(addedBookColumns).toEqual(
      expect.arrayContaining(COORDINATED_BOOK_COLUMNS.map((column) => column.name)),
    );

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
