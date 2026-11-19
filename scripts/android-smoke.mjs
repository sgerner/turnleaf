import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { resolveDeviceSerial } from './android-device.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultApkPath = resolve(
  projectRoot,
  process.env.ANDROID_APK_PATH || 'android/app/build/outputs/apk/debug/app-debug.apk',
);
const defaultPackageName = process.env.ANDROID_PACKAGE_NAME || 'app.turnleaf.reader.debug';

const run = promisify(execFile);

export async function main({
  apkPath = defaultApkPath,
  packageName = defaultPackageName,
  resetData = false,
  serial = process.env.ANDROID_SERIAL,
} = {}) {
  const targetApkPath = resolve(apkPath);
  const activity = `${packageName}/app.turnleaf.reader.MainActivity`;
  const targetSerial = await resolveDeviceSerial({ requestedSerial: serial });
  const adb = (...args) => run('adb', ['-s', targetSerial, ...args], { timeout: 90_000 });

  await access(targetApkPath);
  await adb('wait-for-device');
  await adb('install', '-r', targetApkPath);
  if (resetData) await adb('shell', 'pm', 'clear', packageName);
  const launch = await adb('shell', 'am', 'start', '-S', '-W', '-n', activity);
  if (!/^Status: ok\s*$/m.test(launch.stdout) || /^(Error|Exception):/m.test(launch.stdout)) {
    throw new Error(`Android failed to launch ${activity}: ${launch.stdout.trim()}`);
  }
  const firstPid = (await adb('shell', 'pidof', packageName)).stdout.trim();
  await delay(3_000);
  const appProcess = (await adb('shell', 'pidof', packageName)).stdout.trim();
  const { stdout: activities } = await adb('shell', 'dumpsys', 'activity', 'activities');
  const resumed = activities
    .split('\n')
    .some(
      (line) =>
        /(?:topResumedActivity|mResumedActivity)/.test(line) && line.includes(packageName + '/'),
    );
  if (!appProcess || firstPid !== appProcess || !resumed) {
    const { stdout: crashes } = await adb('logcat', '-d', '-b', 'crash', '-t', '60');
    throw new Error(
      `Android app ${packageName} did not stay in the foreground.\n${crashes.trim()}`,
    );
  }
  console.log(`Android smoke check passed for ${packageName} (pid ${appProcess}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
