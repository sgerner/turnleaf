import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDeviceSerial } from './android-device.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultApkPath = resolve(
  projectRoot,
  process.env.ANDROID_APK_PATH || 'android/app/build/outputs/apk/debug/app-debug.apk',
);
const defaultPackageName = process.env.ANDROID_PACKAGE_NAME || 'app.turnleaf.reader.debug';

function run(command, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectCommand);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveCommand({ stdout, stderr });
        return;
      }
      rejectCommand(
        new Error(
          signal
            ? `${command} terminated by ${signal}`
            : `${command} exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
        ),
      );
    });
  });
}

export async function main({
  apkPath = defaultApkPath,
  packageName = defaultPackageName,
  resetData = false,
  serial = process.env.ANDROID_SERIAL,
} = {}) {
  const targetApkPath = resolve(apkPath);
  const activity = `${packageName}/app.turnleaf.reader.MainActivity`;
  const targetSerial = await resolveDeviceSerial({ requestedSerial: serial });
  const adb = (...args) => run('adb', ['-s', targetSerial, ...args]);

  await access(targetApkPath);
  await adb('wait-for-device');
  await adb('install', '-r', targetApkPath);
  if (resetData) await adb('shell', 'pm', 'clear', packageName);
  await adb('shell', 'am', 'start', '-W', '-n', activity);
  const appProcess = await adb('shell', 'pidof', packageName);
  if (!appProcess.stdout.trim()) {
    throw new Error(`Android app process ${packageName} is not running.`);
  }
  console.log(`Android smoke check passed for ${packageName} (pid ${appProcess.stdout.trim()}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
