import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ANDROID_PLATFORM = 'android-36';
export const MIN_JAVA_MAJOR = 17;

const BUILD_TOOLS_VERSION = /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*$/;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDirectory);
const localPropertiesPath = join(projectRoot, 'android', 'local.properties');

function readLocalProperties(path = localPropertiesPath) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function unescapeProperty(value) {
  return value.replace(/\\([\\:=])/g, '$1').trim();
}

export function parseSdkDir(contents) {
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const match = /^\s*sdk\.dir\s*=(.*)$/.exec(line);
    if (match?.[1]) return unescapeProperty(match[1]);
  }
  return null;
}

function addCandidate(candidates, value, source, baseDirectory) {
  if (!value?.trim()) return;
  const trimmed = value.trim();
  const path = isAbsolute(trimmed) ? trimmed : resolve(baseDirectory, trimmed);
  if (candidates.some((candidate) => candidate.path === path)) return;
  candidates.push({ path, source });
}

export function sdkCandidates({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  localPropertiesContents = readLocalProperties(),
  localPropertiesDirectory = dirname(localPropertiesPath),
} = {}) {
  const candidates = [];
  addCandidate(
    candidates,
    parseSdkDir(localPropertiesContents),
    'android/local.properties',
    localPropertiesDirectory,
  );
  addCandidate(candidates, env.ANDROID_HOME, 'ANDROID_HOME', home);
  addCandidate(candidates, env.ANDROID_SDK_ROOT, 'ANDROID_SDK_ROOT', home);

  if (platform === 'darwin') {
    addCandidate(candidates, join(home, 'Library', 'Android', 'sdk'), 'macOS default', home);
  } else if (platform === 'win32') {
    if (env.LOCALAPPDATA) {
      addCandidate(candidates, join(env.LOCALAPPDATA, 'Android', 'Sdk'), 'Windows default', home);
    }
    addCandidate(
      candidates,
      join(home, 'AppData', 'Local', 'Android', 'Sdk'),
      'Windows default',
      home,
    );
  } else {
    addCandidate(candidates, join(home, 'Android', 'Sdk'), 'Linux default', home);
  }

  return candidates;
}

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

export function buildToolsVersions(
  sdkPath,
  { isDirectory = defaultIsDirectory, readDirectory = defaultReadDirectory } = {},
) {
  const buildToolsPath = join(sdkPath, 'build-tools');
  if (!isDirectory(buildToolsPath)) return [];

  return readDirectory(buildToolsPath).filter(
    (entry) => BUILD_TOOLS_VERSION.test(entry) && isDirectory(join(buildToolsPath, entry)),
  );
}

function missingPackages(sdkPath, { isDirectory, readDirectory }) {
  const missing = [];
  if (!isDirectory(join(sdkPath, 'platforms', ANDROID_PLATFORM))) {
    missing.push(`Android SDK Platform ${ANDROID_PLATFORM.slice('android-'.length)}`);
  }
  if (buildToolsVersions(sdkPath, { isDirectory, readDirectory }).length === 0) {
    missing.push('Android SDK Build Tools');
  }
  return missing;
}

export function validateAndroidSdk(
  candidates,
  { isDirectory = defaultIsDirectory, readDirectory = defaultReadDirectory } = {},
) {
  const existingCandidates = candidates.filter((candidate) => isDirectory(candidate.path));
  if (existingCandidates.length === 0) {
    return {
      ok: false,
      sdk: null,
      missing: ['Android SDK'],
      candidates,
    };
  }

  const packageOptions = { isDirectory, readDirectory };
  const sdk = existingCandidates.find(
    (candidate) => missingPackages(candidate.path, packageOptions).length === 0,
  );
  if (sdk) {
    return {
      ok: true,
      sdk,
      missing: [],
      candidates,
    };
  }

  const firstExisting = existingCandidates[0];
  const missing = missingPackages(firstExisting.path, packageOptions);

  return {
    ok: missing.length === 0,
    sdk: firstExisting,
    missing,
    candidates,
  };
}

export function parseJavaMajor(versionOutput) {
  const version = /version\s+"([^"]+)"/.exec(versionOutput)?.[1];
  if (!version) return null;

  const parts = version.split(/[._-]/).map(Number);
  if (!Number.isInteger(parts[0])) return null;
  return parts[0] === 1 ? (parts[1] ?? null) : parts[0];
}

export function validateJavaCompatibility(javaMajor, minimum = MIN_JAVA_MAJOR) {
  return {
    ok: Number.isInteger(javaMajor) && javaMajor >= minimum,
    major: javaMajor,
    minimum,
  };
}

export function detectJavaCompatibility({ run = spawnSync } = {}) {
  const result = run('java', ['-version'], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const major = parseJavaMajor(output);
  return {
    ...validateJavaCompatibility(major),
    output,
    error: result.error ?? null,
  };
}

export function formatFailure(result) {
  const checked = result.candidates.map(
    (candidate) => `  - ${candidate.path} (${candidate.source})`,
  );
  const lines = ['Android SDK setup is incomplete.'];
  if (result.sdk) {
    lines.push(`Found an SDK at ${result.sdk.path}, but it is missing:`);
    lines.push(...result.missing.map((item) => `  - ${item}`));
  } else {
    lines.push('No Android SDK was found. Checked:');
    lines.push(...checked);
  }
  lines.push(
    '',
    'Install Android Studio or the Android command-line tools, then set the SDK path:',
    '  export ANDROID_HOME="$HOME/Android/Sdk"',
    '  npm run android:doctor',
    '',
    'You can also configure this checkout with android/local.properties:',
    '  printf \'sdk.dir=%s\\n\' "/absolute/path/to/Android/Sdk" > android/local.properties',
  );
  return lines.join('\n');
}

export function formatJavaFailure(result) {
  if (result.major === null) {
    return [
      'Java setup is incomplete or could not be detected.',
      'Android builds require a working Java installation (JDK 17 or newer).',
      'Install a supported JDK and ensure `java` is available on PATH.',
    ].join('\n');
  }

  return [
    `Java ${result.major} is too old for the Android Gradle plugin.`,
    `Android builds require Java ${result.minimum} or newer.`,
    'Install a supported JDK and ensure `java` is available on PATH.',
  ].join('\n');
}

export function main() {
  const result = validateAndroidSdk(sdkCandidates());
  if (!result.ok) {
    console.error(formatFailure(result));
    process.exitCode = 1;
    return;
  }

  const java = detectJavaCompatibility();
  if (!java.ok) {
    console.error(formatJavaFailure(java));
    process.exitCode = 1;
    return;
  }

  const versions = buildToolsVersions(result.sdk.path);
  console.log(
    `Android SDK ready at ${result.sdk.path} (${result.sdk.source}); ` +
      `platform ${ANDROID_PLATFORM}, build tools ${versions.join(', ')}, Java ${java.major}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
