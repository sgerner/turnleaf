import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export function childEnvironment(sdkPath, environment = process.env) {
  return {
    ...environment,
    ANDROID_HOME: sdkPath,
    ANDROID_SDK_ROOT: sdkPath,
  };
}

export function gradleTask(mode) {
  if (mode === 'debug') return 'assembleDebug';
  if (mode === 'release') return 'assembleRelease';
  throw new Error(`Unsupported Android build mode: ${mode}`);
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      ...options,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.once('error', rejectCommand);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }

      const error = new Error(
        signal ? `${command} terminated by ${signal}` : `${command} exited with code ${code}`,
      );
      error.exitCode = code ?? 1;
      rejectCommand(error);
    });
  });
}

export async function main(mode = process.argv[2]) {
  let task;
  try {
    task = gradleTask(mode);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const sdk = validateAndroidSdk(sdkCandidates());
  if (!sdk.ok) {
    console.error(formatFailure(sdk));
    process.exitCode = 1;
    return;
  }

  const java = detectJavaCompatibility();
  if (!java.ok) {
    console.error(formatJavaFailure(java));
    process.exitCode = 1;
    return;
  }

  const env = childEnvironment(sdk.sdk.path);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  console.log(`Using Android SDK at ${sdk.sdk.path} for Capacitor and Gradle.`);

  try {
    await runCommand(npm, ['run', 'cap:sync'], { cwd: projectRoot, env });
    await runCommand(gradle, [task], { cwd: androidDirectory, env });
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
