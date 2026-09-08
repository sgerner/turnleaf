import { describe, expect, it } from 'vitest';
import {
  buildToolsVersions,
  detectJavaCompatibility,
  formatFailure,
  formatJavaFailure,
  parseSdkDir,
  parseJavaMajor,
  sdkCandidates,
  validateJavaCompatibility,
  validateAndroidSdk,
} from './check-android-sdk.mjs';
import { childEnvironment, gradleTask } from './android-build.mjs';

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
    const installed = new Set([
      '/sdk',
      '/sdk/platforms/android-36',
      '/sdk/build-tools',
      '/sdk/build-tools/36.0.0',
    ]);
    const result = validateAndroidSdk(candidates, {
      isDirectory: (path) => installed.has(path),
      readDirectory: () => ['36.0.0'],
    });

    expect(result.ok).toBe(true);
    expect(result.sdk).toEqual(candidates[0]);
    expect(result.missing).toEqual([]);
  });

  it('ignores malformed or empty SDK candidates before selecting a complete SDK', () => {
    const directories = new Set([
      '/empty',
      '/empty/platforms',
      '/empty/build-tools',
      '/complete',
      '/complete/platforms',
      '/complete/platforms/android-36',
      '/complete/build-tools',
      '/complete/build-tools/36.0.0',
    ]);
    const entries = new Map([
      ['/empty/build-tools', []],
      ['/complete/build-tools', ['README.txt', 'latest', '36.0.0']],
    ]);
    const result = validateAndroidSdk(
      [
        { path: '/empty', source: 'android/local.properties' },
        { path: '/complete', source: 'ANDROID_HOME' },
      ],
      {
        isDirectory: (path) => directories.has(path),
        readDirectory: (path) => entries.get(path) ?? [],
      },
    );

    expect(result.ok).toBe(true);
    expect(result.sdk).toEqual({ path: '/complete', source: 'ANDROID_HOME' });
    expect(
      buildToolsVersions('/complete', {
        isDirectory: (path) => directories.has(path),
        readDirectory: (path) => entries.get(path) ?? [],
      }),
    ).toEqual(['36.0.0']);
  });

  it('reports build tools as missing when only malformed entries exist', () => {
    const directories = new Set(['/sdk', '/sdk/platforms/android-36', '/sdk/build-tools']);
    const result = validateAndroidSdk([{ path: '/sdk', source: 'ANDROID_HOME' }], {
      isDirectory: (path) => directories.has(path),
      readDirectory: () => ['README.txt', 'latest', '36'],
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['Android SDK Build Tools']);
  });

  it('detects Java 17 or newer and rejects older or malformed versions', () => {
    expect(parseJavaMajor('openjdk version "21.0.12" 2026-07-21')).toBe(21);
    expect(parseJavaMajor('java version "1.8.0_392"')).toBe(8);
    expect(validateJavaCompatibility(17).ok).toBe(true);
    expect(validateJavaCompatibility(11).ok).toBe(false);
    expect(validateJavaCompatibility(null).ok).toBe(false);
    expect(formatJavaFailure(validateJavaCompatibility(11))).toContain('Java 11 is too old');
    expect(
      detectJavaCompatibility({
        run: () => ({ stdout: '', stderr: 'java: command not found', error: new Error('missing') }),
      }).ok,
    ).toBe(false);
  });

  it('reports actionable guidance when the SDK is missing', () => {
    const result = validateAndroidSdk([{ path: '/missing/sdk', source: 'ANDROID_HOME' }], {
      isDirectory: () => false,
    });

    expect(result.ok).toBe(false);
    expect(formatFailure(result)).toContain('ANDROID_HOME');
    expect(formatFailure(result)).toContain('android/local.properties');
  });

  it('propagates the resolved SDK to every Android child process', () => {
    expect(
      childEnvironment('/opt/android/sdk', {
        ANDROID_HOME: '/old/sdk',
        ANDROID_SDK_ROOT: '/old/sdk',
        PATH: '/bin',
      }),
    ).toMatchObject({
      ANDROID_HOME: '/opt/android/sdk',
      ANDROID_SDK_ROOT: '/opt/android/sdk',
      PATH: '/bin',
    });
    expect(gradleTask('debug')).toBe('assembleDebug');
    expect(gradleTask('release')).toBe('assembleRelease');
  });
});
