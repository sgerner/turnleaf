import { describe, expect, it } from 'vitest';
import {
  formatFailure,
  parseSdkDir,
  sdkCandidates,
  validateAndroidSdk,
} from './check-android-sdk.mjs';

describe('Android SDK preflight', () => {
  it('parses a project SDK path from local.properties', () => {
    expect(parseSdkDir('# comment\nsdk.dir=/opt/android/sdk\n')).toBe('/opt/android/sdk');
    expect(parseSdkDir('sdk.dir=C\\:\\Android\\Sdk')).toBe('C:\\Android\\Sdk');
    expect(parseSdkDir('sdk.path=/wrong')).toBeNull();
  });

  it('prioritizes project configuration and removes duplicate candidates', () => {
    const candidates = sdkCandidates({
      env: { ANDROID_HOME: '/opt/android/sdk', ANDROID_SDK_ROOT: '/opt/android/sdk' },
      home: '/home/tester',
      platform: 'linux',
      localPropertiesContents: 'sdk.dir=/opt/android/sdk\n',
      localPropertiesDirectory: '/workspace/android',
    });

    expect(candidates).toEqual([
      { path: '/opt/android/sdk', source: 'android/local.properties' },
      { path: '/home/tester/Android/Sdk', source: 'Linux default' },
    ]);
  });

  it('requires the compile SDK platform and at least one build-tools version', () => {
    const candidates = [{ path: '/sdk', source: 'ANDROID_HOME' }];
    const installed = new Set(['/sdk', '/sdk/platforms/android-36', '/sdk/build-tools']);
    const result = validateAndroidSdk(candidates, {
      isDirectory: (path) => installed.has(path),
      readDirectory: () => ['36.0.0'],
    });

    expect(result.ok).toBe(true);
    expect(result.sdk).toEqual(candidates[0]);
    expect(result.missing).toEqual([]);
  });

  it('reports actionable guidance when the SDK is missing', () => {
    const result = validateAndroidSdk([{ path: '/missing/sdk', source: 'ANDROID_HOME' }], {
      isDirectory: () => false,
    });

    expect(result.ok).toBe(false);
    expect(formatFailure(result)).toContain('ANDROID_HOME');
    expect(formatFailure(result)).toContain('android/local.properties');
  });
});
