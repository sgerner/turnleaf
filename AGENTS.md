# Agent Notes

- `RELEASE_NOTES.md` is the canonical release-notes source.
- Keep the `## Unreleased` section current.
- A local git hook amends each commit with a `RELEASE_NOTES.md` update from the commit subject when hooks are installed.
- Use `npm run release:notes` to extract the release body for GitHub releases.
- Run `npm run verify` to run dependency audits, formatting, linting, type checking, unit tests, and the web build locally.
- For Android Java or CodeQL build changes, run `npm run build`, `npx cap sync android`, and `(cd android && ./gradlew :app:compileDebugJavaWithJavac --no-daemon)` locally.
- Keep changes small and explicit; do not add abstractions unless they solve a real problem.
