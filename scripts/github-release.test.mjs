import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findPublishedReleaseForRevision,
  hasCompleteReleaseAssets,
  matchesTestedRevision,
  parsePaginatedReleases,
  runPreflight,
  runPublish,
} from './github-release.mjs';

const TESTED_REVISION = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';

function makeRelease({
  tagName = 'v0.3.5+42',
  draft = false,
  prerelease = false,
  body = `## Changes\n\n- Improve release safety\n\nTested revision: \`${TESTED_REVISION}\`\n`,
  assets = [
    { name: 'app-release.apk', size: 4096, state: 'uploaded' },
    { name: 'app-release.apk.sha256', size: 85, state: 'uploaded' },
  ],
} = {}) {
  return {
    tag_name: tagName,
    draft,
    prerelease,
    body,
    assets,
  };
}

function createFakeSpawn(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    queueMicrotask(async () => {
      try {
        const result = (await handler(command, args, calls.length - 1)) ?? {};
        if (result.stdout) {
          child.stdout.emit('data', Buffer.from(result.stdout, 'utf8'));
        }
        if (result.stderr) {
          child.stderr.emit('data', Buffer.from(result.stderr, 'utf8'));
        }
        child.emit('close', result.exitCode ?? 0, result.signal ?? null);
      } catch (error) {
        child.emit('error', error);
      }
    });

    return child;
  };

  return { calls, spawnImpl };
}

