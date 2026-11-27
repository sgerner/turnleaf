import { expect, it } from 'vitest';
import { issue51VolumeDetail } from './fixtures/issue-51-volume-detail';
import { mapSeriesToBooks } from './mapper';
import { normalizeSeriesPage, normalizeSeriesDetail } from './normalization';
import type { KavitaSeries, KavitaSeriesDetail } from './types';

it.each([null, 0])(
  'carries unknown progress through normalized mapping while preserving explicit zero (%s)',
  (pagesRead) => {
    const series = normalizeSeriesPage([{ id: 1, libraryId: 1, format: 3 }])[0]!;
    const detail = normalizeSeriesDetail({
      volumes: [
        {
          id: 7,
          chapters: [
            {
              id: 9,
              pagesRead,
              lastReadingProgressUtc: pagesRead === 0 ? '0001-01-01T00:00:00' : null,
              files: [{ id: 9, format: 3 }],
            },
          ],
        },
      ],
    });
    const book = mapSeriesToBooks('primary', series, detail)[0]!;
    expect(book.pagesRead).toBe(0);
    expect(book.remoteProgressKnown).toBe(pagesRead === null ? false : undefined);
    expect(book.remoteReadDateKnown).toBe(pagesRead === null ? false : undefined);
    expect(book.volumeId).toBe(7);
  },
);

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

it('prefers flat collections in order and keeps non-EPUB chapter IDs out of seen', () => {
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
  const makeChapter = (
    id: number,
    titleName: string,
    overrides: Partial<KavitaSeriesDetail['chapters'][number]> = {},
  ): KavitaSeriesDetail['chapters'][number] => ({
    id,
    title: titleName,
    titleName,
    volumeId: 9,
    pages: 10,
    pagesRead: 0,
    summary: '',
    format: 3,
    files: [{ id, bytes: 900, extension: '.epub', format: 3 }],
    writers: [{ name: 'Author One' }, { name: 'Author Two' }],
    lastReadingProgressUtc: '0001-01-01T00:00:00Z',
    ...overrides,
  });

  const detail = {
    chapters: [
      makeChapter(90, 'From Chapters'),
      makeChapter(92, 'Archive Placeholder', {
        format: 1,
        files: [{ id: 920, bytes: 500, extension: '.cbz', format: 1 }],
      }),
      makeChapter(93, 'Empty Files Placeholder', {
        files: [{ id: 930, bytes: 500, extension: '.pdf', format: 4 }],
      }),
    ],
    specials: [makeChapter(90, 'From Specials'), makeChapter(91, 'From Specials')],
    storylineChapters: [
      makeChapter(91, 'From Storyline'),
      makeChapter(92, 'EPUB After Non-EPUB Format'),
    ],
    volumes: [
      {
        id: 9,
        chapters: [
          makeChapter(90, 'From Volume'),
          makeChapter(91, 'From Volume'),
          makeChapter(93, 'EPUB After Non-EPUB File'),
        ],
      },
    ],
  } satisfies KavitaSeriesDetail;

  const books = mapSeriesToBooks('primary', series, detail);
  expect(books.map((book) => [book.chapterId, book.title, book.lastReadAt, book.author])).toEqual([
    [90, 'From Chapters', null, 'Author One, Author Two'],
    [91, 'From Specials', null, 'Author One, Author Two'],
    [92, 'EPUB After Non-EPUB Format', null, 'Author One, Author Two'],
    [93, 'EPUB After Non-EPUB File', null, 'Author One, Author Two'],
  ]);
  expect(books.every((book) => book.remoteReadDateKnown === undefined)).toBe(true);
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

  const books = mapSeriesToBooks('primary', series, issue51VolumeDetail);
  expect(books).toHaveLength(5);
  expect(books.map((book) => book.chapterId)).toEqual([1406, 1406, 1407, 1409, 1408]);
  expect(books.map((book) => book.fileId)).toEqual([2114, 2115, 2116, 2118, 2117]);
  expect(books.map((book) => book.id)).toEqual([
    'primary:82:1406:2114',
    'primary:82:1406:2115',
    'primary:82:1407',
    'primary:82:1409',
    'primary:82:1408',
  ]);
  expect(books.map((book) => book.pages)).toEqual([5, 4, 16, 8, 11]);
  expect(books.map((book) => book.fileSize)).toEqual([
    1955734, 2169759, 10039970, 2902733, 6659250,
  ]);
  expect(books[0]).toMatchObject({
    id: 'primary:82:1406:2114',
    fileId: 2114,
    fileName: 'pg16163-images-3.epub',
    title: 'The Seven Great Monarchies Of The Ancient Eastern World, Vol 3 (pg16163-images-3)',
    pages: 5,
    fileSize: 1955734,
    remoteFileSize: 1955734,
    chapterEpubIndex: 0,
    multiFileChapter: true,
    syncProgress: true,
  });
  expect(books[1]).toMatchObject({
    id: 'primary:82:1406:2115',
    fileId: 2115,
    fileName: 'The-Seven-Great-Monarchies-Of-The-Ancient-Eastern-World-Vol-3-Media.epub',
    title:
      'The Seven Great Monarchies Of The Ancient Eastern World, Vol 3 (The-Seven-Great-Monarchies-Of-The-Ancient-Eastern-World-Vol-3-Media)',
    pages: 4,
    pagesRead: 0,
    lastReadAt: null,
    fileSize: 2169759,
    remoteFileSize: 2169759,
    chapterEpubIndex: 1,
    multiFileChapter: true,
    syncProgress: false,
    remoteProgressKnown: false,
    remoteReadDateKnown: false,
  });
  expect(books[2]?.title).toBe('The Seven Great Monarchies Of The Ancient Eastern World, Vol 5');
  expect(books.map((book) => book.series)).toEqual(Array(5).fill(series.name));
});

