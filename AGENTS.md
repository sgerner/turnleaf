# Agent Notes

- `RELEASE_NOTES.md` is the canonical release-notes source.
- Keep the `## Unreleased` section current.
- A local git hook amends each commit with a `RELEASE_NOTES.md` update from the commit subject when hooks are installed.
- Use `npm run release:notes` to extract the release body for GitHub releases.
- Android release signing prefers `TURNLEAF_STORE_FILE`, `TURNLEAF_STORE_PASSWORD`, `TURNLEAF_KEY_ALIAS`, and `TURNLEAF_KEY_PASSWORD` environment variables over UTF-8 `android/keystore.properties` (which follows Java `Properties` escaping such as `\\` and leading `\ `); use `npm run android:release -- --no-daemon` for single-use signed builds and never write signing secrets into workspace files in CI.
- Keep changes small and explicit; do not add abstractions unless they solve a real problem.
