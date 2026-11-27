# Kavita API Notes

Research date: 2026-06-20. Source of truth: Kavita's published `develop` OpenAPI document, current source, and the supplied running server.

## Authentication

Kavita supports user-created auth keys through the `x-api-key` header. Turnleaf stores the key only in Android Keystore-backed secure storage or iOS Keychain and never in SQLite, localStorage, logs, or diagnostics.

## Initial endpoints

- `GET /api/Health`: reachability.
- `GET /api/Library/libraries`: user-visible libraries; retain only book libraries.
- `POST /api/Series/v2`: paginated filtered series retrieval.
- `GET /api/Series/series-detail`: volume, special, chapter, and file metadata.
- `GET /api/Download/chapter`: EPUB download by `chapterId`.
- `GET /api/Reader/get-progress`: current `ProgressDto` by `chapterId`.
- `POST /api/Reader/progress`: save `ProgressDto`.
- `GET /api/Image/series-cover`: cover retrieval.
- `GET /api/Search/search`: server search.

## Progress caveat

`ProgressDto` requires `libraryId`, `seriesId`, `volumeId`, `chapterId`, and `pageNum`; it optionally returns `bookScrollId` and includes `lastModifiedUtc`. For EPUBs, Kavita maps `pageNum` to the zero-based spine chapter index (`0 .. pages - 1`) during reading and `pages` (with `bookScrollId = null`) when completed, while `bookScrollId` carries a chapter-scoped content XPath (`//body/...` or `id("...")/...`) without a `DocFragment[N]` wrapper. When no `AppUserProgress` record exists yet, Kavita's `SaveReadingProgress` skips creating one if `pageNum === 0`, so Turnleaf bootstraps `pageNum = 1` before persisting non-zero progress inside chapter index `0`. Turnleaf never sends a raw EPUB CFI in `bookScrollId`.

The exact mapping from Kavita's calculated EPUB page to EPUB.js percentage is not specified by OpenAPI. Turnleaf uses the renderer's percentage when available and otherwise derives a stable spine-and-page approximation; XPath is the semantic cross-device locator and CFI remains the authoritative local locator.

The supplied server confirmed that standalone EPUBs may appear in `series-detail.specials`, format value `3` identifies EPUB, and `Reader/get-progress` returns the expected progress DTO. The key later returned HTTP 401, preventing a final acknowledgement check after the offline queue test.

Kavita's series-cover route is the confirmed exception to header authentication: Kavita's own UI supplies `apiKey` as a query parameter and the tested server returns 404 for header-only access. Turnleaf uses that URL only inside native File Transfer with bridge logging disabled, immediately caches the result in app-private storage, and never persists or exports the URL.

## Version handling

The authentication response includes `kavitaVersion`. The client records it for diagnostics, treats unknown response fields as forward-compatible, and reports missing required fields as an unsupported-server response rather than silently inventing values.
