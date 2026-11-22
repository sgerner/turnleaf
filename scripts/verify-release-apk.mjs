import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from './android-build.mjs';
import {
  buildToolsVersions,
  detectJavaCompatibility,
  formatFailure,
  formatJavaFailure,
  sdkCandidates,
  validateAndroidSdk,
} from './check-android-sdk.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDirectory);
const defaultVariablesGradlePath = join(projectRoot, 'android', 'variables.gradle');
export const DEFAULT_RELEASE_APK_RELATIVE_PATH = join(
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'release',
  'app-release.apk',
);

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const LINUX_RUNNER_SDK_PATH = '/usr/local/lib/android/sdk';

function defaultIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultReadDirectory(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function defaultIsExecutable(path, platform = process.platform) {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') {
      accessSync(path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function apksignerExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'apksigner.bat' : 'apksigner';
}

export function parseMinSdkVersion(contents) {
  const withoutBlockComments = contents.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const line of withoutBlockComments.split(/\r?\n/)) {
    const cleanLine = line.replace(/\/\/.*$/, '').trim();
    if (!cleanLine) continue;
    const match = /^minSdkVersion\s*=\s*(\d+)$/.exec(cleanLine);
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isInteger(parsed) && parsed >= 1) return parsed;
    }
  }
  throw new Error('Could not parse a valid minSdkVersion from android/variables.gradle.');
}

function parseVersionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-.](.+))?$/.exec(version);
  if (!match) return { major: 0, minor: 0, patch: 0, prerelease: version };
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ?? '',
  };
}

export function compareBuildToolsVersions(left, right) {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  if (a.major !== b.major) return b.major - a.major;
  if (a.minor !== b.minor) return b.minor - a.minor;
  if (a.patch !== b.patch) return b.patch - a.patch;
  if (!a.prerelease && b.prerelease) return -1;
  if (a.prerelease && !b.prerelease) return 1;
  return b.prerelease.localeCompare(a.prerelease, undefined, { numeric: true });
}

export function releaseSdkCandidates(options = {}) {
  const platform = options.platform ?? process.platform;
  const candidates = [...sdkCandidates(options)];
  if (
    platform === 'linux' &&
    !candidates.some((candidate) => candidate.path === LINUX_RUNNER_SDK_PATH)
  ) {
    candidates.push({ path: LINUX_RUNNER_SDK_PATH, source: 'Linux runner default' });
  }
  return candidates;
}

export function resolveApksigner(
  candidates = releaseSdkCandidates(),
  {
    isDirectory = defaultIsDirectory,
    readDirectory = defaultReadDirectory,
    isExecutable,
    platform = process.platform,
  } = {},
) {
  const checkExecutable =
    isExecutable ?? ((binaryPath) => defaultIsExecutable(binaryPath, platform));
  const existingCandidates = candidates.filter((candidate) => isDirectory(candidate.path));
  if (existingCandidates.length === 0) {
    return {
      ok: false,
      reason: 'missing-sdk',
      apksignerPath: null,
      sdk: null,
      version: null,
      candidates,
    };
  }

  const validated = validateAndroidSdk(existingCandidates, { isDirectory, readDirectory });
  const prioritizedCandidates = validated.ok
    ? [
        validated.sdk,
        ...existingCandidates.filter((candidate) => candidate.path !== validated.sdk.path),
      ]
    : existingCandidates;

  const executableName = apksignerExecutableName(platform);
  for (const candidate of prioritizedCandidates) {
    const versions = buildToolsVersions(candidate.path, { isDirectory, readDirectory }).sort(
      compareBuildToolsVersions,
    );
    for (const version of versions) {
      const binaryPath = join(candidate.path, 'build-tools', version, executableName);
      if (checkExecutable(binaryPath)) {
        return {
          ok: true,
          reason: null,
          apksignerPath: binaryPath,
          sdk: candidate,
          version,
          candidates,
        };
      }
    }
  }

  return {
    ok: false,
    reason: 'missing-apksigner',
    apksignerPath: null,
    sdk: existingCandidates[0],
    version: null,
    candidates,
  };
}

