import { afterEach, describe, expect, it, vi } from 'vitest';
import { enterOfflineMode, startFixture } from './android-reading-journey.mjs';

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

  it('disables mobile data before wifi and waits for in-flight loopback requests to settle before offline mode', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);

    const adbCalls = [];
    const adbCommand = vi.fn(async (...args) => {
      adbCalls.push(args.join(' '));
      return '';
    });

    let connected = true;
    const webClient = {
      evaluate: vi.fn(async () => connected),
    };

    let pollCount = 0;
    let simulatedLateRequest;
    const wait = async (_label, check) => {
      while (!(await check())) {
        pollCount += 1;
        if (pollCount === 1) {
          connected = false;
          // Simulate a pre-disconnect request arriving over adb reverse right as status flips offline
          simulatedLateRequest = fetch(
            `http://127.0.0.1:${fixture.port}/api/Series/series-detail`,
            {
              headers: { 'x-api-key': 'turnleaf-ci-only' },
            },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    await enterOfflineMode({
      adbCommand,
      webClient,
      fixture,
      settleMs: 30,
      wait,
    });
    await simulatedLateRequest;

    expect(adbCalls).toEqual(['shell svc data disable', 'shell svc wifi disable']);
    expect(fixture.inFlightRequests).toBe(0);
    expect(fixture.requestCount).toBe(1);
    expect(fixture.offlineRequests).toEqual([]);

    // Any request arriving after enterOfflineMode completes is recorded as an offline leak.
    await fetch(`http://127.0.0.1:${fixture.port}/api/Series/series-detail`, {
      headers: { 'x-api-key': 'turnleaf-ci-only' },
    });
    expect(fixture.offlineRequests).toEqual(['/api/Series/series-detail']);
  });
});
