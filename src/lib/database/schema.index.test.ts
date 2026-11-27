// @vitest-environment node

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrations } from './schema';

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

  it('adds a server-scoped file index in migration v8 without duplicating columns', () => {
    db = new DatabaseSync(':memory:');
    for (const migration of migrations) {
      db.exec(migration.statements);
    }

    const columns = db.prepare("PRAGMA table_info('books')").all() as Array<{ name: string }>;
    expect(columns.filter((col) => col.name === 'remote_file_size')).toHaveLength(1);
    expect(columns.map((col) => col.name)).toEqual(
      expect.arrayContaining([
        'file_id',
        'file_name',
        'remote_file_size',
        'downloaded_bytes',
        'downloaded_pages',
        'chapter_key',
        'chapter_epub_index',
        'multi_file_chapter',
        'sync_progress',
      ]),
    );

    const indexes = db.prepare("PRAGMA index_list('books')").all() as Array<{
      name: string;
    }>;
    expect(indexes.map((index) => index.name)).toContain('books_server_file_idx');

    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM books WHERE server_id=? AND file_id=?')
      .all('server', 2114) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('books_server_file_idx'))).toBe(true);
  });
});