export function formatApksignerFailure(result, ioOptions = {}) {
  if (result.reason === 'missing-sdk') {
    return formatFailure(validateAndroidSdk(result.candidates, ioOptions));
  }

  return [
    `No executable apksigner binary was found under ${join(result.sdk.path, 'build-tools')}.`,
    'Install Android SDK Build Tools and ensure apksigner is executable, then re-run:',
    '  npm run android:doctor',
    '  npm run android:verify-release',
  ].join('\n');
}

export function computeFileSha256(filePath) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    throw new Error(`Release APK not found at ${filePath}.`);
  }
  if (!stats.isFile()) {
    throw new Error(`Release APK path is not a regular file: ${filePath}.`);
  }
  if (stats.size === 0) {
    throw new Error(`Release APK is empty: ${filePath}.`);
  }

  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function parseSha256Checksum(contents, expectedFileName) {
  const lines = String(contents)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw new Error('Invalid SHA-256 checksum file: expected exactly one checksum entry.');
  }

  const match = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(lines[0]);
  if (!match) {
    throw new Error('Invalid SHA-256 checksum format: expected a 64-character hex digest.');
  }

  if (match[2] && expectedFileName) {
    const recordedName = basename(match[2].trim());
    if (recordedName !== expectedFileName) {
      throw new Error(
        `SHA-256 checksum target mismatch: expected ${expectedFileName}, got ${match[2].trim()}.`,
      );
    }
  }

  return match[1].toLowerCase();
}

export function verifyApkDigest(apkPath, { expectedSha256, sha256FilePath } = {}) {
  const actualSha256 = computeFileSha256(apkPath);

  if (expectedSha256 !== undefined) {
    const normalizedExpected = String(expectedSha256).trim().toLowerCase();
    if (!SHA256_HEX_PATTERN.test(normalizedExpected)) {
      throw new Error('Expected SHA-256 digest must be a non-empty 64-character hex string.');
    }
    if (actualSha256 !== normalizedExpected) {
      throw new Error(
        `APK SHA-256 digest mismatch for ${apkPath}: expected ${normalizedExpected}, got ${actualSha256}.`,
      );
    }
  }

  if (sha256FilePath !== undefined) {
    const resolvedChecksumPath = String(sha256FilePath).trim();
    if (!resolvedChecksumPath) {
      throw new Error('SHA-256 checksum file path must not be empty.');
    }
    let checksumContents;
    try {
      checksumContents = readFileSync(resolvedChecksumPath, 'utf8');
    } catch {
      throw new Error(`SHA-256 checksum file not found at ${resolvedChecksumPath}.`);
    }
    const recordedDigest = parseSha256Checksum(checksumContents, basename(apkPath));
    if (actualSha256 !== recordedDigest) {
      throw new Error(
        `APK SHA-256 checksum file mismatch for ${apkPath}: expected ${recordedDigest}, got ${actualSha256}.`,
      );
    }
  }

  return actualSha256;
}

