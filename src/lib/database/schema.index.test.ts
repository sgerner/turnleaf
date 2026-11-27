// @vitest-environment node

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrations, V8_BOOK_COLUMNS } from './schema';

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

  it('defines one complete coordinated v8 books column set and server-file index without duplicate columns', () => {
    db = new DatabaseSync(':memory:');
    for (const migration of migrations) {
      db.exec(migration.statements);
    }

    expect(migrations.at(-1)?.version).toBe(8);

    const columns = (db.prepare("PRAGMA table_info('books')").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    for (const column of V8_BOOK_COLUMNS) {
      expect(columns).toContain(column.name);
    }
    expect(columns.filter((name) => name === 'remote_file_size')).toHaveLength(1);

    const indexes = db.prepare("PRAGMA index_list('books')").all() as Array<{
      name: string;
    }>;
    expect(indexes.map((index) => index.name)).toContain('books_server_file_idx');

    const plan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id, chapter_id, file_id FROM books WHERE server_id=? AND file_id=?',
      )
      .all('server', 2114) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('books_server_file_idx'))).toBe(true);
  });
});
