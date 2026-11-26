import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareBuildToolsVersions,
  computeFileSha256,
  formatApksignerFailure,
  parseCliArgs,
  parseMinSdkVersion,
  parseSha256Checksum,
  resolveApksigner,
  verifyApkDigest,
  verifyReleaseApk,
} from './verify-release-apk.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const variablesGradlePath = join(projectRoot, 'android', 'variables.gradle');
const REAL_SIGNING_TEST_TIMEOUT_MS = 30_000;
const tempDirectories = [];

function createTempDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'turnleaf-verify-apk-'));
  tempDirectories.push(dir);
  return dir;
}

function detectRealAndroidSigningTools() {
  const apksigner = resolveApksigner();
  if (!apksigner.ok) return null;

  const buildToolsDir = dirname(apksigner.apksignerPath);
  const aapt2Path = join(buildToolsDir, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
  const androidJarPath = join(apksigner.sdk.path, 'platforms', 'android-36', 'android.jar');
  if (!existsSync(aapt2Path) || !existsSync(androidJarPath)) return null;

  const keytoolProbe = spawnSync('keytool', ['-help'], { encoding: 'utf8' });
  if (keytoolProbe.error) return null;

  return {
    apksignerPath: apksigner.apksignerPath,
    aapt2Path,
    androidJarPath,
    sdkPath: apksigner.sdk.path,
  };
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop(), { recursive: true, force: true });
  }
});

