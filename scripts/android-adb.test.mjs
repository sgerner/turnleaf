import { describe, expect, it, vi } from 'vitest';
import {
  CONFIRMED_IMMERSIVE_MODE,
  DEFAULT_FONT_SCALE,
  KEYCODE_BACK,
  KEYCODE_VOLUME_DOWN,
  createAdbRunner,
  dumpWindowState,
  getFontScale,
  getImmersiveModeConfirmations,
  parseWindowDump,
  sendKeyEvent,
  setFontScale,
  setImmersiveModeConfirmations,
} from './android-adb.mjs';

const packageName = 'app.turnleaf.reader.debug';

const immersiveReaderDump = `
WINDOW MANAGER WINDOWS (dumpsys window windows)
  mHoldScreenWindow=Window{4f2a9c1 u0 app.turnleaf.reader.debug/app.turnleaf.reader.MainActivity}
  Window #3 Window{88ab120 u0 StatusBar}:
    mViewVisibility=0x8
    isVisible=false
  Window #5 Window{4f2a9c1 u0 app.turnleaf.reader.debug/app.turnleaf.reader.MainActivity}:
    mAttrs={(0,0)(fillxfill) sim={adjust=resize} ty=BASE_APPLICATION fl=KEEP_SCREEN_ON LAYOUT_IN_SCREEN LAYOUT_INSET_DECOR SPLIT_TOUCH HARDWARE_ACCELERATED DRAWS_SYSTEM_BAR_BACKGROUNDS}
    mRequestedVisibleTypes=captionBar systemGestures mandatorySystemGestures tappableElement displayCutout
    isVisible=true
  InsetsStateController
    InsetsState
      mDisplayFrame=Rect(0, 0 - 1080, 2400)
      InsetsSource id=3 type=statusBars frame=[0,0][1080,128] visible=false flags=
      InsetsSource id=c340001 type=navigationBars frame=[0,2337][1080,2400] visible=false flags=
`;

const libraryWindowDump = `
WINDOW MANAGER WINDOWS (dumpsys window windows)
  mHoldScreenWindow=null
  Window #2 Window{1111111 u0 app.turnleaf.reader.debug/app.turnleaf.reader.MainActivity}:
    mAnimatingExit=true
    mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION fl=KEEP_SCREEN_ON LAYOUT_IN_SCREEN}
    mRequestedVisibleTypes=captionBar
  Window #5 Window{9b77e12 u0 app.turnleaf.reader.debug/app.turnleaf.reader.MainActivity}:
    mAttrs={(0,0)(fillxfill) sim={adjust=resize} ty=BASE_APPLICATION fl=LAYOUT_IN_SCREEN LAYOUT_INSET_DECOR SPLIT_TOUCH HARDWARE_ACCELERATED DRAWS_SYSTEM_BAR_BACKGROUNDS}
    mRequestedVisibleTypes=statusBars navigationBars captionBar systemGestures mandatorySystemGestures tappableElement displayCutout
    isVisible=true
  InsetsStateController
    InsetsState
      mDisplayFrame=Rect(0, 0 - 1080, 2400)
      InsetsSource id=3 type=statusBars frame=[0,0][1080,128] visible=true flags=
      InsetsSource id=c340001 type=navigationBars frame=[0,2337][1080,2400] visible=true flags=
      InsetsSource id=c340002 type=navigationBars frame=[0,0][0,0] visible=false flags=
`;

