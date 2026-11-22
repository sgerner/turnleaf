# Agent Notes

- `RELEASE_NOTES.md` is the canonical release-notes source.
- Keep the `## Unreleased` section current.
- A local git hook amends each commit with a `RELEASE_NOTES.md` update from the commit subject when hooks are installed.
- Use `npm run release:notes` to extract the release body for GitHub releases.
- Run `npm run verify` for web quality gates, and run `npm run android:lint` (plus `npm run android:debug`) when touching Capacitor or Android files so local runs match CI.
- Keep changes small and explicit; do not add abstractions unless they solve a real problem.
