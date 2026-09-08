# Release Notes

## Unreleased

- docs: add future implementation work plan
- Harden the browser development proxy with loopback and HTTPS origin controls, bounded requests, filtered credentials, and safe upstream failure handling.
- Preserve newer local reading progress when an older sync upload completes.
- Add an Android SDK preflight that explains missing local SDK configuration before Gradle builds.
- Virtualize large library grids while preserving stable book ordering and touch scrolling.
- Load library covers with bounded concurrency, cancel stale refresh work, and clean up browser cover URLs.
- Make native library metadata refreshes transactional so failed updates leave the saved library unchanged.
- Add a retry-first local-data recovery path with an explicit reset warning that preserves downloaded EPUB files.
- Propagate the resolved Android SDK to Capacitor and Gradle builds, validate installed packages and Java compatibility, and report actionable preflight failures.
- Make native reading progress, completion, sync acknowledgement, and migrations transactional.

## 0.3.2

- Generate clean GitHub release notes without npm command output.

## 0.3.1

- Guard library startup teardown and limit concurrent Kavita detail requests for large libraries.

## 0.3.0

- Add a monochrome e-ink theme with light and dark reading modes.
- Add a setting to keep the screen awake while reading, with native controls restored when a book closes or another book opens.
- Register Android reader plugins so immersive mode and volume-button paging work reliably.
- Keep book text inside Android safe-area insets and preserve the reader bottom margin.
- Refresh library progress and Continue Reading after page turns, including when returning from the reader offline.
- Discover every EPUB in numbered Kavita series volumes and avoid duplicate entries without changing existing local book IDs.
- Keep each volume's reading progress separate so unread volumes do not inherit series progress.
- Support Kavita Light Novel libraries, including illustrated EPUBs.
- Add a local Kavita Docker Compose environment and sample EPUB for development.
- Update DOMPurify and the EPUB XML parser to patched releases.
- Update Svelte, Vite, linting and formatting tools, GitHub Actions, and the Android Gradle toolchain.
- Load all Kavita series pages so large libraries do not silently omit books after the first 500 series.

## 0.2.0

- Keep Kavita auth keys out of cover and download URLs by using authenticated headers for those requests.
- Disable Android app-data backup and narrow the Android FileProvider path used by the app.
- Show a persistent warning when a saved Kavita server uses plain HTTP.
- Add diagnostic redaction helpers and tests for common secret fields and auth query parameters.
- Add production dependency audit to pull-request CI.
- Restore cross-device reading from Kavita's precise EPUB XPath instead of its coarse page ratio.
- Convert Kavita EPUB paths into canonical CFIs so first-open restores land on the saved semantic location.
- Improve progress sync across edge cases
- Restore Kavita reading positions without immediately writing transient page-one locations back to the server.
- Restore from Kavita's global book progress first, with its EPUB XPath as a fallback.
- Calculate Kavita progress from the EPUB spine and page instead of EPUB.js's chapter-local percentage.
- Prevent ordinary reader navigation and manual sync from accidentally marking books as completed.
- Retry a failed Kavita progress read once and fall back to cached library progress instead of page one.
- fix: restore kavita epub locations
- Restore Kavita EPUB locations through namespaced XHTML and fall back to server page progress when an exact locator cannot be resolved.
- fix: handle fresh install startup and kavita resume
- Serialize native SQLite startup and avoid preference writes during boot so fresh installs do not begin with inaccessible local data.
- Parse native Android Kavita JSON responses and fall back to Kavita page progress when no EPUB XPath is available.
- fix: make continue card clickable
- Make the entire Continue Reading card open the current book.
- fix: sync reader with kavita on open
- Prefer Kavita's saved EPUB location on book open when this device has no unsent local progress.
- Slightly increase the reader bottom margin to clear the gesture navigation bar
- fix: update android launcher icon

## 0.1.7

- Improve onboarding style and layout
- Improve reader margin
- fix: align release versioning
- Release APKs now embed the full `x.y.z+build` version so the update banner does not falsely appear on the latest installed release.
- chore: release 0.1.6

## 0.1.6

- Preserve and restore Kavita EPUB progress at the correct spine section and nearby text location across devices.
- Prevent the reader's initial page-one event from overwriting saved progress while a location is restoring.
- Resume from newer Kavita progress when the current device has no unsynced reading changes.
- Make the auto-sync furthest setting authoritative for every normal book open.
- Reset visible release versions
- Add local data reset recovery
- Fix Android volume key paging

- Add a startup reset path that clears corrupted local SQLite state without deleting downloaded EPUB files.

## 0.1.5

- Restore reader status bar hiding on Android and add a native reader chrome toggle.
- Reapply Android reader immersive mode on resume and window focus so the gesture bar stays hidden more reliably.
- Add a small extra bottom EPUB padding to clear the gesture navigation area.
- Fix Android volume buttons so reader paging consumes the key events instead of changing system volume.
- Fix versioned release notes

## 0.1.4

- Mount reader footer independently
- Tighten reader safe areas
- Align prettier plugin 4
- Align Vite 8 and Svelte plugin
- Align ESLint 10 packages
- Switch release notes to post-commit amend
- Add release note commit hook

- GitHub Android release builds now publish versioned APK tags and version codes so the in-app update banner can detect them.
- Library "Mark as read" now queues a Kavita progress update instead of only changing local state.
- Reader safe-area layout now keeps EPUB text clear of the camera notch and status bar.
- Optional native reader helpers no longer block EPUBs from opening if they fail.

## 0.1.3

- Reader mode now hides the native status bar on supported devices.
- Android reader mode now supports hardware volume buttons for page turns.
- iOS has matching scaffolding for the same reader hardware-button behavior where the platform allows it.
