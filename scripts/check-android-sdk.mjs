import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ANDROID_PLATFORM = 'android-36';

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

export function validateAndroidSdk(
  candidates,
  { isDirectory = defaultIsDirectory, readDirectory = defaultReadDirectory } = {},
) {
  const sdk = candidates.find((candidate) => isDirectory(candidate.path)) ?? null;
  if (!sdk) {
    return {
      ok: false,
      sdk: null,
      missing: ['Android SDK'],
      candidates,
    };
  }

  const missing = [];
  if (!isDirectory(join(sdk.path, 'platforms', ANDROID_PLATFORM))) {
    missing.push(`Android SDK Platform ${ANDROID_PLATFORM.slice('android-'.length)}`);
  }
  const buildToolsPath = join(sdk.path, 'build-tools');
  if (!isDirectory(buildToolsPath) || readDirectory(buildToolsPath).length === 0) {
    missing.push('Android SDK Build Tools');
  }

  return {
    ok: missing.length === 0,
    sdk,
    missing,
    candidates,
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

export function main() {
  const result = validateAndroidSdk(sdkCandidates());
  if (!result.ok) {
    console.error(formatFailure(result));
    process.exitCode = 1;
    return;
  }
  console.log(`Android SDK ready at ${result.sdk.path} (${result.sdk.source}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
