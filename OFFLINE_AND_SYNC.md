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

## Annotations, bookmarks, and history rule

Highlights, notes, and bookmarks live in cascading server-scoped tables (`annotations` and `bookmarks`) rather than unindexed preferences, so removing a server deletes every local study row and queued edit for that server. Edits save locally immediately (`pending_create`, `pending_update`, `pending_delete`) and flush through the same event-driven `flushProgress` pipeline without background polling or cloud relays.

Opening a book or manually syncing reconciles remote Kavita annotations (`/api/Annotation/*`) and personal table-of-contents bookmarks (`/api/Reader/ptoc`, `/api/Reader/create-ptoc`) using XPath locators while preserving unsynced local edits. Recent page history (`reading_history`) remains device-local and server-scoped because Kavita provides no history trail endpoint.

## Metadata refresh rule

Only a fully fetched, successfully mapped Kavita metadata snapshot reconciles
the local book rows. A missing remote book is removed when it has no local
download, no saved reading position or pending progress, and no saved
annotations or bookmarks; a downloaded or annotated book is kept and marked
unavailable remotely so its offline file and saved notes remain accessible.
Pending progress is also retained and remains queued for retry. Empty, partial,
failed, or cancelled fetches leave the previous local library unchanged.

Kavita's `bookScrollId` is currently a content XPath. Turnleaf keeps CFI locally and sends a compatible XPath only after device/server validation confirms conversion for that EPUB.
