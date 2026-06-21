# Agent Notes

- `RELEASE_NOTES.md` is the canonical release-notes source.
- Keep the `## Unreleased` section current.
- A local git hook updates `RELEASE_NOTES.md` from each commit subject when hooks are installed.
- Use `npm run release:notes` to extract the release body for GitHub releases.
- Keep changes small and explicit; do not add abstractions unless they solve a real problem.
