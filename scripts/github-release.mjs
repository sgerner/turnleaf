import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_RELEASE_ASSETS = ['app-release.apk', 'app-release.apk.sha256'];

export function normalizeReleaseNotes(body) {
  return String(body ?? '').replace(/\r\n?/g, '\n');
}

export function testedRevisionMarker(testedRevision) {
  return `Tested revision: \`${testedRevision}\``;
}

export function matchesTestedRevision(body, testedRevision) {
  const revision = String(testedRevision ?? '').trim();
  if (!revision) return false;
  const marker = testedRevisionMarker(revision);
  return normalizeReleaseNotes(body)
    .split('\n')
    .some((line) => line === marker);
}

export function parsePaginatedReleases(rawOutput) {
  const source = String(rawOutput ?? '').trim();
  if (!source) {
    throw new Error('GitHub releases API returned an empty response.');
  }

  const releases = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      if (depth === 0) {
        throw new Error('Unexpected JSON string at top level of GitHub releases response.');
      }
      inString = true;
      continue;
    }

    if (char === '[' || char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === ']' || char === '}') {
      depth -= 1;
      if (depth < 0) {
        throw new Error('Malformed JSON in GitHub releases response.');
      }
      if (depth === 0) {
        const chunk = JSON.parse(source.slice(start, index + 1));
        if (!Array.isArray(chunk)) {
          throw new Error('Expected GitHub releases API page to be a JSON array.');
        }
        for (const entry of chunk) {
          if (Array.isArray(entry)) {
            releases.push(...entry);
          } else {
            releases.push(entry);
          }
        }
        start = -1;
      }
      continue;
    }

    if (depth === 0 && !/\s/.test(char)) {
      throw new Error('Unexpected token in GitHub releases response.');
    }
  }

  if (depth !== 0 || inString) {
    throw new Error('Unterminated JSON in GitHub releases response.');
  }

  return releases;
}

export function hasCompleteReleaseAssets(release, expectedSizes = null) {
  if (!release || typeof release !== 'object' || !Array.isArray(release.assets)) {
    return false;
  }

  return REQUIRED_RELEASE_ASSETS.every((requiredName) => {
    const matchingAssets = release.assets.filter(
      (asset) => asset && typeof asset === 'object' && asset.name === requiredName,
    );
    if (matchingAssets.length !== 1) return false;

    const [asset] = matchingAssets;
    if (typeof asset.size !== 'number' || !Number.isInteger(asset.size) || asset.size <= 0) {
      return false;
    }
    if (asset.state !== undefined && asset.state !== 'uploaded') {
      return false;
    }
    if (expectedSizes && expectedSizes[requiredName] !== undefined) {
      return asset.size === expectedSizes[requiredName];
    }
    return true;
  });
}

export function findPublishedReleaseForRevision(releases, testedRevision) {
  if (!Array.isArray(releases)) return null;

  return (
    releases.find(
      (release) =>
        release &&
        typeof release === 'object' &&
        release.draft === false &&
        release.prerelease === false &&
        matchesTestedRevision(release.body, testedRevision) &&
        hasCompleteReleaseAssets(release),
    ) ?? null
  );
}

export function runGh(
  args,
  { label = `gh ${args[0] ?? ''}`.trim(), env = process.env, spawnImpl = spawn } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl('gh', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout?.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });

    child.once('error', rejectPromise);
    child.once('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }

      const detail = stderr.trim();
      const baseMessage = signal
        ? `${label} terminated by ${signal}`
        : `${label} exited with code ${code}`;
      const error = new Error(detail ? `${baseMessage}: ${detail}` : baseMessage);
      error.exitCode = code ?? 1;
      error.stderr = stderr;
      rejectPromise(error);
    });
  });
}

function requireEnvValue(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

export async function fetchAllReleases({ repository, env = process.env, spawnImpl = spawn }) {
  const { stdout } = await runGh(
    ['api', '--paginate', `repos/${repository}/releases?per_page=100`],
    {
      label: 'gh api releases',
      env,
      spawnImpl,
    },
  );
  return parsePaginatedReleases(stdout);
}

export async function fetchMasterRevision({ repository, env = process.env, spawnImpl = spawn }) {
  const { stdout } = await runGh(['api', `repos/${repository}/git/ref/heads/master`], {
    label: 'gh api master ref',
    env,
    spawnImpl,
  });
  const payload = JSON.parse(stdout);
  const sha = payload?.object?.sha;
  if (typeof sha !== 'string' || !sha.trim()) {
    throw new Error('Unable to read current master SHA from GitHub API.');
  }
  return sha.trim();
}

export async function runPreflight({
  env = process.env,
  spawnImpl = spawn,
  log = console.log,
} = {}) {
  const repository = requireEnvValue(env, 'GITHUB_REPOSITORY');
  const testedRevision = requireEnvValue(env, 'TESTED_REVISION');
  const releases = await fetchAllReleases({ repository, env, spawnImpl });
  const existingRelease = findPublishedReleaseForRevision(releases, testedRevision);
  const alreadyReleased = existingRelease !== null;

  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `already_released=${alreadyReleased}\n`, 'utf8');
  }

  if (alreadyReleased) {
    log(
      `Complete release ${existingRelease.tag_name} already exists for tested revision ${testedRevision}.`,
    );
  } else {
    log(`No complete published release found for tested revision ${testedRevision}.`);
  }

  return {
    alreadyReleased,
    release: existingRelease,
  };
}

