import { expect, it } from 'vitest';
import { mapSeriesToBook } from './mapper';
import type { KavitaSeries, KavitaSeriesDetail } from './types';

it('maps a Kavita standalone EPUB special into one local book', () => {
  const series = {
    id: 7,
    name: 'Seascraper',
    libraryId: 1,
    format: 3,
    pages: 16,
    pagesRead: 8,
    created: '2026-06-12',
    latestReadDate: '2026-06-20',
    coverImage: 'cover.png',
  } satisfies KavitaSeries;
  const special = {
    id: 7,
    title: 'Seascraper',
    titleName: 'Seascraper',
    volumeId: 7,
    pages: 16,
    pagesRead: 8,
    summary: '<p>Sea.</p>',
    format: 3,
    files: [{ id: 7, bytes: 799783, extension: '.epub', format: 3 }],
    writers: [{ name: 'Benjamin Wood' }],
    lastReadingProgressUtc: '2026',
  };
  const detail = {
    chapters: [],
    specials: [special],
    storylineChapters: [],
  } satisfies KavitaSeriesDetail;
  expect(mapSeriesToBook('primary', series, detail)).toMatchObject({
    id: 'primary:7:7',
    author: 'Benjamin Wood',
    chapterId: 7,
    fileSize: 799783,
  });
});
