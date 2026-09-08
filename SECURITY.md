# Security

- Native auth keys never enter localStorage, SQLite, diagnostics, or logs.
- Native credentials use `@aparajita/capacitor-secure-storage`: Android AES-GCM with a Keystore key and iOS Keychain without iCloud synchronization.
- API keys use the `x-api-key` header and are not placed in Kavita cover or download URLs.
- EPUBs and SQLite live in app-private storage.
- Android backup and device-transfer extraction are disabled for app data so downloaded books, cached covers, and local reading state are not copied into Android cloud backup.
- The Android `FileProvider` is not exported and is limited to a private cache subdirectory.
- The application CSP disallows inline scripts, objects, forms, and arbitrary script origins.
- EPUB rendition iframes omit `allow-scripts`; content hooks remove scripts, nested frames, objects, embeds, and forms and block external link activation.
- `allow-same-origin` is required for semantic range/CFI access. With scripts disabled, book content cannot execute code through that origin.
- External navigation must pass an explicit `http:`/`https:` validator and user action before a system browser is added.
- Kavita HTML descriptions must be passed through DOMPurify before rendering. No component currently renders server HTML.
- Diagnostics must redact `x-api-key`, authorization values, auth query parameters, and secure-storage contents.

HTTP Kavita servers are supported only after a visible warning. Android and iOS transport policy must allow HTTP globally at the native layer, so the UI gate is a product control rather than a cryptographic boundary. HTTPS is the secure configuration.

Browser preview stores its development-only auth key and local database in localStorage. Use the native Android or iOS app for secure credential storage.

Use a dedicated non-administrator Kavita user for Turnleaf. Grant that user access only to the book libraries needed on the device, then create the auth key from that account. A Kavita auth key lets third-party apps act as that Kavita user, so an administrator key has administrator-level blast radius if it is stolen.

Pull requests run formatting, linting, type checking, unit tests, production build, Android debug build, production dependency audit, dependency review, and CodeQL JavaScript/TypeScript analysis.

EPUB.js's transitive `@xmldom/xmldom` dependency is overridden to patched release 0.9.12. Run `npm audit --omit=dev` for the current report; this production-only report does not cover development dependencies.
