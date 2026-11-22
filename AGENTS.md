# Agent Notes

- `RELEASE_NOTES.md` is the canonical release-notes source.
- Keep the `## Unreleased` section current.
- A local git hook amends each commit with a `RELEASE_NOTES.md` update from the commit subject when hooks are installed.
- Use `npm run release:notes` to extract the release body for GitHub releases.
- Pin external GitHub Actions in `.github/workflows/` to full 40-character lowercase commit SHAs with `# vX.Y.Z` version comments; run `npm run workflow:check` (included in `npm run verify`) to verify workflow pins and quality gates locally.
- Keep changes small and explicit; do not add abstractions unless they solve a real problem.