it('keeps chapter progress and dates separate from series aggregates', () => {
  const series = {
    id: 12,
    name: 'Mixed Progress',
    libraryId: 1,
    format: 3,
    pages: 20,
    pagesRead: 12,
    created: '2026-09-05',
    latestReadDate: '2026-09-06T10:00:00',
    coverImage: 'cover.png',
  } satisfies KavitaSeries;
  const chapter = (
    id: number,
    pagesRead: number,
    lastReadingProgressUtc: string,
  ): KavitaSeriesDetail['chapters'][number] => ({
    id,
    title: `Book ${id}`,
    titleName: `Book ${id}`,
    volumeId: id,
    pages: 20,
    pagesRead,
    summary: '',
    format: 3,
    files: [{ id, bytes: 1000, extension: '.epub', format: 3 }],
    writers: [],
    lastReadingProgressUtc,
  });
  const detail = {
    chapters: [],
    specials: [],
    volumes: [
      { id: 12, chapters: [chapter(120, 12, '2026-09-04T10:00:00')] },
      { id: 13, chapters: [chapter(121, 0, '0001-01-01T00:00:00')] },
    ],
    storylineChapters: [],
  } satisfies KavitaSeriesDetail;

  expect(mapSeriesToBooks('primary', series, detail)).toMatchObject([
    { chapterId: 120, pagesRead: 12, lastReadAt: '2026-09-04T10:00:00' },
    { chapterId: 121, pagesRead: 0, lastReadAt: null },
  ]);
});

it('keeps absent chapter progress unknown rather than applying a series aggregate', () => {
  const series = {
    id: 13,
    name: 'Missing Progress',
    libraryId: 1,
    format: 3,
    pages: 20,
    pagesRead: 12,
    created: '2026-09-05',
    latestReadDate: '2026-09-06T10:00:00',
    coverImage: 'cover.png',
  } satisfies KavitaSeries;
  const chapter = {
    id: 130,
    title: 'Book 130',
    titleName: 'Book 130',
    volumeId: 13,
    pages: 20,
    format: 3,
    files: [{ id: 130, bytes: 1000, extension: '.epub', format: 3 }],
    writers: [],
    summary: '',
  };
  const detail = {
    chapters: [],
    specials: [],
    volumes: [{ id: 13, chapters: [chapter] }],
    storylineChapters: [],
  } satisfies KavitaSeriesDetail;

  expect(mapSeriesToBooks('primary', series, detail)[0]).toMatchObject({
    pagesRead: 0,
    lastReadAt: null,
    remoteProgressKnown: false,
    remoteReadDateKnown: false,
  });
});

