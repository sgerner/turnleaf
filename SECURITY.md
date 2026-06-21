# Security

- Auth keys never enter localStorage, SQLite, diagnostics, or logs.
- Native credentials use `@aparajita/capacitor-secure-storage`: Android AES-GCM with a Keystore key and iOS Keychain without iCloud synchronization.
- API keys use the `x-api-key` header except Kavita's cover route, which requires its documented query parameter. Covers are fetched once with native bridge logging disabled and cached privately.
- EPUBs and SQLite live in app-private storage.
- The application CSP disallows inline scripts, objects, forms, and arbitrary script origins.
- EPUB rendition iframes omit `allow-scripts`; content hooks remove scripts, nested frames, objects, embeds, and forms and block external link activation.
- `allow-same-origin` is required for semantic range/CFI access. With scripts disabled, book content cannot execute code through that origin.
- External navigation must pass an explicit `http:`/`https:` validator and user action before a system browser is added.
- Kavita HTML descriptions must be passed through DOMPurify before rendering. No component currently renders server HTML.
- Diagnostics must redact `x-api-key`, authorization values, auth query parameters, and secure-storage contents.

HTTP Kavita servers are supported only after a visible warning. Android and iOS transport policy must allow HTTP globally at the native layer, so the UI gate is a product control rather than a cryptographic boundary. HTTPS is the secure configuration.

EPUB.js's transitive `@xmldom/xmldom` dependency is overridden to patched release 0.9.10. Run `npm audit --omit=dev` for the current report.
