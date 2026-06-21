# Turnleaf Architecture

## Product boundary

Turnleaf is a local Capacitor application for text-based EPUB books on Kavita. It has no server component and deliberately excludes comics, manga, PDFs, magazines, and audio.

## Shape

The app uses plain Svelte 5 and Vite. A small in-memory navigator switches among onboarding, library, book details, reader, and settings. Durable state lives in SQLite; credentials live only in native secure storage; downloaded EPUBs live in Capacitor's app-private data directory.

Domain modules are intentionally direct:

- `kavita`: one typed HTTP client and response mappers.
- `database`: ordered SQL migrations and explicit queries.
- `credentials`: a native Keychain/Keystore adapter with no production web fallback.
- `downloads`: native file transfer plus atomic status updates.
- `reader`: one epub-js book/rendition owner, appearance, and semantic location conversion.
- `sync`: local-first writes, a coalesced queue, and event-driven reconciliation.

Svelte components call these modules directly. There is no repository layer, dependency injection, event bus, service locator, periodic worker, or global mega-store.

## Data flow

1. Authenticate with a Kavita auth key and retain the returned JWT only in secure storage.
2. Fetch book-library metadata through the typed client and transactionally refresh the SQLite cache.
3. Render library screens from SQLite so startup and browsing remain useful offline.
4. Download an EPUB directly to a temporary app-private file, verify it, rename it, then mark it available in SQLite.
5. Open the native file through a Capacitor WebView-safe URL. EPUB content remains in a sandboxed iframe with scripts disabled.
6. Save the current EPUB CFI locally after meaningful movement. Coalesce the corresponding Kavita payload into one queue row per book.
7. Flush on connectivity restoration, app backgrounding, chapter changes, and an idle deadline. Never poll.

## Progress model

EPUB CFI is the authoritative local locator. Kavita's current `ProgressDto` stores `pageNum`, `bookScrollId`, and `lastModifiedUtc`; Kavita's own reader uses a descoped XPath for `bookScrollId`. Turnleaf derives an XPath from the CFI range for server interoperability and retains its CFI locally for exact restoration.

Conflict detection compares local and server changes with the last successfully shared state. If both changed, the user chooses the local or Kavita location. Percentage alone is never used to resolve a conflict.

## Lifecycle and power

Only the active reader session owns EPUB resources and listeners. Closing it destroys the rendition and book and revokes temporary URLs. Reader controls use one rescheduled timeout. Network and sync work is event-driven; there are no intervals, animation loops, WebSockets, or continuous background services.

## Riskiest boundaries

- Kavita's XPath and page calculation must be validated against a real supported server version.
- The maintained epub-js fork must restore CFI and convert CFI to a stable XPath across repagination.
- Capacitor's converted private-file URL must be readable by EPUB.js on Android and iOS without loading the archive into JavaScript memory.
- SQLite and secure-storage native plugins require device-level verification on both platforms.
