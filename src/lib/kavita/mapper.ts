import type { BookRecord } from '../database/database';
import { usableSequenceNumber } from '../library/series-metadata';
import type {
  KavitaChapter,
  KavitaFile,
  KavitaSeries,
  KavitaSeriesDetail,
  KavitaVolume,
} from './types';

const EMPTY_DATE = '0001-01-01T00:00:00';

export function mapSeriesToBooks(
  serverId: string,
  series: KavitaSeries,
  detail: KavitaSeriesDetail,
): BookRecord[] {
  const volumesById =
    detail.volumes && detail.volumes.length > 0
      ? new Map<number, KavitaVolume>(detail.volumes.map((volume) => [volume.id, volume]))
      : undefined;
  // Keep flat arrays first so their representation wins if Kavita exposes the
  // same chapter both flat and nested. IDs include the chapter ID, so existing
  // local records remain matched regardless of this ordering.
  const seen = new Set<number>();
  const books: BookRecord[] = [];
  const appendChapters = (chapters: KavitaChapter[], inSpecials = false): void => {
    for (const chapter of chapters) {
      if (seen.has(chapter.id)) continue;
      if (chapter.format !== undefined && chapter.format !== null && chapter.format !== 3) continue;
      const file = chapter.files.find(isEpubFile);
      if (!file) continue;
      seen.add(chapter.id);
      books.push(
        mapChapterToBook(
          serverId,
          series,
          chapter,
          file,
          volumesById?.get(chapter.volumeId),
          inSpecials || chapter.isSpecial === true,
        ),
      );
    }
  };
  appendChapters(detail.chapters);
  appendChapters(detail.specials, true);
  appendChapters(detail.storylineChapters);
  if (detail.volumes) {
    for (const volume of detail.volumes) {
      appendChapters(volume.chapters);
    }
  }
  if (books.length > 1 && series.name) {
    for (const book of books) book.series = series.name;
  }
  return books;
}

function mapChapterToBook(
  serverId: string,
  series: KavitaSeries,
  chapter: KavitaChapter,
  file: KavitaFile,
  volume: KavitaVolume | undefined,
  isSpecial: boolean,
): BookRecord {
  const writers = chapter.writers;
  const author =
    writers.length === 0
      ? null
      : writers.length === 1
        ? writers[0]!.name || null
        : writers.map((writer) => writer.name).join(', ') || null;
  const rawVolumeNumber =
    usableSequenceNumber(volume?.minNumber) ??
    usableSequenceNumber(volume?.number) ??
    usableSequenceNumber(chapter.volumeNumber);
  const volumeNumber = isSpecial ? null : rawVolumeNumber;
  const sortOrder = isSpecial ? null : usableSequenceNumber(chapter.sortOrder);
  const minNumber = isSpecial ? null : usableSequenceNumber(chapter.minNumber);
  const id = `${serverId}:${series.id}:${chapter.id}`;
  const title = chapter.titleName || chapter.title || series.name || `Book ${chapter.id}`;
  const hasDistinctSeries =
    Boolean(series.name) &&
    ((Boolean(chapter.titleName) && chapter.titleName !== series.name) ||
      (title !== series.name && volumeNumber !== null && volumeNumber > 0));
  const bookSeries = hasDistinctSeries && series.name ? series.name : null;
  const descriptionHtml = chapter.summary || null;
  const pages = chapter.pages || series.pages;
  const pagesRead = chapter.pagesRead ?? 0;
  const readAt = lastReadAt(chapter);
  const book: BookRecord = {
    id,
    serverId,
    libraryId: series.libraryId,
    seriesId: series.id,
    volumeId: chapter.volumeId,
    chapterId: chapter.id,
    title,
    author,
    series: bookSeries,
    descriptionHtml,
    format: 'epub',
    pages,
    pagesRead,
    createdAt: series.created,
    lastReadAt: readAt,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: file.bytes,
    sortOrder,
    minNumber,
    volumeNumber,
    remoteAvailable: true,
  };
  if (chapter.pagesRead === undefined) book.remoteProgressKnown = false;
  if (!chapter.lastReadingProgressUtc) book.remoteReadDateKnown = false;
  return book;
}

function lastReadAt(chapter: KavitaChapter): string | null {
  const value = chapter.lastReadingProgressUtc;
  return !value || value.startsWith(EMPTY_DATE) ? null : value;
}

function isEpubFile(file: KavitaFile): boolean {
  return file.format === 3 || file.extension?.toLowerCase() === '.epub';
}
