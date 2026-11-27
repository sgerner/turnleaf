import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './run-command.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = dirname(scriptDirectory);

export function canReuseWebBuild(environment = process.env) {
  return environment.TURNLEAF_REUSE_WEB_BUILD === 'true';
}

export function extractPbxprojSection(pbxprojContent, sectionName) {
  const beginMarker = `/* Begin ${sectionName} section */`;
  const endMarker = `/* End ${sectionName} section */`;
  const start = pbxprojContent.indexOf(beginMarker);
  const end = pbxprojContent.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    return '';
  }
  return pbxprojContent.slice(start + beginMarker.length, end);
}

export function syncMarketingVersion(pbxprojContent, expectedVersion) {
  const pattern = /^(\s*MARKETING_VERSION = )([^;]+)(;)$/gm;
  let matchCount = 0;
  const content = pbxprojContent.replace(pattern, (_full, prefix, _current, suffix) => {
    matchCount += 1;
    return `${prefix}${expectedVersion}${suffix}`;
  });

  if (matchCount < 2) {
    throw new Error(
      'Expected Debug and Release MARKETING_VERSION settings in ios/App/App.xcodeproj/project.pbxproj.',
    );
  }

  return {
    content,
    updated: content !== pbxprojContent,
  };
}

export function validateIosManifests({
  packageVersion,
  capacitorIosVersion,
  packageSwiftContent,
  pbxprojContent,
  infoPlistContent,
  privacyManifestExists,
  privacyManifestContent = '',
}) {
  const errors = [];

  const spmMatch =
    /\.package\(\s*url:\s*"https:\/\/github\.com\/ionic-team\/capacitor-swift-pm\.git",\s*exact:\s*"([^"]+)"\s*\)/.exec(
      packageSwiftContent,
    );
  const pinnedSpmVersion = spmMatch?.[1] ?? null;
  if (pinnedSpmVersion !== capacitorIosVersion) {
    errors.push(
      `ios/App/CapApp-SPM/Package.swift pins capacitor-swift-pm to ${pinnedSpmVersion ?? 'missing'}, expected ${capacitorIosVersion} from @capacitor/ios.`,
    );
  }

  const marketingVersions = Array.from(
    pbxprojContent.matchAll(/^\s*MARKETING_VERSION = ([^;]+);$/gm),
    (match) => match[1].trim().replace(/^"(.*)"$/, '$1'),
  );
  if (
    marketingVersions.length < 2 ||
    marketingVersions.some((version) => version !== packageVersion)
  ) {
    errors.push(
      `ios/App/App.xcodeproj/project.pbxproj MARKETING_VERSION (${marketingVersions.join(', ') || 'missing'}) does not match package.json version ${packageVersion}.`,
    );
  }

  if (
    !/<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/.test(
      infoPlistContent,
    )
  ) {
    errors.push(
      'ios/App/App/Info.plist must set CFBundleShortVersionString to $(MARKETING_VERSION).',
    );
  }

  if (!privacyManifestExists) {
    errors.push('Missing privacy manifest at ios/App/App/PrivacyInfo.xcprivacy.');
  } else if (
    !privacyManifestContent.includes('<key>NSPrivacyAccessedAPITypes</key>') ||
    !privacyManifestContent.includes('<key>NSPrivacyTracking</key>')
  ) {
    errors.push(
      'ios/App/App/PrivacyInfo.xcprivacy is missing required Apple privacy manifest keys.',
    );
  }

  const fileReferenceSection = extractPbxprojSection(pbxprojContent, 'PBXFileReference');
  const fileRefMatch =
    /^\s*([0-9A-F]{24})\b[^\n]*=\s*\{isa = PBXFileReference;[^\n]*\bpath = "?PrivacyInfo\.xcprivacy"?;/m.exec(
      fileReferenceSection,
    );
  const privacyFileRefId = fileRefMatch?.[1] ?? null;

  if (!privacyFileRefId) {
    errors.push(
      'ios/App/App.xcodeproj/project.pbxproj is missing a PBXFileReference for PrivacyInfo.xcprivacy.',
    );
  } else {
    const buildFileSection = extractPbxprojSection(pbxprojContent, 'PBXBuildFile');
    const buildFileMatch = new RegExp(
      `^\\s*([0-9A-F]{24})\\b[^\\n]*=\\s*\\{isa = PBXBuildFile;[^\\n]*\\bfileRef = ${privacyFileRefId}\\b`,
      'm',
    ).exec(buildFileSection);
    const privacyBuildFileId = buildFileMatch?.[1] ?? null;

    if (!privacyBuildFileId) {
      errors.push(
        'ios/App/App.xcodeproj/project.pbxproj is missing a PBXBuildFile for PrivacyInfo.xcprivacy.',
      );
    } else {
      const resourcesSection = extractPbxprojSection(pbxprojContent, 'PBXResourcesBuildPhase');
      const inResources = new RegExp(`\\b${privacyBuildFileId}\\b`).test(resourcesSection);
      if (!inResources) {
        errors.push(
          'ios/App/App.xcodeproj/project.pbxproj omits PrivacyInfo.xcprivacy from PBXResourcesBuildPhase target resources.',
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function readIosManifestState(rootDir = projectRoot) {
  const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const capacitorIosJson = JSON.parse(
    readFileSync(join(rootDir, 'node_modules', '@capacitor', 'ios', 'package.json'), 'utf8'),
  );
  const packageSwiftPath = join(rootDir, 'ios', 'App', 'CapApp-SPM', 'Package.swift');
  const pbxprojPath = join(rootDir, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  const infoPlistPath = join(rootDir, 'ios', 'App', 'App', 'Info.plist');
  const privacyManifestPath = join(rootDir, 'ios', 'App', 'App', 'PrivacyInfo.xcprivacy');
  const privacyManifestExists = existsSync(privacyManifestPath);

  return {
    packageVersion: packageJson.version,
    capacitorIosVersion: capacitorIosJson.version,
    packageSwiftPath,
    packageSwiftContent: readFileSync(packageSwiftPath, 'utf8'),
    pbxprojPath,
    pbxprojContent: readFileSync(pbxprojPath, 'utf8'),
    infoPlistPath,
    infoPlistContent: readFileSync(infoPlistPath, 'utf8'),
    privacyManifestPath,
    privacyManifestExists,
    privacyManifestContent: privacyManifestExists ? readFileSync(privacyManifestPath, 'utf8') : '',
  };
}

export function verifyGitCleanIos({ cwd = projectRoot, execFileSyncImpl = execFileSync } = {}) {
  const status = execFileSyncImpl('git', ['status', '--porcelain', '--', 'ios'], {
    cwd,
    encoding: 'utf8',
  }).trim();

  if (!status) {
    return;
  }

  const diff = execFileSyncImpl('git', ['--no-pager', 'diff', '--', 'ios'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  if (diff) {
    console.error(diff);
  }
  throw new Error(
    `iOS project files have uncommitted or out-of-sync changes:\n${status}\nRun \`npm run ios:sync\` and commit the updated files in ios/.`,
  );
}

export async function syncIosProject({
  check = false,
  manifestsOnly = false,
  env = process.env,
  rootDir = projectRoot,
} = {}) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  if (check) {
    const preSyncValidation = validateIosManifests(readIosManifestState(rootDir));
    if (!preSyncValidation.ok) {
      throw new Error(
        `${preSyncValidation.errors.join('\n')}\nRun \`npm run ios:sync\` and commit the updated files in ios/.`,
      );
    }
  }

  if (!manifestsOnly) {
    if (!canReuseWebBuild(env)) {
      await runCommand(npm, ['run', 'build'], { cwd: rootDir, env });
    }
    await runCommand(npm, ['exec', '--', 'cap', 'sync', 'ios'], { cwd: rootDir, env });
  }

  if (!check) {
    const state = readIosManifestState(rootDir);
    const synced = syncMarketingVersion(state.pbxprojContent, state.packageVersion);
    if (synced.updated) {
      writeFileSync(state.pbxprojPath, synced.content);
    }
  }

  const postSyncValidation = validateIosManifests(readIosManifestState(rootDir));
  if (!postSyncValidation.ok) {
    throw new Error(postSyncValidation.errors.join('\n'));
  }

  if (check) {
    verifyGitCleanIos({ cwd: rootDir });
  }
}

export async function main(args = process.argv.slice(2)) {
  const check = args.includes('--check');
  const manifestsOnly = args.includes('--manifests-only');

  try {
    await syncIosProject({ check, manifestsOnly });
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