it('maps EPUBs when Kavita omits optional names, covers, or file extensions', () => {
  const series = {
    id: 14,
    name: null,
    libraryId: 1,
    format: 3,
    pages: 20,
    pagesRead: 0,
    created: '2026-09-05',
    latestReadDate: '0001-01-01T00:00:00',
    coverImage: null,
  } satisfies KavitaSeries;
  const chapter = {
    id: 140,
    title: '',
    titleName: '',
    volumeId: 14,
    pages: 20,
    pagesRead: 0,
    summary: '',
    format: null,
    files: [{ id: 140, bytes: 1000, extension: null, format: 3 }],
    writers: [],
  };
  const detail = {
    chapters: [chapter],
    specials: [],
    volumes: [],
    storylineChapters: [],
  } satisfies KavitaSeriesDetail;

  expect(mapSeriesToBooks('primary', series, detail)).toMatchObject([
    {
      chapterId: 140,
      title: 'Book 140',
      series: null,
      fileSize: 1000,
    },
  ]);
});

it('maps mixed EPUB-plus-PDF chapters using per-file pages and keeps sibling EPUB progress local', () => {
  const series = normalizeSeriesPage([
    {
      id: 55,
      libraryId: 1,
      format: 3,
      pages: 400,
      pagesRead: 9,
      name: 'Collected Editions',
      created: '2026-09-05T00:00:00Z',
      latestReadDate: '2026-09-06T10:00:00Z',
    },
  ])[0]!;
  const detail = normalizeSeriesDetail({
    volumes: [
      {
        id: 500,
        chapters: [
          {
            id: 5001,
            volumeId: 500,
            title: 'Volume One',
            titleName: 'Volume One',
            pages: 320,
            pagesRead: 18,
            summary: '',
            format: 3,
            lastReadingProgressUtc: '2026-09-06T10:00:00Z',
            writers: [{ name: 'Editor' }],
            files: [
              {
                id: 9001,
                format: 3,
                bytes: 512000,
                pages: 12,
                extension: '.epub',
                filePath: '/books/Collected/Volume-One-Text.epub',
              },
              {
                id: 9002,
                format: 4,
                bytes: 8400000,
                pages: 308,
                extension: '.pdf',
                filePath: '/books/Collected/Volume-One-Scan.pdf',
              },
            ],
          },
          {
            id: 5002,
            volumeId: 500,
            title: 'Volume Two',
            titleName: 'Volume Two',
            pages: 25,
            pagesRead: 9,
            summary: '',
            format: 3,
            lastReadingProgressUtc: '2026-09-06T12:00:00Z',
            writers: [{ name: 'Editor' }],
            files: [
              { id: 9003, format: 3, bytes: 300000, pages: 10, extension: '.epub' },
              { id: 9004, format: 3, bytes: 450000, pages: 15, extension: '.epub' },
            ],
          },
        ],
      },
    ],
  });

  const books = mapSeriesToBooks('primary', series, detail);
  expect(books).toHaveLength(3);
  expect(books[0]).toMatchObject({
    id: 'primary:55:5001',
    fileId: 9001,
    fileName: 'Volume-One-Text.epub',
    title: 'Volume One',
    pages: 12,
    pagesRead: 12,
    fileSize: 512000,
    multiFileChapter: true,
    syncProgress: true,
  });
  expect(books[1]).toMatchObject({
    id: 'primary:55:5002:9003',
    fileId: 9003,
    title: 'Volume Two (File 1)',
    pages: 10,
    pagesRead: 9,
    lastReadAt: '2026-09-06T12:00:00Z',
    syncProgress: true,
  });
  expect(books[2]).toMatchObject({
    id: 'primary:55:5002:9004',
    fileId: 9004,
    title: 'Volume Two (File 2)',
    pages: 15,
    pagesRead: 0,
    lastReadAt: null,
    syncProgress: false,
    remoteProgressKnown: false,
    remoteReadDateKnown: false,
  });

  const reversedDetail = structuredClone(detail);
  reversedDetail.volumes![0]!.chapters[1]!.files.reverse();
  const reversedBooks = mapSeriesToBooks('primary', series, reversedDetail);
  expect(reversedBooks[1]).toMatchObject({
    id: 'primary:55:5002:9004',
    fileId: 9004,
    title: 'Volume Two (File 2)',
    pages: 15,
    pagesRead: 0,
    lastReadAt: null,
    chapterEpubIndex: 0,
    syncProgress: false,
  });
  expect(reversedBooks[2]).toMatchObject({
    id: 'primary:55:5002:9003',
    fileId: 9003,
    title: 'Volume Two (File 1)',
    pages: 10,
    pagesRead: 9,
    lastReadAt: '2026-09-06T12:00:00Z',
    chapterEpubIndex: 1,
    syncProgress: true,
  });
});
