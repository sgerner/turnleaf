import type { BookRecord } from '../database/database';
import type { KavitaChapter, KavitaSeries, KavitaSeriesDetail } from './types';

const EMPTY_DATE = '0001-01-01T00:00:00';

export function mapSeriesToBooks(
  serverId: string,
  series: KavitaSeries,
  detail: KavitaSeriesDetail,
): BookRecord[] {
  // Preserve the existing order before appending volume chapters. This keeps the
  // old first-book id stable for records already stored locally, while still
  // discovering books that Kavita nests under volumes.
  const chapters = [
    ...detail.chapters,
    ...detail.specials,
    ...detail.storylineChapters,
    ...detail.volumes.flatMap((volume) => volume.chapters),
  ];
  const seen = new Set<number>();
  return chapters
    .filter(isEpubChapter)
    .filter((chapter) => {
      if (seen.has(chapter.id)) return false;
      seen.add(chapter.id);
      return true;
    })
    .map((chapter) => mapChapterToBook(serverId, series, chapter));
}

function mapChapterToBook(
  serverId: string,
  series: KavitaSeries,
  chapter: KavitaChapter,
): BookRecord {
  const file = chapter.files.find((item) => item.extension.toLowerCase() === '.epub');
  if (!file) throw new Error('An EPUB chapter did not include an EPUB file.');
  return {
    id: `${serverId}:${series.id}:${chapter.id}`,
    serverId,
    libraryId: series.libraryId,
    seriesId: series.id,
    volumeId: chapter.volumeId,
    chapterId: chapter.id,
    title: chapter.titleName || chapter.title || series.name,
    author: chapter.writers.map((writer) => writer.name).join(', ') || null,
    series: chapter.titleName && chapter.titleName !== series.name ? series.name : null,
    descriptionHtml: chapter.summary || null,
    format: 'epub',
    pages: chapter.pages || series.pages,
    pagesRead: chapter.pagesRead || series.pagesRead,
    createdAt: series.created,
    lastReadAt: series.latestReadDate.startsWith(EMPTY_DATE) ? null : series.latestReadDate,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: file.bytes,
  };
}

function isEpubChapter(chapter: KavitaChapter): boolean {
  return (
    chapter.format === 3 && chapter.files.some((file) => file.extension.toLowerCase() === '.epub')
  );
}
