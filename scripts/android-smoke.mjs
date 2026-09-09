import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const apkPath = resolve(projectRoot, 'android/app/build/outputs/apk/debug/app-debug.apk');
const packageName = 'app.turnleaf.reader.debug';
const activity = `${packageName}/app.turnleaf.reader.MainActivity`;

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

export async function main() {
  await access(apkPath);
  await run('adb', ['wait-for-device']);
  await run('adb', ['install', '-r', apkPath]);
  await run('adb', ['shell', 'am', 'start', '-W', '-n', activity]);
  const process = await run('adb', ['shell', 'pidof', packageName]);
  if (!process.stdout.trim()) throw new Error(`Android app process ${packageName} is not running.`);
  console.log(`Android smoke check passed for ${packageName} (pid ${process.stdout.trim()}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