const android16ImmersiveDump = `
WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)
  mCurrentFocus=Window{4b33318 u0 app.turnleaf.reader.debug/app.turnleaf.reader.MainActivity}
  mHoldScreenWindow=Window{4b33318 u0 app.turnleaf.reader.debug/app.turnleaf.reader.MainActivity}
  WindowInsetsStateController
    InsetsState
      mDisplayFrame=Rect(0, 0 - 1080, 2400)
        InsetsSource id=9a510001 type=navigationBars frame=[0,2337][1080,2400] visible=false flags=SUPPRESS_SCRIM|ANIMATE_RESIZING sideHint=BOTTOM boundingRects=null
        InsetsSource id=1c660000 type=statusBars frame=[0,0][1080,63] visible=false flags= sideHint=TOP boundingRects=null
    InsetsSourceProviders:
      InsetsSourceProvider
        mSource=InsetsSource id=1c660000 type=statusBars frame=[0,0][1080,63] visible=false flags= sideHint=TOP boundingRects=null
      InsetsSourceProvider
        mSource=InsetsSource id=9a510001 type=navigationBars frame=[0,2337][1080,2400] visible=false flags=SUPPRESS_SCRIM|ANIMATE_RESIZING sideHint=BOTTOM boundingRects=null
WINDOW MANAGER WINDOWS (dumpsys window windows)
  Window #7 Window{77c5c03 u0 StatusBar}:
    isVisible=true
  Window #8 Window{4b33318 u0 app.turnleaf.reader.debug/app.turnleaf.reader.MainActivity}:
    mAttrs={(0,0)(fillxfill) sim={adjust=pan forwardNavigation} layoutInDisplayCutoutMode=always ty=BASE_APPLICATION
      fl=KEEP_SCREEN_ON LAYOUT_IN_SCREEN LAYOUT_INSET_DECOR SPLIT_TOUCH HARDWARE_ACCELERATED DRAWS_SYSTEM_BAR_BACKGROUNDS
      bhv=SHOW_TRANSIENT_BARS_BY_SWIPE}
    isVisible=true
    keepClearAreas: restricted=[], unrestricted=[]
    Requested non-default-visibility types: statusBars navigationBars captionBar systemOverlays
    mPrepareSyncSeqId=0
`;

const android16LibraryDump = `
WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)
  mCurrentFocus=Window{4b33318 u0 app.turnleaf.reader.debug/app.turnleaf.reader.MainActivity}
  mHoldScreenWindow=null
  WindowInsetsStateController
    InsetsState
      mDisplayFrame=Rect(0, 0 - 1080, 2400)
        InsetsSource id=9a510001 type=navigationBars frame=[0,2337][1080,2400] visible=true flags=SUPPRESS_SCRIM|ANIMATE_RESIZING sideHint=BOTTOM boundingRects=null
        InsetsSource id=1c660000 type=statusBars frame=[0,0][1080,63] visible=true flags= sideHint=TOP boundingRects=null
WINDOW MANAGER WINDOWS (dumpsys window windows)
  Window #8 Window{4b33318 u0 app.turnleaf.reader.debug/app.turnleaf.reader.MainActivity}:
    mAttrs={(0,0)(fillxfill) sim={adjust=pan forwardNavigation} layoutInDisplayCutoutMode=always ty=BASE_APPLICATION
      fl=LAYOUT_IN_SCREEN LAYOUT_INSET_DECOR SPLIT_TOUCH HARDWARE_ACCELERATED DRAWS_SYSTEM_BAR_BACKGROUNDS}
    isVisible=true
    keepClearAreas: restricted=[], unrestricted=[]
    mPrepareSyncSeqId=0
`;

const legacyAndroid11Dump = `
  Window #4 Window{abc1234 u0 app.turnleaf.reader.debug/app.turnleaf.reader.MainActivity}:
    mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION fl=LAYOUT_IN_SCREEN}
  InsetsStateController:
    InsetsSource type=ITYPE_STATUS_BAR frame=[0,0][1080,63] visible=true
    InsetsSource type=ITYPE_NAVIGATION_BAR frame=[0,2274][1080,2400] visible=true
`;

