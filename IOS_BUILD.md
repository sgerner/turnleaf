# iOS Build on macOS

The iOS Capacitor project is scaffolded and synchronized. It was not compiled or simulator-tested on Linux.

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
