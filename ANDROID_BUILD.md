# Android Build

## Verified environment

- OpenJDK 21
- Android SDK API 36
- Android Build Tools 36.0.0
- Capacitor Android 8.4.1

The generated project targets API 36, has only the Internet permission, uses app-private storage, and contains adaptive icon and splash placeholders from Capacitor.

Verified on Linux with the `turnleaf_api36` Google APIs x86_64 emulator: install, secure credential persistence, live library browsing, native download, paginated reading, force-stop persistence, airplane-mode cached browsing, and offline CFI reopen.

## Commands

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

Configure the signing secret outside Git in `~/.gradle/gradle.properties` or a CI secret before distributing the generated AAB. The current release script verifies compilation but cannot produce a distributable signed artifact without owner signing credentials.

Device commands used:

```bash
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p app.turnleaf.reader 1
```

Plain HTTP is disabled by product policy until the user explicitly confirms it in onboarding. Android must permit cleartext at the manifest level because network-security XML cannot be changed per server at runtime; HTTPS remains recommended.
