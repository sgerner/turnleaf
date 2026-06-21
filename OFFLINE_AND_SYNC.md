# Offline and Sync

## Storage

- SQLite database: Capacitor Community SQLite app-private database named `turnleaf`.
- EPUB files: `Directory.Data/books/<book-id>.epub`.
- Incomplete files: the same path with `.partial`; deleted on failure.
- Credentials: Android Keystore-backed encrypted SharedPreferences or iOS Keychain, under the `turnleaf_` prefix.
- Covers: planned app-private cache; not browser cache.

## Download rule

A native file transfer writes directly to `.partial`, the app verifies a nonempty native file, renames it, then permits SQLite to mark it available. Startup/open must call `verifyDownloadedEpub`; a missing file becomes unavailable rather than producing a false offline promise.

## Progress rule

Every meaningful relocation is saved locally first using EPUB CFI, percentage, spine location, XPath, and timestamp. The queue has one row per book; a newer payload replaces the older payload without resetting retry history.

Flush triggers are connectivity restoration, app backgrounding, chapter change, and one rescheduled idle deadline. There is no interval, poll, WebSocket, or background service.

Reconciliation compares local and server locations with the last shared state. If both changed, reading pauses for an explicit choice. The furthest percentage never wins automatically.

Kavita's `bookScrollId` is currently a content XPath. Turnleaf keeps CFI locally and sends a compatible XPath only after device/server validation confirms conversion for that EPUB.
