import type { BookRecord } from '../database/database';
import type { KavitaChapter, KavitaSeries, KavitaSeriesDetail } from './types';

const EMPTY_DATE = '0001-01-01T00:00:00';

export function mapSeriesToBooks(
  serverId: string,
  series: KavitaSeries,
  detail: KavitaSeriesDetail,
): BookRecord[] {
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
    .map((chapter) => mapChapterToBook(serverId, series, chapter));
  if (books.length > 1 && series.name) {
    for (const book of books) book.series = series.name;
  }
  return books;
}

function mapChapterToBook(
  serverId: string,
  series: KavitaSeries,
  chapter: KavitaChapter,
): BookRecord {
  const file = chapter.files.find(isEpubFile);
  if (!file) throw new Error('An EPUB chapter did not include an EPUB file.');
  const chapterKey = extractChapterKey(chapter);
  return {
    id: `${serverId}:${series.id}:${chapter.id}`,
    serverId,
    libraryId: series.libraryId,
    seriesId: series.id,
    volumeId: chapter.volumeId,
    chapterId: chapter.id,
    title: chapter.titleName || chapter.title || series.name || `Book ${chapter.id}`,
    author: chapter.writers.map((writer) => writer.name).join(', ') || null,
    series:
      chapter.titleName && series.name && chapter.titleName !== series.name ? series.name : null,
    descriptionHtml: chapter.summary || null,
    format: 'epub',
    pages: chapter.pages || series.pages,
    pagesRead: chapter.pagesRead ?? 0,
    ...(chapterKey ? { chapterKey } : {}),
    ...(chapter.pagesRead === undefined ? { remoteProgressKnown: false } : {}),
    ...(!chapter.lastReadingProgressUtc ? { remoteReadDateKnown: false } : {}),
    createdAt: series.created,
    lastReadAt: lastReadAt(chapter),
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

function isEpubChapter(chapter: KavitaChapter): boolean {
  return (
    (chapter.format === undefined || chapter.format === null || chapter.format === 3) &&
    chapter.files.some(isEpubFile)
  );
}

function isEpubFile(file: KavitaChapter['files'][number]): boolean {
  return file.format === 3 || file.extension?.toLowerCase() === '.epub';
}
