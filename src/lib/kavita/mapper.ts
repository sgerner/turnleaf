import type { BookRecord } from '../database/database';
import { sanitizeEpubFileName } from './normalization';
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
    .flatMap((chapter) => mapChapterToBooks(serverId, series, chapter));
  disambiguateDuplicateTitles(books);
  if (books.length > 1 && series.name) {
    for (const book of books) book.series = series.name;
  }
  return books;
}

function mapChapterToBooks(
  serverId: string,
  series: KavitaSeries,
  chapter: KavitaChapter,
): BookRecord[] {
  const epubFiles = chapter.files.filter(isEpubFile);
  if (!epubFiles.length) throw new Error('An EPUB chapter did not include an EPUB file.');
  const multiFileChapter = Boolean(chapter.hasMultipleFiles) || chapter.files.length > 1;
  return epubFiles.map((file, epubIndex) =>
    mapFileToBook(serverId, series, chapter, file, epubIndex, multiFileChapter),
  );
}

function mapFileToBook(
  serverId: string,
  series: KavitaSeries,
  chapter: KavitaChapter,
  file: KavitaFile,
  epubIndex: number,
  multiFileChapter: boolean,
): BookRecord {
  const isPrimary = epubIndex === 0;
  const pages = resolveFilePages(series, chapter, file, multiFileChapter);
  const rawPagesRead = chapter.pagesRead ?? 0;
  const pagesRead = isPrimary ? (pages > 0 ? Math.min(pages, rawPagesRead) : rawPagesRead) : 0;
  const fileName = sanitizeEpubFileName(file.fileName);
  return {
    id: isPrimary
      ? `${serverId}:${series.id}:${chapter.id}`
      : `${serverId}:${series.id}:${chapter.id}:${file.id}`,
    serverId,
    libraryId: series.libraryId,
    seriesId: series.id,
    volumeId: chapter.volumeId,
    chapterId: chapter.id,
    fileId: file.id,
    fileName,
    title: chapter.titleName || chapter.title || series.name || `Book ${chapter.id}`,
    author: chapter.writers.map((writer) => writer.name).join(', ') || null,
    series:
      chapter.titleName && series.name && chapter.titleName !== series.name ? series.name : null,
    descriptionHtml: chapter.summary || null,
    format: 'epub',
    pages,
    pagesRead,
    ...(isPrimary
      ? {
          ...(chapter.pagesRead === undefined ? { remoteProgressKnown: false } : {}),
          ...(!chapter.lastReadingProgressUtc ? { remoteReadDateKnown: false } : {}),
        }
      : {
          remoteProgressKnown: false,
          remoteReadDateKnown: false,
        }),
    createdAt: series.created,
    lastReadAt: isPrimary ? lastReadAt(chapter) : null,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: file.bytes,
    remoteFileSize: file.bytes,
    chapterEpubIndex: epubIndex,
    multiFileChapter,
    syncProgress: isPrimary,
    remoteAvailable: true,
  };
}

function resolveFilePages(
  series: KavitaSeries,
  chapter: KavitaChapter,
  file: KavitaFile,
  multiFileChapter: boolean,
): number {
  if (file.pages !== undefined && file.pages > 0) return file.pages;
  if (multiFileChapter) return file.pages ?? 0;
  return chapter.pages || series.pages;
}

function fileDisplayStem(fileName: string | null | undefined): string {
  const sanitized = sanitizeEpubFileName(fileName);
  if (!sanitized) return '';
  return sanitized.replace(/\.epub$/i, '').trim();
}

function disambiguateDuplicateTitles(books: BookRecord[]): void {
  const groups = new Map<string, BookRecord[]>();
  for (const book of books) {
    const group = groups.get(book.title);
    if (group) group.push(book);
    else groups.set(book.title, [book]);
  }
  for (const [baseTitle, group] of groups) {
    if (group.length < 2) continue;
    const labels = group.map(
      (book) => fileDisplayStem(book.fileName) || `File ${(book.chapterEpubIndex ?? 0) + 1}`,
    );
    const labelCounts = new Map<string, number>();
    for (const label of labels) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    group.forEach((book, index) => {
      const label = labels[index]!;
      const uniqueLabel =
        (labelCounts.get(label) ?? 0) > 1 ? `${label} #${book.fileId ?? index + 1}` : label;
      book.title = `${baseTitle} (${uniqueLabel})`;
    });
  }
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
