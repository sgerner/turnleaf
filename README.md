# Turnleaf

Turnleaf is a local, offline-first mobile EPUB reader for Kavita. It uses Svelte 5, Vite, Skeleton UI, Capacitor, SQLite, app-private files, and native secure credential storage. It has no application server.

Only conventional text-based EPUB books are in scope. Manga, comics, PDFs, magazines, image-based readers, and audiobooks are intentionally unsupported.

## Status

The application includes secure onboarding, books-only Kavita browsing, cached metadata, atomic app-private EPUB downloads, paginated EPUB.js reading, CFI restoration, appearance controls, a coalesced offline sync queue, conflict handling, diagnostics, and Android/iOS Capacitor projects.

Android API 36 emulator tests covered authenticated library mapping and download, page turns, force-stop persistence, airplane-mode library access, and offline CFI reopen. The supplied test key later began returning HTTP 401, so final server acknowledgement of the queued progress update could not be re-verified. iOS is scaffolded and synchronized but cannot be compiled on Linux.

## Commands

```bash
npm install
npm run dev
npm run format
npm run format:check
npm run lint
npm run check
npm test
npm run build
npm run cap:sync
npm run android:open
ANDROID_HOME="$HOME/Android/Sdk" npm run android:debug
ANDROID_HOME="$HOME/Android/Sdk" npm run android:release
npm run ios:sync
npm run ios:open
```

See [ARCHITECTURE.md](ARCHITECTURE.md), [OFFLINE_AND_SYNC.md](OFFLINE_AND_SYNC.md), [SECURITY.md](SECURITY.md), [ANDROID_BUILD.md](ANDROID_BUILD.md), and [IOS_BUILD.md](IOS_BUILD.md).
