# Android Build

## Verified environment

- OpenJDK 21
- Android SDK API 36 (`minSdkVersion = 24`, `targetSdkVersion = 36`)
- Android Build Tools 36.0.0
- Capacitor Android 8.6.0

The generated project supports Android 7 through 16 (API 24 through 36), declares only `INTERNET` and `ACCESS_NETWORK_STATE` in merged debug and release manifests (zero external storage permissions), streams EPUBs and covers directly to app-private storage, exports Markdown notes through the Android system picker or unexported `FileProvider` `shared/` cache directory, and contains adaptive icon and splash placeholders from Capacitor.

Automated CI and release workflows run the Android reading journey and APK checks on both API 29 (`turnleaf_api29`) and API 36 (`turnleaf_api36`) Google APIs `x86_64` emulators: install, manifest permission bounds, secure credential persistence, live library browsing, cached covers, native EPUB download, system note export, paginated reading, force-stop persistence, offline reopen, and progress sync.

## Commands

Check the local Android toolchain before starting a build. The preflight checks
`android/local.properties`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and the usual
per-user SDK locations. It also verifies that the compile SDK (API 36) and at
least one Android Build Tools version are installed.

```bash
npm run android:doctor
```

The project-specific `android/local.properties` file is intentionally ignored
by Git because its path is machine-specific. Create it when the SDK is in a
non-standard location, or export `ANDROID_HOME` instead:

```bash
printf 'sdk.dir=%s\n' "/absolute/path/to/Android/Sdk" > android/local.properties
```

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
npm ci
npm run android:debug
npm run android:lint
```

Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`.

For release readiness:

```bash
keytool -genkeypair -v -keystore android/turnleaf-release.jks -alias turnleaf -keyalg RSA -keysize 4096 -validity 10000
npm run android:release -- --no-daemon
```

Extra flags after `--` (such as `--no-daemon`) are forwarded to Gradle, and release builds stop the Gradle daemon after signing so credentials do not remain in background daemon memory.

Configure signing credentials outside Git using step-scoped `TURNLEAF_*` environment variables or `android/keystore.properties` (see `android/keystore.properties.example`):

- `TURNLEAF_STORE_FILE` (resolved relative to `android/` or as an absolute path)
- `TURNLEAF_STORE_PASSWORD`
- `TURNLEAF_KEY_ALIAS`
- `TURNLEAF_KEY_PASSWORD`

`TURNLEAF_*` environment variables take precedence over `android/keystore.properties`. Gradle reads `android/keystore.properties` as UTF-8 `java.util.Properties`, which strips unescaped leading whitespace and interprets backslash escapes—escape `\\` and leading `\ ` (and leading `\#` or `\!`), or pass raw values via `TURNLEAF_*` environment variables.

GitHub Actions expects these repository secrets, decodes the keystore into an owner-only `$RUNNER_TEMP` file, scopes `TURNLEAF_*` variables to the `--no-daemon` signing step, and shreds temporary signing files immediately after signing:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The release script produces a signed APK when all four signing values are present and fails loudly if any release signing value is missing or empty.

Device commands used:

```bash
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p app.turnleaf.reader 1
```

Plain HTTP is disabled by product policy until the user explicitly confirms it in onboarding. Android must permit cleartext at the manifest level because network-security XML cannot be changed per server at runtime; HTTPS remains recommended.
