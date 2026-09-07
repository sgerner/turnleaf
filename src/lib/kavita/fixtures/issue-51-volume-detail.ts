import type { KavitaChapter, KavitaSeriesDetail } from '../types';

function chapter(
  id: number,
  volumeId: number,
  pages: number,
  titleName: string,
  files: Array<{ id: number; bytes: number }>,
): KavitaChapter {
  return {
    id,
    title: `Book ${titleName}`,
    titleName,
    volumeId,
    pages,
    pagesRead: 0,
    summary: '',
    format: 3,
    files: files.map((file) => ({ ...file, extension: '.epub', format: 3 })),
    writers: [{ name: 'George Rawlinson' }],
    lastReadingProgressUtc: '0001-01-01T00:00:00',
  };
}

// Minimized from the SeriesDetail response attached to issue #51. The empty
// flat arrays and nested volume chapters are the fields that reproduce it.
export const issue51VolumeDetail = {
  specials: [],
  chapters: [],
  volumes: [
    {
      id: 188,
      chapters: [
        chapter(1406, 188, 9, 'The Seven Great Monarchies Of The Ancient Eastern World, Vol 3', [
          { id: 2114, bytes: 1955734 },
          { id: 2115, bytes: 2169759 },
        ]),
      ],
    },
    {
      id: 189,
      chapters: [
        chapter(1407, 189, 16, 'The Seven Great Monarchies Of The Ancient Eastern World, Vol 5', [
          { id: 2116, bytes: 10039970 },
        ]),
      ],
    },
    {
      id: 191,
      chapters: [
        chapter(1409, 191, 8, 'The Seven Great Monarchies Of The Ancient Eastern World, Vol 6', [
          { id: 2118, bytes: 2902733 },
        ]),
      ],
    },
    {
      id: 190,
      chapters: [
        chapter(1408, 190, 11, 'The Seven Great Monarchies Of The Ancient Eastern World, Vol 7', [
          { id: 2117, bytes: 6659250 },
        ]),
      ],
    },
  ],
  storylineChapters: [],
} satisfies KavitaSeriesDetail;
