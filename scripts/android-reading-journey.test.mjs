import { afterEach, describe, expect, it } from 'vitest';
import { startFixture } from './android-reading-journey.mjs';

const fixtures = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.close();
  }
});

describe('Android reading journey fixture', () => {
  it('tracks offline requests even when no API key header is sent', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    fixture.setOffline(true);

    const response = await fetch(`http://127.0.0.1:${fixture.port}/api/Series/v2`, {
      method: 'POST',
    });

    expect(response.status).toBe(503);
    expect(fixture.offlineRequests).toEqual(['/api/Series/v2']);
    expect(fixture.unauthorizedRequests).toEqual([]);
  });

  it('tracks 401 requests across key rotation and accepts uploads with the rotated key', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);

    const initialHealth = await fetch(`http://127.0.0.1:${fixture.port}/api/Health`, {
      headers: { 'x-api-key': 'turnleaf-ci-only' },
    });
    expect(initialHealth.status).toBe(200);
    await expect(initialHealth.json()).resolves.toEqual({ version: '0.0.0-ci' });

    fixture.setApiKey('turnleaf-ci-rotated', '0.0.1-rotated');

    const staleSeries = await fetch(`http://127.0.0.1:${fixture.port}/api/Series/v2`, {
      method: 'POST',
      headers: { 'x-api-key': 'turnleaf-ci-only' },
    });
    expect(staleSeries.status).toBe(401);
    expect(fixture.unauthorizedRequests).toEqual(['/api/Series/v2']);

    const rotatedHealth = await fetch(`http://127.0.0.1:${fixture.port}/api/Health`, {
      headers: { 'x-api-key': 'turnleaf-ci-rotated' },
    });
    expect(rotatedHealth.status).toBe(200);
    await expect(rotatedHealth.json()).resolves.toEqual({ version: '0.0.1-rotated' });

    const upload = await fetch(`http://127.0.0.1:${fixture.port}/api/Reader/progress`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'turnleaf-ci-rotated',
      },
      body: JSON.stringify({
        libraryId: 1,
        seriesId: 1,
        volumeId: 1,
        chapterId: 1,
        pageNum: 1,
        bookScrollId: '//body/DocFragment[2]/body/h1[1]',
      }),
    });
    expect(upload.status).toBe(200);
    expect(fixture.uploads).toHaveLength(1);
    expect(fixture.uploads[0]).toMatchObject({
      chapterId: 1,
      pageNum: 1,
      bookScrollId: '//body/DocFragment[2]/body/h1[1]',
    });
  });

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
});
