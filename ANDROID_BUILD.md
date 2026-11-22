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
```

Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`.

For release readiness:

```bash
keytool -genkeypair -v -keystore turnleaf-release.jks -alias turnleaf -keyalg RSA -keysize 4096 -validity 10000
npm run android:release
```

Configure the signing secret outside Git in `android/keystore.properties` or a CI secret before distributing the generated APK. The repo includes `android/keystore.properties.example` as a template. GitHub Actions expects these secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The current release script produces a signed APK when those values are present and fails loudly if release signing is missing.

Device commands used:

```bash
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p app.turnleaf.reader 1
```

Plain HTTP is disabled by product policy until the user explicitly confirms it in onboarding. Android must permit cleartext at the manifest level because network-security XML cannot be changed per server at runtime; HTTPS remains recommended.
