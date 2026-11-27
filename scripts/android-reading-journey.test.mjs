import { afterEach, describe, expect, it } from 'vitest';
import { validateEpubArchive } from '../src/lib/downloads/epub-validation';
import { createJourneyEpub, startFixture } from './android-reading-journey.mjs';

const fixtures = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.close();
  }
});

describe('Android reading journey fixture', () => {
  it('serves series covers as PNG with zero 404 responses and enforces the API key', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);

    const unauthorized = await fetch(
      `http://127.0.0.1:${fixture.port}/api/Image/series-cover?seriesId=1`,
    );
    expect(unauthorized.status).toBe(401);

    const response = await fetch(
      `http://127.0.0.1:${fixture.port}/api/Image/series-cover?seriesId=1`,
      {
        headers: { 'x-api-key': 'turnleaf-ci-only' },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(fixture.covers).toBe(1);
    expect(fixture.notFoundPaths).toEqual([]);
  });

  it('tracks cross-origin redirect isolation for cover and EPUB endpoints', async () => {
    const fixture = await startFixture({ crossOriginRedirects: true });
    fixtures.push(fixture);

    const coverRedirect = await fetch(
      `http://127.0.0.1:${fixture.port}/api/Image/series-cover?seriesId=1`,
      {
        headers: { 'x-api-key': 'turnleaf-ci-only' },
        redirect: 'manual',
      },
    );
    expect(coverRedirect.status).toBe(302);
    expect(coverRedirect.headers.get('location')).toBe(
      `http://127.0.0.1:${fixture.foreignPort}/api/Image/series-cover?seriesId=1`,
    );

    const downloadRedirect = await fetch(
      `http://127.0.0.1:${fixture.port}/api/Download/chapter?chapterId=1`,
      {
        headers: { 'x-api-key': 'turnleaf-ci-only' },
        redirect: 'manual',
      },
    );
    expect(downloadRedirect.status).toBe(302);
    expect(downloadRedirect.headers.get('location')).toBe(
      `http://127.0.0.1:${fixture.foreignPort}/api/Download/chapter?chapterId=1`,
    );
    expect(fixture.coverRedirects).toBe(1);
    expect(fixture.downloadRedirects).toBe(1);
    expect(fixture.foreignRequests).toEqual([]);
    expect(fixture.foreignAuthHeaders).toBe(0);

    await fetch(`http://127.0.0.1:${fixture.foreignPort}/probe`);
    expect(fixture.foreignRequests).toEqual(['/probe']);
    expect(fixture.foreignAuthHeaders).toBe(0);

    await fetch(`http://127.0.0.1:${fixture.foreignPort}/probe-auth`, {
      headers: { 'x-api-key': 'turnleaf-ci-only' },
    });
    expect(fixture.foreignRequests).toEqual(['/probe', '/probe-auth']);
    expect(fixture.foreignAuthHeaders).toBe(1);
  });

  it('builds a valid EPUB containing all 5 hostile subresource vectors and records unauthenticated leaks', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);

    const epub = createJourneyEpub(`http://127.0.0.1:${fixture.port}/hostile`);
    await expect(
      validateEpubArchive(epub.length, async (offset, length) =>
        epub.subarray(offset, offset + length),
      ),
    ).resolves.toBeUndefined();

    const archiveText = epub.toString('utf8');
    expect(archiveText).toContain('/hostile/img-src.png');
    expect(archiveText).toContain('/hostile/img-srcset.png');
    expect(archiveText).toContain('/hostile/svg-image.png');
    expect(archiveText).toContain('/hostile/video-poster.png');
    expect(archiveText).toContain('/hostile/inline-bg.png');
    expect(archiveText).toContain('/hostile/packaged-bg.png');
    expect(archiveText).toContain('/hostile/packaged-import.css');
    expect(fixture.hostileRequests).toEqual([]);

    const simulatedLeak = await fetch(`http://127.0.0.1:${fixture.port}/hostile/img-src.png`);
    expect(simulatedLeak.status).toBe(204);
    expect(fixture.hostileRequests).toEqual(['/hostile/img-src.png']);
  });
});
