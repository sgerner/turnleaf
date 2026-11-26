import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergedManifestPath, verifyMergedManifestFile } from './check-android-manifest.mjs';
import { runCommand } from './run-command.mjs';
import {
  detectJavaCompatibility,
  formatFailure,
  formatJavaFailure,
  sdkCandidates,
  validateAndroidSdk,
} from './check-android-sdk.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDirectory);
const androidDirectory = join(projectRoot, 'android');

const SIGNING_ENV_KEYS = [
  'TURNLEAF_STORE_FILE',
  'TURNLEAF_STORE_PASSWORD',
  'TURNLEAF_KEY_ALIAS',
  'TURNLEAF_KEY_PASSWORD',
];

export function childEnvironment(
  sdkPath,
  environment = process.env,
  { includeSigningSecrets = true } = {},
) {
  const next = {
    ...environment,
    ANDROID_HOME: sdkPath,
    ANDROID_SDK_ROOT: sdkPath,
  };
  if (!includeSigningSecrets) {
    for (const key of SIGNING_ENV_KEYS) {
      delete next[key];
    }
  }
  return next;
}

export function gradleTask(mode) {
  if (mode === 'debug') return 'assembleDebug';
  if (mode === 'release') return 'assembleRelease';
  throw new Error(`Unsupported Android build mode: ${mode}`);
}

export function gradleArgs(mode, extraArgs = []) {
  const forwarded = extraArgs[0] === '--' ? extraArgs.slice(1) : extraArgs;
  return [gradleTask(mode), ...forwarded];
}

export function canReuseWebBuild(environment = process.env) {
  return environment.TURNLEAF_REUSE_WEB_BUILD === 'true';
}

export async function main(
  mode = process.argv[2],
  extraArgs = process.argv.slice(3),
  {
    environment = process.env,
    platform = process.platform,
    validateSdk = () => validateAndroidSdk(sdkCandidates({ env: environment, platform })),
    detectJava = detectJavaCompatibility,
    run = runCommand,
    verifyManifests = run === runCommand,
    log = console.log,
    errorLog = console.error,
  } = {},
) {
  let args;
  try {
    args = gradleArgs(mode, extraArgs);
  } catch (error) {
    errorLog(error.message);
    process.exitCode = 1;
    return;
  }

  const sdk = validateSdk();
  if (!sdk.ok) {
    errorLog(formatFailure(sdk));
    process.exitCode = 1;
    return;
  }

  const java = detectJava();
  if (!java.ok) {
    errorLog(formatJavaFailure(java));
    process.exitCode = 1;
    return;
  }

  const baseEnv = childEnvironment(sdk.sdk.path, environment, { includeSigningSecrets: false });
  const gradleEnv = childEnvironment(sdk.sdk.path, environment, {
    includeSigningSecrets: mode === 'release',
  });
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  const gradle = platform === 'win32' ? 'gradlew.bat' : './gradlew';
  const reuseWebBuild = canReuseWebBuild(baseEnv);
  log(`Using Android SDK at ${sdk.sdk.path} for Capacitor and Gradle.`);

  try {
    if (!reuseWebBuild) await run(npm, ['run', 'build'], { cwd: projectRoot, env: baseEnv });
    await run(npm, ['exec', '--', 'cap', 'sync', 'android'], {
      cwd: projectRoot,
      env: baseEnv,
    });
    let buildError;
    let stopError;
    try {
      const effectiveArgs = verifyManifests
        ? [
            args[0],
            mode === 'debug' ? 'processReleaseMainManifest' : 'processDebugMainManifest',
            ...args.slice(1),
          ]
        : args;
      await run(gradle, effectiveArgs, { cwd: androidDirectory, env: gradleEnv });
      if (verifyManifests) {
        for (const variant of ['debug', 'release']) {
          const permissions = verifyMergedManifestFile(
            mergedManifestPath(variant, projectRoot),
            `${variant} merged AndroidManifest.xml`,
          );
          log(
            `Verified ${variant} merged AndroidManifest.xml permissions: ${permissions.join(', ')}.`,
          );
        }
      }
    } catch (error) {
      buildError = error;
    } finally {
      if (mode === 'release') {
        try {
          await run(gradle, ['--stop'], { cwd: androidDirectory, env: baseEnv });
        } catch (error) {
          stopError = error;
        }
      }
    }
    if (buildError) throw buildError;
    if (stopError) throw stopError;
  } catch (error) {
    errorLog(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
