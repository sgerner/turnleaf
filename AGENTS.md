# Agent Notes

- Run `npm run verify` locally before finishing changes so the dependency audit, formatting check, zero-warning `npm run lint`, zero-warning `npm run check`, unit tests, and web build match `CONTRIBUTING.md` and CI.
- Run `npm run lint` and `npm run check` locally when iterating on Svelte, TypeScript, or script changes; both fail on warnings.
- `RELEASE_NOTES.md` is the canonical release-notes source.
- Keep the `## Unreleased` section current.
- A local git hook amends each commit with a `RELEASE_NOTES.md` update from the commit subject when hooks are installed.
- Use `npm run release:notes` to extract the release body for GitHub releases.
- `scripts/github-release.mjs` handles paginated GitHub release preflight deduplication (`preflight`) and staged draft verification/promotion (`publish`), with unit coverage included in `npm run verify` (`scripts/github-release.test.mjs`).
- Keep changes small and explicit; do not add abstractions unless they solve a real problem.
