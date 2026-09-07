import { expect, it } from 'vitest';
import { issue51VolumeDetail } from './fixtures/issue-51-volume-detail';
import { mapSeriesToBooks } from './mapper';
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
    volumes: [],
    storylineChapters: [],
  } satisfies KavitaSeriesDetail;
  expect(mapSeriesToBooks('primary', series, detail)).toHaveLength(1);
  expect(mapSeriesToBooks('primary', series, detail)[0]).toMatchObject({
    id: 'primary:7:7',
    author: 'Benjamin Wood',
    chapterId: 7,
    fileSize: 799783,
  });
});

it('maps every EPUB chapter nested in Kavita volumes', () => {
  const series = {
    id: 82,
    name: 'The Seven Great Monarchies',
    libraryId: 1,
    format: 3,
    pages: 25,
    pagesRead: 0,
    created: '2026-09-05',
    latestReadDate: '0001-01-01T00:00:00',
    coverImage: 'cover.png',
  } satisfies KavitaSeries;
  const chapter = (
    id: number,
    volumeId: number,
    titleName: string,
  ): KavitaSeriesDetail['chapters'][number] => ({
    id,
    title: `Book ${titleName}`,
    titleName,
    volumeId,
    pages: 10,
    pagesRead: 0,
    summary: '',
    format: 3,
    files: [{ id, bytes: 1000 + id, extension: '.epub', format: 3 }],
    writers: [{ name: 'George Rawlinson' }],
    lastReadingProgressUtc: '0001-01-01T00:00:00',
  });
  const detail = {
    chapters: [],
    specials: [],
    volumes: [
      { id: 188, chapters: [chapter(1406, 188, 'Vol 3')] },
      { id: 189, chapters: [chapter(1407, 189, 'Vol 5')] },
    ],
    storylineChapters: [],
  } satisfies KavitaSeriesDetail;

  expect(mapSeriesToBooks('primary', series, detail).map((book) => book.id)).toEqual([
    'primary:82:1406',
    'primary:82:1407',
  ]);
});

it('deduplicates a chapter exposed both flat and inside its volume', () => {
  const series = {
    id: 9,
    name: 'A Series',
    libraryId: 1,
    format: 3,
    pages: 10,
    pagesRead: 0,
    created: '2026-09-05',
    latestReadDate: '0001-01-01T00:00:00',
    coverImage: 'cover.png',
  } satisfies KavitaSeries;
  const chapter = {
    id: 90,
    title: 'Book One',
    titleName: 'Book One',
    volumeId: 9,
    pages: 10,
    pagesRead: 0,
    summary: '',
    format: 3,
    files: [{ id: 90, bytes: 900, extension: '.epub', format: 3 }],
    writers: [],
    lastReadingProgressUtc: '0001-01-01T00:00:00',
  };
  const detail = {
    chapters: [chapter],
    specials: [],
    volumes: [{ id: 9, chapters: [chapter] }],
    storylineChapters: [],
  } satisfies KavitaSeriesDetail;

  expect(mapSeriesToBooks('primary', series, detail)).toHaveLength(1);
});

it('maps the minimized volume-only payload reported in issue #51', () => {
  const series = {
    id: 82,
    name: 'The Seven Great Monarchies Of The Ancient Eastern World',
    libraryId: 1,
    format: 3,
    pages: 44,
    pagesRead: 0,
    created: '2026-09-05',
    latestReadDate: '0001-01-01T00:00:00',
    coverImage: 'cover.png',
  } satisfies KavitaSeries;

  expect(
    mapSeriesToBooks('primary', series, issue51VolumeDetail).map((book) => book.chapterId),
  ).toEqual([1406, 1407, 1409, 1408]);
});
