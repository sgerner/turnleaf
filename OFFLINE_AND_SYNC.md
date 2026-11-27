# Offline and Sync

## Storage

- SQLite database: Capacitor Community SQLite app-private database named `turnleaf`.
- EPUB files: `Directory.Data/books/<book-id>.epub`.
- Incomplete files: the same path with `.partial`; deleted on failure.
- Credentials: Android Keystore-backed encrypted SharedPreferences or iOS Keychain, under the `turnleaf_` prefix.
- Covers: server-scoped app-private cache under `Directory.Data/covers`; browser previews use revocable object URLs.

## Download rule

A native file transfer writes directly to `.partial`, the app verifies a nonempty native file, renames it, then permits SQLite to mark it available. Startup/open must call `verifyDownloadedEpub`; a missing file becomes unavailable rather than producing a false offline promise.

## Progress rule

Every meaningful relocation is saved locally first using EPUB CFI, percentage, spine location, XPath, and timestamp. The queue has one row per book; a newer payload replaces the older payload without resetting retry history.

Flush triggers are connectivity restoration, app backgrounding, chapter change, and one rescheduled idle deadline. There is no interval, poll, WebSocket, or background service.

Reconciliation compares local and server locations with the last shared state. If both changed, reading pauses for an explicit choice. The optional **Auto-sync furthest read** setting (and the explicit reader action) may choose the furthest compatible location by Kavita XPath or percentage; with that setting off, a non-conflicting server position is preferred.

## Metadata refresh rule

Startup, connectivity restoration, and auth-key updates flush pending reading progress first, reconcile a complete Kavita metadata snapshot, and then retry any remapped sync items.

Only a fully fetched, successfully mapped Kavita metadata snapshot reconciles the local book rows. When a complete snapshot replaces chapter or series IDs unambiguously (1-to-1 by chapter lineage key or normalized title/series/author), Turnleaf atomically transfers saved reading state, queued progress payloads, bookmarks, annotations, location history, and offline download paths to the replacement book record. Ambiguous multi-book changes and partial snapshots (`preserveMissing`) are left unmerged.

An unmapped missing remote book is removed only when it holds no local download, reading state, queued sync item, bookmarks, or annotations; otherwise it is kept in the library and marked unavailable remotely. Downloaded books track their downloaded byte and page baselines (`downloaded_bytes`, `downloaded_pages`) against `remote_file_size` and remote `pages` so in-place or remapped EPUB upgrades are flagged for one-tap update without truncating offline spine progress. Empty, partial, failed, or cancelled fetches leave the previous local library unchanged.

Kavita's `bookScrollId` is currently a content XPath. Turnleaf keeps CFI locally and sends a compatible XPath only after device/server validation confirms conversion for that EPUB.
