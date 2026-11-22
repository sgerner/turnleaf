import { describe, expect, it, vi } from 'vitest';
import {
  buildXcodeSimulatorArgs,
  defaultSpmCacheDir,
  shouldCleanXcodeBuild,
  verifyBuiltSimulatorApp,
} from './ios-simulator-build.mjs';
import {
  canReuseWebBuild,
  readIosManifestState,
  syncMarketingVersion,
  validateIosManifests,
} from './ios-sync.mjs';

const samplePrivacyManifest = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>NSPrivacyAccessedAPITypes</key>
  <array/>
  <key>NSPrivacyTracking</key>
  <false/>
</dict>
</plist>
`;

const sampleInfoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
</dict>
</plist>
`;

const samplePackageSwift = `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.0")
    ]
)
`;

const samplePbxproj = `// !$*UTF8*$!
{
/* Begin PBXBuildFile section */
\t\t9D8A0D4C2CEB8C6A00A1B001 /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = 9D8A0D4B2CEB8C6A00A1B001 /* PrivacyInfo.xcprivacy */; };
/* End PBXBuildFile section */
/* Begin PBXFileReference section */
\t\t9D8A0D4B2CEB8C6A00A1B001 /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };
/* End PBXFileReference section */
/* Begin PBXResourcesBuildPhase section */
\t\t504EC3021FED79650016851F /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tfiles = (
\t\t\t\t9D8A0D4C2CEB8C6A00A1B001 /* PrivacyInfo.xcprivacy in Resources */,
\t\t\t);
\t\t};
/* End PBXResourcesBuildPhase section */
/* Begin XCBuildConfiguration section */
\t\t504EC3171FED79650016851F /* Debug */ = {
\t\t\tbuildSettings = {
\t\t\tMARKETING_VERSION = 0.3.5;
\t\t\t};
\t\t};
\t\t504EC3181FED79650016851F /* Release */ = {
\t\t\tbuildSettings = {
\t\t\tMARKETING_VERSION = 0.3.5;
\t\t\t};
\t\t};
/* End XCBuildConfiguration section */
}
`;

