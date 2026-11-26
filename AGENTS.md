# Agent Notes

- Run `npm run verify` locally before finishing changes so the dependency audit, formatting check, zero-warning `npm run lint`, zero-warning `npm run check`, unit tests, and web build match `CONTRIBUTING.md` and CI.
- Run `npm run lint` and `npm run check` locally when iterating on Svelte, TypeScript, or script changes; both fail on warnings.
- `RELEASE_NOTES.md` is the canonical release-notes source.
- Keep the `## Unreleased` section current.
- A local git hook amends each commit with a `RELEASE_NOTES.md` update from the commit subject when hooks are installed.
- Use `npm run release:notes` to extract the release body for GitHub releases.
- For Android Java or CodeQL build changes, run `npm run build`, `npx cap sync android`, and `(cd android && ./gradlew :app:compileDebugJavaWithJavac --no-daemon)` locally.
- Pin external GitHub Actions in `.github/workflows/` to full 40-character lowercase commit SHAs with `# vX.Y.Z` version comments; run `npm run workflow:check` (included in `npm run verify`) to verify workflow pins and quality gates locally.
- `scripts/github-release.mjs` handles paginated GitHub release preflight deduplication (`preflight`) and staged draft verification/promotion (`publish`), with unit coverage included in `npm run verify` (`scripts/github-release.test.mjs`).
- Run `npm run verify` for web quality gates, and run `npm run android:lint` (plus `npm run android:debug`) when touching Capacitor or Android files so local runs match CI.
- Keep changes small and explicit; do not add abstractions unless they solve a real problem.