describe('GitHub release deduplication and draft staging', () => {
  const tempDirs = [];

  function createTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'turnleaf-github-release-test-'));
    tempDirs.push(dir);
    return dir;
  }

  function createPayloadDir({
    apkContent = 'signed-apk-binary-payload',
    shaContent = '0123456789abcdef  app-release.apk\n',
    notesContent = `- Ship release improvements\n\nTested revision: \`${TESTED_REVISION}\`\n`,
  } = {}) {
    const payloadDir = createTempDir();
    writeFileSync(join(payloadDir, 'app-release.apk'), apkContent);
    writeFileSync(join(payloadDir, 'app-release.apk.sha256'), shaContent);
    writeFileSync(join(payloadDir, 'turnleaf-release-notes.md'), notesContent);
    return {
      payloadDir,
      apkSize: Buffer.byteLength(apkContent),
      shaSize: Buffer.byteLength(shaContent),
    };
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('parses multi-page concatenated JSON arrays from gh api --paginate', () => {
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      makeRelease({
        tagName: `v0.3.5+${index + 1}`,
        body: `See [guide][ref] for "details"\n\nTested revision: \`other-${index}\``,
      }),
    );
    const matchingRelease = makeRelease({ tagName: 'v0.3.4+9' });
    const rawPaginated = `${JSON.stringify(pageOne)}${JSON.stringify([matchingRelease])}`;

    const parsed = parsePaginatedReleases(rawPaginated);
    expect(parsed).toHaveLength(101);
    expect(findPublishedReleaseForRevision(parsed, TESTED_REVISION)?.tag_name).toBe('v0.3.4+9');
  });

  it('normalizes CRLF release notes before matching the tested revision', () => {
    const crlfBody = `## Changes\r\n\r\n- Fix reader sync\r\n\r\nTested revision: \`${TESTED_REVISION}\`\r\n`;
    expect(matchesTestedRevision(crlfBody, TESTED_REVISION)).toBe(true);

    const release = makeRelease({ body: crlfBody });
    expect(findPublishedReleaseForRevision([release], TESTED_REVISION)).toEqual(release);
  });

  it('skips 30+ draft releases while finding a complete published release or rejecting drafts-only', async () => {
    const outputDir = createTempDir();
    const githubOutput = join(outputDir, 'github-output.txt');

    const thirtyFiveDrafts = Array.from({ length: 35 }, (_, index) =>
      makeRelease({
        tagName: `v0.3.5+${200 - index}`,
        draft: true,
        body:
          index === 0
            ? `Draft for same revision\r\n\r\nTested revision: \`${TESTED_REVISION}\`\r\n`
            : `Draft ${index}`,
      }),
    );

    const draftsOnlyRun = createFakeSpawn(() => ({
      stdout: JSON.stringify(thirtyFiveDrafts),
    }));
    const draftsOnlyResult = await runPreflight({
      env: {
        GITHUB_REPOSITORY: 'sgerner/turnleaf',
        TESTED_REVISION,
        GITHUB_OUTPUT: githubOutput,
      },
      spawnImpl: draftsOnlyRun.spawnImpl,
      log: () => {},
    });

    expect(draftsOnlyResult.alreadyReleased).toBe(false);
    expect(readFileSync(githubOutput, 'utf8')).toBe('already_released=false\n');
    expect(draftsOnlyRun.calls[0].args).toEqual([
      'api',
      '--paginate',
      'repos/sgerner/turnleaf/releases?per_page=100',
    ]);

    const publishedAfterDrafts = [
      ...thirtyFiveDrafts,
      makeRelease({ tagName: 'v0.3.5+150', draft: false }),
    ];
    const secondOutput = join(outputDir, 'github-output-2.txt');
    const foundRun = createFakeSpawn(() => ({
      stdout: `${JSON.stringify(publishedAfterDrafts.slice(0, 30))}\n${JSON.stringify(publishedAfterDrafts.slice(30))}`,
    }));
    const foundResult = await runPreflight({
      env: {
        GITHUB_REPOSITORY: 'sgerner/turnleaf',
        TESTED_REVISION,
        GITHUB_OUTPUT: secondOutput,
      },
      spawnImpl: foundRun.spawnImpl,
      log: () => {},
    });

    expect(foundResult.alreadyReleased).toBe(true);
    expect(foundResult.release?.tag_name).toBe('v0.3.5+150');
    expect(readFileSync(secondOutput, 'utf8')).toBe('already_released=true\n');
  });

  it('treats published releases missing either required asset or with zero-byte sizes as incomplete', async () => {
    const incompleteCases = [
      makeRelease({ tagName: 'v0.3.5+1', assets: [] }),
      makeRelease({
        tagName: 'v0.3.5+2',
        assets: [{ name: 'app-release.apk', size: 4096, state: 'uploaded' }],
      }),
      makeRelease({
        tagName: 'v0.3.5+3',
        assets: [{ name: 'app-release.apk.sha256', size: 85, state: 'uploaded' }],
      }),
      makeRelease({
        tagName: 'v0.3.5+4',
        assets: [
          { name: 'app-release.apk', size: 0, state: 'uploaded' },
          { name: 'app-release.apk.sha256', size: 85, state: 'uploaded' },
        ],
      }),
      makeRelease({
        tagName: 'v0.3.5+5',
        assets: [
          { name: 'app-release.apk', size: 4096, state: 'starter' },
          { name: 'app-release.apk.sha256', size: 85, state: 'uploaded' },
        ],
      }),
      makeRelease({ tagName: 'v0.3.5+6', prerelease: true }),
    ];

    for (const candidate of incompleteCases.slice(0, 5)) {
      expect(hasCompleteReleaseAssets(candidate)).toBe(false);
    }

    const outputDir = createTempDir();
    const githubOutput = join(outputDir, 'output.txt');
    const { spawnImpl } = createFakeSpawn(() => ({
      stdout: JSON.stringify(incompleteCases),
    }));

    const preflight = await runPreflight({
      env: {
        GITHUB_REPOSITORY: 'sgerner/turnleaf',
        TESTED_REVISION,
        GITHUB_OUTPUT: githubOutput,
      },
      spawnImpl,
      log: () => {},
    });

    expect(preflight.alreadyReleased).toBe(false);
    expect(readFileSync(githubOutput, 'utf8')).toBe('already_released=false\n');
  });

  it('stages a new draft, uploads with --clobber, verifies byte sizes, and promotes to latest', async () => {
    const { payloadDir, apkSize, shaSize } = createPayloadDir();
    let releaseListCalls = 0;

    const { calls, spawnImpl } = createFakeSpawn((_command, args) => {
      if (args[0] === 'api' && args[1] === '--paginate') {
        releaseListCalls += 1;
        if (releaseListCalls === 1) {
          return { stdout: '[]' };
        }
        return {
          stdout: JSON.stringify([
            makeRelease({
              tagName: 'v0.3.5+77',
              draft: true,
              assets: [
                { name: 'app-release.apk', size: apkSize, state: 'uploaded' },
                { name: 'app-release.apk.sha256', size: shaSize, state: 'uploaded' },
              ],
            }),
          ]),
        };
      }
      if (args[0] === 'api' && args[1] === 'repos/sgerner/turnleaf/git/ref/heads/master') {
        return { stdout: JSON.stringify({ object: { sha: TESTED_REVISION } }) };
      }
      return { stdout: '' };
    });

    const result = await runPublish({
      env: {
        GITHUB_REPOSITORY: 'sgerner/turnleaf',
        RELEASE_TAG: 'v0.3.5+77',
        VERSION_BASE: '0.3.5',
        TESTED_REVISION,
      },
      payloadDir,
      spawnImpl,
      log: () => {},
    });

    expect(result).toEqual({ skipped: false, releaseTag: 'v0.3.5+77' });
    expect(calls.map((call) => call.args)).toEqual([
      ['api', '--paginate', 'repos/sgerner/turnleaf/releases?per_page=100'],
      [
        'release',
        'create',
        'v0.3.5+77',
        '--draft',
        '--title',
        'Turnleaf 0.3.5',
        '--notes-file',
        join(payloadDir, 'turnleaf-release-notes.md'),
        '--repo',
        'sgerner/turnleaf',
        '--target',
        TESTED_REVISION,
      ],
      [
        'release',
        'upload',
        'v0.3.5+77',
        join(payloadDir, 'app-release.apk'),
        join(payloadDir, 'app-release.apk.sha256'),
        '--clobber',
        '--repo',
        'sgerner/turnleaf',
      ],
      ['api', '--paginate', 'repos/sgerner/turnleaf/releases?per_page=100'],
      ['api', 'repos/sgerner/turnleaf/git/ref/heads/master'],
      ['release', 'edit', 'v0.3.5+77', '--draft=false', '--latest', '--repo', 'sgerner/turnleaf'],
    ]);
  });

  it('reuses an existing draft for the same tag and overwrites partial assets via --clobber', async () => {
    const { payloadDir, apkSize, shaSize } = createPayloadDir();
    let releaseListCalls = 0;

    const { calls, spawnImpl } = createFakeSpawn((_command, args) => {
      if (args[0] === 'api' && args[1] === '--paginate') {
        releaseListCalls += 1;
        if (releaseListCalls === 1) {
          return {
            stdout: JSON.stringify([
              makeRelease({
                tagName: 'v0.3.5+78',
                draft: true,
                assets: [{ name: 'app-release.apk', size: 12, state: 'uploaded' }],
              }),
            ]),
          };
        }
        return {
          stdout: JSON.stringify([
            makeRelease({
              tagName: 'v0.3.5+78',
              draft: true,
              assets: [
                { name: 'app-release.apk', size: apkSize, state: 'uploaded' },
                { name: 'app-release.apk.sha256', size: shaSize, state: 'uploaded' },
              ],
            }),
          ]),
        };
      }
      if (args[0] === 'api' && args[1] === 'repos/sgerner/turnleaf/git/ref/heads/master') {
        return { stdout: JSON.stringify({ object: { sha: TESTED_REVISION } }) };
      }
      return { stdout: '' };
    });

    await runPublish({
      env: {
        GITHUB_REPOSITORY: 'sgerner/turnleaf',
        RELEASE_TAG: 'v0.3.5+78',
        VERSION_BASE: '0.3.5',
        TESTED_REVISION,
      },
      payloadDir,
      spawnImpl,
      log: () => {},
    });

    expect(calls[1].args).toEqual([
      'release',
      'edit',
      'v0.3.5+78',
      '--draft',
      '--title',
      'Turnleaf 0.3.5',
      '--notes-file',
      join(payloadDir, 'turnleaf-release-notes.md'),
      '--target',
      TESTED_REVISION,
      '--repo',
      'sgerner/turnleaf',
    ]);
    expect(calls[2].args).toContain('--clobber');
    expect(calls.at(-1)?.args).toEqual([
      'release',
      'edit',
      'v0.3.5+78',
      '--draft=false',
      '--latest',
      '--repo',
      'sgerner/turnleaf',
    ]);
  });

  it('repairs an incomplete release matching the tested revision and rejects mismatched published tags', async () => {
    const { payloadDir, apkSize, shaSize } = createPayloadDir();
    let repairListCalls = 0;

    const repairRun = createFakeSpawn((_command, args) => {
      if (args[0] === 'api' && args[1] === '--paginate') {
        repairListCalls += 1;
        if (repairListCalls === 1) {
          return {
            stdout: JSON.stringify([
              makeRelease({
                tagName: 'v0.3.5+79',
                draft: false,
                assets: [],
              }),
            ]),
          };
        }
        return {
          stdout: JSON.stringify([
            makeRelease({
              tagName: 'v0.3.5+79',
              draft: false,
              assets: [
                { name: 'app-release.apk', size: apkSize, state: 'uploaded' },
                { name: 'app-release.apk.sha256', size: shaSize, state: 'uploaded' },
              ],
            }),
          ]),
        };
      }
      if (args[0] === 'api' && args[1] === 'repos/sgerner/turnleaf/git/ref/heads/master') {
        return { stdout: JSON.stringify({ object: { sha: TESTED_REVISION } }) };
      }
      return { stdout: '' };
    });

    await runPublish({
      env: {
        GITHUB_REPOSITORY: 'sgerner/turnleaf',
        RELEASE_TAG: 'v0.3.5+79',
        VERSION_BASE: '0.3.5',
        TESTED_REVISION,
      },
      payloadDir,
      spawnImpl: repairRun.spawnImpl,
      log: () => {},
    });

    expect(repairRun.calls.map((call) => call.args[1])).toEqual([
      '--paginate',
      'upload',
      '--paginate',
      'repos/sgerner/turnleaf/git/ref/heads/master',
      'edit',
    ]);

    const mismatchedTagRun = createFakeSpawn(() => ({
      stdout: JSON.stringify([
        makeRelease({
          tagName: 'v0.3.5+79',
          draft: false,
          body: 'Tested revision: `deadbeef`',
          assets: [],
        }),
      ]),
    }));

    await expect(
      runPublish({
        env: {
          GITHUB_REPOSITORY: 'sgerner/turnleaf',
          RELEASE_TAG: 'v0.3.5+79',
          VERSION_BASE: '0.3.5',
          TESTED_REVISION,
        },
        payloadDir,
        spawnImpl: mismatchedTagRun.spawnImpl,
        log: () => {},
      }),
    ).rejects.toThrow('does not match tested revision');
  });

  it('keeps the release in draft when asset upload fails, remote sizes mismatch, or master advances', async () => {
    const { payloadDir, apkSize, shaSize } = createPayloadDir();

    // 1. Asset upload failure
    const uploadFailure = createFakeSpawn((_command, args) => {
      if (args[0] === 'api' && args[1] === '--paginate') {
        return { stdout: '[]' };
      }
      if (args[0] === 'release' && args[1] === 'upload') {
        return { exitCode: 1, stderr: 'HTTP 502 Bad Gateway' };
      }
      return { stdout: '' };
    });

    await expect(
      runPublish({
        env: {
          GITHUB_REPOSITORY: 'sgerner/turnleaf',
          RELEASE_TAG: 'v0.3.5+80',
          VERSION_BASE: '0.3.5',
          TESTED_REVISION,
        },
        payloadDir,
        spawnImpl: uploadFailure.spawnImpl,
        log: () => {},
      }),
    ).rejects.toThrow('HTTP 502 Bad Gateway');
    expect(uploadFailure.calls.some((call) => call.args.includes('--draft=false'))).toBe(false);

    // 2. Remote byte size mismatch
    let mismatchListCalls = 0;
    const sizeMismatch = createFakeSpawn((_command, args) => {
      if (args[0] === 'api' && args[1] === '--paginate') {
        mismatchListCalls += 1;
        if (mismatchListCalls === 1) return { stdout: '[]' };
        return {
          stdout: JSON.stringify([
            makeRelease({
              tagName: 'v0.3.5+81',
              draft: true,
              assets: [
                { name: 'app-release.apk', size: apkSize - 1, state: 'uploaded' },
                { name: 'app-release.apk.sha256', size: shaSize, state: 'uploaded' },
              ],
            }),
          ]),
        };
      }
      return { stdout: '' };
    });

    await expect(
      runPublish({
        env: {
          GITHUB_REPOSITORY: 'sgerner/turnleaf',
          RELEASE_TAG: 'v0.3.5+81',
          VERSION_BASE: '0.3.5',
          TESTED_REVISION,
        },
        payloadDir,
        spawnImpl: sizeMismatch.spawnImpl,
        log: () => {},
      }),
    ).rejects.toThrow('failed verification');
    expect(sizeMismatch.calls.some((call) => call.args.includes('--draft=false'))).toBe(false);

    // 3. Master advances before promotion
    let movedMasterListCalls = 0;
    const movedMaster = createFakeSpawn((_command, args) => {
      if (args[0] === 'api' && args[1] === '--paginate') {
        movedMasterListCalls += 1;
        if (movedMasterListCalls === 1) return { stdout: '[]' };
        return {
          stdout: JSON.stringify([
            makeRelease({
              tagName: 'v0.3.5+82',
              draft: true,
              assets: [
                { name: 'app-release.apk', size: apkSize, state: 'uploaded' },
                { name: 'app-release.apk.sha256', size: shaSize, state: 'uploaded' },
              ],
            }),
          ]),
        };
      }
      if (args[0] === 'api' && args[1] === 'repos/sgerner/turnleaf/git/ref/heads/master') {
        return {
          stdout: JSON.stringify({
            object: { sha: 'ffffffffffffffffffffffffffffffffffffffff' },
          }),
        };
      }
      return { stdout: '' };
    });

    await expect(
      runPublish({
        env: {
          GITHUB_REPOSITORY: 'sgerner/turnleaf',
          RELEASE_TAG: 'v0.3.5+82',
          VERSION_BASE: '0.3.5',
          TESTED_REVISION,
        },
        payloadDir,
        spawnImpl: movedMaster.spawnImpl,
        log: () => {},
      }),
    ).rejects.toThrow('Master moved before release promotion');
    expect(movedMaster.calls.some((call) => call.args.includes('--draft=false'))).toBe(false);
  });
});