describe('Android ADB journey helpers', () => {
  it('detects active reader immersive chrome and KEEP_SCREEN_ON in dumpsys window', () => {
    expect(parseWindowDump(immersiveReaderDump, packageName)).toEqual({
      windowFound: true,
      windowToken: '4f2a9c1',
      keepScreenOn: true,
      systemBarsVisible: false,
    });
  });

  it('prefers the non-exiting MainActivity window and detects restored system bars', () => {
    expect(parseWindowDump(libraryWindowDump, packageName)).toEqual({
      windowFound: true,
      windowToken: '9b77e12',
      keepScreenOn: false,
      systemBarsVisible: true,
    });
  });

  it('parses Android 16 WindowInsetsStateController and non-default requested visibility types', () => {
    expect(parseWindowDump(android16ImmersiveDump, packageName)).toEqual({
      windowFound: true,
      windowToken: '4b33318',
      keepScreenOn: true,
      systemBarsVisible: false,
    });
    expect(parseWindowDump(android16LibraryDump, packageName)).toEqual({
      windowFound: true,
      windowToken: '4b33318',
      keepScreenOn: false,
      systemBarsVisible: true,
    });
  });

  it('parses legacy ITYPE_* inset sources and missing windows safely', () => {
    expect(parseWindowDump(legacyAndroid11Dump, packageName)).toEqual({
      windowFound: true,
      windowToken: 'abc1234',
      keepScreenOn: false,
      systemBarsVisible: true,
    });
    expect(parseWindowDump('WINDOW MANAGER WINDOWS', packageName)).toEqual({
      windowFound: false,
      windowToken: null,
      keepScreenOn: false,
      systemBarsVisible: null,
    });
  });

  it('builds serial-scoped ADB commands for key events, immersive confirmation, font_scale, and dumpsys window', async () => {
    const calls = [];
    const execFileImpl = vi.fn((command, args, _options, callback) => {
      calls.push([command, ...args]);
      const joined = args.join(' ');
      if (joined.includes('settings get system font_scale')) {
        callback(null, { stdout: '2.0\n', stderr: '' });
      } else if (joined.includes('settings get secure immersive_mode_confirmations')) {
        callback(null, { stdout: 'null\n', stderr: '' });
      } else if (joined.includes('dumpsys window')) {
        callback(null, { stdout: libraryWindowDump, stderr: '' });
      } else {
        callback(null, { stdout: '\n', stderr: '' });
      }
    });

    const adb = createAdbRunner({ getSerial: () => 'emulator-5554', execFileImpl });
    expect(await getImmersiveModeConfirmations(adb)).toBeNull();
    await setImmersiveModeConfirmations(adb, CONFIRMED_IMMERSIVE_MODE);
    await sendKeyEvent(adb, KEYCODE_VOLUME_DOWN);
    await sendKeyEvent(adb, KEYCODE_BACK);
    await setFontScale(adb, '2.0');
    expect(await getFontScale(adb)).toBe(2);
    expect(await dumpWindowState(adb, packageName)).toMatchObject({
      windowFound: true,
      keepScreenOn: false,
      systemBarsVisible: true,
    });
    await setFontScale(adb, DEFAULT_FONT_SCALE);
    await setImmersiveModeConfirmations(adb, null);

    expect(calls).toEqual([
      [
        'adb',
        '-s',
        'emulator-5554',
        'shell',
        'settings',
        'get',
        'secure',
        'immersive_mode_confirmations',
      ],
      [
        'adb',
        '-s',
        'emulator-5554',
        'shell',
        'settings',
        'put',
        'secure',
        'immersive_mode_confirmations',
        'confirmed',
      ],
      ['adb', '-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_VOLUME_DOWN'],
      ['adb', '-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_BACK'],
      ['adb', '-s', 'emulator-5554', 'shell', 'settings', 'put', 'system', 'font_scale', '2.0'],
      ['adb', '-s', 'emulator-5554', 'shell', 'settings', 'get', 'system', 'font_scale'],
      ['adb', '-s', 'emulator-5554', 'shell', 'dumpsys', 'window'],
      ['adb', '-s', 'emulator-5554', 'shell', 'settings', 'put', 'system', 'font_scale', '1.0'],
      [
        'adb',
        '-s',
        'emulator-5554',
        'shell',
        'settings',
        'delete',
        'secure',
        'immersive_mode_confirmations',
      ],
    ]);
  });
});