function parsePositiveInteger(value, label) {
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function parseCliArgs(argv = [], env = process.env, rootDirectory = projectRoot) {
  let cliApkPath;
  let cliExpectedSha256;
  let cliSha256FilePath;
  let cliMinSdkVersion;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apk') {
      if (index + 1 >= argv.length) throw new Error('Missing value for --apk.');
      cliApkPath = argv[index + 1];
      index += 1;
    } else if (arg === '--sha256') {
      if (index + 1 >= argv.length) throw new Error('Missing value for --sha256.');
      cliExpectedSha256 = argv[index + 1];
      index += 1;
    } else if (arg === '--sha256-file') {
      if (index + 1 >= argv.length) throw new Error('Missing value for --sha256-file.');
      cliSha256FilePath = argv[index + 1];
      index += 1;
    } else if (arg === '--min-sdk-version') {
      if (index + 1 >= argv.length) throw new Error('Missing value for --min-sdk-version.');
      cliMinSdkVersion = parsePositiveInteger(argv[index + 1], 'minSdkVersion');
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (cliApkPath === undefined) {
      cliApkPath = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  const rawApkPath =
    cliApkPath ??
    ('ANDROID_APK_PATH' in env ? env.ANDROID_APK_PATH : DEFAULT_RELEASE_APK_RELATIVE_PATH);
  if (!String(rawApkPath ?? '').trim()) {
    throw new Error('APK path must not be empty.');
  }
  const apkPath = resolve(rootDirectory, String(rawApkPath).trim());

  const expectedSha256 =
    cliExpectedSha256 !== undefined
      ? cliExpectedSha256
      : 'ANDROID_EXPECTED_SHA256' in env
        ? env.ANDROID_EXPECTED_SHA256
        : undefined;

  let sha256FilePath;
  if (cliSha256FilePath !== undefined) {
    sha256FilePath = cliSha256FilePath.trim()
      ? resolve(rootDirectory, cliSha256FilePath.trim())
      : '';
  } else if ('ANDROID_SHA256_FILE' in env) {
    const rawFile = String(env.ANDROID_SHA256_FILE ?? '').trim();
    sha256FilePath = rawFile ? resolve(rootDirectory, rawFile) : '';
  } else if (existsSync(`${apkPath}.sha256`)) {
    sha256FilePath = `${apkPath}.sha256`;
  }

  const minSdkVersion =
    cliMinSdkVersion !== undefined
      ? cliMinSdkVersion
      : 'ANDROID_MIN_SDK_VERSION' in env
        ? parsePositiveInteger(env.ANDROID_MIN_SDK_VERSION, 'ANDROID_MIN_SDK_VERSION')
        : undefined;

  return {
    apkPath,
    expectedSha256,
    sha256FilePath,
    minSdkVersion,
  };
}

export function verifyReleaseApk({
  apkPath = resolve(projectRoot, DEFAULT_RELEASE_APK_RELATIVE_PATH),
  expectedSha256,
  sha256FilePath,
  minSdkVersion,
  variablesPath = defaultVariablesGradlePath,
  candidates,
  ioOptions = {},
  run = spawnSync,
  env = process.env,
  platform = process.platform,
} = {}) {
  const targetApkPath = resolve(apkPath);
  const resolvedMinSdk =
    minSdkVersion !== undefined
      ? parsePositiveInteger(minSdkVersion, 'minSdkVersion')
      : parseMinSdkVersion(readFileSync(variablesPath, 'utf8'));

  const sha256 = verifyApkDigest(targetApkPath, { expectedSha256, sha256FilePath });

  const resolvedCandidates = candidates ?? releaseSdkCandidates({ env, platform });
  const apksigner = resolveApksigner(resolvedCandidates, { ...ioOptions, platform });
  if (!apksigner.ok) {
    throw new Error(formatApksignerFailure(apksigner, ioOptions));
  }

  const java = detectJavaCompatibility({ run });
  if (!java.ok) {
    throw new Error(formatJavaFailure(java));
  }

  const verifyResult = run(
    apksigner.apksignerPath,
    ['verify', '--min-sdk-version', String(resolvedMinSdk), '--print-certs', targetApkPath],
    {
      encoding: 'utf8',
      env: childEnvironment(apksigner.sdk.path, env),
      shell: platform === 'win32',
    },
  );

  if (verifyResult.error || verifyResult.status !== 0) {
    const details = [verifyResult.stdout, verifyResult.stderr, verifyResult.error?.message]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join('\n');
    throw new Error(
      details
        ? `APK signature verification failed for ${targetApkPath}:\n${details}`
        : `APK signature verification failed for ${targetApkPath}.`,
    );
  }

  return {
    apkPath: targetApkPath,
    sha256,
    minSdkVersion: resolvedMinSdk,
    apksignerPath: apksigner.apksignerPath,
    buildToolsVersion: apksigner.version,
    certificates: (verifyResult.stdout ?? '').trim(),
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const options = parseCliArgs(argv, env);
    const result = verifyReleaseApk({ ...options, env });
    console.log(
      `Verified release APK ${result.apkPath} (minSdkVersion ${result.minSdkVersion}, ` +
        `build-tools ${result.buildToolsVersion}, sha256 ${result.sha256}).`,
    );
    if (result.certificates) {
      console.log(result.certificates);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
