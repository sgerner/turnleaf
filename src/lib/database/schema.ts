export const V8_MIGRATION_VERSION = 8;

export const V8_BOOK_COLUMNS = [
  { name: 'file_id', definition: 'INTEGER' },
  { name: 'file_name', definition: 'TEXT' },
  { name: 'remote_file_size', definition: 'INTEGER' },
  { name: 'downloaded_bytes', definition: 'INTEGER' },
  { name: 'downloaded_pages', definition: 'INTEGER' },
  { name: 'chapter_key', definition: 'TEXT' },
  { name: 'chapter_epub_index', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'multi_file_chapter', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'sync_progress', definition: 'INTEGER NOT NULL DEFAULT 1' },
] as const;

export const V8_BOOK_INDEX_NAME = 'books_server_file_idx';

export const V8_BOOK_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS books_server_file_idx ON books(server_id, file_id);';

export const migrations = [
  {
    version: 1,
    statements: `
      CREATE TABLE IF NOT EXISTS server_config (
        id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        kavita_version TEXT,
        last_connected_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY NOT NULL,
        server_id TEXT NOT NULL,
        library_id INTEGER NOT NULL,
        series_id INTEGER NOT NULL,
        volume_id INTEGER NOT NULL,
        chapter_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        series TEXT,
        description_html TEXT,
        cover_path TEXT,
        format TEXT NOT NULL,
        metadata_refreshed_at TEXT NOT NULL,
        download_path TEXT,
        download_status TEXT NOT NULL DEFAULT 'none',
        file_size INTEGER,
        FOREIGN KEY(server_id) REFERENCES server_config(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS reading_state (
        book_id TEXT PRIMARY KEY NOT NULL,
        cfi TEXT NOT NULL,
        kavita_xpath TEXT,
        percentage REAL NOT NULL,
        chapter_label TEXT,
        spine_href TEXT,
        local_updated_at TEXT NOT NULL,
        synced_local_updated_at TEXT,
        server_page_num INTEGER,
        server_xpath TEXT,
        server_updated_at TEXT,
        pending_sync INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sync_queue (
        book_id TEXT PRIMARY KEY NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 2,
    statements: `
      ALTER TABLE books ADD COLUMN pages INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE books ADD COLUMN pages_read INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE books ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE books ADD COLUMN last_read_at TEXT;
    `,
  },
  {
    version: 3,
    statements: `
      CREATE TABLE preferences (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    statements: `
      ALTER TABLE books ADD COLUMN remote_available INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 5,
    statements: `
      CREATE INDEX IF NOT EXISTS books_server_title_idx ON books(server_id, title, id);
    `,
  },
  {
    version: 6,
    statements: `
      ALTER TABLE sync_queue ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 7,
    statements: `
      ALTER TABLE reading_state ADD COLUMN sync_revision INTEGER NOT NULL DEFAULT 0;
      UPDATE reading_state SET sync_revision=COALESCE(
        (SELECT revision FROM sync_queue WHERE sync_queue.book_id=reading_state.book_id), 0
      );
    `,
  },
  {
    version: V8_MIGRATION_VERSION,
    statements: `
      ALTER TABLE books ADD COLUMN file_id INTEGER;
      ALTER TABLE books ADD COLUMN file_name TEXT;
      ALTER TABLE books ADD COLUMN remote_file_size INTEGER;
      ALTER TABLE books ADD COLUMN downloaded_bytes INTEGER;
      ALTER TABLE books ADD COLUMN downloaded_pages INTEGER;
      ALTER TABLE books ADD COLUMN chapter_key TEXT;
      ALTER TABLE books ADD COLUMN chapter_epub_index INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE books ADD COLUMN multi_file_chapter INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE books ADD COLUMN sync_progress INTEGER NOT NULL DEFAULT 1;
      ${V8_BOOK_INDEX_SQL}
    `,
  },
] as const;
