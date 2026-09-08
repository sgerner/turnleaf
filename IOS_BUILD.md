# iOS Build on macOS

The iOS Capacitor project is scaffolded and synchronized. It was not compiled or simulator-tested on Linux.

The iOS release status remains **unverified** until the checks below are completed on macOS and at
least one real iPhone. Record the date, device/OS, app build, and result for each check before
describing an iOS build as ready.

## macOS commands

```bash
xcode-select --install
brew install node cocoapods
npm ci
npm run build
npm run ios:sync
npm run ios:open
```

Capacitor 8 generated this project with Swift Package Manager, so CocoaPods is installed for plugin/tooling compatibility but `pod install` is not currently required. If the project is intentionally converted to CocoaPods later:

```bash
cd ios/App
pod install --repo-update
open App.xcworkspace
```

In Xcode:

1. Select the `App` target, then Signing & Capabilities.
2. Choose the owning Apple Developer team and confirm the unique bundle ID `app.turnleaf.reader`.
3. Confirm `PrivacyInfo.xcprivacy` has target membership.
4. Select an iPhone simulator or connected device and use Product > Build.
5. Use Product > Archive for a distribution build, then validate signing in Organizer.

Filesystem, File Transfer, SQLite, secure Keychain storage, app lifecycle, ATS behavior, and native EPUB file loading still require macOS/device verification. `NSAllowsArbitraryLoads` exists solely for user-approved HTTP Kavita servers; remove it if HTTP support is dropped or replace it with known-host exceptions for a managed deployment.

## Readiness matrix

Run the matrix on a simulator and a physical device where the check depends on hardware or
platform services. Attach logs or screenshots to the release record rather than treating a
successful Xcode compile as acceptance.

| Area                     | Check                                                                                             | Evidence to record                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Build and signing        | Debug build, archive, bundle identifier, team, and privacy manifest                               | Xcode build/archive result and signing configuration |
| Secure storage           | Save, replace, reject, and delete a Kavita key; relaunch the app                                  | Keychain behavior and error recovery                 |
| SQLite                   | Fresh install, migration from each supported schema, interrupted migration, and reopen            | Migration log and retained local data                |
| Downloads                | Start, cancel/interrupt, reopen offline, remove, and recover a partial EPUB                       | File manifest and offline open result                |
| Lifecycle                | Background during refresh, download, reader progress, and sync; resume after termination          | Device log and restored state                        |
| Reader                   | Safe EPUB rendering, CFI restoration, table of contents, links/footnotes, and appearance settings | Screen recording or test notes                       |
| Accessibility            | VoiceOver navigation, focus order, Dynamic Type, contrast, and reduced motion                     | VoiceOver smoke-test notes and screenshots           |
| Network policy           | HTTPS, approved HTTP warning, timeout, auth rejection, and ATS behavior                           | Request trace and visible recovery state             |
| Device layout            | Portrait/landscape, safe areas, external keyboard, and rotation during the reader                 | Device matrix and screenshots                        |
| Privacy and distribution | Backup behavior, app-private files, archive validation, and TestFlight installation               | Archive/export checklist and privacy review          |

Release readiness requires every applicable row to pass or have a documented, accepted exception.
