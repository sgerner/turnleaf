# Contributing to Turnleaf

Turnleaf is an offline-first Capacitor app. Contributions are easiest to review when each pull request solves one problem and includes the smallest useful test or validation record.

## Start from a clean checkout

The project uses Node.js 22 in CI. Use the checked-in `.nvmrc` with nvm, fnm, or another version manager when available.

```bash
git clone https://github.com/sgerner/turnleaf.git
cd turnleaf
nvm use 2>/dev/null || true
npm ci
npm run verify
```

`npm ci` installs the dependencies and enables the repository's release-note hook through `postinstall`. If a tool or IDE changes the Git hooks path, restore it with:

```bash
npm run setup:hooks
git config core.hooksPath
```

The expected hooks path is `.githooks`.

## Choose a development loop

For browser UI work, start Vite and use the fast test loop:

```bash
npm run dev
npm run test:watch
```

For realistic onboarding, download, and reader work, start the local Kavita fixture. Docker is optional for browser-only work:

```bash
npm run dev:kavita
npm run dev
```

Open [dev/README.md](dev/README.md) for the first-time Kavita setup. Stop the container when finished with `npm run dev:kavita:down`; use `npm run dev:kavita:logs` when diagnosing startup or scan issues.

The single contributor command is:

```bash
npm run verify
```

It runs the production dependency audit, formatting check, lint, type check, unit tests, and web build. Run `npm run format` only when you intend to rewrite formatting.

## Android validation

Android development requires Android Studio or the command-line SDK, API 36, Build Tools, Java 17 or newer, and an emulator or USB device. The CI and release runners use Java 21.

```bash
npm run android:doctor
npm run android:debug
adb devices
npm run android:smoke
```

`android:smoke` installs the debug APK as `app.turnleaf.reader.debug`, starts the app, and checks that its process stays alive. The `.debug` application ID lets it run alongside a signed production install. It is a startup check, not a replacement for the manual accessibility, offline, network-isolation, or feature pass in [DEVICE_VALIDATION.md](DEVICE_VALIDATION.md).

To open Android Studio or Xcode, use `npm run android:open` or `npm run ios:open`. Both commands load an optional local `.env` when present; copy `.env.example` to `.env` only when you need to set a tool path or a remote development-proxy origin. Never commit `.env`, signing files, SDK paths, credentials, or downloaded library data.

## Open a pull request

1. Create a branch from the current `master` branch with a short `feature/` or `fix/` name.
2. Keep the PR narrow. Separate UI, data, native, documentation, and dependency changes when they can be reviewed independently.
3. Add or update a focused test for behavior that can be exercised in Node or the browser.
4. Run `npm run verify`; run `npm run android:debug` and `npm run android:smoke` for native changes when the toolchain is available.
5. For UI changes, test at narrow and large viewport sizes and attach a screenshot or short recording.
6. For Android behavior, record the device/emulator, OS version, commit, and manual results using [DEVICE_VALIDATION.md](DEVICE_VALIDATION.md).
7. Describe the user-visible behavior, test commands, and any platform limitation in the PR body. The pull-request template includes the expected checks.

GitHub Actions repeats the web quality gates, Android debug build, emulator startup smoke test, dependency review, and CodeQL analysis. A local pass is useful evidence, but CI is still required before merge.

## Release notes and versions

Keep `## Unreleased` in [RELEASE_NOTES.md](RELEASE_NOTES.md) current. The post-commit hook adds a concise entry from each commit subject when hooks are installed. Normal feature PRs should not bump the app version or finalize release notes; release preparation does that in a separate change.

Avoid adding dependencies unless they solve a demonstrated problem. Preserve the offline-first behavior, explicit storage boundaries, and security checks around Kavita requests and rendered EPUB content.
