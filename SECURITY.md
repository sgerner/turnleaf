# Security

- Native auth keys never enter localStorage, SQLite, diagnostics, or logs.
- Native credentials use `@aparajita/capacitor-secure-storage`: Android AES-GCM with a Keystore key and iOS Keychain without iCloud synchronization.
- API keys use the `x-api-key` header and are not placed in Kavita cover or download URLs.
- EPUBs and SQLite live in app-private storage.
- Android backup and device-transfer extraction are disabled for app data so downloaded books, cached covers, and local reading state are not copied into Android cloud backup.
- The Android `FileProvider` is not exported and is limited to a private cache subdirectory.
- The application CSP disallows inline scripts, objects, forms, arbitrary script origins, and remote HTTP/HTTPS image, style, and font sources, scoping `blob:` and `base-uri 'self'` to same-origin app and unpacked EPUB resources (`https://localhost` on Android and `capacitor://localhost` on iOS).
- EPUB rendition iframes omit `allow-scripts`; spine hooks sanitize chapter markup, subresource attributes, inline styles, and packaged stylesheets (after normalizing CSS tokens and escapes) and prepend a local-only chapter CSP before `iframe.srcdoc` serialization, with rendition content hooks kept as idempotent defense in depth and external link activation blocked.
- The chapter CSP retains `default-src 'none'`, `script-src 'none'`, `connect-src 'none'`, `frame-src 'none'`, `object-src 'none'`, `form-action 'none'`, `manifest-src 'none'`, and `worker-src 'none'` (while `<iframe sandbox="allow-same-origin">` omits `allow-forms` and pre-render sanitization removes `<form>` elements, covering `<meta>` CSP delivery where `form-action` is ignored), permitting only the local capabilities sanitized EPUBs require: `base-uri 'self'` for `epub.js` section base resolution; `style-src 'self' 'unsafe-inline' data: blob:` for sanitized `<style>` blocks, author inline `style` attributes, `epub.js` theme/column pagination styles, and sanitized `blob:`/`data:` stylesheets; and `font-src`, `img-src`, and `media-src` `'self' data: blob:` for packaged archive fonts, images, and audio/video unpacked into same-origin `blob:` or allowlisted `data:` URLs while blocking all remote `http:`/`https:` targets.
- `allow-same-origin` is required for semantic range/CFI access. With scripts disabled, book content cannot execute code through that origin.
- External navigation must pass an explicit `http:`/`https:` validator and user action before a system browser is added.
- Kavita HTML descriptions must be passed through DOMPurify before rendering. No component currently renders server HTML.
- Diagnostics must redact `x-api-key`, authorization values, auth query parameters, and secure-storage contents.

HTTP Kavita servers are supported only after a visible warning. Android and iOS transport policy must allow HTTP globally at the native layer, so the UI gate is a product control rather than a cryptographic boundary. HTTPS is the secure configuration.

Browser preview stores its development-only auth key and local database in localStorage. Use the native Android or iOS app for secure credential storage.

Use a dedicated non-administrator Kavita user for Turnleaf. Grant that user access only to the book libraries needed on the device, then create the auth key from that account. A Kavita auth key lets third-party apps act as that Kavita user, so an administrator key has administrator-level blast radius if it is stolen.

Pull requests run formatting, linting, type checking, unit tests, production build, iOS Capacitor sync and manifest verification, Android debug build, Android lint (`npm run android:lint`), Android emulator reading journey, unsigned macOS iOS Simulator build, production and build dependency audits, dependency review, and CodeQL analysis for JavaScript/TypeScript, Java/Kotlin, and Swift. Dependabot monitors npm, GitHub Actions, Android Gradle, and iOS Swift Package Manager manifests.

Android release APKs are verified in CI with `apksigner` against `minSdkVersion` 24, bound to immutable SHA-256 workflow outputs, and signed with OIDC-backed GitHub Artifact Attestations before publication. Verify a downloaded `app-release.apk` before installing:

```bash
sha256sum --check app-release.apk.sha256
gh attestation verify app-release.apk \
  --repo sgerner/turnleaf \
  --signer-workflow sgerner/turnleaf/.github/workflows/android-release.yml \
  --deny-self-hosted-runners
apksigner verify --min-sdk-version 24 --print-certs app-release.apk
```

EPUB.js's transitive `@xmldom/xmldom` dependency is overridden to patched release 0.9.12. Run `npm run security:audit` for both reports. Production advisories fail verification at any severity. The full lockfile audit reports every advisory and fails verification on high or critical findings.
