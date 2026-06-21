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
] as const;
