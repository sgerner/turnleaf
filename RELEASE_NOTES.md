# Release Notes

## Unreleased

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
