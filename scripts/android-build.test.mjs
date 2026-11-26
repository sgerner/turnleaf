import { describe, expect, it } from 'vitest';
import { canReuseWebBuild, childEnvironment, gradleTask } from './android-build.mjs';

describe('android-build helpers', () => {
  it('maps supported modes to Gradle tasks and rejects unknown modes', () => {
    expect(gradleTask('debug')).toBe('assembleDebug');
    expect(gradleTask('release')).toBe('assembleRelease');
    expect(gradleTask('lint')).toBe(':app:lintDebug');
    expect(() => gradleTask('unknown')).toThrow('Unsupported Android build mode: unknown');
    expect(() => gradleTask(undefined)).toThrow('Unsupported Android build mode: undefined');
  });

  it('reuses the web build only when TURNLEAF_REUSE_WEB_BUILD is explicitly true', () => {
    expect(canReuseWebBuild({ TURNLEAF_REUSE_WEB_BUILD: 'true' })).toBe(true);
    expect(canReuseWebBuild({ TURNLEAF_REUSE_WEB_BUILD: 'false' })).toBe(false);
    expect(canReuseWebBuild({ TURNLEAF_REUSE_WEB_BUILD: '1' })).toBe(false);
    expect(canReuseWebBuild({})).toBe(false);
  });

  it('propagates the selected Android SDK path into the child environment', () => {
    expect(
      childEnvironment('/opt/android/sdk', {
        ANDROID_HOME: '/previous/sdk',
        ANDROID_SDK_ROOT: '/previous/root',
        PATH: '/usr/bin',
        TURNLEAF_REUSE_WEB_BUILD: 'true',
      }),
    ).toEqual({
      ANDROID_HOME: '/opt/android/sdk',
      ANDROID_SDK_ROOT: '/opt/android/sdk',
      PATH: '/usr/bin',
      TURNLEAF_REUSE_WEB_BUILD: 'true',
    });
  });
});
