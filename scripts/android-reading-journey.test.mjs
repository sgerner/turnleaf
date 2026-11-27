import { afterEach, describe, expect, it } from 'vitest';
import {
  expectedBookCardPercent,
  hasQueuedSyncBanner,
  inspectLibraryBookCard,
  startFixture,
} from './android-reading-journey.mjs';

const fixtures = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.close();
  }
});

describe('Android reading journey helpers', () => {
  it('derives expected card percentage from persisted SQLite book progress without hard-coding 50%', () => {
    expect(expectedBookCardPercent({ pages: 2, pagesRead: 1 })).toBe(50);
    expect(expectedBookCardPercent({ pages: 8, pagesRead: 5 })).toBe(63);
    expect(expectedBookCardPercent({ pages: 0, pagesRead: 1 })).toBe(0);
    expect(expectedBookCardPercent({ pages: 10, pagesRead: 14 })).toBe(100);
  });

  it('matches book cards by stable identifier and title across grid and list accessibility modes', () => {
    const bookId = 'server:1:1';
    const title = 'Turnleaf CI EPUB';
    const expectedPercent = expectedBookCardPercent({ pages: 8, pagesRead: 5 });

    expect(
      inspectLibraryBookCard(
        {
          bookId,
          heading: title,
          openDisabled: false,
          openLabel: `Open ${title}, by Turnleaf, downloaded for offline reading, 63% complete`,
          progressNow: '63',
          progressText: '63% complete',
        },
        { bookId, title, expectedPercent },
      ),
    ).toBe(true);

    expect(
      inspectLibraryBookCard(
        {
          bookId,
          heading: title,
          openDisabled: false,
          openLabel: `Open ${title}, downloaded for offline reading`,
          progressNow: '63',
          progressText: '63% complete',
        },
        { bookId, title, expectedPercent },
      ),
    ).toBe(true);

    expect(
      inspectLibraryBookCard(
        {
          bookId: 'server:1:999',
          heading: title,
          openDisabled: false,
          openLabel: `Open ${title}, downloaded for offline reading, 63% complete`,
          progressNow: '63',
          progressText: '63% complete',
        },
        { bookId, title, expectedPercent },
      ),
    ).toBe(false);

    expect(
      inspectLibraryBookCard(
        {
          bookId,
          heading: title,
          openDisabled: false,
          openLabel: `Open ${title}, downloaded for offline reading, 50% complete`,
          progressNow: '50',
          progressText: '50% complete',
        },
        { bookId, title, expectedPercent },
      ),
    ).toBe(false);
  });

  it('checks the queued reading progress banner independently from card selectors', () => {
    expect(
      hasQueuedSyncBanner([
        'No network connection. Showing your saved library.',
        '1 reading progress update waiting to sync. Retry sync',
      ]),
    ).toBe(true);
    expect(hasQueuedSyncBanner(['No network connection. Showing your saved library.'])).toBe(false);
  });
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
});
