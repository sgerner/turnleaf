import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncIosProject } from './ios-sync.mjs';
import { runCommand } from './run-command.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDirectory);

export function defaultSpmCacheDir(environment = process.env, home = homedir()) {
  return environment.TURNLEAF_SPM_CACHE_DIR || join(home, '.cache', 'turnleaf-spm');
}

export function shouldCleanXcodeBuild(environment = process.env) {
  return environment.TURNLEAF_XCODE_CLEAN === 'true';
}

export function buildXcodeSimulatorArgs({
  projectPath = join(projectRoot, 'ios', 'App', 'App.xcodeproj'),
  derivedDataPath = join(projectRoot, 'ios', 'App', 'DerivedData'),
  spmCachePath = defaultSpmCacheDir(),
  clean = false,
} = {}) {
  return [
    '-project',
    projectPath,
    '-scheme',
    'App',
    '-configuration',
    'Debug',
    '-destination',
    'generic/platform=iOS Simulator',
    '-derivedDataPath',
    derivedDataPath,
    '-clonedSourcePackagesDirPath',
    spmCachePath,
    'CODE_SIGNING_ALLOWED=NO',
    ...(clean ? ['clean', 'build'] : ['build']),
  ];
}

export function readPlistShortVersion(infoPlistPath, execFileSyncImpl = execFileSync) {
  return execFileSyncImpl(
    'plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlistPath],
    { encoding: 'utf8' },
  ).trim();
}

export function lintPlistFile(plistPath, execFileSyncImpl = execFileSync) {
  execFileSyncImpl('plutil', ['-lint', plistPath], { encoding: 'utf8' });
}

export function verifyBuiltSimulatorApp({
  appBundlePath,
  expectedVersion,
  existsSyncImpl = existsSync,
  statSyncImpl = statSync,
  readShortVersionImpl = readPlistShortVersion,
  lintPlistImpl = lintPlistFile,
}) {
  if (!existsSyncImpl(appBundlePath)) {
    throw new Error(`Expected built simulator app bundle at ${appBundlePath}.`);
  }

  const privacyManifestPath = join(appBundlePath, 'PrivacyInfo.xcprivacy');
  if (!existsSyncImpl(privacyManifestPath) || statSyncImpl(privacyManifestPath).size === 0) {
    throw new Error(
      `Built simulator app bundle omits PrivacyInfo.xcprivacy (${privacyManifestPath}).`,
    );
  }
  lintPlistImpl(privacyManifestPath);

  const infoPlistPath = join(appBundlePath, 'Info.plist');
  if (!existsSyncImpl(infoPlistPath)) {
    throw new Error(`Built simulator app bundle omits Info.plist (${infoPlistPath}).`);
  }

  const bundleVersion = readShortVersionImpl(infoPlistPath);
  if (bundleVersion !== expectedVersion) {
    throw new Error(
      `Built App.app CFBundleShortVersionString (${bundleVersion}) does not match package.json version (${expectedVersion}).`,
    );
  }
}

export async function main({
  platform = process.platform,
  env = process.env,
  rootDir = projectRoot,
} = {}) {
  if (platform !== 'darwin') {
    console.error('Building the iOS Simulator app requires macOS with Xcode installed.');
    process.exitCode = 1;
    return;
  }

  const derivedDataPath = join(rootDir, 'ios', 'App', 'DerivedData');
  const projectPath = join(rootDir, 'ios', 'App', 'App.xcodeproj');
  const spmCachePath = defaultSpmCacheDir(env);
  const appBundlePath = join(
    derivedDataPath,
    'Build',
    'Products',
    'Debug-iphonesimulator',
    'App.app',
  );
  const expectedVersion = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version;

  try {
    await syncIosProject({ env, rootDir });
    const xcodeArgs = buildXcodeSimulatorArgs({
      projectPath,
      derivedDataPath,
      spmCachePath,
      clean: shouldCleanXcodeBuild(env),
    });
    await runCommand('xcodebuild', xcodeArgs, {
      cwd: rootDir,
      env,
      label: 'xcodebuild',
    });
    verifyBuiltSimulatorApp({ appBundlePath, expectedVersion });
    console.log(
      `Verified iOS Simulator bundle at ${appBundlePath} (version ${expectedVersion}, PrivacyInfo.xcprivacy included).`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
