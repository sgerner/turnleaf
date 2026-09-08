# Turnleaf future implementation work plan

Reviewed: 2026-09-07 (America/Phoenix; 2026-09-08 UTC)  
Baseline: `c3c91be` (`master`, Android SDK preflight PR #61)

## Purpose and review limits

This is an implementation backlog based on source inspection, existing product documentation, and independent performance, security, and accessibility reviews. It does not implement the proposed changes. Findings marked **confirmed** describe observable code behavior; **validation needed** means the user-visible impact or security boundary needs a reproduction; **proposal** means a product improvement, not a defect.

Validation during this review: **71 tests passed across 14 files**, and `npm audit --omit=dev --ignore-scripts` reported **zero known production vulnerabilities**. This is not a penetration test, measured performance benchmark, accessibility conformance assessment, or Android/iOS device acceptance run. Audit results are time-sensitive and do not cover every security risk.

Keep the existing product boundary: a local, offline-first Kavita EPUB reader. PDF, comics, manga, audiobooks, a companion backend, and a wholesale framework rewrite are outside this plan. iOS should remain described as unverified until exercised on macOS and real hardware.

Already implemented foundations: library metadata pagination, row virtualization, bounded detail fetching, transactional native metadata UPSERTs, six-worker cover loading with stale-result suppression and blob disposal, secure native credential storage, EPUB script disabling, offline downloads, reading appearance controls, table of contents, Continue Reading, and progress reconciliation. The work below strengthens these foundations rather than proposing them again.

## Priorities and sequencing

- **P1:** fix before the next substantial feature release; protects reading state, security boundaries, or essential interaction.
- **P2:** next improvement cycle; meaningful speed, reliability, or usability benefit.
- **P3:** later product expansion; validate demand first.
- Effort **S**: a focused change; **M**: several modules and integration tests; **L**: a feature or platform effort. These are relative estimates, not delivery promises.

| Phase                                   | Work items   | Exit criteria                                                                                                       |
| --------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1 — Protect saved state                 | R1–R4, T1    | Race/failure reproductions pass; a fresh checkout can run the Android build with a supported SDK setup.             |
| 2 — Make core flows accessible and safe | A1–A3, S1–S4 | Keyboard and TalkBack smoke tests pass; hostile EPUB and transport fixtures have explicit expected outcomes.        |
| 3 — Reduce library and reader overhead  | P1–P4, U1–U2 | Publish before/after measurements on the same device and dataset; loading and failure states remain usable offline. |
| 4 — Improve discovery and reading tools | F1–F3, U3    | Validate prototypes with readers; ship each capability with offline persistence and lifecycle tests.                |
| 5 — Broaden release confidence          | T2–T3, F4    | Native acceptance matrix, documentation, and release readiness checks agree with shipped behavior.                  |

Each numbered item should normally be its own PR. Add regression coverage with the relevant fix, keep `RELEASE_NOTES.md` current, and avoid bundling unrelated visual changes into correctness work.

## Reliability and data integrity

### R1 — Acknowledge only the progress version actually uploaded

**P1 · M · confirmed**

Evidence: [sync.ts](src/lib/sync/sync.ts), `run`, snapshots pending payloads, uploads them, then calls `confirmSync(bookId, ...)`. [database.ts](src/lib/database/database.ts), `getPendingSync` and `confirmSync`, do not carry a queue revision; confirmation deletes by book ID and marks the current local state synchronized.

A relocation arriving while an older request is in flight can replace the queue row; the old request's completion can then remove the newer update. Introduce a monotonic revision or equivalent token carried through upload and conditional acknowledgement. Update the acknowledged baseline from the sent snapshot, not whatever happens to be current. Scope in-flight flushing to server/credential identity so account changes cannot reuse unrelated work.

Acceptance: delay upload A, save B, complete A, and prove B remains pending and is subsequently uploaded. Repeat with failure, duplicate completion, background/foreground events, and credential/server changes on browser and native paths.

### R2 — Commit local reading state and queue changes together

**P1 · M · confirmed**

Evidence: [database.ts](src/lib/database/database.ts), `saveLocalProgress`, `markBookCompleted`, and `confirmSync`, issue multiple independent writes. Metadata refresh transactions do not cover these operations. `migrate` commits schema statements separately from the version update.

Use atomic units for reading state, book progress, and the queue entry; serialize or version rapid relocation writes. Make each migration and its version advancement crash-consistent using the supported SQLite transaction API. Preserve files and reading history on error.

Acceptance: inject failure between every write; reopen the database and verify consistent state and retryability. Test migrations from supported schema versions and interrupted migration recovery. Use actual SQLite integration coverage in addition to mocks that simulate rollback themselves.

### R3 — Recover local data without unnecessary loss

**P1 · M · confirmed behavior; recovery design needed**

Evidence: [App.svelte](src/App.svelte), `repairLocalData`, invokes [database.ts](src/lib/database/database.ts), `resetLocalDatabase`, which deletes the database. Native EPUB files remain, but their associations, preferences, and unsynced reading state can be lost.

Separate transient open failures, migration failures, and confirmed corruption. Offer retry and an explicit explanation of reset consequences; preserve recoverable data before destructive repair. Reconcile orphaned downloads and interrupted `.partial` files using a deterministic file manifest where needed. Do not promise recovery of a corrupt database without a validated strategy.

Acceptance: transient plugin failure does not require reset; reset warning accurately names lost data; recoverable downloads are rediscovered; missing files are never advertised as available offline. Exercise force-stop during download and database upgrade.

### R4 — Reconcile removed books and credential cleanup

**P2 · M · confirmed**

Evidence: [database.ts](src/lib/database/database.ts), `replaceBooksInTransaction`, only upserts and no-ops on an empty list, so successful upstream removals are not reflected in the native library. [Onboarding.svelte](src/lib/components/Onboarding.svelte) saves a key before server configuration; [Library.svelte](src/lib/components/Library.svelte), `deleteServer`, suppresses secure-key removal errors.

Define a policy for books removed from Kavita: hide or mark unavailable remotely while preserving explicitly retained downloads and pending progress. Apply reconciliation only after a complete successful metadata fetch. Add compensating cleanup/retry for credential and database operations that cannot share a transaction; never report successful credential deletion when it failed.

Acceptance: upstream deletion and a genuinely empty library reconcile correctly; a network/auth error does not purge cached books; downloaded books follow the documented retention policy; injected secure-storage or configuration-write failure leaves a recoverable, accurately reported state.

## Performance

### P1 — Harden virtualized scrolling and focus before tuning throughput

**P1 · M · confirmed calculation gap; interaction validation needed**

Evidence: [library-virtualization.ts](src/lib/components/library-virtualization.ts), `calculateVirtualWindow`, clamps the final row but does not clamp `firstRow` to `totalRows - 1`. A large scroll offset after filtering can produce an inverted range. [Library.svelte](src/lib/components/Library.svelte), `rowHeightFor` and the row loop, use fixed text-height estimates and key rows by window offset.

Clamp windows after filtering/resizing, stabilize row identity, and measure or robustly reserve card height under text scaling. Preserve a sensible anchor when returning from the reader or changing filters. Define keyboard and screen-reader navigation beyond the currently mounted rows; provide a tested alternative if windowing cannot expose all results accessibly.

Acceptance: 0, 1, 500, 5,000, and 10,000 books; scrolled-to-end filtering; same-count result replacement; orientation changes; 200% text; one- and two-line titles; return from reader. No invalid ranges, inaccessible remaining books, overlapping cards, or lost focus. DOM count stays proportional to viewport plus overscan.

### P2 — Prioritize visible covers and bound work across refresh generations

**P2 · M · confirmed**

Evidence: [Library.svelte](src/lib/components/Library.svelte), `loadCovers`, queues the entire book collection and copies the cover map on every completion. [cover-loader.ts](src/lib/downloads/cover-loader.ts) bounds each batch, while [native-download.ts](src/lib/downloads/native-download.ts), `cacheCover`, checks cancellation around a transfer without stopping that transfer.

Load Continue Reading and visible/overscan rows first. Deduplicate in-flight native requests across generations, not only within a batch; set a shared concurrency ceiling. Bound cache memory/disk usage, use server-scoped cache keys, and avoid treating nonzero partial cover files as valid. Coordinate clearing/deleting the cache with active transfers. Where the native API cannot abort a transfer, document that limit and wait or discard safely.

Acceptance: repeated refresh/clear-cache actions do not multiply physical transfers or write to the same final path concurrently; scrolling prioritizes new visible rows; corrupt/partial covers retry; removed covers release browser URLs; clearing cache has a clear and tested meaning rather than immediately refilling the entire library.

### P3 — Reduce per-page and metadata-refresh overhead

**P2 · M · confirmed hot paths; speedup requires measurement**

Evidence: [Library.svelte](src/lib/components/Library.svelte), `relocated`, reloads every book after each local progress write; `visibleBooks` filters all books and normalizes the query inside its predicate; `continueBook` sorts candidates. `refresh` fetches every series detail in batches. [session.ts](src/lib/reader/session.ts) can generate EPUB locations for fallback restoration.

Update the changed book in memory or query that row, normalize search once, and select Continue Reading without sorting the full candidate list. Keep exact local progress durable while reducing derived UI work. Pass cancellation through metadata requests and stop scheduling work after teardown. Consider incremental detail refresh only if supported server metadata reliably identifies changes. Profile EPUB parsing and location generation before adding caches or workers; key any cache by book content/version.

Acceptance: no full-library database query on every page turn; last local position survives immediate close/force-stop; metadata cancellation leaves the saved library coherent. Record cold/warm open time, search latency, scroll frame times, native bridge calls, request count, and peak memory on fixed datasets before and after.

### P4 — Index native library queries and measure data transfer costs

**P2 · M · confirmed missing index; optimization requires profiling**

Evidence: [schema.ts](src/lib/database/schema.ts) has no `(server_id, title)` index; [database.ts](src/lib/database/database.ts), `getBooks`, filters and orders by these columns and returns every row. Browser storage reparses/stringifies the entire database object. Native metadata refresh creates one transaction task per book.

Add a justified query index with a migration and verify its use with `EXPLAIN QUERY PLAN`. Measure database time, bridge payload size, and memory at 10,000 books. Consider paged/keyset reads or a bulk native API only where measurements warrant them; preserve metadata atomicity. Batch/cache browser-preview reads before considering a storage-engine replacement. Profile the initial JS/CSS bundle and lazy-load the reader if it materially improves startup.

Acceptance: representative queries use the index and return identical ordering; record refresh/startup timing and peak memory. No batching change reintroduces partial metadata commits or loses offline filtering.

## Security and privacy

### S1 — Validate EPUB network isolation and navigation handling

**P1 · M · validation needed / hardening**

Evidence: [session.ts](src/lib/reader/session.ts), `harden`, removes selected elements and selected anchor schemes; [index.html](index.html) permits HTTP(S) image and connection sources. Scripts are already disabled, but that alone is not proof that remote images, CSS URLs, or alternate navigation forms are contained.

Build malicious EPUB fixtures first. Define whether remote resources are allowed; prefer local archive resources by default with any exceptions made explicit. Normalize navigation with URL parsing, cover protocol-relative/encoded URLs, SVG links and CSS resources, and preserve safe internal chapter/footnote links. Enforce policy before requests where the rendering API permits it; retain iframe script restrictions and CFI access.

Acceptance: fixture books cannot execute scripts or unexpectedly navigate the app; external resource requests match the chosen policy; no auth key is exposed to book content or resource origins. Verify in Android WebView and later WKWebView. Record network traces rather than relying solely on DOM-removal tests.

### S2 — Harden authenticated transport and development-only browser access

**P1 · M · validation needed / hardening**

Evidence: [client.ts](src/lib/kavita/client.ts) sends `x-api-key`; [native-download.ts](src/lib/downloads/native-download.ts) uses authenticated FileTransfer requests. [credentials.ts](src/lib/native/credentials.ts) uses localStorage for all non-native execution. [vite.config.ts](vite.config.ts) contains a development proxy that forwards request headers to a URL supplied in the route.

Test browser/native redirect handling for cross-origin redirects and HTTPS downgrades; implement an explicit safe policy without breaking supported reverse-proxy/subpath setups. Clearly gate persistent browser credentials as a development feature or document a deliberate production browser mode. Restrict the development proxy to the intended local development context and expected server, with timeouts and error handling; do not expose it as an unrestricted network service.

Acceptance: redirected test servers cannot receive credentials unexpectedly; invalid schemes and downgrade attempts fail clearly; browser-mode warnings and persistence match documentation; proxy tests cover malformed targets, connection failure, and forbidden destinations. Preserve intentional LAN Kavita support.

### S3 — Validate downloads and server payloads at trust boundaries

**P2 · M · confirmed weak validation; abuse impact requires testing**

Evidence: [native-download.ts](src/lib/downloads/native-download.ts) accepts downloaded EPUBs based on file type/size of at least 22 bytes. [client.ts](src/lib/kavita/client.ts) largely casts JSON responses to TypeScript types.

Validate minimum EPUB container structure before marking a download available, with bounded archive inspection and practical limits for file size, entry count, expanded size, and malformed paths. Validate critical server response fields and pagination shape; reject repeated/malformed pages without erasing a usable offline library. Keep validation lightweight and avoid reading large archives wholesale into JavaScript solely for verification.

Acceptance: HTML error bodies, truncated ZIPs, malformed containers, invalid metadata, and repeated pagination fail predictably; legitimate illustrated EPUBs still work; failed imports leave no available-book marker or abandoned final file.

### S4 — Validate update links and strengthen release provenance

**P2 · S–M · confirmed URL-validation gap; pipeline hardening proposal**

Evidence: [releases.ts](src/lib/github/releases.ts), `buildBanner` and `pickDownloadUrl`, return API-provided URLs directly to [App.svelte](src/App.svelte) links. [android-release.yml](.github/workflows/android-release.yml) publishes on default-branch pushes with job-wide write permissions; it does not run the full PR audit/test suite. Workflow actions use version tags.

Validate update link schemes and expected GitHub repository/asset origins before rendering them. Add malformed/foreign-URL fixtures. Ensure the exact release revision passes the required quality gates before publication, isolate publishing permissions, and consider verified SHA-pinned actions with automated updates. Evaluate a protected tag/manual release policy as a product/workflow decision rather than silently changing automatic releases. Retain Android package signing; checksums may supplement provenance but are not a replacement for signature verification.

Acceptance: unsafe or foreign update URLs are omitted; failed validation cannot publish; signing material is only available to the job that needs it; release artifacts and notes identify the tested revision. Do not claim an in-app verified installer when the app only opens a download link.

## Accessibility, usability, and UI/UX

### A1 — Give overlays complete modal and focus behavior

**P1 · M · confirmed markup gap; assistive-technology validation needed**

Evidence: [Library.svelte](src/lib/components/Library.svelte) renders settings, actions, and conflict overlays as ordinary sections/divs; [Reader.svelte](src/lib/components/Reader.svelte) renders appearance and contents panels. Labels alone do not provide focus containment or restore focus when virtual rows disappear.

Use appropriate dialog semantics, accessible names, initial focus, background inertness, Escape/platform Back behavior, and focus restoration. Keep non-modal panels intentionally non-modal if that is the design. Make reader errors and long-running actions announce meaningful status without announcing every page movement excessively.

Acceptance: keyboard-only open/use/close, tab containment for modals, screen-reader title announcement, and sensible restored focus after filtering/deletion. Test nested confirmation states and reader iframe focus with TalkBack plus desktop keyboard.

### A2 — Improve touch targets, text scaling, and theme readability

**P1 · M · confirmed small controls; visual measurements needed**

Evidence: [Library.svelte](src/lib/components/Library.svelte) includes action buttons sized `h-7 w-7` and header controls `h-8 w-8`; the virtual grid reserves fixed text height. Many themes and light/dark combinations are exposed.

Increase interactive hit areas while keeping the visual design compact; use a product target of at least 44 × 44 CSS pixels for primary touch controls. Check focus indicators, selected-state cues beyond color, truncation, contrast, and safe areas across supported themes. Expose selected reader modes with `aria-pressed` and connect panel toggles with `aria-controls`. Retain the existing reduced-motion CSS and verify Svelte transitions and e-ink behavior as well.

Acceptance: small phone, tablet, landscape, 200% text, keyboard focus, light/dark/e-ink checks; no overlap or clipped essential controls. Record measured contrast results and fix failing combinations; do not claim accessibility conformance from automated checks alone.

### A3 — Preserve access to EPUB content and navigation

**P1 · M · validation needed**

Evidence: [Reader.svelte](src/lib/components/Reader.svelte) overlays page-navigation tap zones over iframe content; [session.ts](src/lib/reader/session.ts) owns content click behavior.

Test selection, footnotes, links, screen-reader reading order, and keyboard page turns. Provide an accessible controls mode when gesture/tap interception prevents content interaction. Make the current chapter/location available to assistive technology without forcing visual controls to stay open.

Acceptance: a reader can read content continuously with TalkBack, open a footnote and return, select text where supported, navigate chapters, and close the reader without a touch-only dependency.

### U1 — Expose sync, connection, and download state clearly

**P2 · M · confirmed**

Evidence: [Library.svelte](src/lib/components/Library.svelte) swallows several sync errors, treats refresh failures generically as offline, and tracks a single downloading book. [sync.ts](src/lib/sync/sync.ts) stops a batch at its first failure.

Separate offline, timeout, rejected credentials, storage-full, corrupt-book, and sync-conflict states. Show pending/failed sync with last successful sync and a manual retry action. Add download progress and cancellation where supported, plus a bounded queue only after the single-download path is reliable. Define backoff and per-item failure behavior so one bad record does not silently starve all others.

Acceptance: airplane mode, 401/403, timeout, disk-full, and one permanently failing queue item each have clear recovery paths; no lost local progress; repeated retry taps do not duplicate work. Depend on R1/R2 for trustworthy sync status.

### U2 — Make destructive storage actions understandable and recoverable

**P2 · S–M · confirmed**

Evidence: [Library.svelte](src/lib/components/Library.svelte), `removeAllDownloads`, deletes in a loop; individual removal suppresses filesystem errors. Cache clear starts cover loading again. Server deletion has a separate confirmation flow.

Show affected book count and storage estimate before bulk removal. Explain the distinction between local files, local reading state, credentials, and server-side data. Report partial failures honestly, and offer undo only where the data has actually been retained. Align reset, server deletion, cache clearing, and download removal terminology.

Acceptance: cancel changes nothing; failed file deletion is reported accurately; metadata/file state remains consistent; no operation claims to clear storage while immediately refilling it without explanation.

### U3 — Simplify settings and first-run guidance

**P2 · S–M · proposal**

Evidence: [Library.svelte](src/lib/components/Library.svelte) combines themes, sync preferences, credentials, and storage controls in one large settings panel; [Onboarding.svelte](src/lib/components/Onboarding.svelte) owns connection setup.

Group reading appearance, connection, sync, and storage into clearly labeled sections. Explain the consequences of “Auto-sync furthest read,” and distinguish it from ordinary progress upload. Offer concise first-run page-navigation/offline-download guidance and a preview for appearance changes. Preserve expert controls without requiring all readers to understand CFI or server payload details.

Acceptance: usability sessions show readers can connect, download, resume offline, recover rejected credentials, and explain the chosen sync behavior without external instructions.

## Missing features to validate and implement

These are proposals within the EPUB/Kavita scope, not statements that the current app is broken.

| ID  | Priority / effort | Opportunity and code context                                                                                                                                                                                                                                     | Minimum acceptance criteria                                                                                                                                                                                                             |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | P2 / M            | Better discovery: persistent sort order, library/author/series filters, result count, clear filters, and optional compact list view. Current `visibleBooks` in [Library.svelte](src/lib/components/Library.svelte) provides text/downloaded/completed filtering. | Stable ordering online/offline; persisted preferences; accessible empty state; large-library performance and focus tests. Coordinate with P1/P3.                                                                                        |
| F2  | P2 / M            | Bookmarks and return-to-location history in [Reader.svelte](src/lib/components/Reader.svelte), [session.ts](src/lib/reader/session.ts), and [schema.ts](src/lib/database/schema.ts).                                                                             | Local CFI-based bookmarks survive restart and repagination; rename/delete and return after TOC jumps work offline. Do not imply Kavita bookmark sync without API validation.                                                            |
| F3  | P3 / L            | Search within an EPUB, followed by optional highlights/notes. The current reader exposes TOC but no book-text search/annotation workflow.                                                                                                                        | Cancellable bounded indexing; results navigate to exact content; selection remains accessible; local notes survive restart and can be exported. Prototype before committing to annotation sync.                                         |
| F4  | P2 / L            | iOS readiness as a validation milestone, not an assumption. See [IOS_BUILD.md](IOS_BUILD.md).                                                                                                                                                                    | macOS build plus real-device secure storage, SQLite migration, downloads, offline reopen, safe areas, VoiceOver, lifecycle restoration, backup/privacy behavior, and distribution/signing checks. Release only after the matrix passes. |

## Engineering and delivery enablers

### T1 — Make Android preflight readiness agree with Gradle

**P1 · M · confirmed**

Evidence: [check-android-sdk.mjs](scripts/check-android-sdk.mjs) discovers platform defaults and prints success but does not pass the discovered SDK to subsequent commands. A child process cannot export variables into its parent npm shell. It also accepts any build-tools directory entry and hardcodes API 36. [package.json](package.json) invokes doctor as a separate process before the build.

Provide a build wrapper that passes the validated SDK environment to its child build, or require explicit configuration and print the discovered path as a suggestion. Never report an unusable default as ready. Respect explicit configuration and diagnose stale/conflicting paths. Derive required platform/build tools from build configuration or a shared source; check real package/tool presence and Java compatibility. Keep installation and license acceptance explicit. Update CI to exercise the preflight too; its current direct Gradle step bypasses it.

Acceptance: fresh clone with no local.properties/env but an installed default SDK; stale sdk.dir; conflicting variables; incomplete install; paths with spaces; missing Java; valid configured SDK. Execute a real Gradle build from the fresh-clone case and test failure before Capacitor sync. Local setup in `.zprofile` remains useful, but cannot substitute for portable repo behavior.

### T2 — Add integration tests and a reproducible performance baseline

**P2 · M · proposal grounded in coverage gaps**

Evidence: [vite.config.ts](vite.config.ts) uses jsdom tests; current suites mainly cover helpers and mocks. [ci.yml](.github/workflows/ci.yml) builds Android but does not exercise native app flows.

Add browser component/E2E coverage with deterministic 500/5,000/10,000-book fixtures, delayed network responses, and malformed EPUB fixtures. Add actual SQLite transaction tests and a small Android emulator smoke suite for offline reopen, progress durability, lifecycle, and secure storage. Define performance budgets only after collecting baseline measurements on named hardware; keep a fixed reference EPUB set and record cold/warm conditions. Test Windows/macOS tooling only if claiming support.

Acceptance: CI fails on the R1 race and P1 window/focus regressions before fixes, passes after; device smoke tests exercise native plugins; benchmark artifacts show dataset, hardware, sample count, and before/after timings. Avoid brittle wall-clock unit-test thresholds.

### T3 — Align documentation, release checks, and implementation

**P2 · S · confirmed drift**

Evidence: [ARCHITECTURE.md](ARCHITECTURE.md) describes JWT authentication and no web credential fallback, while the implementation uses an auth-key header and a browser fallback; [OFFLINE_AND_SYNC.md](OFFLINE_AND_SYNC.md) still calls covers planned and says furthest never wins automatically; [SECURITY.md](SECURITY.md) names an older xmldom override than [package.json](package.json).

Reconcile claims with code and validated behavior, especially sync triggers, reset consequences, browser security, SDK setup, and platform support. Generate or validate version-dependent release facts where practical. Keep production audit, dependency review, CodeQL, and native builds; evaluate development-dependency findings separately rather than presenting the production audit as complete coverage.

Acceptance: documentation walkthrough from clean install to offline reading matches the app; referenced package versions agree with the lockfile; release notes distinguish implementation from device verification; a release checklist records remaining platform limitations.

## Implementation status

The remaining implementable items from this plan are split into focused pull requests:

- F1 residual discovery controls: [#89](https://github.com/sgerner/turnleaf/pull/89).
- F3 in-book search: [#90](https://github.com/sgerner/turnleaf/pull/90); local highlights, notes, and Markdown export: [#91](https://github.com/sgerner/turnleaf/pull/91).
- S2 authenticated redirect hardening: [#92](https://github.com/sgerner/turnleaf/pull/92).
- T2 real SQLite transaction coverage: [#93](https://github.com/sgerner/turnleaf/pull/93); Android emulator startup smoke: [#94](https://github.com/sgerner/turnleaf/pull/94).
- Android accessibility, network-isolation, and offline-reopen procedure: [DEVICE_VALIDATION.md](DEVICE_VALIDATION.md) and [#95](https://github.com/sgerner/turnleaf/pull/95).
- P4 native library query index and query-plan coverage: [#96](https://github.com/sgerner/turnleaf/pull/96).

Automated checks cover the code paths available in this environment. TalkBack behavior, WebView network traces, and named-device performance measurements still require an Android device or a completed emulator acceptance run; record those results with the checklist. iOS readiness and the deferred product decisions remain intentionally outside this implementation batch.

## Deferred product decisions

- Multi-server profiles: onboarding currently uses a fixed `primary` identity. Validate demand before expanding it; first require server-scoped queues, cache keys, credentials, and offline data isolation.
- Local backup/export: prioritize bookmarks/notes and unsynced-progress recovery over exporting credentials. Define encryption, restore compatibility, and EPUB redistribution boundaries before adding a full backup feature.
- Rich book details: descriptions are stored but not rendered. If adding a details screen, sanitize HTML at the render boundary and test hostile descriptions; the presence of a DOMPurify dependency alone does not protect a future HTML renderer.
- Transport policy: global native HTTP allowances currently support explicitly accepted LAN servers. Evaluate a stricter default only with a feasible exception design and migration path; do not remove documented LAN support casually.

## Recommended first implementation batch

1. R1: preserve newer queued progress during acknowledgement.
2. R2: atomic local progress and migration bookkeeping, with real SQLite failure tests.
3. T1: portable Android build environment propagation and realistic SDK validation.
4. P1 + A1 in separate coordinated PRs: valid virtual windows, stable focus, and modal behavior.
5. S1/S2: security fixtures first, then narrowly scoped hardening based on observed behavior.

Before each PR: reproduce the issue, agree on observable acceptance criteria, and inspect the current branch because this plan refers to a fixed baseline. After each PR: run relevant checks, update release notes, and mark this plan's item with the implementation PR and measured outcome. Completion means the acceptance criteria passed, not merely that code was added.
