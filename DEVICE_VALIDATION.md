# Device validation checklist

This checklist covers the Android device and emulator checks that complement the automated web, SQLite, EPUB, and Android startup tests. Record the device, Android version, app commit, and date with every run. The checklist deliberately avoids treating a passing build as proof of accessibility or network isolation.

## Automated checks

Run these from a clean checkout before the device pass:

```sh
npm ci
npm run verify
npm run android:debug
npm run android:smoke
```

`npm run verify` runs the same web quality gates used by pull-request CI. `android:smoke` installs the debug APK as `app.turnleaf.reader.debug`, starts its main activity, and verifies that the application process stays alive. The `.debug` application ID lets contributors test alongside a signed production install without replacing it. The CI emulator job runs the same script on an API 29 default x86 Nexus 5 image.

## Android accessibility pass

Use a physical Android device when possible; otherwise use the CI emulator image. Enable TalkBack and large display/text settings before opening the app.

1. From onboarding, move through every field and action with TalkBack swipe navigation. Each control must have a useful spoken label, and focus must remain visible after opening or closing a panel.
2. In the library, open settings, the book actions menu, and the conflict dialog. Confirm that focus enters the dialog, stays inside while tabbing or swiping, closes with Back/Escape, and returns to the opener after filtering or deleting a book.
3. In the reader, use the Contents, Text, Marks, Notes, and Sync controls. Confirm that each toggle announces its expanded state and that the panel title is announced once. Verify that the page controls remain available without relying on the three tap zones.
4. Set text and display size to 200% and rotate between portrait and landscape. Essential labels, progress, dialogs, and close controls must remain reachable without horizontal clipping or overlap.
5. Test light, dark, and e-ink themes with keyboard focus and TalkBack. Selected modes must have a state cue in addition to color, and all primary controls must remain at least 44 CSS pixels (the app uses 48px compact targets for these controls).
6. Select a passage in an EPUB, save a local note, navigate to its highlight, edit it, export Markdown, close the reader, and reopen it. TalkBack must be able to reach the note form and saved annotation actions.

Record any failure with a screenshot, the spoken label, the focused element, and the exact reproduction path. A passing automated test suite does not replace this step.

## Network and content isolation pass

Use a test server that can return a redirect, an HTTPS-to-HTTP downgrade, malformed JSON, an HTML error body, and a valid EPUB containing remote image/CSS/navigation references.

1. Configure the server URL and confirm that the normal API, cover, download, and progress requests include the auth header only on the intended Kavita origin.
2. Return a cross-origin redirect and an HTTPS downgrade from each authenticated endpoint. The browser client, native client, and cover loader must fail the request without sending the auth header to the redirected origin.
3. Open the hostile EPUB fixture and capture WebView requests. No script, form submission, remote stylesheet, remote image, SVG resource, media poster, or external navigation may execute or receive the auth key. Internal chapter, fragment, and local stylesheet links must continue to work.
4. Interrupt an EPUB download and verify that the partial file is not advertised as available. Reopen the app offline and confirm that a previously completed EPUB remains readable.

For Android, capture the WebView request log or a proxy trace with the test server origin and destination redacted only after verifying that no credentials appear. Store the result with the release candidate’s validation record.

## Result record

Use this small record in the release checklist or PR description:

| Field                         | Value                 |
| ----------------------------- | --------------------- |
| Commit / version              |                       |
| Device or emulator image      |                       |
| Android version               |                       |
| TalkBack version and settings |                       |
| Automated checks              | pass / fail           |
| Accessibility pass            | pass / fail / blocked |
| Network isolation pass        | pass / fail / blocked |
| Defects / follow-up           |                       |
