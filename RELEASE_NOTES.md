# Release Notes

## Unreleased

- GitHub Android release builds now publish versioned APK tags and version codes so the in-app update banner can detect them.
- Library "Mark as read" now queues a Kavita progress update instead of only changing local state.
- Reader safe-area layout now keeps EPUB text clear of the camera notch and status bar.
- Optional native reader helpers no longer block EPUBs from opening if they fail.

## 0.1.3

- Reader mode now hides the native status bar on supported devices.
- Android reader mode now supports hardware volume buttons for page turns.
- iOS has matching scaffolding for the same reader hardware-button behavior where the platform allows it.