describe('Android release APK verification', () => {
  it('reads minSdkVersion from android/variables.gradle and rejects malformed files', () => {
    expect(parseMinSdkVersion(readFileSync(variablesGradlePath, 'utf8'))).toBe(24);
    expect(
      parseMinSdkVersion(`
        ext {
          // minSdkVersion = 19
          minSdkVersion = 26 // inline comment
        }
      `),
    ).toBe(26);
    expect(() => parseMinSdkVersion('ext { compileSdkVersion = 36 }')).toThrow(
      'Could not parse a valid minSdkVersion',
    );
  });

  it('orders build-tools versions semantically and resolves the newest executable apksigner', () => {
    expect(
      ['33.0.2', '36.0.0-rc1', '35.0.0', '36.0.0', '34.0.0'].sort(compareBuildToolsVersions),
    ).toEqual(['36.0.0', '36.0.0-rc1', '35.0.0', '34.0.0', '33.0.2']);

    const directories = new Set([
      '/sdk',
      '/sdk/platforms/android-36',
      '/sdk/build-tools',
      '/sdk/build-tools/34.0.0',
      '/sdk/build-tools/35.0.0',
      '/sdk/build-tools/36.0.0',
    ]);
    const executables = new Set([
      '/sdk/build-tools/34.0.0/apksigner',
      '/sdk/build-tools/35.0.0/apksigner',
    ]);

    const result = resolveApksigner([{ path: '/sdk', source: 'ANDROID_HOME' }], {
      platform: 'linux',
      isDirectory: (path) => directories.has(path),
      readDirectory: () => ['34.0.0', '36.0.0', '35.0.0'],
      isExecutable: (path) => executables.has(path),
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBe('35.0.0');
    expect(result.apksignerPath).toBe('/sdk/build-tools/35.0.0/apksigner');
  });

  it('resolves apksigner.bat on Windows and falls back across SDK candidates', () => {
    const emptySdk = '/empty-sdk';
    const winSdk = '/windows-sdk';
    const directories = new Set([
      emptySdk,
      join(emptySdk, 'build-tools'),
      join(emptySdk, 'build-tools', '36.0.0'),
      winSdk,
      join(winSdk, 'build-tools'),
      join(winSdk, 'build-tools', '35.0.0'),
    ]);
    const entries = new Map([
      [join(emptySdk, 'build-tools'), ['36.0.0']],
      [join(winSdk, 'build-tools'), ['35.0.0']],
    ]);
    const executables = new Set([join(winSdk, 'build-tools', '35.0.0', 'apksigner.bat')]);

    const result = resolveApksigner(
      [
        { path: emptySdk, source: 'android/local.properties' },
        { path: winSdk, source: 'ANDROID_HOME' },
      ],
      {
        platform: 'win32',
        isDirectory: (path) => directories.has(path),
        readDirectory: (path) => entries.get(path) ?? [],
        isExecutable: (path) => executables.has(path),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.sdk).toEqual({ path: winSdk, source: 'ANDROID_HOME' });
    expect(result.apksignerPath).toBe(join(winSdk, 'build-tools', '35.0.0', 'apksigner.bat'));
  });

  it('fails immediately when build-tools lacks an executable apksigner binary', () => {
    const directories = new Set([
      '/sdk',
      '/sdk/platforms/android-36',
      '/sdk/build-tools',
      '/sdk/build-tools/36.0.0',
    ]);
    const result = resolveApksigner([{ path: '/sdk', source: 'ANDROID_HOME' }], {
      platform: 'linux',
      isDirectory: (path) => directories.has(path),
      readDirectory: () => ['36.0.0'],
      isExecutable: () => false,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing-apksigner');
    expect(formatApksignerFailure(result)).toContain('No executable apksigner binary');
  });

  it('computes SHA-256 digests and rejects empty, mismatched, or malformed checksums', () => {
    const dir = createTempDirectory();
    const apkPath = join(dir, 'app-release.apk');
    const emptyApkPath = join(dir, 'empty.apk');
    const checksumPath = join(dir, 'app-release.apk.sha256');
    const payload = Buffer.from('turnleaf-signed-apk-payload');
    const expectedDigest = createHash('sha256').update(payload).digest('hex');

    writeFileSync(apkPath, payload);
    writeFileSync(emptyApkPath, '');
    writeFileSync(checksumPath, `${expectedDigest}  app-release.apk\n`);

    expect(computeFileSha256(apkPath)).toBe(expectedDigest);
    expect(
      verifyApkDigest(apkPath, {
        expectedSha256: expectedDigest.toUpperCase(),
        sha256FilePath: checksumPath,
      }),
    ).toBe(expectedDigest);

    expect(() => computeFileSha256(emptyApkPath)).toThrow('Release APK is empty');
    expect(() => computeFileSha256(join(dir, 'missing.apk'))).toThrow('Release APK not found');
    expect(() => verifyApkDigest(apkPath, { expectedSha256: '' })).toThrow(
      '64-character hex string',
    );
    expect(() => verifyApkDigest(apkPath, { expectedSha256: '0'.repeat(64) })).toThrow(
      'APK SHA-256 digest mismatch',
    );

    writeFileSync(checksumPath, `${'f'.repeat(64)}  app-release.apk\n`);
    expect(() => verifyApkDigest(apkPath, { sha256FilePath: checksumPath })).toThrow(
      'APK SHA-256 checksum file mismatch',
    );
    expect(() => parseSha256Checksum(`${expectedDigest}  other.apk\n`, 'app-release.apk')).toThrow(
      'SHA-256 checksum target mismatch',
    );
  });

  it('auto-discovers adjacent .sha256 files and preserves explicit empty env overrides for fail-fast checks', () => {
    const dir = createTempDirectory();
    const apkPath = join(dir, 'app-release.apk');
    const checksumPath = `${apkPath}.sha256`;
    writeFileSync(apkPath, 'apk-bytes');
    writeFileSync(checksumPath, `${computeFileSha256(apkPath)}  app-release.apk\n`);

    const parsed = parseCliArgs(['app-release.apk'], {}, dir);
    expect(parsed.apkPath).toBe(apkPath);
    expect(parsed.sha256FilePath).toBe(checksumPath);

    const emptyDigestEnv = parseCliArgs(['app-release.apk'], { ANDROID_EXPECTED_SHA256: '' }, dir);
    expect(emptyDigestEnv.expectedSha256).toBe('');
    expect(() => verifyApkDigest(apkPath, emptyDigestEnv)).toThrow('64-character hex string');
  });

  it('invokes apksigner verify with minSdkVersion from variables.gradle and rejects unsigned or tampered APKs', () => {
    const dir = createTempDirectory();
    const apkPath = join(dir, 'app-release.apk');
    writeFileSync(apkPath, 'apk-binary-content');

    const directories = new Set([
      '/sdk',
      '/sdk/platforms/android-36',
      '/sdk/build-tools',
      '/sdk/build-tools/36.0.0',
    ]);
    const ioOptions = {
      isDirectory: (path) => directories.has(path),
      readDirectory: () => ['36.0.0'],
      isExecutable: (path) => path === '/sdk/build-tools/36.0.0/apksigner',
    };

    const calls = [];
    const verified = verifyReleaseApk({
      apkPath,
      variablesPath: variablesGradlePath,
      candidates: [{ path: '/sdk', source: 'ANDROID_HOME' }],
      ioOptions,
      platform: 'linux',
      run: (command, args) => {
        calls.push([command, args]);
        if (command === 'java') {
          return { status: 0, stdout: '', stderr: 'openjdk version "21.0.4" 2026-07-16' };
        }
        return {
          status: 0,
          stdout: 'Signer #1 certificate DN: CN=Turnleaf Release',
          stderr: '',
        };
      },
    });

    expect(verified.minSdkVersion).toBe(24);
    expect(verified.buildToolsVersion).toBe('36.0.0');
    expect(calls[1]).toEqual([
      '/sdk/build-tools/36.0.0/apksigner',
      ['verify', '--min-sdk-version', '24', '--print-certs', apkPath],
    ]);

    expect(() =>
      verifyReleaseApk({
        apkPath,
        variablesPath: variablesGradlePath,
        candidates: [{ path: '/sdk', source: 'ANDROID_HOME' }],
        ioOptions,
        platform: 'linux',
        run: (command) => {
          if (command === 'java') {
            return { status: 0, stdout: '', stderr: 'openjdk version "21.0.4" 2026-07-16' };
          }
          return {
            status: 1,
            stdout: '',
            stderr: 'DOES NOT VERIFY\nERROR: Missing META-INF/MANIFEST.MF',
          };
        },
      }),
    ).toThrow('DOES NOT VERIFY');
  });

  const realSigningTools = detectRealAndroidSigningTools();
  it.runIf(Boolean(realSigningTools))(
    'verifies a real signed APK with apksigner and rejects unsigned or tampered APKs',
    () => {
      const dir = createTempDirectory();
      const manifestPath = join(dir, 'AndroidManifest.xml');
      const unsignedApkPath = join(dir, 'unsigned.apk');
      const signedApkPath = join(dir, 'app-release.apk');
      const tamperedApkPath = join(dir, 'tampered.apk');
      const keystorePath = join(dir, 'release.jks');

      writeFileSync(
        manifestPath,
        [
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="app.turnleaf.reader">',
          '  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36" />',
          '</manifest>',
        ].join('\n'),
      );

      const linkResult = spawnSync(
        realSigningTools.aapt2Path,
        [
          'link',
          '-o',
          unsignedApkPath,
          '-I',
          realSigningTools.androidJarPath,
          '--manifest',
          manifestPath,
        ],
        { encoding: 'utf8' },
      );
      expect(linkResult.status).toBe(0);

      const keytoolResult = spawnSync(
        'keytool',
        [
          '-genkeypair',
          '-keystore',
          keystorePath,
          '-storepass',
          'turnleaf-test-pass',
          '-keypass',
          'turnleaf-test-pass',
          '-alias',
          'turnleaf',
          '-keyalg',
          'RSA',
          '-keysize',
          '2048',
          '-validity',
          '1',
          '-dname',
          'CN=Turnleaf Test',
        ],
        { encoding: 'utf8' },
      );
      expect(keytoolResult.status).toBe(0);

      expect(() =>
        verifyReleaseApk({
          apkPath: unsignedApkPath,
          variablesPath: variablesGradlePath,
        }),
      ).toThrow('APK signature verification failed');

      const signResult = spawnSync(
        realSigningTools.apksignerPath,
        [
          'sign',
          '--ks',
          keystorePath,
          '--ks-pass',
          'pass:turnleaf-test-pass',
          '--key-pass',
          'pass:turnleaf-test-pass',
          '--ks-key-alias',
          'turnleaf',
          '--min-sdk-version',
          '24',
          '--out',
          signedApkPath,
          unsignedApkPath,
        ],
        { encoding: 'utf8' },
      );
      expect(signResult.status).toBe(0);

      const signedDigest = computeFileSha256(signedApkPath);
      writeFileSync(`${signedApkPath}.sha256`, `${signedDigest}  app-release.apk\n`);

      const verified = verifyReleaseApk({
        apkPath: signedApkPath,
        sha256FilePath: `${signedApkPath}.sha256`,
        variablesPath: variablesGradlePath,
      });
      expect(verified.sha256).toBe(signedDigest);
      expect(verified.minSdkVersion).toBe(24);
      expect(verified.certificates).toContain('CN=Turnleaf Test');

      const mutatedBytes = Buffer.from(readFileSync(signedApkPath));
      mutatedBytes[32] ^= 0xff;
      writeFileSync(tamperedApkPath, mutatedBytes);

      expect(() =>
        verifyReleaseApk({
          apkPath: tamperedApkPath,
          variablesPath: variablesGradlePath,
        }),
      ).toThrow('APK signature verification failed');
    },
    REAL_SIGNING_TEST_TIMEOUT_MS,
  );

  it('keeps release preflight deduplication, revision guards, and provenance attestation gates wired in android-release.yml', () => {
    const workflowPath = join(projectRoot, '.github', 'workflows', 'android-release.yml');
    const workflow = readFileSync(workflowPath, 'utf8');
    const [buildSection, publishSection] = workflow.split('\n  publish-github-release:\n');
    expect(buildSection).toBeTruthy();
    expect(publishSection).toBeTruthy();

    expect(buildSection).toContain('id-token: write');
    expect(buildSection).toContain('attestations: write');
    expect(buildSection).toContain(
      'already_released: ${{ steps.release_preflight.outputs.already_released }}',
    );
    expect(buildSection).toContain('apk_sha256: ${{ steps.stage_release.outputs.apk_sha256 }}');
    expect(buildSection).toContain('notes_sha256: ${{ steps.stage_release.outputs.notes_sha256 }}');
    expect(buildSection).toContain(
      'min_sdk_version: ${{ steps.stage_release.outputs.min_sdk_version }}',
    );

    const buildSteps = buildSection
      .split(/\n {6}- name: /)
      .slice(1)
      .map((chunk) => {
        const [name, ...rest] = chunk.split('\n');
        return { name: name.trim(), body: rest.join('\n') };
      });
    const buildStepNames = buildSteps.map((step) => step.name);

    expect(buildStepNames.slice(0, 3)).toEqual([
      'Check out source',
      'Confirm release revision is current master',
      'Check for existing release',
    ]);
    expect(buildStepNames.indexOf('Confirm release revision is current before signing')).toBe(
      buildStepNames.indexOf('Restore signing key') - 1,
    );
    expect(buildStepNames.slice(-3)).toEqual([
      'Stage release artifacts and notes',
      'Attest release APK build provenance',
      'Upload release artifacts',
    ]);

    for (const step of buildSteps.slice(3)) {
      expect(
        step.body,
        `Expected build-release-apk step "${step.name}" to guard against already_released`,
      ).toContain("steps.release_preflight.outputs.already_released != 'true'");
    }

    expect(publishSection).toContain(
      "if: needs.build-release-apk.outputs.already_released != 'true'",
    );
    expect(publishSection).toContain('contents: write');
    expect(publishSection).toContain('attestations: read');

    const publishSteps = publishSection
      .split(/\n {6}- name: /)
      .slice(1)
      .map((chunk) => chunk.split('\n')[0].trim());

    expect(publishSteps).toEqual([
      'Check out release helper',
      'Download tested release artifacts',
      'Verify release provenance',
      'Verify APK provenance attestation',
      'Confirm release revision is still current master',
      'Publish GitHub release',
    ]);
  });
});
