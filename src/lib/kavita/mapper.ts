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
  const seen = new Set<number>();
  const books: BookRecord[] = [];
  const appendChapters = (chapters: KavitaChapter[]): void => {
    for (const chapter of chapters) {
      if (seen.has(chapter.id)) continue;
      if (chapter.format !== undefined && chapter.format !== null && chapter.format !== 3) continue;
      const epubFiles = chapter.files.filter(isEpubFile);
      if (epubFiles.length === 0) continue;
      seen.add(chapter.id);
      const hasMultipleEpubs = epubFiles.length > 1;
      const multiFileChapter = Boolean(chapter.hasMultipleFiles) || chapter.files.length > 1;
      const primaryFileId = Math.min(...epubFiles.map((file) => file.id));
      for (let epubIndex = 0; epubIndex < epubFiles.length; epubIndex += 1) {
        const file = epubFiles[epubIndex]!;
        const isPrimary = !hasMultipleEpubs || file.id === primaryFileId;
        books.push(
          mapFileToBook(
            serverId,
            series,
            chapter,
            file,
            epubIndex,
            multiFileChapter,
            hasMultipleEpubs,
            isPrimary,
          ),
        );
      }
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
  disambiguateDuplicateTitles(books);
  if (books.length > 1 && series.name) {
    for (const book of books) book.series = series.name;
  }
  return books;
}

function mapFileToBook(
  serverId: string,
  series: KavitaSeries,
  chapter: KavitaChapter,
  file: KavitaFile,
  epubIndex: number,
  multiFileChapter: boolean,
  hasMultipleEpubs: boolean,
  isPrimary: boolean,
): BookRecord {
  const writers = chapter.writers;
  const author =
    writers.length === 0
      ? null
      : writers.length === 1
        ? writers[0]!.name || null
        : writers.map((writer) => writer.name).join(', ') || null;
  const pages = resolveFilePages(series, chapter, file, multiFileChapter);
  const rawPagesRead = chapter.pagesRead ?? 0;
  const pagesRead = isPrimary ? (pages > 0 ? Math.min(pages, rawPagesRead) : rawPagesRead) : 0;
  const fileName = sanitizeEpubFileName(file.fileName);
  const record: BookRecord = {
    id: hasMultipleEpubs
      ? `${serverId}:${series.id}:${chapter.id}:${file.id}`
      : `${serverId}:${series.id}:${chapter.id}`,
    serverId,
    libraryId: series.libraryId,
    seriesId: series.id,
    volumeId: chapter.volumeId,
    chapterId: chapter.id,
    fileId: file.id,
    fileName,
    title: chapter.titleName || chapter.title || series.name || `Book ${chapter.id}`,
    author,
    series:
      chapter.titleName && series.name && chapter.titleName !== series.name ? series.name : null,
    descriptionHtml: chapter.summary || null,
    format: 'epub',
    pages,
    pagesRead,
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
  if (!isPrimary) {
    record.remoteProgressKnown = false;
    record.remoteReadDateKnown = false;
  } else {
    if (chapter.pagesRead === undefined) record.remoteProgressKnown = false;
    if (!chapter.lastReadingProgressUtc) record.remoteReadDateKnown = false;
  }
  return record;
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
  if (books.length < 2) return;
  const groups = new Map<string, BookRecord[]>();
  for (const book of books) {
    const group = groups.get(book.title);
    if (group) group.push(book);
    else groups.set(book.title, [book]);
  }
  for (const [baseTitle, group] of groups) {
    if (group.length < 2) continue;
    const fallbackOrder = [...group].sort((left, right) => {
      if (left.fileId != null && right.fileId != null && left.fileId !== right.fileId) {
        return left.fileId - right.fileId;
      }
      return (left.chapterEpubIndex ?? 0) - (right.chapterEpubIndex ?? 0);
    });
    const fallbackRank = new Map<BookRecord, number>(
      fallbackOrder.map((book, rank) => [book, rank + 1]),
    );
    const labels = group.map(
      (book) => fileDisplayStem(book.fileName) || `File ${fallbackRank.get(book) ?? 1}`,
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

function isEpubFile(file: KavitaFile): boolean {
  return file.format === 3 || file.extension?.toLowerCase() === '.epub';
}
