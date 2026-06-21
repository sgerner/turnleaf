type GithubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type GithubRelease = {
  html_url: string;
  name: string | null;
  tag_name: string;
  published_at: string | null;
  assets: GithubReleaseAsset[];
  draft: boolean;
  prerelease: boolean;
};

export type ReleaseBanner = {
  version: string;
  releaseUrl: string;
  downloadUrl: string | null;
  publishedAt: string | null;
  title: string | null;
};

const githubReleasesUrl = 'https://api.github.com/repos/sgerner/turnleaf/releases/latest';

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
};

function parseVersion(raw: string): ParsedVersion | null {
  const match = raw
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] ? match[5].split('.') : [],
  };
}

function compareSegments(left: string[], right: string[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    const leftIsNumber = Number.isInteger(leftNumber) && String(leftNumber) === leftPart;
    const rightIsNumber = Number.isInteger(rightNumber) && String(rightNumber) === rightPart;
    if (leftIsNumber && rightIsNumber) return leftNumber - rightNumber;
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;

  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (!aPre.length && !bPre.length) return compareSegments(a.build, b.build);
  if (!aPre.length) return 1;
  if (!bPre.length) return -1;

  const prerelease = compareSegments(aPre, bPre);
  if (prerelease !== 0) return prerelease;
  // Turnleaf APK releases use build metadata to distinguish successive GitHub builds.
  return compareSegments(a.build, b.build);
}

function pickDownloadUrl(release: GithubRelease): string | null {
  const apkAsset = release.assets.find((asset) => asset.name.toLowerCase().endsWith('.apk'));
  return apkAsset?.browser_download_url ?? null;
}

function buildBanner(release: GithubRelease, currentVersion: string): ReleaseBanner | null {
  const latestVersion = release.tag_name.trim().replace(/^v/i, '');
  if (!parseVersion(latestVersion)) return null;
  if (compareVersions(latestVersion, currentVersion) <= 0) return null;

  return {
    version: latestVersion,
    releaseUrl: release.html_url,
    downloadUrl: pickDownloadUrl(release),
    publishedAt: release.published_at,
    title: release.name,
  };
}

export async function fetchLatestGithubRelease(
  currentVersion: string,
  timeoutMs = 4500,
): Promise<ReleaseBanner | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(githubReleasesUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) return null;
    const release = (await response.json()) as GithubRelease;
    return buildBanner(release, currentVersion);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
