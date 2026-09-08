import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, fetchLatestGithubRelease } from './releases';

const trustedAsset = {
  name: 'app-release.apk',
  browser_download_url:
    'https://github.com/sgerner/turnleaf/releases/download/v0.3.3%2B4/app-release.apk',
};

const trustedRelease = {
  html_url: 'https://github.com/sgerner/turnleaf/releases/tag/v0.3.3%2B4',
  name: 'Turnleaf 0.3.3',
  tag_name: 'v0.3.3+4',
  published_at: '2026-09-08T00:00:00Z',
  draft: false,
  prerelease: false,
  assets: [trustedAsset],
};

function mockRelease(release: typeof trustedRelease) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => release,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('compareVersions', () => {
  it('orders patch and minor versions', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
  });

  it('treats stable releases as newer than prereleases', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
  });

  it('treats build metadata as increasing release builds for Turnleaf', () => {
    expect(compareVersions('0.1.3+124', '0.1.3+123')).toBeGreaterThan(0);
    expect(compareVersions('0.1.3+1', '0.1.3')).toBeGreaterThan(0);
  });

  it('treats equal versions as equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
});

describe('fetchLatestGithubRelease', () => {
  it('keeps links for the expected GitHub release and APK asset', async () => {
    mockRelease(trustedRelease);

    await expect(fetchLatestGithubRelease('0.3.2')).resolves.toEqual({
      version: '0.3.3+4',
      releaseUrl: trustedRelease.html_url,
      downloadUrl: trustedAsset.browser_download_url,
      publishedAt: trustedRelease.published_at,
      title: trustedRelease.name,
    });
  });

  it.each([
    'javascript:alert(1)',
    'http://github.com/sgerner/turnleaf/releases/tag/v0.3.3%2B4',
    'https://evil.example/releases/tag/v0.3.3%2B4',
    'https://github.com/another/repository/releases/tag/v0.3.3%2B4',
  ])('omits a banner when the release URL is unsafe or foreign: %s', async (htmlUrl) => {
    mockRelease({ ...trustedRelease, html_url: htmlUrl });

    await expect(fetchLatestGithubRelease('0.3.2')).resolves.toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'http://github.com/sgerner/turnleaf/releases/download/v0.3.3%2B4/app-release.apk',
    'https://evil.example/releases/download/v0.3.3%2B4/app-release.apk',
    'https://github.com/sgerner/other/releases/download/v0.3.3%2B4/app-release.apk',
  ])('omits an unsafe or foreign APK URL: %s', async (browserDownloadUrl) => {
    mockRelease({
      ...trustedRelease,
      assets: [{ ...trustedAsset, browser_download_url: browserDownloadUrl }],
    });

    await expect(fetchLatestGithubRelease('0.3.2')).resolves.toMatchObject({
      releaseUrl: trustedRelease.html_url,
      downloadUrl: null,
    });
  });

  it('omits APK assets with path traversal or a mismatched asset path', async () => {
    mockRelease({
      ...trustedRelease,
      assets: [
        {
          name: '../app-release.apk',
          browser_download_url:
            'https://github.com/sgerner/turnleaf/releases/download/v0.3.3%2B4/../app-release.apk',
        },
      ],
    });

    await expect(fetchLatestGithubRelease('0.3.2')).resolves.toMatchObject({
      releaseUrl: trustedRelease.html_url,
      downloadUrl: null,
    });
  });
});
