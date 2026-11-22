import type { BookRecord } from '../database/database';
import { usableSequenceNumber } from '../library/series-metadata';
import type { KavitaChapter, KavitaSeries, KavitaSeriesDetail, KavitaVolume } from './types';

const EMPTY_DATE = '0001-01-01T00:00:00';

export function mapSeriesToBooks(
  serverId: string,
  series: KavitaSeries,
  detail: KavitaSeriesDetail,
): BookRecord[] {
  const volumesById = new Map<number, KavitaVolume>(
    (detail.volumes ?? []).map((volume) => [volume.id, volume]),
  );
  const specialIds = new Set(detail.specials.map((chapter) => chapter.id));
  // Keep flat arrays first so their representation wins if Kavita exposes the
  // same chapter both flat and nested. IDs include the chapter ID, so existing
  // local records remain matched regardless of this ordering.
  const chapters = [
    ...detail.chapters,
    ...detail.specials,
    ...detail.storylineChapters,
    ...(detail.volumes ?? []).flatMap((volume) => volume.chapters),
  ];
  const seen = new Set<number>();
  const books = chapters
    .filter(isEpubChapter)
    .filter((chapter) => {
      if (seen.has(chapter.id)) return false;
      seen.add(chapter.id);
      return true;
    })
    .map((chapter) =>
      mapChapterToBook(
        serverId,
        series,
        chapter,
        volumesById.get(chapter.volumeId),
        specialIds.has(chapter.id) || chapter.isSpecial === true,
      ),
    );
  if (books.length > 1 && series.name) {
    for (const book of books) book.series = series.name;
  }
  return books;
}

function mapChapterToBook(
  serverId: string,
  series: KavitaSeries,
  chapter: KavitaChapter,
  volume: KavitaVolume | undefined,
  isSpecial: boolean,
): BookRecord {
  const file = chapter.files.find(isEpubFile);
  if (!file) throw new Error('An EPUB chapter did not include an EPUB file.');
  const rawVolumeNumber =
    usableSequenceNumber(volume?.minNumber) ??
    usableSequenceNumber(volume?.number) ??
    usableSequenceNumber(chapter.volumeNumber);
  const volumeNumber = isSpecial ? null : rawVolumeNumber;
  const sortOrder = isSpecial ? null : usableSequenceNumber(chapter.sortOrder);
  const minNumber = isSpecial ? null : usableSequenceNumber(chapter.minNumber);
  const title = chapter.titleName || chapter.title || series.name || `Book ${chapter.id}`;
  const hasDistinctSeries =
    Boolean(series.name) &&
    ((Boolean(chapter.titleName) && chapter.titleName !== series.name) ||
      (title !== series.name && volumeNumber !== null && volumeNumber > 0));
  return {
    id: `${serverId}:${series.id}:${chapter.id}`,
    serverId,
    libraryId: series.libraryId,
    seriesId: series.id,
    volumeId: chapter.volumeId,
    chapterId: chapter.id,
    title,
    author: chapter.writers.map((writer) => writer.name).join(', ') || null,
    series: hasDistinctSeries && series.name ? series.name : null,
    descriptionHtml: chapter.summary || null,
    format: 'epub',
    pages: chapter.pages || series.pages,
    pagesRead: chapter.pagesRead ?? 0,
    ...(chapter.pagesRead === undefined ? { remoteProgressKnown: false } : {}),
    ...(!chapter.lastReadingProgressUtc ? { remoteReadDateKnown: false } : {}),
    createdAt: series.created,
    lastReadAt: lastReadAt(chapter),
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: file.bytes,
    sortOrder,
    minNumber,
    volumeNumber,
    remoteAvailable: true,
  };
}

function lastReadAt(chapter: KavitaChapter): string | null {
  const value = chapter.lastReadingProgressUtc;
  return !value || value.startsWith(EMPTY_DATE) ? null : value;
}

function isEpubChapter(chapter: KavitaChapter): boolean {
  return (
    (chapter.format === undefined || chapter.format === null || chapter.format === 3) &&
    chapter.files.some(isEpubFile)
  );
}

function isEpubFile(file: KavitaChapter['files'][number]): boolean {
  return file.format === 3 || file.extension?.toLowerCase() === '.epub';
}
