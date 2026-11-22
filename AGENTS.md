# Agent Notes

- Run `npm run verify` locally before finishing changes so the dependency audit, formatting check, zero-warning `npm run lint`, zero-warning `npm run check`, unit tests, and web build match `CONTRIBUTING.md` and CI.
- Run `npm run lint` and `npm run check` locally when iterating on Svelte, TypeScript, or script changes; both fail on warnings.
- `RELEASE_NOTES.md` is the canonical release-notes source.
- Keep the `## Unreleased` section current.
- A local git hook amends each commit with a `RELEASE_NOTES.md` update from the commit subject when hooks are installed.
- Use `npm run release:notes` to extract the release body for GitHub releases.
- Use `npm run android:verify-release` to verify a signed release APK's signature and SHA-256 digest locally.
- Keep changes small and explicit; do not add abstractions unless they solve a real problem.
