// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { openBookLabel } from '../src/lib/a11y/book-labels';
import { prepareDownloadedEpub, validateEpubArchive } from '../src/lib/downloads/epub-validation';
import { mapSeriesToBooks } from '../src/lib/kavita/mapper';
import { normalizeSeriesDetail, normalizeSeriesPage } from '../src/lib/kavita/normalization';
import { startFixture } from './android-reading-journey.mjs';

const fixtures = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.close();
  }
});

describe('Android reading journey fixture', () => {
  it('serves a multi-EPUB plus PDF chapter that maps to two disambiguated books and unwraps each inner EPUB', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const baseUrl = `http://127.0.0.1:${fixture.port}`;
    const headers = { 'x-api-key': fixture.key };

    const [seriesResponse, detailResponse, downloadResponse] = await Promise.all([
      fetch(`${baseUrl}/api/Series/v2`, { headers }),
      fetch(`${baseUrl}/api/Series/series-detail?seriesId=1`, { headers }),
      fetch(`${baseUrl}/api/Download/chapter?chapterId=1`, { headers }),
    ]);

    expect(downloadResponse.headers.get('content-type')).toBe('application/vnd.comicbook+zip');
    const series = normalizeSeriesPage(await seriesResponse.json())[0];
    const detail = normalizeSeriesDetail(await detailResponse.json());
    const books = mapSeriesToBooks('ci', series, detail);

    expect(books).toHaveLength(2);
    expect(books.map((book) => book.title)).toEqual([fixture.primaryTitle, fixture.companionTitle]);
    expect(openBookLabel(books[0])).toBe(fixture.primaryOpenLabel);
    expect(openBookLabel({ ...books[0], downloadPath: 'books/ci-1-1.epub', pagesRead: 1 })).toBe(
      fixture.primaryReadLabel,
    );
    expect(openBookLabel(books[1])).toBe(fixture.companionOpenLabel);
    expect(openBookLabel({ ...books[1], downloadPath: 'books/ci-1-1-2.epub', pagesRead: 1 })).toBe(
      fixture.companionReadLabel,
    );
    expect(books[0]).toMatchObject({
      id: 'ci:1:1',
      pages: 2,
      fileSize: fixture.primaryByteSize,
      syncProgress: true,
      multiFileChapter: true,
    });
    expect(books[1]).toMatchObject({
      id: 'ci:1:1:2',
      pages: 2,
      fileSize: fixture.companionByteSize,
      syncProgress: false,
      multiFileChapter: true,
    });

    const outerArchive = new Uint8Array(await downloadResponse.arrayBuffer());
    for (const book of books) {
      const extracted = await prepareDownloadedEpub(
        outerArchive.length,
        async (offset, length) => outerArchive.slice(offset, offset + length),
        {
          fileName: book.fileName,
          expectedByteSize: book.remoteFileSize,
          epubIndex: book.chapterEpubIndex,
        },
      );
      expect(extracted).toBeDefined();
      expect(extracted?.length).toBe(book.fileSize);
      await expect(
        validateEpubArchive(extracted.length, async (offset, length) =>
          extracted.slice(offset, offset + length),
        ),
      ).resolves.toBeUndefined();
    }
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