function validateLocalPayload(payloadDir, testedRevision) {
  const notesPath = join(payloadDir, 'turnleaf-release-notes.md');
  const notesContent = readFileSync(notesPath, 'utf8');
  if (!notesContent.trim()) {
    throw new Error(`Release notes file ${notesPath} is empty.`);
  }
  if (!matchesTestedRevision(notesContent, testedRevision)) {
    throw new Error(
      `Release notes file ${notesPath} does not contain ${testedRevisionMarker(testedRevision)}.`,
    );
  }

  const expectedSizes = {};
  const assetPaths = [];

  for (const assetName of REQUIRED_RELEASE_ASSETS) {
    const assetPath = join(payloadDir, assetName);
    const stat = statSync(assetPath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`Release asset ${assetPath} is missing or empty.`);
    }
    expectedSizes[assetName] = stat.size;
    assetPaths.push(assetPath);
  }

  return {
    notesPath,
    assetPaths,
    expectedSizes,
  };
}

export async function runPublish({
  env = process.env,
  payloadDir = 'release-payload',
  spawnImpl = spawn,
  log = console.log,
} = {}) {
  const repository = requireEnvValue(env, 'GITHUB_REPOSITORY');
  const releaseTag = requireEnvValue(env, 'RELEASE_TAG');
  const versionBase = requireEnvValue(env, 'VERSION_BASE');
  const testedRevision = requireEnvValue(env, 'TESTED_REVISION');
  const releaseTitle = `Turnleaf ${versionBase}`;

  const { notesPath, assetPaths, expectedSizes } = validateLocalPayload(payloadDir, testedRevision);

  const releases = await fetchAllReleases({ repository, env, spawnImpl });
  const existingComplete = findPublishedReleaseForRevision(releases, testedRevision);
  if (existingComplete) {
    log(
      `Complete release ${existingComplete.tag_name} already exists for tested revision ${testedRevision}.`,
    );
    return { skipped: true, releaseTag: existingComplete.tag_name };
  }

  const existingTagRelease = releases.find(
    (release) => release && typeof release === 'object' && release.tag_name === releaseTag,
  );

  if (!existingTagRelease) {
    await runGh(
      [
        'release',
        'create',
        releaseTag,
        '--draft',
        '--title',
        releaseTitle,
        '--notes-file',
        notesPath,
        '--repo',
        repository,
        '--target',
        testedRevision,
      ],
      { label: 'gh release create', env, spawnImpl },
    );
  } else if (existingTagRelease.draft === true) {
    await runGh(
      [
        'release',
        'edit',
        releaseTag,
        '--draft',
        '--title',
        releaseTitle,
        '--notes-file',
        notesPath,
        '--target',
        testedRevision,
        '--repo',
        repository,
      ],
      { label: 'gh release edit draft', env, spawnImpl },
    );
  } else if (
    existingTagRelease.prerelease !== false ||
    !matchesTestedRevision(existingTagRelease.body, testedRevision)
  ) {
    throw new Error(
      `Release ${releaseTag} already exists and does not match tested revision ${testedRevision}.`,
    );
  }

  await runGh(['release', 'upload', releaseTag, ...assetPaths, '--clobber', '--repo', repository], {
    label: 'gh release upload',
    env,
    spawnImpl,
  });

  const updatedReleases = await fetchAllReleases({ repository, env, spawnImpl });
  const stagedRelease = updatedReleases.find(
    (release) => release && typeof release === 'object' && release.tag_name === releaseTag,
  );

  if (!stagedRelease) {
    throw new Error(`Staged release ${releaseTag} could not be found via GitHub API.`);
  }

  if (!hasCompleteReleaseAssets(stagedRelease, expectedSizes)) {
    const actualSummary = REQUIRED_RELEASE_ASSETS.map((name) => {
      const asset = Array.isArray(stagedRelease.assets)
        ? stagedRelease.assets.find((item) => item?.name === name)
        : null;
      return `${name}: expected ${expectedSizes[name]} bytes, got ${asset ? `${asset.size} bytes` : 'missing'}`;
    }).join('; ');
    throw new Error(
      `Uploaded release assets for ${releaseTag} failed verification (${actualSummary}).`,
    );
  }

  const currentMaster = await fetchMasterRevision({ repository, env, spawnImpl });
  if (currentMaster !== testedRevision) {
    throw new Error(
      'Master moved before release promotion; keeping staged draft release unpublished.',
    );
  }

  await runGh(['release', 'edit', releaseTag, '--draft=false', '--latest', '--repo', repository], {
    label: 'gh release edit promote',
    env,
    spawnImpl,
  });

  log(`Published verified GitHub release ${releaseTag} for tested revision ${testedRevision}.`);
  return { skipped: false, releaseTag };
}

export async function main(
  argv = process.argv.slice(2),
  { env = process.env, spawnImpl = spawn, payloadDir = 'release-payload', log = console.log } = {},
) {
  const [subcommand] = argv;
  if (subcommand === 'preflight') {
    await runPreflight({ env, spawnImpl, log });
    return;
  }
  if (subcommand === 'publish') {
    await runPublish({ env, payloadDir, spawnImpl, log });
    return;
  }
  throw new Error('Usage: node scripts/github-release.mjs <preflight|publish>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
