import type { BookRecord } from '../database/database';
import type { KavitaChapter, KavitaFile, KavitaSeries, KavitaSeriesDetail } from './types';

const EMPTY_DATE = '0001-01-01T00:00:00';

export function mapSeriesToBooks(
  serverId: string,
  series: KavitaSeries,
  detail: KavitaSeriesDetail,
): BookRecord[] {
  // Keep flat arrays first so their representation wins if Kavita exposes the
  // same chapter both flat and nested. IDs include the chapter ID, so existing
  // local records remain matched regardless of this ordering.
  const seen = new Set<number>();
  const books: BookRecord[] = [];
  const appendChapters = (chapters: KavitaChapter[]): void => {
    for (const chapter of chapters) {
      if (seen.has(chapter.id)) continue;
      if (chapter.format !== undefined && chapter.format !== null && chapter.format !== 3) continue;
      const file = chapter.files.find(isEpubFile);
      if (!file) continue;
      seen.add(chapter.id);
      books.push(mapChapterToBook(serverId, series, chapter, file));
    }
  };
  appendChapters(detail.chapters);
  appendChapters(detail.specials);
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
): BookRecord {
  const chapterKey = extractChapterKey(chapter);
  const writers = chapter.writers;
  const author =
    writers.length === 0
      ? null
      : writers.length === 1
        ? writers[0]!.name || null
        : writers.map((writer) => writer.name).join(', ') || null;
  const id = `${serverId}:${series.id}:${chapter.id}`;
  const title = chapter.titleName || chapter.title || series.name || `Book ${chapter.id}`;
  const bookSeries =
    chapter.titleName && series.name && chapter.titleName !== series.name ? series.name : null;
  const descriptionHtml = chapter.summary || null;
  const pages = chapter.pages || series.pages;
  const pagesRead = chapter.pagesRead ?? 0;
  const readAt = lastReadAt(chapter);
  if (chapter.pagesRead !== undefined && chapter.lastReadingProgressUtc && !chapterKey) {
    return {
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
      remoteFileSize: file.bytes,
      remoteAvailable: true,
    };
  }
  return {
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
    ...(chapterKey ? { chapterKey } : {}),
    ...(chapter.pagesRead === undefined ? { remoteProgressKnown: false } : {}),
    ...(!chapter.lastReadingProgressUtc ? { remoteReadDateKnown: false } : {}),
    createdAt: series.created,
    lastReadAt: readAt,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: file.bytes,
    remoteFileSize: file.bytes,
    remoteAvailable: true,
  };
}

function extractChapterKey(chapter: KavitaChapter): string | null {
  const isbn = chapter.isbn?.replace(/[\s-]+/g, '').toLowerCase();
  if (isbn) return `isbn:${isbn}`;
  const number = chapter.number?.trim();
  if (number && number !== '-100000') return `number:${number.toLowerCase()}`;
  const range = chapter.range?.trim();
  if (range && range !== '-100000' && !/\.epub$/i.test(range)) {
    return `range:${range.toLowerCase()}`;
  }
  if (
    typeof chapter.sortOrder === 'number' &&
    Number.isFinite(chapter.sortOrder) &&
    chapter.sortOrder >= 0
  ) {
    return `sort:${chapter.sortOrder}`;
  }
  return null;
}

function lastReadAt(chapter: KavitaChapter): string | null {
  const value = chapter.lastReadingProgressUtc;
  return !value || value.startsWith(EMPTY_DATE) ? null : value;
}

function isEpubFile(file: KavitaFile): boolean {
  return file.format === 3 || file.extension?.toLowerCase() === '.epub';
}
