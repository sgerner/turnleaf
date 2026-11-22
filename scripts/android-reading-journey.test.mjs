// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { prepareDownloadedEpub, validateEpubArchive } from '../src/lib/downloads/epub-validation';
import { mapSeriesToBooks } from '../src/lib/kavita/mapper';
import { normalizeSeriesDetail, normalizeSeriesPage } from '../src/lib/kavita/normalization';
import { startFixture } from './android-reading-journey.mjs';

describe('Android reading journey multi-file chapter fixture', () => {
  let fixture;

  afterEach(() => {
    fixture?.close();
    fixture = undefined;
  });

  it('serves a multi-EPUB plus PDF chapter that maps to two disambiguated books and unwraps each inner EPUB', async () => {
    fixture = await startFixture();
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
});