describe('iOS sync and manifest validation', () => {
  it('reuses web builds only when TURNLEAF_REUSE_WEB_BUILD is true', () => {
    expect(canReuseWebBuild({ TURNLEAF_REUSE_WEB_BUILD: 'true' })).toBe(true);
    expect(canReuseWebBuild({ TURNLEAF_REUSE_WEB_BUILD: 'false' })).toBe(false);
    expect(canReuseWebBuild({})).toBe(false);
  });

  it('updates stale Debug and Release MARKETING_VERSION values cleanly', () => {
    const stale = samplePbxproj.replaceAll('0.3.5', '0.3.3');
    const synced = syncMarketingVersion(stale, '0.3.5');
    expect(synced.updated).toBe(true);
    expect(synced.content).toBe(samplePbxproj);
    expect(syncMarketingVersion(synced.content, '0.3.5').updated).toBe(false);
  });

  it('passes when Package.swift, MARKETING_VERSION, and PrivacyInfo.xcprivacy match', () => {
    const result = validateIosManifests({
      packageVersion: '0.3.5',
      capacitorIosVersion: '8.6.0',
      packageSwiftContent: samplePackageSwift,
      pbxprojContent: samplePbxproj,
      infoPlistContent: sampleInfoPlist,
      privacyManifestExists: true,
      privacyManifestContent: samplePrivacyManifest,
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('detects capacitor-swift-pm version drift, MARKETING_VERSION drift, and missing PrivacyInfo resource membership', () => {
    const withoutPrivacyInResources = samplePbxproj.replace(
      '\t\t\t\t9D8A0D4C2CEB8C6A00A1B001 /* PrivacyInfo.xcprivacy in Resources */,\n',
      '',
    );
    const result = validateIosManifests({
      packageVersion: '0.3.5',
      capacitorIosVersion: '8.6.0',
      packageSwiftContent: samplePackageSwift.replace('8.6.0', '8.4.1'),
      pbxprojContent: withoutPrivacyInResources.replaceAll('0.3.5', '0.3.3'),
      infoPlistContent: sampleInfoPlist,
      privacyManifestExists: true,
      privacyManifestContent: samplePrivacyManifest,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      'ios/App/CapApp-SPM/Package.swift pins capacitor-swift-pm to 8.4.1, expected 8.6.0 from @capacitor/ios.',
      'ios/App/App.xcodeproj/project.pbxproj MARKETING_VERSION (0.3.3, 0.3.3) does not match package.json version 0.3.5.',
      'ios/App/App.xcodeproj/project.pbxproj omits PrivacyInfo.xcprivacy from PBXResourcesBuildPhase target resources.',
    ]);
  });

  it('validates the checked-in repository iOS manifests', () => {
    const validation = validateIosManifests(readIosManifestState());
    expect(validation).toEqual({ ok: true, errors: [] });
  });
});

describe('iOS simulator build helpers', () => {
  it('constructs unsigned iPhone Simulator xcodebuild arguments with SPM cache', () => {
    expect(defaultSpmCacheDir({}, '/Users/runner')).toBe('/Users/runner/.cache/turnleaf-spm');
    expect(defaultSpmCacheDir({ TURNLEAF_SPM_CACHE_DIR: '/tmp/spm' }, '/Users/runner')).toBe(
      '/tmp/spm',
    );
    expect(shouldCleanXcodeBuild({ TURNLEAF_XCODE_CLEAN: 'true' })).toBe(true);
    expect(shouldCleanXcodeBuild({})).toBe(false);

    expect(
      buildXcodeSimulatorArgs({
        projectPath: '/repo/ios/App/App.xcodeproj',
        derivedDataPath: '/repo/ios/App/DerivedData',
        spmCachePath: '/Users/runner/.cache/turnleaf-spm',
        clean: true,
      }),
    ).toEqual([
      '-project',
      '/repo/ios/App/App.xcodeproj',
      '-scheme',
      'App',
      '-configuration',
      'Debug',
      '-destination',
      'generic/platform=iOS Simulator',
      '-derivedDataPath',
      '/repo/ios/App/DerivedData',
      '-clonedSourcePackagesDirPath',
      '/Users/runner/.cache/turnleaf-spm',
      'CODE_SIGNING_ALLOWED=NO',
      'clean',
      'build',
    ]);
  });

  it('verifies PrivacyInfo.xcprivacy and CFBundleShortVersionString in App.app', () => {
    const lintSpy = vi.fn();
    expect(() =>
      verifyBuiltSimulatorApp({
        appBundlePath: '/DerivedData/Build/Products/Debug-iphonesimulator/App.app',
        expectedVersion: '0.3.5',
        existsSyncImpl: () => true,
        statSyncImpl: () => ({ size: 642 }),
        readShortVersionImpl: () => '0.3.5',
        lintPlistImpl: lintSpy,
      }),
    ).not.toThrow();
    expect(lintSpy).toHaveBeenCalledWith(
      '/DerivedData/Build/Products/Debug-iphonesimulator/App.app/PrivacyInfo.xcprivacy',
    );

    expect(() =>
      verifyBuiltSimulatorApp({
        appBundlePath: '/DerivedData/Build/Products/Debug-iphonesimulator/App.app',
        expectedVersion: '0.3.5',
        existsSyncImpl: (path) => !path.endsWith('PrivacyInfo.xcprivacy'),
        statSyncImpl: () => ({ size: 642 }),
        readShortVersionImpl: () => '0.3.5',
        lintPlistImpl: lintSpy,
      }),
    ).toThrow('PrivacyInfo.xcprivacy');

    expect(() =>
      verifyBuiltSimulatorApp({
        appBundlePath: '/DerivedData/Build/Products/Debug-iphonesimulator/App.app',
        expectedVersion: '0.3.5',
        existsSyncImpl: () => true,
        statSyncImpl: () => ({ size: 642 }),
        readShortVersionImpl: () => '0.3.3',
        lintPlistImpl: lintSpy,
      }),
    ).toThrow('CFBundleShortVersionString (0.3.3)');
  });
});
