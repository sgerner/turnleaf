import { afterEach, describe, expect, it } from 'vitest';
import { startFixture } from './android-reading-journey.mjs';

describe('android reading journey fixture', () => {
  let fixture;

  afterEach(() => {
    fixture?.close();
    fixture = undefined;
  });

  it('tracks offline requests even when no API key header is sent', async () => {
    fixture = await startFixture();
    fixture.setOffline(true);

    const response = await fetch(`http://127.0.0.1:${fixture.port}/api/Series/v2`, {
      method: 'POST',
    });

    expect(response.status).toBe(503);
    expect(fixture.offlineRequests).toEqual(['/api/Series/v2']);
    expect(fixture.unauthorizedRequests).toEqual([]);
  });

  it('tracks 401 requests across key rotation and accepts uploads with the rotated key', async () => {
    fixture = await startFixture();

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
});
